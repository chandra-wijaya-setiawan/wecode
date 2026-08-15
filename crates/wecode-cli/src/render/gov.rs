//! Authorisation, read back: the surface a grant unlocks, one verdict, and the
//! ledger of every verdict there has been.
//!
//! `wecode-gov` decides; nothing here does. What this module owes the Broker is a
//! faithful reading of the distinction it drew — regimented, sanctioned, alarm — and
//! of where each record came from, because that is what lets an operator tell a scope
//! that is wrong from an agent that is.

use wecode_gov::{Action, ControlMode, Decision, Grant, WorkKind};
use wecode_store::AuditLine;

/// The commands a grant unlocks.
///
/// **This is the discovery mechanism.** An agent logs in, asks `whoami`, and learns
/// its surface instead of guessing or hardcoding role names. Kept as one function
/// because an MCP server would expose exactly this list as its tool set — the
/// derivation should exist once.
#[must_use]
pub(crate) fn available_commands(grant: &Grant) -> Vec<(&'static str, String)> {
    let mut out = vec![
        ("tree", "projects and their tasks".to_string()),
        ("ready", "what is schedulable now".to_string()),
        ("show <id>", "one project or task in full".to_string()),
        ("board [<id>]", "the cockpit".to_string()),
        ("audit", "the ledger".to_string()),
    ];
    if grant.define.contains(&WorkKind::Project) {
        out.push(("project add", "define a project".to_string()));
        // Listed off the same capability that gates it, so a seat is never told it
        // may record one and then refused.
        out.push((
            "playbook gap \"<...>\"",
            "write down what the guidance did not say".to_string(),
        ));
    }
    if grant.define.contains(&WorkKind::Task) {
        out.push(("task add", "define a task".to_string()));
    }
    if grant.staff {
        out.push(("assign <task> --to <post>", "dispatch work".to_string()));
    }
    if !grant.approve.is_empty() {
        let kinds: Vec<String> = grant
            .approve
            .iter()
            .map(|k| k.as_str().to_string())
            .collect();
        out.push(("approve <what>", format!("may sign: {}", kinds.join(", "))));
    }
    out
}

/// One authorisation verdict, with the reason and what happens next.
#[must_use]
pub(crate) fn decision(post: &str, occupant: &str, action: &Action, d: &Decision) -> String {
    let (verb, target) = match action {
        Action::Read { path } => ("read", path.clone()),
        Action::Write { path } => ("write", path.clone()),
        Action::Run { argv } => ("run", argv.join(" ")),
        Action::Merge { branch } => ("merge", branch.clone()),
        Action::Spend { tokens, wall_secs } => ("spend", format!("{tokens} tokens, {wall_secs}s")),
        other => ("act", format!("{other:?}")),
    };

    let mut out = format!("{post} ({occupant})  {verb} {target}\n\n");
    match d {
        Decision::Allow => out.push_str("  ✓ allowed\n"),
        Decision::RequireApproval { by } => out.push_str(&format!(
            "  ⏸ needs approval: {}\n     nothing happens until a holder signs.\n",
            by.as_str()
        )),
        Decision::Deny {
            reason,
            mode,
            alarm,
        } => {
            out.push_str(&format!("  ✗ denied — {reason}\n"));
            match mode {
                ControlMode::Regimented => {
                    out.push_str("     regimented: blocked before it happens.\n");
                }
                ControlMode::Sanctioned => out.push_str(
                    "     sanctioned: recoverable, so the attempt is recorded as a signal.\n\
                     \x20    repeated attempts mean the scope is wrong, not the agent.\n",
                ),
            }
            if *alarm {
                out.push_str(
                    "\n  ⚡ ALARM — charter invariant. Dispatch freezes until acknowledged.\n",
                );
            }
        }
    }
    out
}

