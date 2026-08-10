//! Encoding for audit records.
//!
//! One line per decision, with the correlation keys on every record so
//! cross-harness questions ("who touched this path?") are ordinary scans.

use wecode_gov::{Action, ActionKind, ControlMode, Decision, DenyReason, Record, Source};

use crate::codec::Fields;

fn source_str(s: Source) -> &'static str {
    match s {
        Source::Broker => "broker",
        Source::Supervisor => "supervisor",
        Source::Harness => "harness",
    }
}

fn action_str(a: &Action) -> (&'static str, String) {
    match a {
        Action::Read { path } => ("read", path.clone()),
        Action::Write { path } => ("write", path.clone()),
        Action::Run { argv } => ("run", argv.join(" ")),
        Action::Network { host } => ("network", host.clone()),
        Action::Spend { tokens, wall_secs } => ("spend", format!("{tokens}t/{wall_secs}s")),
        Action::Merge { branch } => ("merge", branch.clone()),
        Action::Approve { kind } => ("approve", format!("{kind:?}")),
        Action::Define { kind } => ("define", kind.as_str().to_string()),
        Action::Introspect { level } => ("introspect", format!("{level:?}")),
        Action::Staff => ("staff", String::new()),
    }
}

fn decision_parts(d: &Decision) -> (&'static str, String, bool) {
    match d {
        Decision::Allow => ("allow", String::new(), false),
        Decision::RequireApproval { by } => ("approval", format!("{by:?}"), false),
        Decision::Deny {
            reason,
            mode,
            alarm,
        } => {
            let m = match mode {
                ControlMode::Regimented => "regimented",
                ControlMode::Sanctioned => "sanctioned",
            };
            (
                if *alarm { "alarm" } else { "deny" },
                format!("{m}: {reason}"),
                *alarm,
            )
        }
    }
}

/// Encodes one record as a single line.
#[must_use]
pub fn encode_record(r: &Record) -> String {
    let (verb, target) = action_str(&r.action);
    let (outcome, detail, _) = decision_parts(&r.decision);
    let mut parts = vec![
        "audit".to_string(),
        format!("seq={}", r.seq),
        format!("session={}", r.session),
        format!("post={}", r.post),
        format!("occupant={}", r.occupant),
        format!("intent={}", r.intent),
        format!("source={}", source_str(r.source)),
        format!("action={verb}"),
        format!("target={}", target.replace('\t', " ")),
        format!("outcome={outcome}"),
    ];
    if !detail.is_empty() {
        parts.push(format!("detail={}", detail.replace('\t', " ")));
    }
    parts.join("\t")
}

/// A decoded audit line. Kept as strings: the ledger is for reading and
/// filtering, not for reconstructing typed decisions.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AuditLine {
    pub seq: u64,
    pub post: String,
    pub occupant: String,
    pub intent: String,
    pub source: String,
    pub action: String,
    pub target: String,
    pub outcome: String,
    pub detail: String,
}

impl AuditLine {
    #[must_use]
    pub fn is_alarm(&self) -> bool {
        self.outcome == "alarm"
    }

    #[must_use]
    pub fn is_denial(&self) -> bool {
        self.outcome == "deny" || self.outcome == "alarm"
    }
}

/// Decodes one `audit` line, or `None` if it is not one.
#[must_use]
pub fn decode_record(line: &str) -> Option<AuditLine> {
    let f = Fields::parse(line);
    if f.kind != "audit" {
        return None;
    }
    Some(AuditLine {
        seq: f.opt("seq")?.parse().ok()?,
        post: f.opt("post").unwrap_or_default().to_string(),
        occupant: f.opt("occupant").unwrap_or_default().to_string(),
        intent: f.opt("intent").unwrap_or_default().to_string(),
        source: f.opt("source").unwrap_or_default().to_string(),
        action: f.opt("action").unwrap_or_default().to_string(),
        target: f.opt("target").unwrap_or_default().to_string(),
        outcome: f.opt("outcome").unwrap_or_default().to_string(),
        detail: f.opt("detail").unwrap_or_default().to_string(),
    })
}

