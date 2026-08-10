//! The cockpit: a full-screen board with the same five columns at every level.
//!
//! Rendering only — no raw-mode input, because wasip1 has no termios. Navigation
//! is `wecode board [id]` rather than arrow keys; when a native build exists this
//! module keeps its shape and gains a key loop.
//!
//! Health is **computed**, never reported by an agent: it comes from status,
//! admission defects, the audit ledger and declared budgets.

use std::collections::BTreeMap;

use wecode_core::{Admission, Intent, IntentId, IntentKind, IntentTree, Status};
use wecode_store::AuditLine;

use crate::render::kind_tag;

const RESET: &str = "\x1b[0m";
const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const GREEN: &str = "\x1b[32m";
const AMBER: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Health {
    Green,
    Amber,
    Red,
}

impl Health {
    fn dot(self) -> String {
        match self {
            Self::Green => format!("{GREEN}●{RESET}green"),
            Self::Amber => format!("{AMBER}●{RESET}amber"),
            Self::Red => format!("{RED}●{RESET}red  "),
        }
    }
}

/// Everything the board knows about one intent, all of it derived.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Vitals {
    pub(crate) health: Health,
    pub(crate) progress: f32,
    pub(crate) spent: u64,
    pub(crate) budget: Option<u64>,
    pub(crate) alarms: usize,
    pub(crate) denials: usize,
    pub(crate) defects: usize,
    pub(crate) needs: Vec<String>,
}

/// Spend and incident counts per intent, folded from the ledger once.
pub(crate) fn ledger_index(audit: &[AuditLine]) -> BTreeMap<String, (u64, usize, usize)> {
    let mut out: BTreeMap<String, (u64, usize, usize)> = BTreeMap::new();
    for l in audit {
        let e = out.entry(l.intent.clone()).or_default();
        if l.action == "spend" {
            // target is "<tokens>t/<secs>s"
            if let Some(t) = l.target.split('t').next()
                && let Ok(n) = t.parse::<u64>()
            {
                e.0 += n;
            }
        }
        if l.is_alarm() {
            e.1 += 1;
        } else if l.is_denial() {
            e.2 += 1;
        }
    }
    out
}

/// Fraction of leaf descendants that are done. A leaf counts as itself.
fn progress(tree: &IntentTree, id: &IntentId) -> f32 {
    let leaves = leaf_statuses(tree, id);
    if leaves.is_empty() {
        return 0.0;
    }
    let done = leaves.iter().filter(|s| **s == Status::Done).count();
    done as f32 / leaves.len() as f32
}

fn leaf_statuses(tree: &IntentTree, id: &IntentId) -> Vec<Status> {
    let Some(node) = tree.get(id) else {
        return Vec::new();
    };
    let kids: Vec<&Intent> = tree.children(id).collect();
    if kids.is_empty() {
        return vec![node.status];
    }
    kids.iter()
        .flat_map(|k| leaf_statuses(tree, &k.id))
        .collect()
}

/// Rolled-up spend and incidents for an intent and everything beneath it.
fn subtree_totals(
    tree: &IntentTree,
    id: &IntentId,
    idx: &BTreeMap<String, (u64, usize, usize)>,
) -> (u64, usize, usize) {
    let own = idx.get(id.as_str()).copied().unwrap_or_default();
    let mut total = own;
    for kid in tree.children(id) {
        let k = subtree_totals(tree, &kid.id, idx);
        total.0 += k.0;
        total.1 += k.1;
        total.2 += k.2;
    }
    total
}

pub(crate) fn vitals(
    tree: &IntentTree,
    intent: &Intent,
    idx: &BTreeMap<String, (u64, usize, usize)>,
) -> Vitals {
    let (spent, alarms, denials) = subtree_totals(tree, &intent.id, idx);
    let defects = Admission::check(intent, tree).defects().len();
    let budget = intent.budget.tokens;
    let prog = progress(tree, &intent.id);

    let over_budget = budget.is_some_and(|b| spent > b);
    let stalled = spent > 0 && prog == 0.0 && intent.status == Status::Active;

    let mut needs = Vec::new();
    if alarms > 0 {
        needs.push(format!("{alarms} alarm"));
    }
    if defects > 0 {
        needs.push(format!("{defects} defect"));
    }
    if over_budget {
        needs.push("over budget".to_string());
    }
    if stalled {
        needs.push("stalled".to_string());
    }
    if intent.kind.is_assignable() && intent.status == Status::Draft && defects == 0 {
        needs.push("unassigned".to_string());
    }

    let health = if alarms > 0 || over_budget {
        Health::Red
    } else if defects > 0 || stalled || denials > 0 {
        Health::Amber
    } else {
        Health::Green
    };

    Vitals {
        health,
        progress: prog,
        spent,
        budget,
        alarms,
        denials,
        defects,
        needs,
    }
}

