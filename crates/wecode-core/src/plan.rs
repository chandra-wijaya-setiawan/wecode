//! The plan: every project and task, with the structural rules that keep it sound.
//!
//! Grammar violations are rejected on insert. Soft defects — a missing measure, a
//! vague title — are *not*; those are reported by [`crate::Admission`] so the author
//! can be asked. A plan may hold drafts; it may never hold a cycle.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::common::TaskStatus;
use crate::id::{ProjectId, TaskId};
use crate::project::Project;
use crate::short::{self, Number};
use crate::task::Task;

/// Structural rejections. These make the plan incoherent, so they are errors
/// rather than defects.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum PlanError {
    EmptyId,
    DuplicateProject(ProjectId),
    DuplicateTask(TaskId),
    NoSuchProject(ProjectId),
    NoSuchTask(TaskId),
    /// A subtask whose parent is in a different project.
    ParentInAnotherProject {
        task: TaskId,
        parent: TaskId,
    },
    /// `parent` chain loops.
    ParentCycle(TaskId),
    /// `depends_on` graph loops.
    DependencyCycle(TaskId),
    /// A task cannot wait for itself.
    SelfDependency(TaskId),
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyId => f.write_str("id is empty"),
            Self::DuplicateProject(id) => write!(f, "project `{id}` already exists"),
            Self::DuplicateTask(id) => write!(f, "task `{id}` already exists"),
            Self::NoSuchProject(id) => write!(f, "no project `{id}`"),
            Self::NoSuchTask(id) => write!(f, "no task `{id}`"),
            Self::ParentInAnotherProject { task, parent } => write!(
                f,
                "`{task}` cannot be a subtask of `{parent}`: different projects"
            ),
            Self::ParentCycle(id) => write!(f, "`{id}` would make a subtask loop"),
            Self::DependencyCycle(id) => write!(f, "`{id}` would make a dependency loop"),
            Self::SelfDependency(id) => write!(f, "`{id}` cannot depend on itself"),
        }
    }
}

impl std::error::Error for PlanError {}

/// Why a task is not startable yet.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Blocker {
    /// A predecessor that is not finished, but still on its way — a tick will
    /// release the dependent once the work completes.
    Waiting(TaskId),
    /// A predecessor that will never finish by itself — failed with its retries
    /// exhausted, or dropped. It looks like `Waiting` on the board and is not:
    /// no tick releases the dependent, so the work cannot advance without a
    /// person reopening or re-pointing the predecessor. Carries the status so a
    /// renderer can say which kind of dead end it is.
    Stuck(TaskId, TaskStatus),
    /// A predecessor that does not exist.
    ///
    /// Unreachable through this API — `add_task` and `update_task` both refuse an
    /// unknown prerequisite, and the store has a foreign key. It survives because
    /// `foreign_keys` is per-connection and defaults *off*, so anyone opening
    /// wecode.db with the sqlite3 CLI can delete a task and leave a dangling row.
    /// Reporting that beats silently treating the dependency as satisfied.
    Missing(TaskId),
}

#[derive(Clone, Default, Debug)]
pub struct Plan {
    projects: BTreeMap<ProjectId, Project>,
    tasks: BTreeMap<TaskId, Task>,
}

