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
use crate::short::Number;

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
    /// Work whose agent is a person. The console step, the token only the owner can
    /// mint, the button only a human may press.
    ///
    /// Every other kind is dispatched to a harness; this one is dispatched to nobody.
    /// It stops on a person the moment its prerequisites are done, and advances only
    /// on a recorded signature. That is the point: the dependency is real work that
    /// the graph should hold, and holding it must not mean handing an agent the
    /// credentials to do it instead.
    Manual,
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
            Self::Manual => "manual",
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
            "manual" | "human" => Self::Manual,
            _ => return None,
        })
    }

    /// A spike answers a question; it is not expected to change the codebase, so it
    /// is the one kind that may be admitted without a write scope.
    ///
    /// A design is not exempt: it writes a document, and that document is the whole
    /// deliverable. A design task with no write scope has nothing to show for itself.
    ///
    /// A manual task is exempt for a different reason again: its deliverable is a fact
    /// in the world — a resource that exists, a token that has been minted — and no
    /// file in this repository records it. Nothing writes, so there is nothing to
    /// fence. Its acceptance still has to be a command, because admission takes one
    /// from every task, and that is the useful discipline here: the probe that checks
    /// the fact is what stops "I did it" from being the only evidence.
    #[must_use]
    pub fn requires_write_scope(self) -> bool {
        !matches!(self, Self::Spike | Self::Manual)
    }

    /// Whether passing verification finishes the work, or only makes it reviewable.
    ///
    /// A design is a proposal. Nothing downstream should proceed on the strength of a
    /// document existing — the point of writing it down is that a human can disagree
    /// with it while disagreeing is still cheap. So verification moves a design to
    /// `needs-approval`, and only a recorded signature moves it to `done`.
    ///
    /// A manual task arrives at the same gate from the other side. There is no
    /// verification to pass, because nothing ran: the signature is not a review of the
    /// work, it *is* the work being reported. Same state, same signing path, so the
    /// operator has one gesture to learn and the ledger one shape to record.
    #[must_use]
    pub fn needs_a_signature(self) -> bool {
        matches!(self, Self::Design | Self::Manual)
    }

    /// Whether the work is a person's to do rather than an agent's.
    ///
    /// The scheduler asks this twice, and the two answers are what the kind is for:
    /// such a task is never dispatched, and it stops on a person as soon as it is
    /// unblocked. Asked as a question about the *kind*, not about the assignee, so
    /// the answer cannot be lost by leaving a post unfilled.
    #[must_use]
    pub fn is_done_by_a_person(self) -> bool {
        matches!(self, Self::Manual)
    }

    /// Every kind a project writes a playbook section for — which is every kind an
    /// agent is dispatched for.
    ///
    /// `Manual` is deliberately absent. A playbook section is guidance for a worker:
    /// the worktree it gets, the commands that judge it, the prose it is told. A
    /// manual task has no worker to guide, so a `[manual]` section would be advice
    /// addressed to nobody, and the starter that must cover every entry here would
    /// have to invent some.
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
    /// The short number this task also answers to — the handle that fits on a phone
    /// keyboard. `None` until something mints one; see [`crate::short`].
    pub number: Option<Number>,
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
    /// Whether the operator has filed this away. Orthogonal to `status`, as on a
    /// project: a `done` task can stay on the board, and a `draft` one can be hidden.
    ///
    /// Weaker than a project's flag, deliberately. Archiving a project *parks* it —
    /// `Plan::ready_tasks`, the scheduler and the overlap check all skip it — whereas
    /// this only hides: an archived task is still promoted, still dispatched, still
    /// competition for the files it writes. Nothing in the domain reads it, which is
    /// why the command that sets it refuses to file away work that could still move on
    /// its own. Filing is for work that is finished with, not for parking.
    pub archived: bool,
}

impl Task {
    pub fn new(
        id: impl Into<TaskId>,
        project: impl Into<ProjectId>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            number: None,
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
            archived: false,
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

    /// Whether the cockpit should show this. A method rather than reading the field, so
    /// the rule has one home if it ever grows past the flag — `Project::is_visible`
    /// exists for the same reason.
    #[must_use]
    pub fn is_visible(&self) -> bool {
        !self.archived
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
        // Named separately because `all()` is the playbook's list, not the enum's:
        // manual has no section to write, but it is still a kind an operator types.
        let manual = TaskKind::Manual;
        assert_eq!(TaskKind::parse(manual.as_str()), Some(manual));
        assert_eq!(TaskKind::parse("human"), Some(manual), "the brief's own word");
    }

    #[test]
    fn a_spike_needs_no_write_scope_but_others_do() {
        assert!(!TaskKind::Spike.requires_write_scope());
        // A manual task's deliverable is a fact in the world; nothing in the tree
        // changes, so there is nothing to fence.
        assert!(!TaskKind::Manual.requires_write_scope());
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
    fn only_a_manual_task_is_a_persons_to_do() {
        assert!(TaskKind::Manual.is_done_by_a_person());
        // A design is written by an agent and only *judged* by a person: the
        // distinction the scheduler turns on is who does the work, not who signs.
        for k in TaskKind::all() {
            assert!(!k.is_done_by_a_person(), "{k:?} is dispatched to a harness");
        }
    }

    #[test]
    fn a_manual_task_advances_only_on_a_signature() {
        // Same gate as a design, reached for the opposite reason: a design is signed
        // because passing is not enough, a manual task because nothing ran at all.
        assert!(TaskKind::Manual.needs_a_signature());
        assert!(TaskKind::Design.needs_a_signature());
        for k in [TaskKind::Feature, TaskKind::Bug, TaskKind::Spike] {
            assert!(!k.needs_a_signature(), "{k:?} is finished by passing");
        }
    }

    #[test]
    fn the_playbook_list_holds_only_kinds_with_a_worker_to_guide() {
        // The starter must carry a section for every entry, and there is no useful
        // guidance to give a task with no agent — so the absence is the rule, not an
        // oversight to be tidied up by adding it.
        assert!(!TaskKind::all().contains(&TaskKind::Manual));
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
        assert!(t.is_visible(), "nothing is filed away to begin with");
    }

    #[test]
    fn filing_a_task_away_says_nothing_about_its_status() {
        // The two must not be inferable from each other in either direction: a done
        // task can stay on the board, and an unfinished one can be hidden — which is
        // why the command, not the model, is what guards against hiding live work.
        let mut t = Task::new("t", "p", "x");
        t.status = TaskStatus::Done;
        assert!(t.is_visible(), "finished is not filed away");

        t.archived = true;
        t.status = TaskStatus::Running;
        assert!(!t.is_visible());
        assert_eq!(t.status, TaskStatus::Running, "filing did not move it");
    }
}