fn bar(fraction: f32) -> String {
    let filled = (fraction * 6.0).round().clamp(0.0, 6.0) as usize;
    let mut s = String::new();
    for i in 0..6 {
        s.push(if i < filled { '█' } else { '▁' });
    }
    format!("{s} {:>3.0}%", fraction * 100.0)
}

fn spend_cell(spent: u64, budget: Option<u64>) -> String {
    let k = |n: u64| {
        if n >= 1000 {
            format!("{}k", n / 1000)
        } else {
            n.to_string()
        }
    };
    match budget {
        Some(b) => format!("{:>5}/{:<5}", k(spent), k(b)),
        None => format!("{:>5}{:<6}", k(spent), ""),
    }
}

fn title_bar(level: &str, subject: &str, hint: &str) -> String {
    let head = format!(" {level} · {subject} ");
    let pad = 76usize.saturating_sub(head.chars().count() + hint.chars().count() + 3);
    format!(
        "{BOLD}┌{head}{RESET}{DIM}{}{hint} ─┐{RESET}\n",
        "─".repeat(pad)
    )
}

fn header_row() -> String {
    format!(
        "{DIM}│ {:<26} {:<12} {:<11} {:<12} {}{RESET}\n",
        "what", "health", "progress", "spend", "needs you"
    )
}