impl Plan {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty() && self.tasks.is_empty()
    }

    #[must_use]
    pub fn project(&self, id: &ProjectId) -> Option<&Project> {
        self.projects.get(id)
    }

    #[must_use]
    pub fn task(&self, id: &TaskId) -> Option<&Task> {
        self.tasks.get(id)
    }

    /// The project a reference an operator typed names — its id, or its short number.
    ///
    /// The one resolver for `--project` and for every command that takes a project
    /// positionally. Two of these would be two answers to *what does `4` mean*.
    #[must_use]
    pub fn project_ref(&self, typed: &str) -> Option<&Project> {
        short::resolve(
            typed,
            |name| self.project(&ProjectId::new(name)),
            |n| self.project_numbered(n),
        )
    }

    /// The task a reference an operator typed names — its id, or its short number.
    #[must_use]
    pub fn task_ref(&self, typed: &str) -> Option<&Task> {
        short::resolve(
            typed,
            |name| self.task(&TaskId::new(name)),
            |n| self.task_numbered(n),
        )
    }

    /// A scan, not an index. The number of projects and tasks a workspace holds is
    /// bounded by what one operator can oversee, and an index would be a second copy
    /// of the mapping to keep in step with the first.
    #[must_use]
    pub fn project_numbered(&self, n: Number) -> Option<&Project> {
        self.projects.values().find(|p| p.number == Some(n))
    }

    #[must_use]
    pub fn task_numbered(&self, n: Number) -> Option<&Task> {
        self.tasks.values().find(|t| t.number == Some(n))
    }

    /// Projects the cockpit shows — archived ones omitted.
    ///
    /// The *narrow* set keeps the existing name on purpose: every display path was
    /// already calling this, so all of them filter by default and none can forget.
    /// Reaching an archived project takes a deliberate `all_projects`.
    pub fn projects(&self) -> impl Iterator<Item = &Project> {
        self.projects.values().filter(|p| p.is_visible())
    }

    /// Every project, archived included. For anything that must not lose track of a
    /// project merely because it is hidden — resolving an id, listing worktrees.
    pub fn all_projects(&self) -> impl Iterator<Item = &Project> {
        self.projects.values()
    }

    /// Whether any project is hidden, so a view can say so rather than silently
    /// showing less than everything.
    #[must_use]
    pub fn archived_count(&self) -> usize {
        self.projects.values().filter(|p| p.archived).count()
    }

    pub fn tasks(&self) -> impl Iterator<Item = &Task> {
        self.tasks.values()
    }

    /// Tasks belonging to a project, in id order.
    pub fn tasks_of(&self, project: &ProjectId) -> impl Iterator<Item = &Task> {
        self.tasks.values().filter(move |t| t.project == *project)
    }

    /// Direct subtasks.
    pub fn subtasks(&self, id: &TaskId) -> impl Iterator<Item = &Task> {
        self.tasks
            .values()
            .filter(move |t| t.parent.as_ref() == Some(id))
    }

    /// Tasks that wait on this one — the inverse of `depends_on`.
    ///
    /// A scan, for the reason [`Self::project_numbered`] is one. It exists because
    /// three commands need the same answer — what would be left stranded by removing a
    /// task, by dropping it, or by moving it — and three filters written by hand are
    /// three chances for one of them to disagree with the others.
    pub fn dependents(&self, id: &TaskId) -> impl Iterator<Item = &Task> {
        self.tasks
            .values()
            .filter(move |t| t.depends_on.contains(id))
    }

    /// Tasks of a project that have no parent — the top of its hierarchy.
    pub fn roots_of(&self, project: &ProjectId) -> impl Iterator<Item = &Task> {
        self.tasks
            .values()
            .filter(move |t| t.project == *project && t.parent.is_none())
    }

    pub fn add_project(&mut self, p: Project) -> Result<(), PlanError> {
        if p.id.is_empty() {
            return Err(PlanError::EmptyId);
        }
        if self.projects.contains_key(&p.id) {
            return Err(PlanError::DuplicateProject(p.id));
        }
        self.projects.insert(p.id.clone(), p);
        Ok(())
    }

    /// Inserts a task, enforcing both relations separately.
    pub fn add_task(&mut self, t: Task) -> Result<(), PlanError> {
        if t.id.is_empty() {
            return Err(PlanError::EmptyId);
        }
        if self.tasks.contains_key(&t.id) {
            return Err(PlanError::DuplicateTask(t.id));
        }
        if !self.projects.contains_key(&t.project) {
            return Err(PlanError::NoSuchProject(t.project));
        }
        self.check_parent(&t)?;
        self.check_dependencies(&t)?;
        self.tasks.insert(t.id.clone(), t);
        Ok(())
    }

    /// Replaces a task, re-running the same structural checks.
    pub fn update_task(&mut self, t: Task) -> Result<(), PlanError> {
        if !self.tasks.contains_key(&t.id) {
            return Err(PlanError::NoSuchTask(t.id));
        }
        // Check against the plan without the old version, so a task is never
        // compared to itself.
        let previous = self.tasks.remove(&t.id);
        let outcome = self
            .check_parent(&t)
            .and_then(|()| self.check_dependencies(&t));
        match outcome {
            Ok(()) => {
                self.tasks.insert(t.id.clone(), t);
                Ok(())
            }
            Err(e) => {
                if let Some(old) = previous {
                    self.tasks.insert(old.id.clone(), old);
                }
                Err(e)
            }
        }
    }

    /// Re-declares what a task is part of, leaving everything else about it alone.
    ///
    /// `None` lifts it to the top of its project. Every rule [`Self::add_task`]
    /// enforces is enforced again — a parent in another project, a chain that loops
    /// back through the task itself — and a rejected move leaves the plan exactly as
    /// it was, which is [`Self::update_task`]'s guarantee rather than a second
    /// implementation of it.
    ///
    /// Moving a task is not making it wait: the two relations stay independent here as
    /// everywhere else, so joining a group does not acquire the group's ordering.
    pub fn set_parent(&mut self, id: &TaskId, parent: Option<TaskId>) -> Result<Task, PlanError> {
        let mut t = self.the(id)?;
        t.parent = parent;
        self.update_task(t.clone())?;
        Ok(t)
    }

    /// Re-declares what a task must come after, replacing the list whole.
    ///
    /// Wholesale rather than an edge at a time, because an ordering is read as a set:
    /// a task that came after two things and should now come after one has had a
    /// prerequisite *removed*, and an additive API has no spelling for that. Repeats
    /// collapse for the same reason — naming a prerequisite twice is one edge, not two.
    pub fn set_predecessors(&mut self, id: &TaskId, after: Vec<TaskId>) -> Result<Task, PlanError> {
        let mut t = self.the(id)?;
        let mut seen = BTreeSet::new();
        t.depends_on = after
            .into_iter()
            .filter(|d| seen.insert(d.clone()))
            .collect();
        self.update_task(t.clone())?;
        Ok(t)
    }

    /// A copy of a task to amend, or the refusal that names it.
    fn the(&self, id: &TaskId) -> Result<Task, PlanError> {
        self.tasks
            .get(id)
            .cloned()
            .ok_or_else(|| PlanError::NoSuchTask(id.clone()))
    }

    pub fn update_project(&mut self, p: Project) -> Result<(), PlanError> {
        if !self.projects.contains_key(&p.id) {
            return Err(PlanError::NoSuchProject(p.id));
        }
        self.projects.insert(p.id.clone(), p);
        Ok(())
    }

    fn check_parent(&self, t: &Task) -> Result<(), PlanError> {
        let Some(parent_id) = &t.parent else {
            return Ok(());
        };
        if *parent_id == t.id {
            return Err(PlanError::ParentCycle(t.id.clone()));
        }
        let parent = self
            .tasks
            .get(parent_id)
            .ok_or_else(|| PlanError::NoSuchTask(parent_id.clone()))?;

        // A subtask belongs to the same project as its parent, or the hierarchy
        // would straddle two projects and neither would own it.
        if parent.project != t.project {
            return Err(PlanError::ParentInAnotherProject {
                task: t.id.clone(),
                parent: parent_id.clone(),
            });
        }

        let mut seen = BTreeSet::new();
        let mut cursor = Some(parent_id.clone());
        while let Some(id) = cursor {
            if id == t.id {
                return Err(PlanError::ParentCycle(t.id.clone()));
            }
            if !seen.insert(id.clone()) {
                break; // a pre-existing loop; not this task's doing
            }
            cursor = self.tasks.get(&id).and_then(|p| p.parent.clone());
        }
        Ok(())
    }

    fn check_dependencies(&self, t: &Task) -> Result<(), PlanError> {
        for dep in &t.depends_on {
            if *dep == t.id {
                return Err(PlanError::SelfDependency(t.id.clone()));
            }
            if !self.tasks.contains_key(dep) {
                return Err(PlanError::NoSuchTask(dep.clone()));
            }
            // Following the existing graph from the dependency must not lead back.
            if self.reaches(dep, &t.id) {
                return Err(PlanError::DependencyCycle(t.id.clone()));
            }
        }
        Ok(())
    }

    /// Whether `from` depends, transitively, on `target`.
    fn reaches(&self, from: &TaskId, target: &TaskId) -> bool {
        let mut stack = vec![from.clone()];
        let mut seen = BTreeSet::new();
        while let Some(id) = stack.pop() {
            if id == *target {
                return true;
            }
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(t) = self.tasks.get(&id) {
                stack.extend(t.depends_on.iter().cloned());
            }
        }
        false
    }

    /// What stands between a task and being started.
    #[must_use]
    pub fn blockers(&self, id: &TaskId) -> Vec<Blocker> {
        let Some(t) = self.tasks.get(id) else {
            return Vec::new();
        };
        t.depends_on
            .iter()
            .filter_map(|d| match self.tasks.get(d) {
                None => Some(Blocker::Missing(d.clone())),
                Some(dep) if dep.status.is_dead_end() => {
                    Some(Blocker::Stuck(d.clone(), dep.status))
                }
                Some(dep) if !dep.status.is_done() => Some(Blocker::Waiting(d.clone())),
                Some(_) => None,
            })
            .collect()
    }

    /// Whether every predecessor is finished. A task with none is ready at once.
    #[must_use]
    pub fn is_ready(&self, id: &TaskId) -> bool {
        self.blockers(id).is_empty()
    }

    /// Tasks a dispatcher could pick up now: in a live project, schedulable, and
    /// every predecessor done.
    ///
    /// `is_schedulable`, not `!is_closed`. A running task is not closed, and listing
    /// it here is how the same work gets dispatched twice; a draft one has not been
    /// admitted yet.
    ///
    /// Archived projects are skipped. Archiving parks a project rather than merely
    /// hiding it — the scheduler scans live projects only, so this query has to agree
    /// with it or the board would advertise work nothing will ever pick up.
    pub fn ready_tasks(&self) -> impl Iterator<Item = &Task> {
        self.tasks.values().filter(|t| {
            t.status.is_schedulable()
                && self.projects.get(&t.project).is_some_and(|p| !p.archived)
                && self.is_ready(&t.id)
        })
    }

    /// Fraction of a project's tasks that are done, counting leaves only so a
    /// parent is not counted twice.
    #[must_use]
    pub fn progress(&self, project: &ProjectId) -> f32 {
        let leaves: Vec<&Task> = self
            .tasks_of(project)
            .filter(|t| self.subtasks(&t.id).next().is_none())
            .collect();
        if leaves.is_empty() {
            return 0.0;
        }
        let done = leaves.iter().filter(|t| t.status.is_done()).count();
        done as f32 / leaves.len() as f32
    }
}

