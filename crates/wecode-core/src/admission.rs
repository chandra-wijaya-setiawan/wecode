//! The admission gate: is this well enough formed to be worked on?
//!
//! Every check is decided by inspecting values and the plan. Nothing calls a model.
//! That is the point — a gate that sometimes says yes for reasons nobody can
//! reproduce is not a gate.

use crate::id::TaskId;
use crate::plan::Plan;
use crate::project::Project;
use crate::task::Task;

/// Words that name a direction without naming a target. Their presence means we
/// cannot tell when the work is done, so we ask.
const VAGUE_TERMS: &[&str] = &[
    "faster", "slower", "better", "improve", "improved", "optimize", "optimise", "robust",
    "clean", "cleaner", "cleanup", "nice", "nicer", "modern", "scalable", "simple", "simpler",
    "good", "bad", "various", "stuff", "things", "somehow", "properly", "correctly", "etc",
];

/// Separators that suggest more than one outcome in a single statement.
const COMPOUND_MARKERS: &[&str] = &[" and ", " & ", ";", " then ", " plus ", " also "];

/// A specific, reportable reason something is not workable.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Defect {
    StatementEmpty,
    StatementCompound { marker: String },
    StatementVague { term: String },
    RepoMissing,
    /// The repo is not one the company registers.
    RepoUnknown { repo: String, known: Vec<String> },
    MeasureMissing,
    MeasureNotExecutable,
    ScopeMissing,
    ScopeTooBroad { glob: String },
    ScopeOverlaps { with: TaskId, glob: String },
    BudgetMissing,
    /// A project with no tasks cannot progress.
    ProjectHasNoTasks,
    /// A dependency that will never be satisfied.
    DependencyMissing { on: TaskId },
}

impl Defect {
    /// The question to put to whoever wrote this. Fixed text: the dialogue is
    /// scripted so it stays reproducible.
    #[must_use]
    pub fn question(&self) -> String {
        match self {
            Self::StatementEmpty => "What should be achieved? One sentence.".into(),
            Self::StatementCompound { marker } => format!(
                "This names more than one outcome (found {marker:?}). Split it, or restate as one."
            ),
            Self::StatementVague { term } => format!(
                "{term:?} names a direction, not a target. {term} compared to what, and by how much?"
            ),
            Self::RepoMissing => "Which repository does this project work in?".into(),
            Self::RepoUnknown { repo, known } => {
                if known.is_empty() {
                    format!(
                        "Repo {repo:?} is not registered. Add it under [[repos]] in company.toml."
                    )
                } else {
                    format!(
                        "Repo {repo:?} is not registered. Known: {}.",
                        known.join(", ")
                    )
                }
            }
            Self::MeasureMissing => {
                "How will we know this is done? Give a command, or a metric with a target.".into()
            }
            Self::MeasureNotExecutable => {
                "Every measure here needs a person to judge it. Add a command or a metric \
                 that can be checked without asking anyone."
                    .into()
            }
            Self::ScopeMissing => "Which paths may this change?".into(),
            Self::ScopeTooBroad { glob } => {
                format!("Write scope {glob:?} covers everything. Which paths specifically?")
            }
            Self::ScopeOverlaps { with, glob } => format!(
                "Write scope {glob:?} overlaps task `{with}`, which could run at the same time. \
                 Narrow one, or make this depend on it."
            ),
            Self::BudgetMissing => "What is the budget — tokens, wall time, or both?".into(),
            Self::ProjectHasNoTasks => {
                "This project has no tasks. Break it down before starting it.".into()
            }
            Self::DependencyMissing { on } => {
                format!("This waits on `{on}`, which does not exist.")
            }
        }
    }

    /// Whether this blocks work outright. Everything currently does; the
    /// distinction exists so advisory checks can be added without changing callers.
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

