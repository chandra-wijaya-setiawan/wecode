//! Tasks: the executable unit, and the two ways they relate.
//!
//! Tasks are **not** a tree. They carry two distinct relations, and conflating them
//! is the classic modelling error here:
//!
//! - `parent` — *is part of*. A subtask. Hierarchy; strictly a tree.
//! - `depends_on` — *must come after*. A predecessor. A DAG.
//!
//! A subtask is not blocked by its parent, and a predecessor is not a parent. Both
//! need cycle checks, separately.

use crate::common::{Budget, Measure, Scope, TaskStatus};
use crate::id::{ProjectId, TaskId};

/// What kind of work this is. Affects reporting and routing, never authority.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Default)]
pub enum TaskKind {
    #[default]
    Feature,
    Bug,
    /// Behaviour must not change. Distinct from a chore because that claim is
    /// checkable: the existing suite passes and no test needed editing.
    Refactor,
    Chore,
    /// Time-boxed investigation. Expected to produce an answer, not a change.
    Spike,
    /// Proposes a change and writes no code. Distinct from a spike: a spike answers a
    /// question, a design proposes an answer to it — and unlike every other kind, it
    /// is not finished when it passes. It is finished when someone signs it.
    Design,
    Docs,
}

impl TaskKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Feature => "feature",
            Self::Bug => "bug",
            Self::Refactor => "refactor",
            Self::Chore => "chore",
            Self::Spike => "spike",
            Self::Design => "design",
            Self::Docs => "docs",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "feature" | "feat" => Self::Feature,
            "bug" | "fix" => Self::Bug,
            "refactor" | "refac" => Self::Refactor,
            "chore" => Self::Chore,
            "spike" => Self::Spike,
            "design" => Self::Design,
            "docs" | "doc" => Self::Docs,
            _ => return None,
        })
    }

    /// A spike answers a question; it is not expected to change the codebase, so it
    /// is the one kind that may be admitted without a write scope.
    ///
    /// A design is not exempt: it writes a document, and that document is the whole
    /// deliverable. A design task with no write scope has nothing to show for itself.
    #[must_use]
    pub fn requires_write_scope(self) -> bool {
        !matches!(self, Self::Spike)
    }

    /// Whether passing verification finishes the work, or only makes it reviewable.
    ///
    /// A design is a proposal. Nothing downstream should proceed on the strength of a
    /// document existing — the point of writing it down is that a human can disagree
    /// with it while disagreeing is still cheap. So verification moves a design to
    /// `needs-approval`, and only a recorded signature moves it to `done`.
    #[must_use]
    pub fn needs_a_signature(self) -> bool {
        matches!(self, Self::Design)
    }

    #[must_use]
    pub fn all() -> &'static [TaskKind] {
        &[
            Self::Feature,
            Self::Bug,
            Self::Refactor,
            Self::Chore,
            Self::Spike,
            Self::Design,
            Self::Docs,
        ]
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct Task {
    pub id: TaskId,
    pub project: ProjectId,
    pub title: String,
    pub kind: TaskKind,
    /// Hierarchy: the task this is a part of. Not a scheduling constraint.
    pub parent: Option<TaskId>,
    /// Scheduling: tasks that must finish first. Not a hierarchy.
    pub depends_on: Vec<TaskId>,
    /// How we know it is done.
    pub acceptance: Vec<Measure>,
    pub scope: Scope,
    pub budget: Budget,
    /// The post doing it, once assigned.
    pub assignee: Option<String>,
    pub status: TaskStatus,
}

impl Task {
    pub fn new(
        id: impl Into<TaskId>,
        project: impl Into<ProjectId>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            project: project.into(),
            title: title.into(),
            kind: TaskKind::Feature,
            parent: None,
            depends_on: Vec::new(),
            acceptance: Vec::new(),
            scope: Scope::default(),
            budget: Budget::default(),
            assignee: None,
            status: TaskStatus::Draft,
        }
    }

    #[must_use]
    pub fn of_kind(mut self, kind: TaskKind) -> Self {
        self.kind = kind;
        self
    }

    #[must_use]
    pub fn under(mut self, parent: impl Into<TaskId>) -> Self {
        self.parent = Some(parent.into());
        self
    }

    #[must_use]
    pub fn after(mut self, predecessor: impl Into<TaskId>) -> Self {
        let id = predecessor.into();
        if !self.depends_on.contains(&id) {
            self.depends_on.push(id);
        }
        self
    }

    #[must_use]
    pub fn accepting(mut self, m: Measure) -> Self {
        self.acceptance.push(m);
        self
    }

    #[must_use]
    pub fn scoped(mut self, scope: Scope) -> Self {
        self.scope = scope;
        self
    }

    #[must_use]
    pub fn budgeted(mut self, b: Budget) -> Self {
        self.budget = b;
        self
    }

    #[must_use]
    pub fn assigned_to(mut self, post: impl Into<String>) -> Self {
        self.assignee = Some(post.into());
        self
    }

    #[must_use]
    pub fn has_executable_acceptance(&self) -> bool {
        self.acceptance.iter().any(Measure::is_executable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_parse_with_common_aliases() {
        assert_eq!(TaskKind::parse("bug"), Some(TaskKind::Bug));
        assert_eq!(TaskKind::parse("fix"), Some(TaskKind::Bug));
        assert_eq!(TaskKind::parse("feat"), Some(TaskKind::Feature));
        assert_eq!(TaskKind::parse("nonsense"), None);
    }

    #[test]
    fn every_kind_round_trips_through_its_name() {
        for k in TaskKind::all() {
            assert_eq!(TaskKind::parse(k.as_str()), Some(*k));
        }
    }

    #[test]
    fn a_spike_needs_no_write_scope_but_others_do() {
        assert!(!TaskKind::Spike.requires_write_scope());
        // A refactor changes code, so it needs a scope like any other change.
        assert!(TaskKind::Refactor.requires_write_scope());
        for k in [
            TaskKind::Feature,
            TaskKind::Bug,
            TaskKind::Refactor,
            TaskKind::Chore,
            TaskKind::Docs,
        ] {
            assert!(k.requires_write_scope(), "{k:?} should need a scope");
        }
    }

    #[test]
    fn parent_and_dependency_are_separate_relations() {
        let t = Task::new("cache-tests", "caching", "cover the cache layer")
            .under("cache-layer")
            .after("cache-layer");
        // The same task can be both, but they are stored apart and mean
        // different things.
        assert_eq!(t.parent.as_ref().map(TaskId::as_str), Some("cache-layer"));
        assert_eq!(t.depends_on.len(), 1);
    }

    #[test]
    fn repeating_a_dependency_does_not_duplicate_it() {
        let t = Task::new("t", "p", "x").after("a").after("a").after("b");
        assert_eq!(t.depends_on.len(), 2);
    }

    #[test]
    fn a_new_task_assumes_nothing() {
        let t = Task::new("t", "p", "x");
        assert_eq!(t.kind, TaskKind::Feature);
        assert_eq!(t.status, TaskStatus::Draft);
        assert!(t.parent.is_none());
        assert!(t.depends_on.is_empty());
        assert!(t.assignee.is_none());
        assert!(!t.has_executable_acceptance());
    }
}
