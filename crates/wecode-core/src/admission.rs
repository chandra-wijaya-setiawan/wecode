//! The admission gate: is this well enough formed to be worked on?
//!
//! Every check is decided by inspecting values and the plan. Nothing calls a model.
//! That is the point — a gate that sometimes says yes for reasons nobody can
//! reproduce is not a gate.
//!
//! Two layers, and the second is not the first with a flag on it. A [`Defect`] is a
//! reason work cannot start; a [`Divergence`] is a workable declaration that is not
//! what the project's own guidance would have written — see [`advise`] for why that
//! had to be a separate verdict rather than a defect that declines to block.

use crate::common::Measure;
use crate::id::{ProjectId, TaskId};
use crate::plan::Plan;
use crate::project::Project;
use crate::task::{Task, TaskKind};

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
    /// Two tasks that could run at once claim the same paths in the same repo.
    ///
    /// `in_project` names the other task's project when it is not this one, and is
    /// `None` when both are siblings. A repository is what tasks compete for, and a
    /// repository outlives any one project on it — so the conflict crosses projects,
    /// while the id alone reads as a task the operator cannot find on their board.
    ScopeOverlaps {
        with: TaskId,
        glob: String,
        in_project: Option<ProjectId>,
    },
    /// A declared write path the project's own playbook says no task of its may take.
    ///
    /// Both globs are carried because they are rarely the same string: `glob` is the line
    /// to narrow, `refused` the line that said no. `why` is the playbook's own sentence,
    /// empty when it gave none.
    ScopeRefused { glob: String, refused: String, why: String },
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
            Self::RepoUnknown { repo, known } if known.is_empty() => {
                format!("Repo {repo:?} is not registered. Add it under [[repos]] in company.toml.")
            }
            Self::RepoUnknown { repo, known } => {
                format!("Repo {repo:?} is not registered. Known: {}.", known.join(", "))
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
            Self::ScopeOverlaps {
                with,
                glob,
                in_project: None,
            } => format!(
                "Write scope {glob:?} overlaps task `{with}`, which could run at the same time. \
                 Narrow one, or make this depend on it."
            ),
            // The same defect, said so it survives the reader not having the other
            // project on screen — an id alone reads as a task missing from their own
            // board. Both repairs still hold across the boundary: a dependency may
            // name any task in the plan, whatever project it belongs to.
            Self::ScopeOverlaps {
                with,
                glob,
                in_project: Some(other),
            } => format!(
                "Write scope {glob:?} overlaps task `{with}` in project `{other}`, which shares \
                 this repo and could run at the same time. Narrow one, or make this depend on it."
            ),
            // With the reason where there is one and without where there is not, the way
            // `RepoUnknown` names the known repos only when it has any.
            Self::ScopeRefused { glob, refused, why } => format!(
                "Write scope {glob:?} reaches {refused:?}, which this project refuses{}. \
                 Which paths instead?",
                if why.is_empty() { String::new() } else { format!(": {why:?}") }
            ),
            Self::BudgetMissing => "What is the budget — tokens, wall time, or both?".into(),
            Self::DesignMissing => "This project requires a design before work of this kind. \
                 Which design is it built on? Depend on a design task (--after <id>), \
                 or create the pair with --expand."
                .into(),
            Self::ProjectHasNoTasks => {
                "This project has no tasks. Break it down before starting it.".into()
            }
            Self::DependencyMissing { on } => format!("This waits on `{on}`, which does not exist."),
        }
    }

    /// Whether this blocks work outright. Everything does, and the flag survives
    /// only because [`Admission::decide`] is written in terms of it.
    ///
    /// It was put here as the seam advisory checks would arrive through, and that
    /// turned out to be the wrong seam: every caller reads a non-empty `Vec<Defect>`
    /// as a refusal without consulting this — `task add` declines to save, the board
    /// counts the rows as defects — so one answering `false` would have blocked the
    /// work anyway, at sites that never asked. Advice went beside the gate instead:
    /// [`Divergence`], reported by [`advise`].
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

    if t.is_dispatched() && t.acceptance.is_empty() {
        out.push(Defect::MeasureMissing);
    } else if t.is_dispatched() && !t.has_executable_acceptance() {
        out.push(Defect::MeasureNotExecutable);
    }

    if t.is_dispatched() && t.kind.requires_write_scope() {
        if t.scope.write.is_empty() {
            out.push(Defect::ScopeMissing);
        }
        // No `else`: an empty list has nothing to walk, so the two are not alternatives.
        for glob in t.scope.write.iter().filter(|g| is_too_broad(g)) {
            out.push(Defect::ScopeTooBroad { glob: glob.clone() });
        }
    }
    if t.is_dispatched() && !t.budget.is_set() {
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

    // Nothing in a parked project ever starts — `Plan::ready_tasks` and the scheduler
    // both skip it — so a task there is not competition for anyone, itself included.
    if parked(plan, &t.project) {
        return out;
    }

    // The competition is for a working tree, and a working tree belongs to a
    // repository rather than to a project. Two projects on one repo is the ordinary
    // shape of a codebase that is being worked on from more than one angle, and
    // scanning only `tasks_of(&t.project)` let each of them admit a task claiming the
    // same files: nothing said no until two worktrees came back with the same lines
    // changed, by which point both had been paid for.
    //
    // Three further things stop concurrency: a dependency in either direction
    // sequences them — across projects too, since a dependency may name any task in
    // the plan — a parent/child relation means one contains the other rather than
    // competing with it, and a different repository means they never touch the same
    // file however alike their globs read.
    for other in plan.tasks() {
        if other.id == t.id
            || other.status.is_closed()
            || parked(plan, &other.project)
            || !share_a_repo(plan, t, other)
            || sequenced(plan, t, other)
            || nested(plan, t, other)
        {
            continue;
        }
        // Named only when it is somewhere else. A sibling conflict is the common one
        // and reads better without a project it was never ambiguous about.
        let elsewhere = (other.project != t.project).then(|| other.project.clone());
        for glob in &t.scope.write {
            if glob.starts_with(crate::WORKER_DIR) {
                continue;
            }
            if other.scope.write.iter().any(|o| globs_overlap(glob, o)) {
                out.push(Defect::ScopeOverlaps {
                    with: other.id.clone(),
                    glob: glob.clone(),
                    in_project: elsewhere.clone(),
                });
            }
        }
    }
    out
}

