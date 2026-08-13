//! The admission gate: is this well enough formed to be worked on?
//!
//! Every check is decided by inspecting values and the plan. Nothing calls a model.
//! That is the point — a gate that sometimes says yes for reasons nobody can
//! reproduce is not a gate.

use crate::id::TaskId;
use crate::plan::Plan;
use crate::project::Project;
use crate::task::{Task, TaskKind};

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

/// A specific, reportable reason something is not workable.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Defect {
    StatementEmpty,
    StatementCompound {
        marker: String,
    },
    StatementVague {
        term: String,
    },
    RepoMissing,
    /// The repo is not one the company registers.
    RepoUnknown {
        repo: String,
        known: Vec<String>,
    },
    MeasureMissing,
    MeasureNotExecutable,
    ScopeMissing,
    ScopeTooBroad {
        glob: String,
    },
    ScopeOverlaps {
        with: TaskId,
        glob: String,
    },
    BudgetMissing,
    /// The project demands a design before work of this kind, and no task of the
    /// `design` kind stands before this one or inside it.
    ///
    /// The relation is the whole check, on purpose. A design reaches `done` only
    /// through a recorded signature, and a dispatcher runs nothing whose
    /// predecessors are unfinished — so "depends on a design" at admission time *is*
    /// "an approved design exists" by the time this task runs. Whether the design is
    /// any good stays a human judgement; the gate does not pretend to it.
    DesignMissing,
    /// A project with no tasks cannot progress.
    ProjectHasNoTasks,
    /// A dependency that will never be satisfied.
    DependencyMissing {
        on: TaskId,
    },
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
            Self::DesignMissing => "This project requires a design before work of this kind. \
                 Which design is it built on? Depend on a design task (--after <id>), \
                 or create the pair with --expand."
                .into(),
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
///
/// `needs_design` is the kinds this project refuses without a design behind them —
/// from its playbook, since core reads no files. An empty list skips the check, the
/// way an empty `known_repos` does: a project that has not asked for the gate does
/// not get it by omission.
#[must_use]
pub fn check_task(t: &Task, plan: &Plan, needs_design: &[TaskKind]) -> Vec<Defect> {
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

    // Overlap matters only between tasks that could run at once. A finished task is
    // not one of them: its scope is history, and letting a newly added task make an
    // old one retroactively defective reports the fault against the wrong task.
    if t.status.is_closed() {
        return out;
    }

    // The design gate. A closed task skips it above for the same reason it skips
    // the overlap check: a playbook that turns the gate on must not retroactively
    // fault work that already finished.
    if needs_design.contains(&t.kind) && !waits_on_a_design(plan, t) && !contains_a_design(plan, t)
    {
        out.push(Defect::DesignMissing);
    }

    // Two further things stop concurrency: a dependency in either direction
    // sequences them, and a parent/child relation means one contains the other
    // rather than competing with it.
    for other in plan.tasks_of(&t.project) {
        if other.id == t.id
            || other.status.is_closed()
            || sequenced(plan, t, other)
            || nested(plan, t, other)
        {
            continue;
        }
        for glob in &t.scope.write {
            if glob.starts_with(crate::WORKER_DIR) {
                continue;
            }
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

/// Whether either task waits on the other, in either direction, at any remove.
///
/// Transitively, because ordering is transitive: if `c` waits on `b` and `b` waits on
/// `a`, then `c` and `a` cannot run at the same time, and refusing them for a scope
/// overlap states something untrue. A chain of tasks each building on the last is the
/// ordinary shape of a slice, and the direct-only version made the third and every
/// later link impossible to admit.
fn sequenced(plan: &Plan, a: &Task, b: &Task) -> bool {
    waits_on(plan, a, &b.id) || waits_on(plan, b, &a.id)
}

/// Whether `t` waits on `target`, directly or through other tasks.
///
/// Seeded from `t`'s own declared dependencies rather than looked up by id: the task
/// being admitted is not in the plan yet, so looking it up would find nothing.
fn waits_on(plan: &Plan, t: &Task, target: &TaskId) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    let mut stack: Vec<TaskId> = t.depends_on.clone();
    while let Some(id) = stack.pop() {
        if &id == target {
            return true;
        }
        // A cycle is its own defect, reported by another check. This walk has to
        // terminate whether or not that check has run yet.
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(next) = plan.task(&id) {
            stack.extend(next.depends_on.iter().cloned());
        }
    }
    false
}

/// Whether a `design` task stands anywhere before `t` in its dependency chain.
///
/// Only the kind is asked for, never the status. The dispatcher already refuses a
/// task whose predecessors are unfinished, and a design finishes only through a
/// recorded signature — so the ordering machinery, not this check, is what holds
/// the work back until the design is approved. Asking for `done` here would refuse
/// every expansion at the moment it is created, when its design is still a draft.
///
/// Transitive, because a chain of steps built on one design is the ordinary shape
/// of an expansion, and only the first link names the design directly. Seeded from
/// `t`'s own declared dependencies, like `waits_on`: the task being admitted is not
/// in the plan yet.
fn waits_on_a_design(plan: &Plan, t: &Task) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    let mut stack: Vec<TaskId> = t.depends_on.clone();
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(dep) = plan.task(&id) {
            if dep.kind == TaskKind::Design {
                return true;
            }
            stack.extend(dep.depends_on.iter().cloned());
        }
    }
    false
}

