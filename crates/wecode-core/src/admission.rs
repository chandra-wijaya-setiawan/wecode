//! The admission gate: is this intent well enough formed to be assigned?
//!
//! Every check here is decided by inspecting values and the tree. Nothing calls a
//! model. That is the point — a gate that sometimes says yes for reasons nobody can
//! reproduce is not a gate.

use crate::id::IntentId;
use crate::intent::{Intent, IntentKind, Link, Measure};
use crate::tree::IntentTree;

/// Words that name a direction without naming a target. Their presence means we
/// cannot tell when the work is done, so we ask.
const VAGUE_TERMS: &[&str] = &[
    "faster",
    "slower",
    "better",
    "improve",
    "improved",
    "optimize",
    "optimise",
    "robust",
    "clean",
    "cleaner",
    "cleanup",
    "nice",
    "nicer",
    "modern",
    "scalable",
    "simple",
    "simpler",
    "good",
    "bad",
    "various",
    "stuff",
    "things",
    "somehow",
    "properly",
    "correctly",
    "etc",
];

/// Separators that suggest more than one outcome in a single statement.
const COMPOUND_MARKERS: &[&str] = &[" and ", " & ", ";", " then ", " plus ", " also "];

/// A specific, reportable reason an intent is not assignable.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Defect {
    StatementEmpty,
    StatementCompound { marker: String },
    StatementVague { term: String },
    NoParentLink,
    ParentMissing { parent: IntentId },
    MeasureMissing,
    MeasureNotExecutable,
    ProxyNotAllowed,
    ScopeMissing,
    ScopeTooBroad { glob: String },
    ScopeOverlaps { with: IntentId, glob: String },
    BudgetMissing,
    HorizonExceedsParent,
    CompoundHasNoChildren,
}

impl Defect {
    /// The question to put to whoever created this intent. Fixed text: the dialogue
    /// is scripted so it stays reproducible.
    #[must_use]
    pub fn question(&self) -> String {
        match self {
            Self::StatementEmpty => "What should be achieved? One sentence.".into(),
            Self::StatementCompound { marker } => format!(
                "This names more than one outcome (found {marker:?}). Split it, or restate as a single outcome."
            ),
            Self::StatementVague { term } => format!(
                "{term:?} names a direction, not a target. {term} compared to what, and by how much?"
            ),
            Self::NoParentLink => "Which intent does this serve? If none, say why it stands alone \
                 (maintenance, urgent, exploration, personal)."
                .into(),
            Self::ParentMissing { parent } => {
                format!("Parent `{parent}` does not exist. Create it, or re-link this intent.")
            }
            Self::MeasureMissing => {
                "How will we know this is done? Give a command, or a metric with a target.".into()
            }
            Self::MeasureNotExecutable => {
                "Every measure here needs a human to judge it. Add a command or a metric \
                 that can be checked without asking anyone."
                    .into()
            }
            Self::ProxyNotAllowed => {
                "A proxy measure is only valid on a vision. Give something checkable.".into()
            }
            Self::ScopeMissing => "Which paths may this change?".into(),
            Self::ScopeTooBroad { glob } => {
                format!("Write scope {glob:?} covers everything. Which paths specifically?")
            }
            Self::ScopeOverlaps { with, glob } => format!(
                "Write scope {glob:?} overlaps sibling `{with}`. Narrow one, or sequence them."
            ),
            Self::BudgetMissing => "What is the budget — tokens, wall time, or both?".into(),
            Self::HorizonExceedsParent => {
                "This has a longer horizon than its parent. Shorten it, or re-parent.".into()
            }
            Self::CompoundHasNoChildren => {
                "This cannot be executed directly and has no children. Decompose it.".into()
            }
        }
    }

    /// Whether this defect blocks assignment outright. Everything currently does;
    /// the distinction exists so advisory checks can be added without changing
    /// callers.
    #[must_use]
    pub fn is_blocking(&self) -> bool {
        true
    }
}

/// An explicit, attributed decision to skip a check.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Waiver {
    pub defect: Defect,
    pub by: String,
    pub reason: String,
}

/// The outcome of the gate.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Admission {
    Draft { defects: Vec<Defect> },
    Admitted { by: String, waivers: Vec<Waiver> },
}