    /// Admits if nothing blocking remains after waivers.
    #[must_use]
    pub fn decide(defects: Vec<Defect>, by: impl Into<String>, waivers: Vec<Waiver>) -> Self {
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
}

/// Checks a project. `known_repos` comes from the company registry; an empty list
/// skips the check, so core stays usable without a company.
#[must_use]
pub fn check_project(p: &Project, plan: &Plan, known_repos: &[String]) -> Vec<Defect> {
    let mut out = Vec::new();
    check_statement(&p.objective, &mut out);

    if p.repo.trim().is_empty() {
        out.push(Defect::RepoMissing);
    } else if !known_repos.is_empty() && !known_repos.contains(&p.repo) {
        out.push(Defect::RepoUnknown {
            repo: p.repo.clone(),
            known: known_repos.to_vec(),
        });
    }

    if p.measures.is_empty() {
        out.push(Defect::MeasureMissing);
    } else if !p.has_executable_measure() {
        out.push(Defect::MeasureNotExecutable);
    }
    if !p.budget.is_set() {
        out.push(Defect::BudgetMissing);
    }

    // Only meaningful once the project is in the plan; a fresh one is expected to
    // have no tasks yet.
    if plan.project(&p.id).is_some() && plan.tasks_of(&p.id).next().is_none() {
        out.push(Defect::ProjectHasNoTasks);
    }
    out
}

/// Checks a task against its project and the tasks it could run alongside.
#[must_use]
pub fn check_task(t: &Task, plan: &Plan) -> Vec<Defect> {
    let mut out = Vec::new();
    check_statement(&t.title, &mut out);

    if t.acceptance.is_empty() {
        out.push(Defect::MeasureMissing);
    } else if !t.has_executable_acceptance() {
        out.push(Defect::MeasureNotExecutable);
    }

    if t.kind.requires_write_scope() {
        if t.scope.write.is_empty() {
            out.push(Defect::ScopeMissing);
        } else {
            for glob in &t.scope.write {
                if is_too_broad(glob) {
                    out.push(Defect::ScopeTooBroad { glob: glob.clone() });
                }
            }
        }
    }
    if !t.budget.is_set() {
        out.push(Defect::BudgetMissing);
    }

    for dep in &t.depends_on {
        if plan.task(dep).is_none() {
            out.push(Defect::DependencyMissing { on: dep.clone() });
        }
    }

    // Overlap matters only between tasks that could run at once. A dependency in
    // either direction sequences them, so sharing paths is then fine — which is
    // half the reason dependencies exist.
    for other in plan.tasks_of(&t.project) {
        if other.id == t.id || other.status.is_closed() || sequenced(t, other) {
            continue;
        }
        for glob in &t.scope.write {
            if other.scope.write.iter().any(|o| globs_overlap(glob, o)) {
                out.push(Defect::ScopeOverlaps {
                    with: other.id.clone(),
                    glob: glob.clone(),
                });
            }
        }
    }
    out
}

/// Whether either task waits on the other, in either direction.
fn sequenced(a: &Task, b: &Task) -> bool {
    a.depends_on.contains(&b.id) || b.depends_on.contains(&a.id)
}

fn check_statement(text: &str, out: &mut Vec<Defect>) {
    let s = text.trim();
    if s.is_empty() {
        out.push(Defect::StatementEmpty);
        return;
    }
    let lower = format!(" {} ", s.to_lowercase());
    if let Some(marker) = COMPOUND_MARKERS.iter().find(|m| lower.contains(**m)) {
        out.push(Defect::StatementCompound {
            marker: (*marker).trim().to_string(),
        });
    }
    if let Some(term) = VAGUE_TERMS
        .iter()
        .find(|t| lower.contains(&format!(" {t} ")) || lower.contains(&format!(" {t}.")))
    {
        out.push(Defect::StatementVague {
            term: (*term).to_string(),
        });
    }
}

/// `**`, `*`, `.` and `/` name everything, which is not a scope.
fn is_too_broad(glob: &str) -> bool {
    matches!(glob.trim(), "**" | "*" | "**/*" | "." | "./**" | "/" | "")
}

/// Prefix-containment overlap. Deliberately coarse: it errs toward reporting a
/// conflict, and a false positive costs one question while a false negative costs a
/// corrupted worktree.
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
    use crate::common::{Budget, Cmp, Measure, Scope, TaskStatus};
    use crate::task::TaskKind;

    fn repos() -> Vec<String> {
        vec!["wecode".to_string()]
    }

    fn budget() -> Budget {
        Budget {
            tokens: Some(1000),
            wall_secs: Some(60),
        }
    }

    fn cmd() -> Measure {
        Measure::Command {
            cmd: "cargo test".into(),
            expect_status: 0,
        }
    }

    fn good_project() -> Project {
        Project::new(
            "caching",
            "wecode",
            "add response caching to the export endpoint",
        )
        .measured(Measure::Metric {
            name: "p99_ms".into(),
            target: 500.0,
            cmp: Cmp::Lt,
        })
        .budgeted(budget())
    }