/// The chain of subtask parents above a task, nearest first.
impl Plan {
    pub fn ancestors(&self, id: &TaskId) -> Vec<&Task> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        let mut cursor = self.tasks.get(id).and_then(|t| t.parent.clone());
        while let Some(pid) = cursor {
            if !seen.insert(pid.clone()) {
                break;
            }
            let Some(p) = self.tasks.get(&pid) else { break };
            out.push(p);
            cursor = p.parent.clone();
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::TaskStatus;
    use crate::project::Project;
    use crate::task::Task;

    fn plan() -> Plan {
        let mut p = Plan::new();
        p.add_project(Project::new("caching", "add response caching", "wecode"))
            .unwrap();
        p
    }

    fn task(id: &str) -> Task {
        Task::new(id, "caching", format!("do {id}"))
    }

    #[test]
    fn a_task_needs_a_project_that_exists() {
        let mut p = Plan::new();
        let err = p.add_task(task("t1")).unwrap_err();
        assert_eq!(err, PlanError::NoSuchProject("caching".into()));
    }

    #[test]
    fn duplicates_are_rejected() {
        let mut p = plan();
        p.add_task(task("t1")).unwrap();
        assert_eq!(
            p.add_task(task("t1")).unwrap_err(),
            PlanError::DuplicateTask("t1".into())
        );
        assert!(matches!(
            p.add_project(Project::new("caching", "x", "r"))
                .unwrap_err(),
            PlanError::DuplicateProject(_)
        ));
    }

    #[test]
    fn a_subtask_must_share_its_parents_project() {
        let mut p = plan();
        p.add_project(Project::new("other", "something else", "wecode"))
            .unwrap();
        p.add_task(task("parent")).unwrap();

        let stray = Task::new("child", "other", "x").under("parent");
        assert!(matches!(
            p.add_task(stray).unwrap_err(),
            PlanError::ParentInAnotherProject { .. }
        ));
    }

    #[test]
    fn a_task_cannot_be_its_own_parent_or_ancestor() {
        let mut p = plan();
        p.add_task(task("a")).unwrap();
        p.add_task(task("b").under("a")).unwrap();

        // Direct.
        let mut a = p.task(&"a".into()).unwrap().clone();
        a.parent = Some("a".into());
        assert!(matches!(
            p.update_task(a).unwrap_err(),
            PlanError::ParentCycle(_)
        ));

        // Transitive: a under its own child.
        let mut a = p.task(&"a".into()).unwrap().clone();
        a.parent = Some("b".into());
        assert!(matches!(
            p.update_task(a).unwrap_err(),
            PlanError::ParentCycle(_)
        ));
    }

    #[test]
    fn a_failed_update_leaves_the_task_as_it_was() {
        let mut p = plan();
        p.add_task(task("a")).unwrap();
        p.add_task(task("b").under("a")).unwrap();

        let mut a = p.task(&"a".into()).unwrap().clone();
        a.parent = Some("b".into());
        assert!(p.update_task(a).is_err());
        assert!(
            p.task(&"a".into()).unwrap().parent.is_none(),
            "the rejected change must not have been applied"
        );
    }

    #[test]
    fn dependencies_must_exist_and_cannot_loop() {
        let mut p = plan();
        p.add_task(task("a")).unwrap();

        assert!(matches!(
            p.add_task(task("b").after("ghost")).unwrap_err(),
            PlanError::NoSuchTask(_)
        ));
        assert!(matches!(
            p.add_task(task("b").after("b")).unwrap_err(),
            PlanError::SelfDependency(_)
        ));

        p.add_task(task("b").after("a")).unwrap();
        let mut a = p.task(&"a".into()).unwrap().clone();
        a.depends_on = vec!["b".into()];
        assert!(matches!(
            p.update_task(a).unwrap_err(),
            PlanError::DependencyCycle(_)
        ));
    }

    #[test]
    fn a_long_dependency_loop_is_caught() {
        let mut p = plan();
        p.add_task(task("a")).unwrap();
        p.add_task(task("b").after("a")).unwrap();
        p.add_task(task("c").after("b")).unwrap();

        let mut a = p.task(&"a".into()).unwrap().clone();
        a.depends_on = vec!["c".into()];
        assert!(matches!(
            p.update_task(a).unwrap_err(),
            PlanError::DependencyCycle(_)
        ));
    }

    #[test]
    fn a_task_joins_a_group_and_leaves_it_again_without_being_recreated() {
        // The plan is reshaped by moving what is in it. Nothing here creates or
        // destroys a task, so everything already recorded against it stays where it is.
        let mut p = plan();
        p.add_task(task("sprint")).unwrap();
        p.add_task(task("item")).unwrap();

        let moved = p.set_parent(&"item".into(), Some("sprint".into())).unwrap();
        assert_eq!(moved.parent, Some("sprint".into()));
        assert_eq!(p.subtasks(&"sprint".into()).count(), 1);
        assert!(
            p.is_ready(&"item".into()),
            "joining a group is not waiting for it"
        );

        let lifted = p.set_parent(&"item".into(), None).unwrap();
        assert!(lifted.parent.is_none());
        assert_eq!(p.roots_of(&"caching".into()).count(), 2);
    }

    #[test]
    fn a_move_that_would_loop_is_refused_and_changes_nothing() {
        let mut p = plan();
        p.add_task(task("sprint")).unwrap();
        p.add_task(task("item").under("sprint")).unwrap();

        assert!(matches!(
            p.set_parent(&"sprint".into(), Some("item".into()))
                .unwrap_err(),
            PlanError::ParentCycle(_)
        ));
        assert!(
            p.task(&"sprint".into()).unwrap().parent.is_none(),
            "the rejected move must not have been applied"
        );
        assert!(matches!(
            p.set_parent(&"ghost".into(), None).unwrap_err(),
            PlanError::NoSuchTask(_)
        ));
    }

    #[test]
    fn a_move_across_projects_is_refused() {
        let mut p = plan();
        p.add_project(Project::new("other", "something else", "wecode"))
            .unwrap();
        p.add_task(task("item")).unwrap();
        p.add_task(Task::new("elsewhere", "other", "x")).unwrap();

        assert!(matches!(
            p.set_parent(&"item".into(), Some("elsewhere".into()))
                .unwrap_err(),
            PlanError::ParentInAnotherProject { .. }
        ));
    }

    #[test]
    fn an_ordering_can_be_replaced_after_the_task_exists() {
        // The gap this closes: `after` could only ever be declared at creation, so a
        // sequence discovered later meant a new task.
        let mut p = plan();
        p.add_task(task("first")).unwrap();
        p.add_task(task("second")).unwrap();
        p.add_task(task("third")).unwrap();

        p.set_predecessors(&"third".into(), vec!["first".into(), "first".into()])
            .unwrap();
        assert_eq!(
            p.task(&"third".into()).unwrap().depends_on,
            vec![TaskId::from("first")],
            "one edge, however many times it was named"
        );
        assert!(!p.is_ready(&"third".into()));

        // Replaced whole, so a prerequisite can be dropped as well as added.
        p.set_predecessors(&"third".into(), vec!["second".into()])
            .unwrap();
        assert_eq!(
            p.task(&"third".into()).unwrap().depends_on,
            vec![TaskId::from("second")]
        );
        p.set_predecessors(&"third".into(), Vec::new()).unwrap();
        assert!(p.is_ready(&"third".into()), "and cleared entirely");
    }

    #[test]
    fn an_ordering_that_would_loop_is_refused() {
        let mut p = plan();
        p.add_task(task("first")).unwrap();
        p.add_task(task("second").after("first")).unwrap();

        assert!(matches!(
            p.set_predecessors(&"first".into(), vec!["second".into()])
                .unwrap_err(),
            PlanError::DependencyCycle(_)
        ));
        assert!(matches!(
            p.set_predecessors(&"first".into(), vec!["first".into()])
                .unwrap_err(),
            PlanError::SelfDependency(_)
        ));
        assert!(
            p.task(&"first".into()).unwrap().depends_on.is_empty(),
            "neither refusal may leave half of itself behind"
        );
    }

    #[test]
    fn dependents_are_the_inverse_of_depends_on() {
        let mut p = plan();
        p.add_task(task("first")).unwrap();
        p.add_task(task("second").after("first")).unwrap();
        p.add_task(task("third").after("first")).unwrap();
        p.add_task(task("part").under("first")).unwrap();

        let waiting: Vec<&str> = p
            .dependents(&"first".into())
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(
            waiting,
            vec!["second", "third"],
            "being part of something is not waiting for it"
        );
        assert_eq!(p.dependents(&"second".into()).count(), 0);
    }

    #[test]
    fn a_parent_does_not_block_its_subtask() {
        // The relations are independent: being part of something is not waiting
        // for it.
        let mut p = plan();
        p.add_task(task("parent")).unwrap();
        p.add_task(task("child").under("parent")).unwrap();
        assert!(p.is_ready(&"child".into()), "hierarchy is not a dependency");
    }

    #[test]
    fn readiness_follows_predecessors_only() {
        let mut p = plan();
        p.add_task(task("first")).unwrap();
        p.add_task(task("second").after("first")).unwrap();

        assert!(p.is_ready(&"first".into()));
        assert!(!p.is_ready(&"second".into()));
        assert_eq!(
            p.blockers(&"second".into()),
            vec![Blocker::Waiting("first".into())]
        );

        let mut first = p.task(&"first".into()).unwrap().clone();
        first.status = TaskStatus::Done;
        p.update_task(first).unwrap();

        assert!(p.is_ready(&"second".into()));
        assert!(p.blockers(&"second".into()).is_empty());
    }

    #[test]
    fn a_dead_end_prerequisite_is_reported_as_stuck_not_waiting() {
        // Both block the dependent; the difference is what happens next. A tick
        // releases a `Waiting` blocker by itself; a `Stuck` one waits for a person,
        // and calling the two by one name is how dead chains sat green forever.
        let mut p = plan();
        p.add_task(task("first")).unwrap();
        p.add_task(task("second").after("first")).unwrap();

        for status in [TaskStatus::Failed, TaskStatus::Dropped] {
            let mut first = p.task(&"first".into()).unwrap().clone();
            first.status = status;
            p.update_task(first).unwrap();
            assert_eq!(
                p.blockers(&"second".into()),
                vec![Blocker::Stuck("first".into(), status)]
            );
            assert!(!p.is_ready(&"second".into()), "stuck still blocks");
        }

        // The moment the dead end is reopened, the blocker is merely waiting again.
        let mut first = p.task(&"first".into()).unwrap().clone();
        first.status = TaskStatus::Waiting;
        p.update_task(first).unwrap();
        assert_eq!(
            p.blockers(&"second".into()),
            vec![Blocker::Waiting("first".into())]
        );
    }

    #[test]
    fn ready_tasks_lists_only_what_a_dispatcher_may_pick_up() {
        let mut p = plan();
        let mut at = |id: &str, status: TaskStatus| {
            let mut t = task(id);
            t.status = status;
            p.add_task(t).unwrap();
        };
        at("waiting", TaskStatus::Waiting);
        at("draft", TaskStatus::Draft);
        at("running", TaskStatus::Running);
        at("done", TaskStatus::Done);
        at("failed", TaskStatus::Failed);

        let ready: Vec<&str> = p.ready_tasks().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ready,
            vec!["waiting"],
            "a draft is not admitted, a running task is already out, \
             and done/failed are not up for grabs"
        );
    }