fn row(label: &str, v: &Vitals) -> String {
    let needs = if v.needs.is_empty() {
        format!("{DIM}—{RESET}")
    } else {
        v.needs.join(", ")
    };
    format!(
        "│ {:<26} {:<12} {:<11} {:<12} {}\n",
        truncate(label, 26),
        v.health.dot(),
        bar(v.progress),
        spend_cell(v.spent, v.budget),
        needs
    )
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

fn footer(hint: &str) -> String {
    format!("{DIM}└─ {hint}{RESET}\n")
}

/// The portfolio view: one line per root, then its goals.
pub(crate) fn portfolio(tree: &IntentTree, audit: &[AuditLine]) -> String {
    if tree.is_empty() {
        return "no intents yet — wecode intent add vision <id> \"<statement>\"\n".to_string();
    }
    let idx = ledger_index(audit);
    let mut out = title_bar("L0", "PORTFOLIO", "wecode board <id> to descend");
    out.push_str(&header_row());

    let mut roots: Vec<&Intent> = tree.roots().collect();
    roots.sort_by_key(|r| r.id.clone());

    for r in roots {
        out.push_str(&row(
            &format!("{} {}", kind_tag(r.kind), r.id),
            &vitals(tree, r, &idx),
        ));
        let mut kids: Vec<&Intent> = tree.children(&r.id).collect();
        kids.sort_by_key(|k| k.id.clone());
        for k in kids {
            out.push_str(&row(
                &format!("  {} {}", kind_tag(k.kind), k.id),
                &vitals(tree, k, &idx),
            ));
        }
    }
    out.push_str(&footer("alarms freeze dispatch · silence on green"));
    out
}

/// A focused view: the intent, its children, and its incidents.
pub(crate) fn focus(tree: &IntentTree, audit: &[AuditLine], id: &IntentId) -> String {
    let Some(node) = tree.get(id) else {
        return format!("no such intent: {id}\n");
    };
    let idx = ledger_index(audit);
    let v = vitals(tree, node, &idx);

    let level = match node.kind {
        IntentKind::Vision | IntentKind::Goal => "L1",
        IntentKind::Project => "L2",
        IntentKind::Task => "L3",
    };
    let mut out = title_bar(level, &id.to_string(), "wecode board to go up");
    out.push_str(&format!("{DIM}│ {}{RESET}\n", node.statement));
    out.push_str(&header_row());
    out.push_str(&row(&format!("{} {}", kind_tag(node.kind), id), &v));

    let mut kids: Vec<&Intent> = tree.children(id).collect();
    kids.sort_by_key(|k| k.id.clone());
    for k in kids {
        out.push_str(&row(
            &format!("  {} {}", kind_tag(k.kind), k.id),
            &vitals(tree, k, &idx),
        ));
    }

    let incidents: Vec<&AuditLine> = audit
        .iter()
        .filter(|l| l.intent == id.as_str() && l.is_denial())
        .collect();
    if !incidents.is_empty() {
        out.push_str(&format!("{DIM}│{RESET}\n"));
        out.push_str(&format!("{DIM}│ incidents{RESET}\n"));
        for l in incidents.iter().take(5) {
            let mark = if l.is_alarm() {
                format!("{RED}⚡{RESET}")
            } else {
                format!("{AMBER}✗{RESET}")
            };
            // The target is the point of an incident line: what was touched.
            out.push_str(&format!(
                "│  {mark} {:<10} {:<6} {:<24} {DIM}{}{RESET}\n",
                l.post,
                l.action,
                truncate(&l.target, 24),
                l.detail
            ));
        }
    }

    let hint = if v.needs.is_empty() {
        "nothing needs you here"
    } else {
        "wecode intent check <id> · wecode audit --alarms"
    };
    out.push_str(&footer(hint));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Link, Measure, Scope};

    fn tree() -> IntentTree {
        let mut t = IntentTree::new();
        t.insert(Intent::new("vis", IntentKind::Vision, "be fast"))
            .unwrap();
        t.insert(
            Intent::new("goal", IntentKind::Goal, "cut p99 below 500ms")
                .under("vis", Link::Requires)
                .measured(Measure::Rollup),
        )
        .unwrap();
        t.insert(
            Intent::new("proj", IntentKind::Project, "add caching")
                .under("goal", Link::Requires)
                .measured(Measure::Command {
                    cmd: "cargo test".into(),
                    expect_status: 0,
                })
                .scoped(Scope::write(&["crates/**"]))
                .budgeted(Budget {
                    tokens: Some(1000),
                    wall_secs: Some(60),
                }),
        )
        .unwrap();
        t
    }

    fn line(intent: &str, action: &str, target: &str, outcome: &str) -> AuditLine {
        AuditLine {
            seq: 1,
            post: "impl".into(),
            occupant: "claude-code".into(),
            intent: intent.into(),
            source: "broker".into(),
            action: action.into(),
            target: target.into(),
            outcome: outcome.into(),
            detail: "d".into(),
        }
    }

    #[test]
    fn empty_tree_suggests_a_next_step() {
        assert!(portfolio(&IntentTree::new(), &[]).contains("intent add vision"));
    }

    #[test]
    fn portfolio_lists_roots_and_their_children() {
        let out = portfolio(&tree(), &[]);
        assert!(out.contains("VIS vis"), "{out}");
        assert!(out.contains("GOAL goal"), "{out}");
        assert!(out.contains("L0 · PORTFOLIO"), "{out}");
    }

    #[test]
    fn every_level_shows_the_same_five_columns() {
        for out in [
            portfolio(&tree(), &[]),
            focus(&tree(), &[], &IntentId::new("goal")),
        ] {
            for col in ["what", "health", "progress", "spend", "needs you"] {
                assert!(out.contains(col), "missing `{col}` in:\n{out}");
            }
        }
    }

    #[test]
    fn an_alarm_turns_the_subtree_red_and_rolls_upward() {
        let audit = vec![line("proj", "write", "x.pem", "alarm")];
        let t = tree();
        let idx = ledger_index(&audit);
        // The project itself, and the goal above it, both go red.
        for id in ["proj", "goal", "vis"] {
            let node = t.get(&IntentId::new(id)).unwrap();
            assert_eq!(
                vitals(&t, node, &idx).health,
                Health::Red,
                "{id} should be red"
            );
        }
    }

    #[test]
    fn a_denial_is_amber_not_red() {
        let audit = vec![line("proj", "write", "other.rs", "deny")];
        let t = tree();
        let idx = ledger_index(&audit);
        let node = t.get(&IntentId::new("proj")).unwrap();
        assert_eq!(vitals(&t, node, &idx).health, Health::Amber);
    }

    #[test]
    fn spend_rolls_up_from_children() {
        let audit = vec![line("proj", "spend", "400t/10s", "allow")];
        let t = tree();
        let idx = ledger_index(&audit);
        let goal = t.get(&IntentId::new("goal")).unwrap();
        assert_eq!(
            vitals(&t, goal, &idx).spent,
            400,
            "goal sees its child's spend"
        );
    }

    #[test]
    fn exceeding_budget_is_red() {
        let audit = vec![line("proj", "spend", "5000t/0s", "allow")];
        let t = tree();
        let idx = ledger_index(&audit);
        let node = t.get(&IntentId::new("proj")).unwrap();
        let v = vitals(&t, node, &idx);
        assert_eq!(v.health, Health::Red);
        assert!(
            v.needs.iter().any(|n| n.contains("over budget")),
            "{:?}",
            v.needs
        );
    }

    #[test]
    fn progress_is_the_done_fraction_of_leaves() {
        let mut t = tree();
        t.insert(
            Intent::new("t1", IntentKind::Task, "one")
                .under("proj", Link::Requires)
                .measured(Measure::Command {
                    cmd: "c".into(),
                    expect_status: 0,
                })
                .scoped(Scope::write(&["a/**"]))
                .budgeted(Budget {
                    tokens: Some(1),
                    wall_secs: None,
                }),
        )
        .unwrap();
        let proj = IntentId::new("proj");
        assert_eq!(progress(&t, &proj), 0.0, "one leaf, not done");

        // Set the status before inserting: the tree is append-style, and rebuilding
        // it by iterating in id order would insert a child before its parent.
        let mut t2 = tree();
        let mut task = Intent::new("t1", IntentKind::Task, "one").under("proj", Link::Requires);
        task.status = Status::Done;
        t2.insert(task).unwrap();
        assert_eq!(progress(&t2, &proj), 1.0, "the only leaf is done");

        let mut second = Intent::new("t2", IntentKind::Task, "two").under("proj", Link::Requires);
        second.status = Status::Active;
        t2.insert(second).unwrap();
        assert_eq!(progress(&t2, &proj), 0.5, "one of two leaves done");
    }

    #[test]
    fn a_draft_with_no_defects_reads_as_unassigned() {
        // Must be a leaf: a compound intent with no children carries a defect of
        // its own, which would mask the unassigned signal.
        let mut t = tree();
        t.insert(
            Intent::new("t1", IntentKind::Task, "write the cache layer")
                .under("proj", Link::Requires)
                .measured(Measure::Command {
                    cmd: "cargo test".into(),
                    expect_status: 0,
                })
                .scoped(Scope::write(&["crates/cache.rs"]))
                .budgeted(Budget {
                    tokens: Some(100),
                    wall_secs: Some(10),
                }),
        )
        .unwrap();

        let idx = BTreeMap::new();
        let v = vitals(&t, t.get(&IntentId::new("t1")).unwrap(), &idx);
        assert_eq!(v.defects, 0, "control case must be defect-free");
        assert!(v.needs.iter().any(|n| n == "unassigned"), "{:?}", v.needs);
        assert_eq!(
            v.health,
            Health::Green,
            "waiting to be assigned is not a fault"
        );
    }

    #[test]
    fn a_compound_intent_with_no_children_is_amber() {
        // The project in `tree()` has no children, which the admission gate reports.
        let t = tree();
        let idx = BTreeMap::new();
        let v = vitals(&t, t.get(&IntentId::new("proj")).unwrap(), &idx);
        assert!(v.defects > 0);
        assert_eq!(v.health, Health::Amber);
    }

    #[test]
    fn focus_on_a_missing_intent_says_so() {
        assert!(focus(&tree(), &[], &IntentId::new("nope")).contains("no such intent"));
    }

    #[test]
    fn focus_shows_incidents_for_that_intent_only() {
        let audit = vec![
            line("proj", "write", "x.pem", "alarm"),
            line("goal", "write", "other", "deny"),
        ];
        let out = focus(&tree(), &audit, &IntentId::new("proj"));
        assert!(out.contains("incidents"), "{out}");
        assert!(out.contains("x.pem"), "{out}");
        assert!(
            !out.contains("other"),
            "should not show another intent's: {out}"
        );
    }

    #[test]
    fn bars_and_spend_cells_are_fixed_width() {
        assert_eq!(bar(0.0).chars().count(), bar(1.0).chars().count());
        assert_eq!(
            spend_cell(0, Some(100)).chars().count(),
            spend_cell(999_999, Some(100_000)).chars().count()
        );
    }

    #[test]
    fn long_labels_are_truncated_not_wrapped() {
        let s = truncate("a-very-long-intent-identifier-that-overflows", 26);
        assert_eq!(s.chars().count(), 26);
        assert!(s.ends_with('…'));
    }
}