    fn good_task() -> Task {
        Task::new("cache-layer", "caching", "write the response cache layer")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget())
    }

    fn seeded() -> Plan {
        let mut p = Plan::new();
        p.add_project(good_project()).unwrap();
        p
    }

    #[test]
    fn a_well_formed_project_and_task_admit() {
        let empty = Plan::new();
        assert!(
            check_project(&good_project(), &empty, &repos()).is_empty(),
            "{:?}",
            check_project(&good_project(), &empty, &repos())
        );
        let plan = seeded();
        assert!(
            check_task(&good_task(), &plan).is_empty(),
            "{:?}",
            check_task(&good_task(), &plan)
        );
    }

    #[test]
    fn a_vague_objective_is_caught_with_the_term() {
        let mut p = good_project();
        p.objective = "make the export faster".into();
        let d = check_project(&p, &Plan::new(), &repos());
        assert!(
            d.iter()
                .any(|x| matches!(x, Defect::StatementVague { term } if term == "faster")),
            "{d:?}"
        );
    }

    #[test]
    fn a_compound_title_is_caught() {
        let mut t = good_task();
        t.title = "write the cache and rewrite the client".into();
        assert!(
            check_task(&t, &seeded())
                .iter()
                .any(|d| matches!(d, Defect::StatementCompound { .. }))
        );
    }

    #[test]
    fn an_unregistered_repo_lists_the_known_ones() {
        let mut p = good_project();
        p.repo = "ghost".into();
        let d = check_project(&p, &Plan::new(), &repos());
        match d.iter().find(|x| matches!(x, Defect::RepoUnknown { .. })) {
            Some(Defect::RepoUnknown { known, .. }) => assert_eq!(known, &repos()),
            other => panic!("expected RepoUnknown, got {other:?}"),
        }
    }

    #[test]
    fn a_project_in_the_plan_with_no_tasks_is_incomplete() {
        let plan = seeded();
        let stored = plan.project(&"caching".into()).unwrap().clone();
        assert!(check_project(&stored, &plan, &repos()).contains(&Defect::ProjectHasNoTasks));
    }

    #[test]
    fn a_judged_only_acceptance_is_not_executable() {
        let mut t = good_task();
        t.acceptance = vec![Measure::Judged {
            note: "looks right".into(),
        }];
        assert!(check_task(&t, &seeded()).contains(&Defect::MeasureNotExecutable));
    }

    #[test]
    fn a_spike_needs_no_write_scope_but_a_feature_does() {
        let mut spike = good_task().of_kind(TaskKind::Spike);
        spike.scope = Scope::default();
        assert!(
            !check_task(&spike, &seeded()).contains(&Defect::ScopeMissing),
            "a spike investigates; it need not write"
        );

        let mut feature = good_task();
        feature.scope = Scope::default();
        assert!(check_task(&feature, &seeded()).contains(&Defect::ScopeMissing));
    }

    #[test]
    fn a_scope_of_everything_is_refused() {
        for broad in ["**", "*", ".", "**/*"] {
            let t = good_task().scoped(Scope::write(&[broad]));
            assert!(
                check_task(&t, &seeded())
                    .iter()
                    .any(|d| matches!(d, Defect::ScopeTooBroad { .. })),
                "{broad} should be too broad"
            );
        }
    }

    #[test]
    fn a_missing_dependency_is_reported() {
        let t = good_task().after("ghost");
        assert!(check_task(&t, &seeded()).contains(&Defect::DependencyMissing {
            on: "ghost".into()
        }));
    }

    #[test]
    fn concurrent_tasks_may_not_share_a_write_scope() {
        let mut plan = seeded();
        plan.add_task(good_task()).unwrap();

        let sibling = Task::new("cache-metrics", "caching", "record the cache hit rate")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget());
        assert!(
            check_task(&sibling, &plan)
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. })),
            "two tasks that can run at once must not share paths"
        );
    }

    #[test]
    fn sequenced_tasks_may_share_a_write_scope() {
        // Half the reason dependencies exist: ordering removes the conflict.
        let mut plan = seeded();
        plan.add_task(good_task()).unwrap();

        let later = Task::new("cache-metrics", "caching", "record the cache hit rate")
            .after("cache-layer")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget());
        assert!(
            !check_task(&later, &plan)
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. })),
            "a successor cannot collide with its predecessor"
        );
    }

    #[test]
    fn a_closed_task_does_not_block_a_new_scope() {
        let mut plan = seeded();
        let mut done = good_task();
        done.status = TaskStatus::Done;
        plan.add_task(done).unwrap();

        let fresh = Task::new("cache-metrics", "caching", "record the cache hit rate")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget());
        assert!(
            !check_task(&fresh, &plan)
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. }))
        );
    }

    #[test]
    fn waivers_admit_but_are_recorded() {
        let mut t = good_task();
        t.budget = Budget::default();
        let defects = check_task(&t, &seeded());
        let waiver = Waiver {
            defect: Defect::BudgetMissing,
            by: "Chandra".into(),
            reason: "spike, capped manually".into(),
        };
        let a = Admission::decide(defects, "Chandra", vec![waiver.clone()]);
        assert!(a.is_admitted());
        match a {
            Admission::Admitted { waivers, .. } => assert_eq!(waivers, vec![waiver]),
            Admission::Draft { .. } => panic!("expected admitted"),
        }
    }

    #[test]
    fn glob_overlap_helper() {
        assert!(globs_overlap("crates/export/**", "crates/export/cache.rs"));
        assert!(globs_overlap("crates/**", "crates/export/**"));
        assert!(!globs_overlap("crates/export/**", "crates/import/**"));
    }
}