    #[test]
    fn a_schedulable_task_still_waits_for_its_predecessor() {
        let mut p = plan();
        let mut a = task("a");
        a.status = TaskStatus::Waiting;
        p.add_task(a).unwrap();
        let mut b = task("b").after("a");
        b.status = TaskStatus::Waiting;
        p.add_task(b).unwrap();

        let ready: Vec<&str> = p.ready_tasks().map(|t| t.id.as_str()).collect();
        assert_eq!(ready, vec!["a"], "b's predecessor is not done");
    }

    #[test]
    fn progress_counts_leaves_so_a_parent_is_not_double_counted() {
        let mut p = plan();
        p.add_task(task("parent")).unwrap();
        let mut a = task("a");
        a.parent = Some("parent".into());
        a.status = TaskStatus::Done;
        p.add_task(a).unwrap();
        let mut b = task("b");
        b.parent = Some("parent".into());
        p.add_task(b).unwrap();

        // Two leaves, one done — the parent itself is not counted.
        assert!((p.progress(&"caching".into()) - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn ancestors_walk_upward_nearest_first() {
        let mut p = plan();
        p.add_task(task("top")).unwrap();
        p.add_task(task("mid").under("top")).unwrap();
        p.add_task(task("leaf").under("mid")).unwrap();

        let names: Vec<&str> = p
            .ancestors(&"leaf".into())
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(names, vec!["mid", "top"]);
    }

    #[test]
    fn archiving_hides_a_project_from_the_default_view_only() {
        let mut p = plan();
        p.add_project(Project::new("other", "something else", "wecode"))
            .unwrap();
        let mut hidden = p.project(&"other".into()).unwrap().clone();
        hidden.archived = true;
        p.update_project(hidden).unwrap();

        let shown: Vec<&str> = p.projects().map(|x| x.id.as_str()).collect();
        assert_eq!(shown, vec!["caching"], "archived is omitted");

        let all: Vec<&str> = p.all_projects().map(|x| x.id.as_str()).collect();
        assert_eq!(all, vec!["caching", "other"], "but still present");

        assert_eq!(p.archived_count(), 1);
        // Direct lookup must still work, or an archived project becomes unreachable.
        assert!(p.project(&"other".into()).is_some());
    }

    #[test]
    fn archiving_a_project_parks_its_work() {
        // Archiving is not merely hiding: the scheduler scans live projects only, so
        // an archived project's tasks must stop being offered. `ready` and the
        // scheduler have to answer the same question.
        let mut p = plan();
        let mut t = task("a");
        t.status = TaskStatus::Waiting;
        p.add_task(t).unwrap();
        assert!(
            !p.ready_tasks().next().is_none(),
            "control: something ready"
        );

        let mut parked = p.project(&"caching".into()).unwrap().clone();
        parked.archived = true;
        p.update_project(parked).unwrap();

        assert_eq!(
            p.ready_tasks().count(),
            0,
            "parked work is not dispatchable"
        );

        // ...and unarchiving brings it back, so this is reversible.
        let mut live = p.project(&"caching".into()).unwrap().clone();
        live.archived = false;
        p.update_project(live).unwrap();
        assert_eq!(p.ready_tasks().count(), 1);
    }

    #[test]
    fn a_project_or_task_is_reachable_by_its_number() {
        let mut p = plan();
        let mut proj = p.project(&"caching".into()).unwrap().clone();
        proj.number = Some(Number::new(1));
        p.update_project(proj).unwrap();
        let mut t = task("layer");
        t.number = Some(Number::new(2));
        p.add_task(t).unwrap();

        assert_eq!(p.project_ref("1").map(|x| x.id.as_str()), Some("caching"));
        assert_eq!(p.project_ref("#1").map(|x| x.id.as_str()), Some("caching"));
        assert_eq!(p.task_ref("2").map(|x| x.id.as_str()), Some("layer"));
        assert_eq!(p.task_ref("layer").map(|x| x.id.as_str()), Some("layer"));

        // The sequence spans both levels, so a number is never both. A project
        // reference that names a task's number finds nothing rather than the project
        // that shares the digit — there is no such project.
        assert!(p.project_ref("2").is_none());
        assert!(p.task_ref("1").is_none());
        assert!(p.task_ref("99").is_none());
    }

    #[test]
    fn an_unnumbered_plan_still_resolves_by_name() {
        // Every in-memory plan is this: nothing has minted numbers, so `None` must not
        // be reachable by typing a number at it.
        let mut p = plan();
        p.add_task(task("layer")).unwrap();
        assert_eq!(p.task_ref("layer").map(|x| x.id.as_str()), Some("layer"));
        assert!(p.task_ref("1").is_none());
        assert!(p.project_ref("1").is_none());
    }

    #[test]
    fn tasks_of_and_roots_of_partition_by_project() {
        let mut p = plan();
        p.add_project(Project::new("other", "x", "wecode")).unwrap();
        p.add_task(task("a")).unwrap();
        p.add_task(task("b").under("a")).unwrap();
        p.add_task(Task::new("z", "other", "x")).unwrap();

        assert_eq!(p.tasks_of(&"caching".into()).count(), 2);
        assert_eq!(p.roots_of(&"caching".into()).count(), 1);
        assert_eq!(p.tasks_of(&"other".into()).count(), 1);
    }
}