/// Human-readable name for a required approval.
#[must_use]
pub fn approval_name(kind: ActionKind) -> &'static str {
    match kind {
        ActionKind::Merge => "merge",
        ActionKind::Admission => "admission",
        ActionKind::BudgetIncrease => "budget increase",
        ActionKind::MeasureAmendment => "measure amendment",
    }
}

/// Short reason text, for terminal output.
#[must_use]
pub fn deny_summary(reason: &DenyReason) -> String {
    reason.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::IntentId;
    use wecode_gov::{Broker, Charter, Effective, Grant, Invariant, Session};

    fn ledger_of(actions: &[Action]) -> Vec<String> {
        let mut b = Broker::new(Charter::with(vec![
            Invariant::NeverTouch(vec!["**/*.pem".into()]),
            Invariant::ApprovalToMerge(vec!["main".into()]),
        ]));
        let s = Session::new(
            "s1",
            "impl-api",
            "claude-code",
            IntentId::new("caching"),
            Effective::of(vec![
                Grant::writer(&["crates/export/**"])
                    .with_run(&["cargo *"])
                    .with_spend(1000, 60),
            ]),
        );
        for a in actions {
            b.authorize(&s, a);
        }
        b.ledger().iter().map(encode_record).collect()
    }

    #[test]
    fn allow_round_trips() {
        let lines = ledger_of(&[Action::Write {
            path: "crates/export/cache.rs".into(),
        }]);
        let d = decode_record(&lines[0]).expect("decodes");
        assert_eq!(d.seq, 1);
        assert_eq!(d.action, "write");
        assert_eq!(d.target, "crates/export/cache.rs");
        assert_eq!(d.outcome, "allow");
        assert_eq!(d.occupant, "claude-code");
        assert_eq!(d.source, "broker");
        assert!(!d.is_denial());
    }

    #[test]
    fn sanctioned_denial_records_its_mode() {
        let lines = ledger_of(&[Action::Write {
            path: "crates/auth/token.rs".into(),
        }]);
        let d = decode_record(&lines[0]).unwrap();
        assert_eq!(d.outcome, "deny");
        assert!(d.detail.starts_with("sanctioned:"), "{}", d.detail);
        assert!(d.is_denial());
        assert!(!d.is_alarm());
    }

    #[test]
    fn invariant_violation_records_an_alarm() {
        let lines = ledger_of(&[Action::Write {
            path: "deploy/key.pem".into(),
        }]);
        let d = decode_record(&lines[0]).unwrap();
        assert_eq!(d.outcome, "alarm");
        assert!(d.is_alarm());
        assert!(d.detail.contains("regimented"), "{}", d.detail);
    }

    #[test]
    fn approval_is_distinct_from_denial() {
        let lines = ledger_of(&[Action::Merge {
            branch: "main".into(),
        }]);
        let d = decode_record(&lines[0]).unwrap();
        assert_eq!(d.outcome, "approval");
        assert!(!d.is_denial());
    }

    #[test]
    fn every_action_variant_encodes_one_line() {
        let lines = ledger_of(&[
            Action::Read {
                path: "src/a".into(),
            },
            Action::Write {
                path: "src/b".into(),
            },
            Action::Run {
                argv: vec!["cargo".into(), "test".into()],
            },
            Action::Network {
                host: "crates.io".into(),
            },
            Action::Spend {
                tokens: 10,
                wall_secs: 1,
            },
            Action::Merge {
                branch: "topic".into(),
            },
            Action::Staff,
        ]);
        assert_eq!(lines.len(), 7);
        for (i, line) in lines.iter().enumerate() {
            assert!(!line.contains('\n'), "line {i} is multi-line");
            let d = decode_record(line).unwrap_or_else(|| panic!("line {i} failed: {line}"));
            assert_eq!(d.seq as usize, i + 1);
            assert!(!d.action.is_empty());
        }
    }

    #[test]
    fn run_targets_keep_the_whole_argv() {
        let lines = ledger_of(&[Action::Run {
            argv: vec!["cargo".into(), "test".into(), "--workspace".into()],
        }]);
        let d = decode_record(&lines[0]).unwrap();
        assert_eq!(d.target, "cargo test --workspace");
    }

    #[test]
    fn a_foreign_line_is_not_an_audit_record() {
        assert!(decode_record("intent\tid=x").is_none());
    }
}