/// Whether a project is archived, and so dispatches nothing.
///
/// A project the plan does not hold is treated as live: the task being admitted may
/// name a project that is about to be created, and skipping the whole check on that
/// basis would let the first task of a new project claim anything.
fn parked(plan: &Plan, id: &ProjectId) -> bool {
    plan.project(id).is_some_and(|p| p.archived)
}

/// Whether two tasks would be editing the same checkout.
///
/// Same project is the common case and settles it without a lookup — a project owns
/// exactly one repo, so its own tasks always agree. Across projects the repo name each
/// one registers decides it; an unregistered or absent project answers no, which keeps
/// this check from inventing conflicts out of missing data. A project with a blank
/// repo is a defect [`check_project`] already reports, and pairing two of them off
/// each other would report it a second time as something else.
fn share_a_repo(plan: &Plan, a: &Task, b: &Task) -> bool {
    if a.project == b.project {
        return true;
    }
    match (plan.project(&a.project), plan.project(&b.project)) {
        (Some(x), Some(y)) => !x.repo.trim().is_empty() && x.repo == y.repo,
        _ => false,
    }
}

/// Whether either task waits on the other, in either direction, at any remove.
///
/// Transitively, because ordering is transitive: if `c` waits on `b` and `b` waits on
/// `a`, then `c` and `a` cannot run at the same time, and refusing them for a scope
/// overlap states something untrue. A chain of tasks each building on the last is the
/// ordinary shape of a slice, and the direct-only version made the third and every
/// later link impossible to admit.
fn sequenced(plan: &Plan, a: &Task, b: &Task) -> bool {
    // Ordering lifts through containment, or expanded units collide with their sequenced siblings.
    let fa: Vec<&Task> = std::iter::once(a).chain(plan.ancestors(&a.id)).collect();
    let fb: Vec<&Task> = std::iter::once(b).chain(plan.ancestors(&b.id)).collect();
    fa.iter().any(|x| fb.iter().any(|y| waits_on(plan, x, &y.id) || waits_on(plan, y, &x.id)))
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

// ------------------------------------------------------------ refusals ------

/// One path a project will not have written, and why it will not.
///
/// Handed in rather than read, exactly as [`Expected`] and the design gate are: a playbook
/// is a file in somebody else's repository and core opens none. The reason travels with the
/// glob because a refusal is answerable only if whoever reads it knows what it was for, and
/// whoever narrows the scope is often nowhere near the repository the line was written in.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Refusal {
    pub glob: String,
    /// Prose. Empty is legal — a project that names the path and no reason still gets the
    /// refusal, stated without one.
    pub why: String,
}

