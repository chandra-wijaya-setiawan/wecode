//! Rendering: the intent tree and the admission dialogue.
//!
//! Pure string functions so the output is testable without a terminal.

use wecode_core::{Admission, Intent, IntentId, IntentKind, IntentTree, Link, Measure, Status};

#[must_use]
pub(crate) fn kind_tag(kind: IntentKind) -> &'static str {
    match kind {
        IntentKind::Vision => "VIS",
        IntentKind::Goal => "GOAL",
        IntentKind::Project => "PROJ",
        IntentKind::Task => "TASK",
    }
}

#[must_use]
pub(crate) fn status_mark(status: Status) -> char {
    match status {
        Status::Draft => '·',
        Status::Active => '>',
        Status::Blocked => '!',
        Status::Done => 'x',
        Status::Dropped => '-',
    }
}

fn link_note(intent: &Intent) -> &'static str {
    // A kind with no legal parent is meant to be a root, so it is never drift.
    if intent.kind.valid_parents().is_empty() {
        return "";
    }
    match &intent.link {
        Link::Requires => "",
        Link::Alternative => " (alt)",
        Link::Contributes { .. } => " (contributes)",
        Link::Standalone { .. } => " (standalone)",
        Link::Unlinked => " (UNLINKED)",
    }
}

/// The whole tree, roots first, children indented.
#[must_use]
pub(crate) fn tree(t: &IntentTree) -> String {
    let mut out = String::new();
    if t.is_empty() {
        out.push_str("no intents yet — try: wecode intent add goal <id> \"<statement>\"\n");
        return out;
    }
    let roots: Vec<&Intent> = t.roots().collect();
    for r in roots {
        render_node(t, r, 0, &mut out);
    }
    out
}

fn render_node(t: &IntentTree, node: &Intent, depth: usize, out: &mut String) {
    let indent = "  ".repeat(depth);
    out.push_str(&format!(
        "{indent}{} {:<4} {:<22} {}{}\n",
        status_mark(node.status),
        kind_tag(node.kind),
        node.id.to_string(),
        node.statement,
        link_note(node),
    ));
    let mut kids: Vec<&Intent> = t.children(&node.id).collect();
    kids.sort_by(|a, b| a.id.cmp(&b.id));
    for k in kids {
        render_node(t, k, depth + 1, out);
    }
}

/// The chain from an intent up to its root — "what does this serve?".
#[must_use]
pub(crate) fn lineage(t: &IntentTree, id: &IntentId) -> String {
    let Some(node) = t.get(id) else {
        return format!("no such intent: {id}\n");
    };
    let mut chain: Vec<String> = t
        .ancestors(id)
        .map(|a| format!("{} {}", kind_tag(a.kind), a.statement))
        .collect();
    chain.reverse();
    chain.push(format!("{} {}", kind_tag(node.kind), node.statement));

    let mut out = String::new();
    for (i, step) in chain.iter().enumerate() {
        out.push_str(&format!("{}{}\n", "  ".repeat(i), step));
    }
    if t.ancestors(id).next().is_none()
        && node.link.is_unlinked()
        && !node.kind.valid_parents().is_empty()
    {
        out.push_str("\n  ⚠ unlinked: this serves nothing. `wecode intent link` to fix.\n");
    }
    out
}

fn measure_line(m: &Measure) -> String {
    match m {
        Measure::Command { cmd, expect_status } => format!("`{cmd}` exits {expect_status}"),
        Measure::Metric { name, target, cmp } => format!("{name} {cmp:?} {target}"),
        Measure::Deliverable { path } => format!("file exists: {path}"),
        Measure::Rollup => "rolled up from children".to_string(),
        Measure::Proxy { note } => format!("judged: {note}"),
    }
}

