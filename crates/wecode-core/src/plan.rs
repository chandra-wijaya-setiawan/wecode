//! The plan: every project and task, with the structural rules that keep it sound.
//!
//! Grammar violations are rejected on insert. Soft defects — a missing measure, a
//! vague title — are *not*; those are reported by [`crate::Admission`] so the author
//! can be asked. A plan may hold drafts; it may never hold a cycle.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::id::{ProjectId, TaskId};
use crate::project::Project;
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
    /// A predecessor that is not finished.
    Waiting(TaskId),
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