/// The paths a task declares that its project refuses outright.
///
/// A gate beside [`check_task`] rather than a check inside it, because it is asked of one
/// thing only: a *declaration*. Nothing but re-declaring answers it — a narrower write
/// scope, or the playbook line coming out — so it is asked wherever a scope is written,
/// re-written, or read back for a verdict, and those are all one command group.
///
/// Overlap is [`globs_overlap`], the rule two tasks compete under, coarse the same way: a
/// task claiming `src/**` where `src/generated/**` is refused may write there whatever it
/// intends to. Nor is the work asked whether it is dispatched — a person's task is refused
/// the same paths, because a refusal is about the repository, not about who is typing.
#[must_use]
pub fn check_refusals(t: &Task, refuses: &[Refusal]) -> Vec<Defect> {
    let mut out = Vec::new();
    // The exemption the design gate and the overlap check both make: guidance arrives
    // in a playbook commit, and finished work cannot be re-declared against it.
    if t.status.is_closed() {
        return out;
    }
    for glob in &t.scope.write {
        // Every task is told to write its result here, in a worktree of its own, so it is
        // not a project's to refuse. A refusal of `.wecode/**` still reaches the guidance
        // beside it — the same split that keeps a worker out of the playbook.
        if glob.starts_with(crate::WORKER_DIR) {
            continue;
        }
        for r in refuses.iter().filter(|r| globs_overlap(glob, &r.glob)) {
            let (glob, refused, why) = (glob.clone(), r.glob.clone(), r.why.clone());
            out.push(Defect::ScopeRefused { glob, refused, why });
        }
    }
    out
}

// -------------------------------------------------------------- advice ------

/// What a project's playbook would have put on a task of one kind, reduced to the
/// fields a declaration can be compared against.
///
/// Handed in rather than read, for the reason `needs_design` is: core touches no
/// files, and a playbook is a file in somebody else's repository. The default says
/// nothing, so a project that wrote no guidance for a kind gets no advice rather
/// than advice invented on its behalf.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct Expected {
    /// The commands work of this kind is accepted by.
    pub accept: Vec<String>,
    /// The post work of this kind is done by.
    pub assign_to: Option<String>,
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
    /// The names of the steps `--expand` would emit, in declared order.
    pub steps: Vec<String>,
}