/// The admission verdict: either admitted, or the numbered questions to answer.
#[must_use]
pub(crate) fn admission(intent: &Intent, verdict: &Admission) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{} {}  {}\n",
        kind_tag(intent.kind),
        intent.id,
        intent.statement
    ));

    if !intent.measures.is_empty() {
        for m in &intent.measures {
            out.push_str(&format!("  measure   {}\n", measure_line(m)));
        }
    }
    if !intent.scope.write.is_empty() {
        out.push_str(&format!("  writes    {}\n", intent.scope.write.join(", ")));
    }

    let defects = verdict.defects();
    if defects.is_empty() {
        out.push_str("\n  ✓ admitted — assignable\n");
        return out;
    }

    out.push_str(&format!(
        "\n  ⚠ {} defect{} — not assignable\n\n",
        defects.len(),
        if defects.len() == 1 { "" } else { "s" }
    ));
    for (i, d) in defects.iter().enumerate() {
        out.push_str(&format!("  {}  {}\n", i + 1, d.question()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Scope};

    fn sample() -> IntentTree {
        let mut t = IntentTree::new();
        t.insert(Intent::new(
            "vis",
            IntentKind::Vision,
            "be the fastest exporter",
        ))
        .unwrap();
        t.insert(
            Intent::new("goal", IntentKind::Goal, "cut p99 below 500ms")
                .under("vis", Link::Requires),
        )
        .unwrap();
        t.insert(
            Intent::new("proj", IntentKind::Project, "add response caching")
                .under("goal", Link::Requires),
        )
        .unwrap();
        t
    }

    #[test]
    fn empty_tree_suggests_a_next_step() {
        let out = tree(&IntentTree::new());
        assert!(out.contains("no intents yet"), "{out}");
        assert!(out.contains("intent add"), "{out}");
    }

    #[test]
    fn tree_indents_by_depth() {
        let out = tree(&sample());
        let goal = out.lines().find(|l| l.contains("goal")).unwrap();
        let proj = out.lines().find(|l| l.contains("proj")).unwrap();
        assert!(goal.starts_with("  "), "{goal:?}");
        assert!(proj.starts_with("    "), "{proj:?}");
    }

    #[test]
    fn tree_shows_kind_tags() {
        let out = tree(&sample());
        assert!(out.contains("VIS"));
        assert!(out.contains("GOAL"));
        assert!(out.contains("PROJ"));
    }

    #[test]
    fn unlinked_intents_are_marked() {
        let mut t = sample();
        t.insert(Intent::new("orphan", IntentKind::Task, "bump deps"))
            .unwrap();
        assert!(tree(&t).contains("UNLINKED"));
    }

    #[test]
    fn a_root_only_kind_is_never_marked_as_drift() {
        // Regression: a vision has no legal parent, so it is a root by design.
        let out = tree(&sample());
        let vis = out.lines().find(|l| l.contains("VIS")).unwrap();
        assert!(!vis.contains("UNLINKED"), "{vis:?}");
        assert!(!lineage(&sample(), &IntentId::new("vis")).contains("serves nothing"));
    }

    #[test]
    fn lineage_walks_root_downward() {
        let out = lineage(&sample(), &IntentId::new("proj"));
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[0].contains("fastest exporter"), "{lines:?}");
        assert!(lines[2].contains("caching"), "{lines:?}");
    }

    #[test]
    fn lineage_of_an_unlinked_intent_warns() {
        let mut t = sample();
        t.insert(Intent::new("orphan", IntentKind::Task, "bump deps"))
            .unwrap();
        assert!(lineage(&t, &IntentId::new("orphan")).contains("serves nothing"));
    }

    #[test]
    fn lineage_of_a_missing_intent_says_so() {
        assert!(lineage(&sample(), &IntentId::new("nope")).contains("no such intent"));
    }

    #[test]
    fn admission_lists_numbered_questions() {
        let t = sample();
        let i = Intent::new("p2", IntentKind::Project, "make the export faster")
            .under("goal", Link::Requires);
        let verdict = Admission::check(&i, &t);
        let out = admission(&i, &verdict);
        assert!(out.contains("defect"), "{out}");
        assert!(out.contains("  1  "), "{out}");
        // The vague term must appear in the question, not just be counted.
        assert!(out.contains("faster"), "{out}");
    }

    #[test]
    fn admission_confirms_a_well_formed_intent() {
        let t = sample();
        let i = Intent::new("p3", IntentKind::Project, "add response caching to export")
            .under("goal", Link::Requires)
            .measured(Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 0,
            })
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(Budget {
                tokens: Some(1000),
                wall_secs: Some(60),
            });
        let verdict = Admission::decide(&i, &t, "operator", vec![]);
        let out = admission(&i, &verdict);
        assert!(out.contains("admitted"), "{out}");
        assert!(out.contains("cargo test"), "{out}");
        assert!(out.contains("crates/export/**"), "{out}");
    }
}