impl Admission {
    /// Runs every check. `tree` supplies the parent and siblings.
    #[must_use]
    pub fn check(intent: &Intent, tree: &IntentTree) -> Self {
        let mut defects = Vec::new();
        check_statement(intent, &mut defects);
        check_link(intent, tree, &mut defects);
        check_measures(intent, &mut defects);
        check_scope(intent, tree, &mut defects);
        check_budget(intent, &mut defects);
        check_decomposition(intent, tree, &mut defects);
        Self::Draft { defects }
    }

    /// Runs the checks and admits if nothing blocking remains after waivers.
    #[must_use]
    pub fn decide(
        intent: &Intent,
        tree: &IntentTree,
        by: impl Into<String>,
        waivers: Vec<Waiver>,
    ) -> Self {
        let Self::Draft { defects } = Self::check(intent, tree) else {
            unreachable!("check always returns Draft");
        };
        let remaining: Vec<Defect> = defects
            .into_iter()
            .filter(|d| d.is_blocking() && !waivers.iter().any(|w| w.defect == *d))
            .collect();

        if remaining.is_empty() {
            Self::Admitted {
                by: by.into(),
                waivers,
            }
        } else {
            Self::Draft { defects: remaining }
        }
    }

    #[must_use]
    pub fn is_admitted(&self) -> bool {
        matches!(self, Self::Admitted { .. })
    }

    #[must_use]
    pub fn defects(&self) -> &[Defect] {
        match self {
            Self::Draft { defects } => defects,
            Self::Admitted { .. } => &[],
        }
    }
}

fn check_statement(intent: &Intent, out: &mut Vec<Defect>) {
    let s = intent.statement.trim();
    if s.is_empty() {
        out.push(Defect::StatementEmpty);
        return;
    }
    let lower = format!(" {} ", s.to_lowercase());
    if let Some(marker) = COMPOUND_MARKERS.iter().find(|m| lower.contains(*m)) {
        out.push(Defect::StatementCompound {
            marker: (*marker).trim().to_string(),
        });
    }
    // A vision names a direction on purpose, so vagueness is expected there.
    if intent.kind != IntentKind::Vision {
        if let Some(term) = VAGUE_TERMS
            .iter()
            .find(|t| lower.contains(&format!(" {t} ")) || lower.contains(&format!(" {t}.")))
        {
            out.push(Defect::StatementVague {
                term: (*term).to_string(),
            });
        }
    }
}

fn check_link(intent: &Intent, tree: &IntentTree, out: &mut Vec<Defect>) {
    // A kind with no legal parent is inherently a root, so having no link is
    // correct rather than drift. Only kinds that *could* be attached can dangle.
    if intent.kind.valid_parents().is_empty() {
        if let Some(parent) = &intent.parent {
            out.push(Defect::ParentMissing {
                parent: parent.clone(),
            });
        }
        return;
    }
    match (&intent.link, &intent.parent) {
        (Link::Unlinked, _) => out.push(Defect::NoParentLink),
        (link, None) if link.needs_parent() => out.push(Defect::NoParentLink),
        (_, Some(parent)) => match tree.get(parent) {
            None => out.push(Defect::ParentMissing {
                parent: parent.clone(),
            }),
            Some(p) if intent.horizon > p.horizon => {
                out.push(Defect::HorizonExceedsParent);
            }
            Some(_) => {}
        },
        _ => {}
    }
}

fn check_measures(intent: &Intent, out: &mut Vec<Defect>) {
    if intent.kind == IntentKind::Vision {
        return; // Proxy measures are the point at this level.
    }
    if intent.measures.is_empty() {
        out.push(Defect::MeasureMissing);
        return;
    }
    if intent
        .measures
        .iter()
        .any(|m| matches!(m, Measure::Proxy { .. }))
    {
        out.push(Defect::ProxyNotAllowed);
    }
    // Rollup counts as satisfied for compound kinds: children carry the evidence.
    let rollup_ok = !intent.kind.is_primitive() && intent.measures.contains(&Measure::Rollup);
    if intent.kind.requires_executable_measure() && !intent.has_executable_measure() && !rollup_ok {
        out.push(Defect::MeasureNotExecutable);
    }
}