/// One place a task is not what its project's guidance would have written.
///
/// Deliberately not a [`Defect`]. Every one of these is a call the operator is
/// allowed to make — an acceptance command that does not apply here, a post chosen
/// for this one job, a budget cut on purpose — and a gate that refused them would be
/// wrong about as often as it was right. What nobody chooses is making one *without
/// noticing*, and that is what this reports: the playbook's values fill only what a
/// declaration left blank, so each of these was typed over guidance already there.
///
/// `measure` on the two budget variants is the phrase the figure is counted in, not
/// a discriminant — tokens and seconds differ in unit and in nothing else worth
/// branching on.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Divergence {
    /// A command this kind is accepted by that this task will not run.
    AcceptanceDropped { cmd: String },
    /// Assigned to a post other than the one this kind names.
    AssignedElsewhere { on: String, expected: String },
    /// A budget figure under this kind's default.
    BudgetBelow { measure: &'static str, declared: u64, expected: u64 },
    /// A budget figure this kind is written for that the task carries none of — the
    /// acceptance trap from the other end, and the more expensive one. The default
    /// budget is filled only when a task states no figure at all, so `--tokens` on
    /// its own quietly takes the wall limit off, and a run with no wall limit stops
    /// when somebody notices.
    BudgetUnset { measure: &'static str, expected: u64 },
    /// A figure larger than the whole project's own.
    ///
    /// The only one of these that is not read off a playbook. A playbook says what
    /// work of a kind usually costs; the project says what *this* piece of work was
    /// given, and the two are written by different people at different times — so a
    /// kind's default can quietly exceed the project it is applied in, and does. It
    /// is advice for the same reason the rest is: raising the project's budget is a
    /// decision an operator is entitled to make. Making it one task at a time,
    /// without ever saying so, is how a project's stated cost stops meaning anything.
    AboveProjectBudget { measure: &'static str, declared: u64, project: ProjectId, allowed: u64 },
    /// A kind this project breaks down, declared whole.
    NotDecomposed { steps: Vec<String> },
}

impl Divergence {
    /// What to say about it. Fixed text, like [`Defect::question`] — but stated
    /// rather than asked: nothing is waiting on an answer.
    #[must_use]
    pub fn note(&self) -> String {
        match self {
            Self::AcceptanceDropped { cmd } => format!(
                "`{cmd}` is how this project accepts work of this kind, and this task does not \
                 run it. Naming any acceptance replaces all of it."
            ),
            Self::AssignedElsewhere { on, expected } => {
                format!("this kind is done by `{expected}`; this one is on `{on}`.")
            }
            Self::BudgetBelow { measure, declared, expected } => format!(
                "the budget is {declared} {measure}, under the {expected} this kind is written \
                 for — a run that stops short still spends what it used."
            ),
            Self::BudgetUnset { measure, expected } => format!(
                "this kind is written for {expected} {measure} and this task declares none. \
                 Naming either figure takes the whole default off."
            ),
            Self::AboveProjectBudget { measure, declared, project, allowed } => format!(
                "this asks for {declared} {measure}, and project `{project}` was given {allowed} \
                 for all of its work. Raising the project's budget is the honest repair."
            ),
            Self::NotDecomposed { steps } => format!(
                "this kind breaks into {}, and this task has no steps. `--expand` on a fresh \
                 declaration writes them, or add each with `--parent`.",
                steps.join(", ")
            ),
        }
    }
}

/// Where a task departs from what its project wrote down for its kind.
///
/// A second verdict, not a softer first one. It could not be folded into
/// [`check_task`] as non-blocking defects: no caller of that function asks
/// [`Defect::is_blocking`] before acting on the list, so an advisory defect would
/// still have stopped `task add` saving, and counted as a defect on the board.
/// Closed work is exempt, for the reason the design gate exempts it: guidance
/// arrives in a playbook commit, and a task that already finished cannot be
/// re-declared against guidance written after it.
#[must_use]
pub fn advise(t: &Task, plan: &Plan, expected: &Expected) -> Vec<Divergence> {
    let mut out = Vec::new();
    if t.status.is_closed() {
        return out;
    }

    // A task that states no acceptance has it filled from here, so only one that
    // states some can have dropped any. The empty case is `MeasureMissing`, already
    // asked about by the gate; answering it twice in two voices helps nobody.
    if !t.acceptance.is_empty() {
        let runs = |cmd: &String| {
            t.acceptance
                .iter()
                .any(|m| matches!(m, Measure::Command { cmd: c, .. } if c == cmd))
        };
        for cmd in expected.accept.iter().filter(|c| !runs(c)) {
            out.push(Divergence::AcceptanceDropped { cmd: cmd.clone() });
        }
    }

    if let (Some(on), Some(post)) = (&t.assignee, &expected.assign_to)
        && on != post
    {
        out.push(Divergence::AssignedElsewhere {
            on: on.clone(),
            expected: post.clone(),
        });
    }

    // A budget nobody stated is `BudgetMissing`, and the gate is asking about it.
    // Past that the two figures are read separately, because they are overridden
    // together: naming one takes the playbook's default off both.
    //
    // Under, not merely different. Room bought above the default costs nothing when
    // it turns out to be unnecessary; below it the run stops part-done with the spend
    // already made, which is the expensive direction to discover by accident.
    if t.budget.is_set() {
        for (measure, declared, default) in [
            ("tokens", t.budget.tokens, expected.tokens),
            ("seconds of wall time", t.budget.wall_secs, expected.wall_secs),
        ] {
            match (declared, default) {
                (None, Some(expected)) => out.push(Divergence::BudgetUnset { measure, expected }),
                (Some(declared), Some(expected)) if declared < expected => {
                    out.push(Divergence::BudgetBelow { measure, declared, expected });
                }
                _ => {}
            }
        }
    }

    // And what the project said about itself, which no playbook knows: a task is part
    // of a project and its figures come out of the same pot, so one that alone asks
    // for more than the project was given has outgrown the thing it belongs to. Read
    // from the plan rather than from `expected`, because it is not the playbook's
    // opinion. Silent when either figure is absent — an unstated budget is
    // `BudgetMissing`, which the gate is already asking about on both.
    if let Some(p) = plan.project(&t.project) {
        for (measure, declared, ceiling) in [
            ("tokens", t.budget.tokens, p.budget.tokens),
            ("seconds of wall time", t.budget.wall_secs, p.budget.wall_secs),
        ] {
            if let (Some(declared), Some(allowed)) = (declared, ceiling) && declared > allowed {
                let project = t.project.clone();
                out.push(Divergence::AboveProjectBudget { measure, declared, project, allowed });
            }
        }
    }

    // A kind the project decomposes, declared whole. Not said to a task that is
    // already a step of somebody else's expansion: a template whose step takes the
    // kind being expanded would otherwise advise every one of them to expand again.
    if !expected.steps.is_empty() && t.parent.is_none() && plan.subtasks(&t.id).next().is_none() {
        out.push(Divergence::NotDecomposed {
            steps: expected.steps.clone(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::{Budget, Cmp, Measure, Scope, TaskStatus};
    use crate::task::{Doer, TaskKind};

    fn repos() -> Vec<String> {
        vec!["wecode".to_string()]
    }

    fn budget() -> Budget {
        Budget { tokens: Some(1000), wall_secs: Some(60) }
    }

    fn cmd() -> Measure {
        Measure::Command { cmd: "cargo test".into(), expect_status: 0 }
    }

    fn good_project() -> Project {
        Project::new("caching", "add response caching to the export endpoint", "wecode")
            .measured(Measure::Metric { name: "p99_ms".into(), target: 500.0, cmp: Cmp::Lt })
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
        let d = check_project(&good_project(), &Plan::new(), &repos());
        assert!(d.is_empty(), "{d:?}");
        let d = check_task(&good_task(), &seeded(), &[]);
        assert!(d.is_empty(), "{d:?}");
    }

    #[test]
    fn a_manual_task_is_asked_for_none_of_what_a_dispatch_needs() {
        // A scope, a budget and a command over the result all describe a dispatch that
        // never happens. The title does not, and is held to the standard every one is.
        let mut t = good_task().done_by(Doer::Person);
        t.scope = Scope::default();
        t.budget = Budget::default();
        t.acceptance.clear();
        let d = check_task(&t, &seeded(), &[]);
        assert!(d.is_empty(), "{d:?}");
        t.title = "sort out the tokens and improve the setup".into();
        assert!(!check_task(&t, &seeded(), &[]).is_empty());
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
        let d = check_task(&t, &seeded(), &[]);
        let compound = |x: &Defect| matches!(x, Defect::StatementCompound { .. });
        assert!(d.iter().any(compound), "{d:?}");
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
        let d = check_task(&good_task().after("ghost"), &seeded(), &[]);
        assert!(d.contains(&Defect::DependencyMissing { on: "ghost".into() }));
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
    fn an_unordered_unrelated_task_still_collides() {
        // The control on both exemptions above, which were the same test written
        // twice: neither ordering nor nesting may become a blanket pass. With no path
        // between two tasks and no parent relation either, the same two scopes are a
        // genuine conflict.
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
            "two concurrent siblings on the same paths is a real conflict"
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

    // ------------------------------------------------- across projects ------

    /// A second project on the same repo as `good_project`.
    fn neighbour() -> Project {
        Project::new("exports", "cut the export payload in half", "wecode")
            .measured(cmd())
            .budgeted(budget())
    }

    /// `caching` and `exports`, both on `wecode`, with `cache-layer` already in.
    fn two_projects() -> Plan {
        let mut plan = seeded();
        plan.add_project(neighbour()).unwrap();
        plan.add_task(good_task()).unwrap();
        plan
    }

    fn rival(project: &str) -> Task {
        Task::new("export-writer", project, "rewrite the export writer")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(budget())
    }

    fn overlap(defects: &[Defect]) -> Option<&Defect> {
        defects.iter().find(|d| matches!(d, Defect::ScopeOverlaps { .. }))
    }

    #[test]
    fn two_projects_on_one_repo_may_not_claim_the_same_files() {
        // The gap using wecode on itself kept finding: a repository carries as many
        // projects as anyone starts, each was checked only against its own tasks, and
        // so both admitted a task on the same paths. Nothing said no until two
        // worktrees came back having changed the same lines.
        let plan = two_projects();
        let d = check_task(&rival("exports"), &plan, &[]);
        match overlap(&d) {
            Some(Defect::ScopeOverlaps {
                with, in_project, ..
            }) => {
                assert_eq!(with.as_str(), "cache-layer");
                assert_eq!(
                    in_project.as_ref().map(ProjectId::as_str),
                    Some("caching"),
                    "the operator is looking at `exports` and cannot find `cache-layer` on it"
                );
            }
            other => panic!("expected a cross-project overlap, got {other:?}"),
        }
    }

    #[test]
    fn the_question_names_the_other_project_only_when_there_is_one() {
        // The field exists to be said out loud; a defect whose message never differs
        // is a distinction only the type system can see.
        let across = Defect::ScopeOverlaps {
            with: "cache-layer".into(),
            glob: "crates/export/**".into(),
            in_project: Some("caching".into()),
        };
        let q = across.question();
        assert!(q.contains("`cache-layer`"), "{q}");
        assert!(q.contains("`caching`"), "{q}");
        assert!(q.contains("shares this repo"), "{q}");

        let sibling = Defect::ScopeOverlaps {
            with: "cache-layer".into(),
            glob: "crates/export/**".into(),
            in_project: None,
        };
        assert!(!sibling.question().contains("project"), "{q}");
    }

    #[test]
    fn a_sibling_conflict_still_names_no_project() {
        // The control on the field: within one project it was never ambiguous, and
        // the message that has always been printed must not gain a clause.
        let plan = two_projects();
        assert!(
            matches!(
                overlap(&check_task(&rival("caching"), &plan, &[])),
                Some(Defect::ScopeOverlaps {
                    in_project: None,
                    ..
                })
            ),
            "{:?}",
            check_task(&rival("caching"), &plan, &[])
        );
    }

    #[test]
    fn two_projects_on_different_repos_never_collide() {
        // Identical globs against different checkouts are different files. Without
        // this the check would refuse most of a company's board at once.
        let mut plan = seeded();
        let mut far = neighbour();
        far.repo = "wemail".into();
        plan.add_project(far).unwrap();
        plan.add_task(good_task()).unwrap();
        assert!(
            overlap(&check_task(&rival("exports"), &plan, &[])).is_none(),
            "{:?}",
            check_task(&rival("exports"), &plan, &[])
        );
    }

    #[test]
    fn a_dependency_across_projects_sequences_them_too() {
        // The repair the message offers has to actually work: `depends_on` is not
        // confined to one project, so ordering removes a cross-project conflict the
        // same way it removes a sibling one.
        let plan = two_projects();
        let later = rival("exports").after("cache-layer");
        assert!(
            overlap(&check_task(&later, &plan, &[])).is_none(),
            "{:?}",
            check_task(&later, &plan, &[])
        );
    }

    #[test]
    fn a_parked_project_is_not_competition() {
        // Archiving parks a project: the scheduler and `ready_tasks` both skip it, so
        // nothing in it can be running while this task is. Reporting it would say
        // "could run at the same time" about work that cannot start at all.
        let mut plan = two_projects();
        let mut parked = plan.project(&"caching".into()).unwrap().clone();
        parked.archived = true;
        plan.update_project(parked).unwrap();
        assert!(
            overlap(&check_task(&rival("exports"), &plan, &[])).is_none(),
            "{:?}",
            check_task(&rival("exports"), &plan, &[])
        );

        // ...and unarchiving is all it takes to get the conflict back.
        let mut live = plan.project(&"caching".into()).unwrap().clone();
        live.archived = false;
        plan.update_project(live).unwrap();
        assert!(overlap(&check_task(&rival("exports"), &plan, &[])).is_some());
    }

    #[test]
    fn a_task_in_a_parked_project_claims_nothing() {
        // The other direction of the same rule. A task that will never be dispatched
        // is not competing for files, so it neither raises a conflict nor is faulted
        // for one.
        let mut plan = two_projects();
        let mut parked = plan.project(&"exports".into()).unwrap().clone();
        parked.archived = true;
        plan.update_project(parked).unwrap();
        assert!(
            overlap(&check_task(&rival("exports"), &plan, &[])).is_none(),
            "{:?}",
            check_task(&rival("exports"), &plan, &[])
        );
    }

    #[test]
    fn the_worker_area_is_shared_across_projects_as_well() {
        // Every task is told to write its result there whatever project it belongs
        // to, and each runs in its own worktree. The exemption has to survive the
        // widened scan, or the second project's first task is un-admittable.
        let mut plan = seeded();
        plan.add_project(neighbour()).unwrap();
        let mut first = good_task();
        first.scope = Scope::write(&["crates/export/**", ".wecode/run/**"]);
        plan.add_task(first).unwrap();

        let other = Task::new("export-writer", "exports", "a different piece of work")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/import/**", ".wecode/run/**"]))
            .budgeted(budget());
        assert!(
            overlap(&check_task(&other, &plan, &[])).is_none(),
            "{:?}",
            check_task(&other, &plan, &[])
        );
    }

    #[test]
    fn a_closed_task_in_another_project_does_not_block_a_new_scope() {
        let mut plan = two_projects();
        let mut done = plan.task(&"cache-layer".into()).unwrap().clone();
        done.status = TaskStatus::Done;
        plan.update_task(done).unwrap();
        assert!(
            overlap(&check_task(&rival("exports"), &plan, &[])).is_none(),
            "{:?}",
            check_task(&rival("exports"), &plan, &[])
        );
    }

    #[test]
    fn a_project_the_plan_does_not_hold_competes_with_nobody_elses_work() {
        // `project add` checks its own admission before the project is saved, and a
        // task may be probed against a plan that does not carry it yet. Answering
        // "same repo" on missing data would invent conflicts; answering no leaves the
        // sibling check, which needs no lookup, exactly as it was.
        let mut plan = Plan::new();
        plan.add_project(good_project()).unwrap();
        plan.add_task(good_task()).unwrap();

        let mut orphan = rival("exports");
        orphan.project = "nowhere".into();
        assert!(
            overlap(&check_task(&orphan, &plan, &[])).is_none(),
            "{:?}",
            check_task(&orphan, &plan, &[])
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

    // ----------------------------------------------------------- advice ------

    /// What a project would have written for the kind `good_task` is — matched to
    /// `good_task` itself, so a note in these tests is always a real divergence.
    fn written() -> Expected {
        Expected {
            accept: vec!["cargo test".into()], assign_to: Some("impl".into()),
            tokens: Some(1000), wall_secs: Some(60), steps: Vec::new(),
        }
    }

    /// The same, for a project that also decomposes the kind.
    fn decomposed() -> Expected {
        Expected { steps: vec!["design".into(), "build".into()], ..written() }
    }

    fn ran(cmd: &str) -> Measure {
        Measure::Command { cmd: cmd.into(), expect_status: 0 }
    }

    #[test]
    fn a_declaration_that_takes_the_guidance_as_written_draws_nothing() {
        // Three silences at once. A task that matches says nothing; guidance nobody
        // wrote says nothing, the way an empty `known_repos` or an empty design gate
        // does; and an extra check of one's own is more checking, not less — only
        // omissions are reported.
        let t = good_task().assigned_to("impl");
        assert!(advise(&t, &seeded(), &written()).is_empty());
        assert!(advise(&t, &seeded(), &Expected::default()).is_empty());
        let extra = t.clone().accepting(ran("cargo clippy"));
        assert!(advise(&extra, &seeded(), &written()).is_empty(), "{extra:?}");
    }

    #[test]
    fn naming_an_acceptance_replaces_all_of_it_and_that_is_said_out_loud() {
        // The silent one. `task add` fills acceptance only when none was given, so
        // one `--accept-cmd` drops the project's own check without a word.
        let mut t = good_task().assigned_to("impl");
        t.acceptance = vec![ran("cargo test -p export")];
        assert_eq!(
            advise(&t, &seeded(), &written()),
            vec![Divergence::AcceptanceDropped { cmd: "cargo test".into() }]
        );
    }

    #[test]
    fn what_the_gate_is_already_asking_for_is_not_asked_again_in_another_voice() {
        // An absent acceptance is `MeasureMissing` and an absent budget is
        // `BudgetMissing`. Advice on top of either would read as a second problem.
        let mut t = good_task().assigned_to("impl");
        t.acceptance.clear();
        t.budget = Budget::default();
        let defects = check_task(&t, &seeded(), &[]);
        assert!(defects.contains(&Defect::MeasureMissing), "{defects:?}");
        assert!(defects.contains(&Defect::BudgetMissing), "{defects:?}");
        assert!(advise(&t, &seeded(), &written()).is_empty());
    }

    #[test]
    fn a_post_other_than_the_one_the_kind_names_is_noted() {
        let t = good_task().assigned_to("review");
        let elsewhere = Divergence::AssignedElsewhere { on: "review".into(), expected: "impl".into() };
        assert!(advise(&t, &seeded(), &written()).contains(&elsewhere));
        // Unassigned is not a divergence: the playbook is about to fill it.
        assert!(!advise(&good_task(), &seeded(), &written()).contains(&elsewhere));
    }

    #[test]
    fn a_budget_under_the_default_is_noted_and_one_over_it_is_not() {
        let mut lean = good_task().assigned_to("impl");
        lean.budget = Budget { tokens: Some(100), wall_secs: Some(10) };
        let notes = advise(&lean, &seeded(), &written());
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(notes.contains(&Divergence::BudgetBelow {
            measure: "tokens", declared: 100, expected: 1000,
        }));

        // Over, read from the other side: the same task against guidance written for
        // less. Raising the task's own figures would now cross the project's ceiling
        // as well, which is a different note about a different thing.
        let modest = Expected { tokens: Some(10), wall_secs: Some(5), ..written() };
        assert!(advise(&good_task().assigned_to("impl"), &seeded(), &modest).is_empty());
    }

    #[test]
    fn naming_one_figure_takes_the_other_off_and_that_is_said_out_loud() {
        // `--tokens` alone leaves the task with no wall limit at all, because the
        // playbook's budget is filled only when nothing was stated. The gate is
        // satisfied — a budget *is* set — and the run has no ceiling on its clock.
        let mut t = good_task().assigned_to("impl");
        // The project's own ceiling, so the wall limit is the only thing departed from.
        t.budget = Budget { tokens: Some(1000), wall_secs: None };
        assert!(check_task(&t, &seeded(), &[]).is_empty(), "the gate is happy");
        assert_eq!(
            advise(&t, &seeded(), &written()),
            vec![Divergence::BudgetUnset { measure: "seconds of wall time", expected: 60 }]
        );
    }

    #[test]
    fn a_kind_the_project_breaks_down_is_noted_when_it_is_declared_whole() {
        let t = good_task().assigned_to("impl");
        let notes = advise(&t, &seeded(), &decomposed());
        assert_eq!(
            notes,
            vec![Divergence::NotDecomposed { steps: vec!["design".into(), "build".into()] }]
        );
        assert!(notes[0].note().contains("design, build"), "{notes:?}");
    }

    #[test]
    fn nothing_that_is_already_part_of_a_decomposition_is_told_to_expand() {
        // Both ends of it. A task that has steps needs none written, and a step of
        // somebody else's expansion is already inside one — a template step that
        // names no kind takes the kind being expanded, so without the second half
        // every generated step would be advised to expand itself.
        let mut plan = seeded();
        plan.add_task(good_task()).unwrap();
        plan.add_task(design().under("cache-layer")).unwrap();
        let whole = plan.task(&"cache-layer".into()).unwrap().clone();
        let step = Task::new("cache-layer-build", "caching", "build the cache layer")
            .under("cache-layer")
            .accepting(cmd())
            .scoped(Scope::write(&["crates/export/inner/**"]))
            .budgeted(budget())
            .assigned_to("impl");
        for t in [&whole, &step] {
            let notes = advise(t, &plan, &decomposed());
            assert!(!notes.iter().any(|d| matches!(d, Divergence::NotDecomposed { .. })), "{notes:?}");
        }
    }

    #[test]
    fn a_task_worth_more_than_the_whole_project_is_told_so() {
        // The one thing here that no playbook knows, and the reason it is worth
        // saying: a kind's default budget is written once, in a repository, and
        // applied in every project on it — so the figure filled in for a task can
        // exceed what its project was given without anyone typing a number at all.
        // Nothing read the project's own budget at planning time before this; the
        // contradiction turned up as spend on the board, after it had been paid.
        let mut t = good_task().assigned_to("impl");
        t.budget = Budget { tokens: Some(5000), wall_secs: Some(60) };
        assert_eq!(
            advise(&t, &seeded(), &written()),
            vec![Divergence::AboveProjectBudget {
                measure: "tokens", declared: 5000, project: "caching".into(), allowed: 1000,
            }],
            "the wall figure is equal, and equal has not outgrown anything"
        );
        assert!(check_task(&t, &seeded(), &[]).is_empty(), "and nothing is refused for it");

        // A project that states no budget is no ceiling — that absence is
        // `BudgetMissing`, which the gate is asking about on the project itself.
        let mut open_ended = Plan::new();
        let mut p = good_project();
        p.budget = Budget::default();
        open_ended.add_project(p).unwrap();
        assert!(advise(&t, &open_ended, &written()).is_empty());
    }

    #[test]
    fn finished_work_is_not_second_guessed_by_guidance_written_after_it() {
        // The same rule the design gate keeps: guidance arrives in a playbook commit,
        // and a task that has already run cannot be re-declared against it.
        let mut done = good_task().assigned_to("review");
        done.status = TaskStatus::Done;
        assert!(advise(&done, &seeded(), &decomposed()).is_empty());
    }

    #[test]
    fn advice_never_refuses_anything() {
        // The pin on the whole layer: a task can diverge from the guidance on every
        // count and still be admitted, because a divergence is not a defect.
        let mut t = good_task().assigned_to("review");
        t.budget = Budget { tokens: Some(1), wall_secs: Some(1) };
        assert!(!advise(&t, &seeded(), &decomposed()).is_empty());
        assert!(check_task(&t, &seeded(), &[]).is_empty());
    }

    // --------------------------------------------------------- refusals ------

    fn refusing(glob: &str, why: &str) -> Vec<Refusal> {
        vec![Refusal { glob: glob.into(), why: why.into() }]
    }

    #[test]
    fn a_path_the_project_refuses_is_refused_with_the_reason_it_gave() {
        let why = "the schema tool writes it";
        let d = check_refusals(&good_task(), &refusing("crates/export/**", why));
        assert_eq!(d, vec![Defect::ScopeRefused {
            glob: "crates/export/**".into(), refused: "crates/export/**".into(), why: why.into(),
        }]);
        assert!(d[0].question().contains(why), "{d:?}");

        // Coarse in the safe direction, like the overlap check it borrows: a task
        // claiming the parent of a refused path may write inside it. And a refusal with
        // no reason is still a refusal — said without the clause, not with an empty one.
        let d = check_refusals(&good_task(), &refusing("crates/export/generated/**", ""));
        assert_eq!(d.len(), 1, "{d:?}");
        assert!(!d[0].question().contains("refuses:"), "{}", d[0].question());
    }

    #[test]
    fn nothing_is_refused_by_omission_in_the_worker_area_or_after_the_work_is_done() {
        // Silence by omission, the way an empty design gate and an empty `known_repos`
        // are silent. Then the two paths no project refuses: the area every task is told
        // to write its result in, and work that finished before the line existed.
        let no = refusing("crates/export/**", "the schema tool writes it");
        assert!(check_refusals(&good_task(), &[]).is_empty());
        let mut worker = good_task();
        worker.scope = Scope::write(&[".wecode/run/**"]);
        let mut done = good_task();
        done.status = TaskStatus::Done;
        assert!(check_refusals(&worker, &no).is_empty());
        assert!(check_refusals(&done, &no).is_empty());
    }

    #[test]
    fn glob_overlap_helper() {
        assert!(globs_overlap("crates/export/**", "crates/export/cache.rs"));
        assert!(globs_overlap("crates/**", "crates/export/**"));
        assert!(!globs_overlap("crates/export/**", "crates/import/**"));
    }
}