/// The audit ledger.
///
/// `source` is a column rather than a footnote because it is what makes a row
/// admissible or not: `broker` decided it, `supervisor` measured it, `harness` is the
/// agent's account of itself. A spend row is the first one where that distinction is
/// load-bearing — nothing sits between an agent and its model to count tokens, so the
/// number is reported, and a reader must be able to see that without knowing which
/// actions happen to be measurable.
#[must_use]
pub(crate) fn audit(lines: &[AuditLine]) -> String {
    if lines.is_empty() {
        return "no matching audit records\n".to_string();
    }
    let mut out =
        String::from("seq  post        agent         verdict   source      action  target\n");
    for l in lines {
        let mark = match l.outcome.as_str() {
            "allow" => "✓ allow",
            "approval" => "⏸ approve",
            "alarm" => "⚡ ALARM",
            _ => "✗ deny",
        };
        out.push_str(&format!(
            "{:<4} {:<11} {:<13} {:<9} {:<11} {:<7} {}\n",
            l.seq, l.post, l.agent, mark, l.source, l.action, l.target
        ));
        if !l.detail.is_empty() && l.outcome != "allow" {
            out.push_str(&format!("     └─ {}\n", l.detail));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_gov::{Broker, Charter, Effective, Invariant, Session};

    fn verdict_for(grant: Grant, action: &Action) -> (Decision, Vec<AuditLine>) {
        let mut b = Broker::new(Charter::with(vec![
            Invariant::NeverTouch(vec!["**/*.pem".into()]),
            Invariant::ApprovalToMerge(vec!["main".into()]),
        ]));
        let s = Session::new("s", "impl-api", "claude-code", Effective::of(vec![grant]))
            .on(Some("export".into()), Some("cache".into()));
        let d = b.authorize(&s, action);
        let store = wecode_store::Store::in_memory().unwrap();
        store.append_records(b.ledger()).unwrap();
        let lines = store.audit(&wecode_store::AuditQuery::default()).unwrap();
        (d, lines)
    }

    fn engineer() -> Grant {
        Grant::writer(&["crates/**"])
            .with_run(&["cargo *"])
            .with_spend(1000, 60)
    }

    #[test]
    fn allowed_action_reads_plainly() {
        let action = Action::Write {
            path: "crates/export/a.rs".into(),
        };
        let (d, _) = verdict_for(engineer(), &action);
        let out = decision("impl-api", "claude-code", &action, &d);
        assert!(out.contains("allowed"), "{out}");
        assert!(out.contains("crates/export/a.rs"), "{out}");
    }

    #[test]
    fn sanctioned_denial_explains_it_is_a_signal() {
        let action = Action::Write {
            path: "secrets/other.txt".into(),
        };
        let (d, _) = verdict_for(engineer(), &action);
        let out = decision("impl-api", "claude-code", &action, &d);
        assert!(out.contains("denied"), "{out}");
        assert!(out.contains("sanctioned"), "{out}");
        assert!(out.contains("scope is wrong"), "{out}");
    }

    #[test]
    fn an_invariant_violation_announces_the_freeze() {
        let action = Action::Write {
            path: "deploy/key.pem".into(),
        };
        let (d, _) = verdict_for(Grant::root(), &action);
        let out = decision("impl-api", "claude-code", &action, &d);
        assert!(out.contains("ALARM"), "{out}");
        assert!(out.contains("freezes"), "{out}");
    }

    #[test]
    fn approval_says_nothing_happens_yet() {
        let action = Action::Merge {
            branch: "main".into(),
        };
        let (d, _) = verdict_for(Grant::root(), &action);
        let out = decision("review", "claude-code", &action, &d);
        assert!(out.contains("needs approval"), "{out}");
        assert!(out.contains("nothing happens"), "{out}");
    }

    #[test]
    fn empty_audit_says_so() {
        assert!(audit(&[]).contains("no matching"));
    }

    #[test]
    fn audit_shows_verdict_and_reason() {
        let action = Action::Write {
            path: "deploy/key.pem".into(),
        };
        let (_, lines) = verdict_for(Grant::root(), &action);
        let out = audit(&lines);
        assert!(out.contains("ALARM"), "{out}");
        assert!(out.contains("deploy/key.pem"), "{out}");
        assert!(out.contains("└─"), "reason should be shown: {out}");
    }

    #[test]
    fn audit_omits_a_reason_for_allowed_actions() {
        let action = Action::Write {
            path: "crates/a.rs".into(),
        };
        let (_, lines) = verdict_for(engineer(), &action);
        let out = audit(&lines);
        assert!(out.contains("allow"), "{out}");
        assert!(!out.contains("└─"), "{out}");
    }

    #[test]
    fn audit_says_where_each_record_came_from() {
        // The distinction the spend column rests on: 1540 tokens is the agent's own
        // account of itself, and a reader has to be able to see that it was not
        // measured. Nothing sits between an agent and its model to measure it.
        let mut b = Broker::new(Charter::with(vec![]));
        let s = Session::new("s", "impl", "claude-code", Effective::of(vec![engineer()]))
            .on(Some("export".into()), Some("cache".into()));
        b.observe(
            &s,
            Action::Spend {
                tokens: 1540,
                wall_secs: 42,
            },
            Decision::Allow,
            wecode_gov::Source::Harness,
        );
        let store = wecode_store::Store::in_memory().unwrap();
        store.append_records(b.ledger()).unwrap();

        let out = audit(&store.audit(&wecode_store::AuditQuery::default()).unwrap());
        assert!(out.contains("source"), "the column is headed: {out}");
        assert!(out.contains("harness"), "{out}");
        assert!(out.contains("1540t/42s"), "{out}");
    }

    #[test]
    fn available_commands_track_the_grant_not_the_role_name() {
        let chief = Grant {
            read: vec!["**".into()],
            define: [WorkKind::Project, WorkKind::Task].into(),
            staff: true,
            ..Grant::default()
        };
        let cmds = available_commands(&chief);
        let names: Vec<&str> = cmds.iter().map(|(c, _)| *c).collect();
        assert!(names.contains(&"project add"), "{names:?}");
        assert!(names.contains(&"task add"), "{names:?}");

        let coder = available_commands(&engineer());
        let names: Vec<&str> = coder.iter().map(|(c, _)| *c).collect();
        assert!(!names.contains(&"project add"), "{names:?}");
    }
}