fn check_scope(intent: &Intent, tree: &IntentTree, out: &mut Vec<Defect>) {
    if !intent.kind.requires_scope() {
        return;
    }
    if intent.scope.write.is_empty() {
        out.push(Defect::ScopeMissing);
        return;
    }
    for glob in &intent.scope.write {
        if is_too_broad(glob) {
            out.push(Defect::ScopeTooBroad { glob: glob.clone() });
        }
    }
    // Siblings only: unrelated branches are sequenced by the scheduler, not here.
    if let Some(parent) = &intent.parent {
        for sib in tree.children(parent) {
            if sib.id == intent.id {
                continue;
            }
            for glob in &intent.scope.write {
                if sib
                    .scope
                    .write
                    .iter()
                    .any(|other| globs_overlap(glob, other))
                {
                    out.push(Defect::ScopeOverlaps {
                        with: sib.id.clone(),
                        glob: glob.clone(),
                    });
                }
            }
        }
    }
}

fn check_budget(intent: &Intent, out: &mut Vec<Defect>) {
    if intent.kind.is_assignable() && !intent.budget.is_set() {
        out.push(Defect::BudgetMissing);
    }
}

fn check_decomposition(intent: &Intent, tree: &IntentTree, out: &mut Vec<Defect>) {
    // Only meaningful once the intent is in the tree; a fresh compound intent is
    // expected to have no children yet.
    if !intent.kind.is_primitive()
        && tree.get(&intent.id).is_some()
        && tree.children(&intent.id).next().is_none()
    {
        out.push(Defect::CompoundHasNoChildren);
    }
}

/// `**`, `*`, `.` and `/` name everything, which is not a scope.
fn is_too_broad(glob: &str) -> bool {
    matches!(glob.trim(), "**" | "*" | "**/*" | "." | "./**" | "/" | "")
}

/// Prefix-containment overlap: compare the literal parts before the first
/// wildcard. Deliberately coarse — it errs toward reporting an overlap, and a
/// false positive costs one question while a false negative costs a corrupted
/// worktree.
fn globs_overlap(a: &str, b: &str) -> bool {
    let pa = literal_prefix(a);
    let pb = literal_prefix(b);
    pa.starts_with(&pb) || pb.starts_with(&pa)
}