/// Whether a `design` task sits anywhere beneath `t` — the other shape a design
/// takes: the main task of an expansion *contains* its design step rather than
/// waiting on it, and the steps that build are the ones ordered after it.
///
/// This is also the repair path. A dependency cannot be added to a task that
/// exists, but a subtask can — so a feature caught by a gate turned on after its
/// creation is satisfied by `task add <id>-design --parent <id> --kind design`.
fn contains_a_design(plan: &Plan, t: &Task) -> bool {
    plan.subtasks(&t.id)
        .any(|s| s.kind == TaskKind::Design || contains_a_design(plan, s))
}

/// Whether one task is part of the other, at any depth.
///
/// A subtask almost always writes inside its parent's area — that is what makes it
/// a subtask. Reporting that as a conflict would make the parent relation unusable
/// for anything that touches files.
fn nested(plan: &Plan, a: &Task, b: &Task) -> bool {
    let ancestor_of = |x: &Task, y: &Task| {
        // `x` is fresh and may not be in the plan yet, so walk from `y` upward and
        // also check `x`'s own declared parent chain against `y`.
        plan.ancestors(&y.id).iter().any(|p| p.id == x.id)
    };
    a.parent.as_ref() == Some(&b.id)
        || b.parent.as_ref() == Some(&a.id)
        || ancestor_of(a, b)
        || ancestor_of(b, a)
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
            "add response caching to the export endpoint",
            "wecode",
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
            check_task(&good_task(), &plan, &[]).is_empty(),
            "{:?}",
            check_task(&good_task(), &plan, &[])
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
            check_task(&t, &seeded(), &[])
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
        assert!(check_task(&t, &seeded(), &[]).contains(&Defect::MeasureNotExecutable));
    }

    #[test]
    fn a_spike_needs_no_write_scope_but_a_feature_does() {
        let mut spike = good_task().of_kind(TaskKind::Spike);
        spike.scope = Scope::default();
        assert!(
            !check_task(&spike, &seeded(), &[]).contains(&Defect::ScopeMissing),
            "a spike investigates; it need not write"
        );

        let mut feature = good_task();
        feature.scope = Scope::default();
        assert!(check_task(&feature, &seeded(), &[]).contains(&Defect::ScopeMissing));
    }

    #[test]
    fn a_scope_of_everything_is_refused() {
        for broad in ["**", "*", ".", "**/*"] {
            let t = good_task().scoped(Scope::write(&[broad]));
            assert!(
                check_task(&t, &seeded(), &[])
                    .iter()
                    .any(|d| matches!(d, Defect::ScopeTooBroad { .. })),
                "{broad} should be too broad"
            );
        }
    }

    #[test]
    fn a_missing_dependency_is_reported() {
        let t = good_task().after("ghost");
        assert!(
            check_task(&t, &seeded(), &[])
                .contains(&Defect::DependencyMissing { on: "ghost".into() })
        );
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
            check_task(&sibling, &plan, &[])
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
            !check_task(&later, &plan, &[])
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. })),
            "a successor cannot collide with its predecessor"
        );
    }

    #[test]
    fn ordering_holds_across_a_chain_not_just_one_link() {
        // Found by using the tool: a slice is a chain, and the third link was refused
        // for overlapping the first — which it can never run beside. The message even
        // said "could run at the same time", which was false.
        let mut plan = seeded();
        plan.add_task(good_task()).unwrap();

        let second = Task::new("cache-metrics", "caching", "record the cache hit rate")
            .after("cache-layer")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/metrics/**"]))
            .budgeted(budget());
        plan.add_task(second).unwrap();

        let third = Task::new("cache-report", "caching", "publish the hit rate weekly")
            .after("cache-metrics")
            .accepting(cmd())
            // The same scope as `cache-layer`, two links back.
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget());
        assert!(
            !check_task(&third, &plan, &[])
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. })),
            "a task cannot collide with something it transitively waits on"
        );
    }

    #[test]
    fn an_unordered_task_still_collides() {
        // The guard above must not swallow the check it guards: with no path between
        // them, the same two scopes are a genuine conflict.
        let mut plan = seeded();
        plan.add_task(good_task()).unwrap();

        let loose = Task::new("cache-report", "caching", "publish the hit rate weekly")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget());
        assert!(
            check_task(&loose, &plan, &[])
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. })),
            "two tasks with no ordering between them still compete"
        );
    }

    #[test]
    fn a_subtask_may_write_inside_its_parents_scope() {
        // Otherwise the parent relation is unusable for anything touching files.
        let mut plan = seeded();
        plan.add_task(good_task()).unwrap();

        let inner = Task::new("cache-keys", "caching", "design the cache key format")
            .under("cache-layer")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/keys.rs"]))
            .budgeted(budget());
        assert!(
            !check_task(&inner, &plan, &[])
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. })),
            "a subtask works inside its parent, it does not compete with it"
        );
    }

    #[test]
    fn unrelated_siblings_still_collide() {
        // The control: nesting must not become a blanket exemption.
        let mut plan = seeded();
        plan.add_task(good_task()).unwrap();

        let rival = Task::new("other", "caching", "rewrite the export writer")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget());
        assert!(
            check_task(&rival, &plan, &[])
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. })),
            "two concurrent siblings on the same paths is a real conflict"
        );
    }

    #[test]
    fn a_finished_task_is_not_made_defective_by_a_later_one() {
        // The board computes defects for every row, so this surfaced as a done task
        // showing "1 defect" the moment an overlapping task was added.
        let mut plan = seeded();
        let mut done = good_task();
        done.status = TaskStatus::Done;
        plan.add_task(done.clone()).unwrap();

        let newcomer = Task::new("later", "caching", "revisit the export writer")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget());
        plan.add_task(newcomer).unwrap();

        assert!(
            check_task(&done, &plan, &[]).is_empty(),
            "a finished task cannot conflict: {:?}",
            check_task(&done, &plan, &[])
        );
    }

    #[test]
    fn two_tasks_may_both_claim_the_worker_area() {
        // Every task is told to write its result there, and each runs in its own
        // worktree, so it is not a resource they compete for. Treating it as one made
        // any two tasks that declared it un-admittable together.
        let mut plan = seeded();
        let mut first = good_task();
        first.scope = Scope::write(&["crates/export/**", ".wecode/run/**"]);
        plan.add_task(first).unwrap();

        let other = Task::new("other", "caching", "a different piece of work")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/other/**", ".wecode/run/**"]))
            .budgeted(budget());
        assert!(
            !check_task(&other, &plan, &[])
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. })),
            "{:?}",
            check_task(&other, &plan, &[])
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
            !check_task(&fresh, &plan, &[])
                .iter()
                .any(|d| matches!(d, Defect::ScopeOverlaps { .. }))
        );
    }

    // -------------------------------------------------------- design gate ------

    /// The kinds wecode's own playbook would gate: features only.
    fn gated() -> Vec<TaskKind> {
        vec![TaskKind::Feature]
    }

    fn design() -> Task {
        Task::new("cache-design", "caching", "decide the cache key format")
            .of_kind(TaskKind::Design)
            .accepting(cmd())
            .scoped(Scope::write(&["docs/wecode/cache/design.md"]))
            .budgeted(budget())
    }

    #[test]
    fn a_gated_feature_with_no_design_behind_it_is_refused() {
        let d = check_task(&good_task(), &seeded(), &gated());
        assert!(d.contains(&Defect::DesignMissing), "{d:?}");
    }

    #[test]
    fn an_empty_gate_asks_for_nothing() {
        // The same rule as `known_repos`: a project that has not asked for the
        // gate does not get it by omission.
        assert!(check_task(&good_task(), &seeded(), &[]).is_empty());
    }

    #[test]
    fn a_dependency_on_a_design_satisfies_the_gate_before_the_design_is_done() {
        // The design is still a draft — that is the moment `--expand` admits the
        // build step. The ordering machinery holds the work back until the design
        // is signed; the gate only asks that the design exist to wait on.
        let mut plan = seeded();
        plan.add_task(design()).unwrap();
        let t = good_task().after("cache-design");
        assert!(
            !check_task(&t, &plan, &gated()).contains(&Defect::DesignMissing),
            "{:?}",
            check_task(&t, &plan, &gated())
        );
    }

    #[test]
    fn the_design_may_stand_anywhere_up_the_chain() {
        // Only the first step of an expansion names the design directly; the ones
        // after it are built on it just the same.
        let mut plan = seeded();
        plan.add_task(design()).unwrap();
        plan.add_task(good_task().after("cache-design")).unwrap();
        let third = Task::new("cache-metrics", "caching", "record the cache hit rate")
            .after("cache-layer")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/metrics/**"]))
            .budgeted(budget());
        assert!(!check_task(&third, &plan, &gated()).contains(&Defect::DesignMissing));
    }

    #[test]
    fn a_design_subtask_satisfies_the_gate_for_its_container() {
        // The main task of an expansion holds its design as a child, not a
        // predecessor — the steps that build are the ones ordered after it.
        let mut plan = seeded();
        plan.add_task(good_task()).unwrap();
        plan.add_task(design().under("cache-layer")).unwrap();
        let container = plan.task(&"cache-layer".into()).unwrap();
        assert!(
            !check_task(container, &plan, &gated()).contains(&Defect::DesignMissing),
            "{:?}",
            check_task(container, &plan, &gated())
        );
    }

    #[test]
    fn an_ungated_kind_needs_no_design() {
        let t = good_task().of_kind(TaskKind::Chore);
        assert!(!check_task(&t, &seeded(), &gated()).contains(&Defect::DesignMissing));
    }

    #[test]
    fn a_finished_feature_is_not_faulted_by_a_gate_turned_on_later() {
        // The flag arrives in a playbook commit; work done before it is history,
        // and there is no way to add a dependency to an existing task anyway.
        let mut done = good_task();
        done.status = TaskStatus::Done;
        let mut plan = seeded();
        plan.add_task(done.clone()).unwrap();
        assert!(check_task(&done, &plan, &gated()).is_empty());
    }

    #[test]
    fn waivers_admit_but_are_recorded() {
        let mut t = good_task();
        t.budget = Budget::default();
        let defects = check_task(&t, &seeded(), &[]);
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