fn literal_prefix(glob: &str) -> String {
    let cut = glob.find(['*', '?', '[']).unwrap_or(glob.len());
    glob[..cut].trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::{Budget, Horizon, Measure, Scope, StandaloneReason};

    fn cmd() -> Measure {
        Measure::Command {
            cmd: "cargo test".into(),
            expect_status: 0,
        }
    }

    fn budget() -> Budget {
        Budget {
            tokens: Some(100_000),
            wall_secs: Some(1800),
        }
    }

    fn base_tree() -> IntentTree {
        let mut t = IntentTree::new();
        t.insert(Intent::new("vis", IntentKind::Vision, "be excellent"))
            .unwrap();
        t.insert(
            Intent::new("goal", IntentKind::Goal, "cut p99 below 500ms")
                .under("vis", Link::Requires)
                .measured(Measure::Metric {
                    name: "p99_ms".into(),
                    target: 500.0,
                    cmp: crate::intent::Cmp::Lt,
                }),
        )
        .unwrap();
        t
    }

    /// A fully-formed project: the control case for every negative test below.
    fn good_project() -> Intent {
        Intent::new(
            "proj",
            IntentKind::Project,
            "add response caching to the export endpoint",
        )
        .under("goal", Link::Requires)
        .measured(cmd())
        .scoped(Scope::write(&["crates/export/**"]))
        .budgeted(budget())
        .horizon(Horizon::Month)
    }

    #[test]
    fn a_well_formed_project_admits() {
        let t = base_tree();
        let a = Admission::decide(&good_project(), &t, "operator", vec![]);
        assert!(a.is_admitted(), "unexpected defects: {:?}", a.defects());
    }

    #[test]
    fn empty_statement_is_a_defect() {
        let t = base_tree();
        let mut i = good_project();
        i.statement = "   ".into();
        assert!(
            Admission::check(&i, &t)
                .defects()
                .contains(&Defect::StatementEmpty)
        );
    }

    #[test]
    fn vague_statement_is_caught_with_the_offending_term() {
        let t = base_tree();
        let mut i = good_project();
        i.statement = "make the export faster".into();
        let defects = Admission::check(&i, &t);
        assert!(
            defects
                .defects()
                .iter()
                .any(|d| matches!(d, Defect::StatementVague { term } if term == "faster")),
            "got {:?}",
            defects.defects()
        );
    }

    #[test]
    fn a_bare_vision_admits() {
        // A vision has no legal parent, so being unlinked is correct, not drift.
        // Regression: the gate used to refuse every vision.
        let t = IntentTree::new();
        let v = Intent::new("vis", IntentKind::Vision, "lead the market on export speed");
        let a = Admission::decide(&v, &t, "operator", vec![]);
        assert!(a.is_admitted(), "unexpected defects: {:?}", a.defects());
    }

    #[test]
    fn a_vision_with_a_parent_is_a_defect() {
        let t = base_tree();
        let mut v = Intent::new("vis2", IntentKind::Vision, "another direction");
        v.parent = Some(IntentId::new("vis"));
        assert!(
            Admission::check(&v, &t)
                .defects()
                .iter()
                .any(|d| matches!(d, Defect::ParentMissing { .. })),
            "a vision may not be parented"
        );
    }

    #[test]
    fn vagueness_is_allowed_on_a_vision() {
        let t = IntentTree::new();
        let v = Intent::new("v", IntentKind::Vision, "build a simple, better product");
        let defects = Admission::check(&v, &t);
        assert!(
            !defects
                .defects()
                .iter()
                .any(|d| matches!(d, Defect::StatementVague { .. })),
            "got {:?}",
            defects.defects()
        );
    }

    #[test]
    fn compound_statement_is_caught() {
        let t = base_tree();
        let mut i = good_project();
        i.statement = "add caching and rewrite the client".into();
        let defects = Admission::check(&i, &t);
        assert!(
            defects
                .defects()
                .iter()
                .any(|d| matches!(d, Defect::StatementCompound { marker } if marker == "and")),
            "got {:?}",
            defects.defects()
        );
    }

    #[test]
    fn unlinked_is_a_defect_but_standalone_is_not() {
        let t = base_tree();
        let mut i = good_project();
        i.parent = None;
        i.link = Link::Unlinked;
        assert!(
            Admission::check(&i, &t)
                .defects()
                .contains(&Defect::NoParentLink)
        );

        let ok = good_project().standalone(StandaloneReason::Maintenance);
        let a = Admission::decide(&ok, &t, "operator", vec![]);
        assert!(a.is_admitted(), "unexpected defects: {:?}", a.defects());
    }

    #[test]
    fn missing_measure_is_a_defect() {
        let t = base_tree();
        let mut i = good_project();
        i.measures.clear();
        assert!(
            Admission::check(&i, &t)
                .defects()
                .contains(&Defect::MeasureMissing)
        );
    }

    #[test]
    fn judged_only_measures_are_not_executable() {
        let t = base_tree();
        let mut i = good_project();
        i.measures = vec![Measure::Proxy {
            note: "looks right".into(),
        }];
        let d = Admission::check(&i, &t);
        assert!(d.defects().contains(&Defect::ProxyNotAllowed));
        assert!(d.defects().contains(&Defect::MeasureNotExecutable));
    }

    #[test]
    fn rollup_satisfies_a_compound_kind_only() {
        let t = base_tree();
        let mut project = good_project();
        project.measures = vec![Measure::Rollup];
        assert!(
            !Admission::check(&project, &t)
                .defects()
                .contains(&Defect::MeasureNotExecutable)
        );

        let mut task = Intent::new("t", IntentKind::Task, "write the cache layer")
            .under("proj", Link::Requires)
            .scoped(Scope::write(&["crates/export/cache.rs"]))
            .budgeted(budget());
        task.measures = vec![Measure::Rollup];
        assert!(
            Admission::check(&task, &t)
                .defects()
                .contains(&Defect::MeasureNotExecutable)
        );
    }

    #[test]
    fn scope_is_required_and_must_be_narrow() {
        let t = base_tree();
        let mut i = good_project();
        i.scope = Scope::default();
        assert!(
            Admission::check(&i, &t)
                .defects()
                .contains(&Defect::ScopeMissing)
        );

        for broad in ["**", "*", ".", "**/*"] {
            let j = good_project().scoped(Scope::write(&[broad]));
            assert!(
                Admission::check(&j, &t)
                    .defects()
                    .iter()
                    .any(|d| matches!(d, Defect::ScopeTooBroad { .. })),
                "{broad} should be too broad"
            );
        }
    }

    #[test]
    fn goals_need_no_scope_or_budget() {
        let t = base_tree();
        let g = Intent::new("g2", IntentKind::Goal, "reach 99.9% uptime")
            .under("vis", Link::Requires)
            .measured(Measure::Metric {
                name: "uptime".into(),
                target: 99.9,
                cmp: crate::intent::Cmp::Gte,
            });
        let a = Admission::decide(&g, &t, "operator", vec![]);
        assert!(a.is_admitted(), "unexpected defects: {:?}", a.defects());
    }

    #[test]
    fn sibling_scope_overlap_is_reported() {
        let mut t = base_tree();
        t.insert(good_project()).unwrap();
        let sibling = Intent::new("proj2", IntentKind::Project, "add export pagination")
            .under("goal", Link::Requires)
            .measured(cmd())
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget());
        let d = Admission::check(&sibling, &t);
        assert!(
            d.defects()
                .iter()
                .any(|x| matches!(x, Defect::ScopeOverlaps { .. })),
            "got {:?}",
            d.defects()
        );
    }

    #[test]
    fn disjoint_sibling_scopes_are_fine() {
        let mut t = base_tree();
        t.insert(good_project()).unwrap();
        let sibling = Intent::new("proj2", IntentKind::Project, "add import validation")
            .under("goal", Link::Requires)
            .measured(cmd())
            .scoped(Scope::write(&["crates/import/**"]))
            .budgeted(budget());
        assert!(
            !Admission::check(&sibling, &t)
                .defects()
                .iter()
                .any(|x| matches!(x, Defect::ScopeOverlaps { .. }))
        );
    }

    #[test]
    fn budget_is_required_for_assignable_kinds() {
        let t = base_tree();
        let mut i = good_project();
        i.budget = Budget::default();
        assert!(
            Admission::check(&i, &t)
                .defects()
                .contains(&Defect::BudgetMissing)
        );
    }

    #[test]
    fn horizon_may_not_exceed_the_parent() {
        let t = base_tree();
        let i = good_project().horizon(Horizon::Year); // parent goal is Quarter
        assert!(
            Admission::check(&i, &t)
                .defects()
                .contains(&Defect::HorizonExceedsParent)
        );
    }

    #[test]
    fn compound_in_tree_without_children_is_a_defect() {
        let mut t = base_tree();
        t.insert(good_project()).unwrap();
        let stored = t.get(&IntentId::new("proj")).unwrap().clone();
        assert!(
            Admission::check(&stored, &t)
                .defects()
                .contains(&Defect::CompoundHasNoChildren)
        );
    }

    #[test]
    fn waiver_admits_but_is_recorded() {
        let t = base_tree();
        let mut i = good_project();
        i.budget = Budget::default();
        let waiver = Waiver {
            defect: Defect::BudgetMissing,
            by: "operator".into(),
            reason: "spike, will cap manually".into(),
        };
        let a = Admission::decide(&i, &t, "operator", vec![waiver.clone()]);
        assert!(a.is_admitted());
        match a {
            Admission::Admitted { waivers, .. } => assert_eq!(waivers, vec![waiver]),
            Admission::Draft { .. } => panic!("expected admitted"),
        }
    }

    #[test]
    fn every_defect_asks_a_question() {
        let all = [
            Defect::StatementEmpty,
            Defect::StatementCompound {
                marker: "and".into(),
            },
            Defect::StatementVague {
                term: "faster".into(),
            },
            Defect::NoParentLink,
            Defect::ParentMissing {
                parent: IntentId::new("x"),
            },
            Defect::MeasureMissing,
            Defect::MeasureNotExecutable,
            Defect::ProxyNotAllowed,
            Defect::ScopeMissing,
            Defect::ScopeTooBroad { glob: "**".into() },
            Defect::ScopeOverlaps {
                with: IntentId::new("y"),
                glob: "a/**".into(),
            },
            Defect::BudgetMissing,
            Defect::HorizonExceedsParent,
            Defect::CompoundHasNoChildren,
        ];
        for d in all {
            let q = d.question();
            assert!(!q.is_empty(), "{d:?} has no question");
            assert!(q.len() > 15, "{d:?} question is too terse: {q}");
        }
    }

    #[test]
    fn glob_overlap_helper() {
        assert!(globs_overlap("crates/export/**", "crates/export/cache.rs"));
        assert!(globs_overlap("crates/**", "crates/export/**"));
        assert!(!globs_overlap("crates/export/**", "crates/import/**"));
        assert!(!globs_overlap("tests/**", "src/**"));
    }
}
