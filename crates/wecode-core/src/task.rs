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
    /// Aggregating kinds (ADR-0004). They carry no write scope and no
    /// acceptance of their own: an epic or a story is done when its children
    /// are. Epic is SCOPE — one objective, decomposed; story is one
    /// user-visible capability beneath it. A release is a label on work, never
    /// a container of it.
    Epic,
    Story,
}

impl TaskKind {
    /// Whether this kind only groups other work. Admission exempts these from
    /// the scope and acceptance checks, and nothing dispatches them.
    #[must_use]
    pub fn aggregates(self) -> bool {
        matches!(self, Self::Epic | Self::Story)
    }
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
            Self::Epic => "epic",
            Self::Story => "story",
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
            "epic" => Self::Epic,
            "story" | "user-story" => Self::Story,
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
        !matches!(self, Self::Spike) && !self.aggregates()
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

/// Who does the work: a harness, or a person. A task whose doer is a person is what
/// an operator calls a **manual** task.
///
/// Kept apart from [`TaskKind`] on purpose, and for the reason this module opens with.
/// The kind says *what* the work is; this says whose hands are on it. Provisioning a
/// bucket by hand is still a chore and rotating a key is still a chore — fold the two
/// axes into one enum and a manual task loses the ability to say which it was, exactly
/// the conflation `parent` and `depends_on` are kept apart to avoid, one field over.
///
/// The distinction earns its place by what follows from it. An agent's task is
/// dispatched into a worktree under a scope and a budget; a person's is dispatched to
/// nobody. It stops on the operator the moment its prerequisites are done, and nothing
/// advances it but a signature. That is how a plan can hold a step that touches real
/// cloud resources — a console click, a token only the owner can mint — without an
/// agent ever being handed the credentials to do it.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Default)]
pub enum Doer {
    /// A coding agent, run under supervision. Everything wecode dispatches.
    #[default]
    Agent,
    /// A person, working where nothing here can watch. What the work leaves behind is
    /// a fact in the world rather than a diff, so the report of it is a signature.
    Person,
}

impl Doer {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Person => "person",
        }
    }

    /// `manual` and `human` are accepted because they are the words an operator
    /// reaches for: the work is named by what it is *not* dispatched to.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "agent" | "auto" => Self::Agent,
            "person" | "manual" | "human" => Self::Person,
            _ => return None,
        })
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
    /// Who does it. `Agent` unless someone says otherwise; see [`Doer`].
    ///
    /// Not carried by the store yet, so a plan read back out of SQLite reads `Agent`:
    /// the `tasks` table has a column for a task's kind and none for its doer. The
    /// rule lands here and in the tick first, because the tick is what has to honour
    /// it, and the column, the flag that sets it and the tag the board prints are what
    /// carry it the rest of the way.
    pub doer: Doer,
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
            doer: Doer::Agent,
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
    pub fn done_by(mut self, doer: Doer) -> Self {
        self.doer = doer;
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

    /// Whether the work is a person's to do rather than an agent's.
    ///
    /// The scheduler asks this twice, and the two answers are what the flag is for: a
    /// manual task is never dispatched, and it stops on a person as soon as it is
    /// unblocked. Asked of the task and not of its assignee, so the answer cannot be
    /// lost by leaving a post unfilled — nor invented by filling one.
    #[must_use]
    pub fn is_done_by_a_person(&self) -> bool {
        self.doer == Doer::Person
    }

    /// Whether wecode dispatches this at all.
    ///
    /// The negation of [`Task::is_done_by_a_person`], named for what follows from it,
    /// because the admission gate turns on it three times for one reason. A write scope
    /// bounds what a worktree may change, a budget bounds what a run may spend, and an
    /// acceptance command is something a harness executes over the result. All three
    /// describe a dispatch, and a manual task has none: no tree is cut, no agent is
    /// launched, nothing is metered. Demanding them anyway would teach operators to
    /// declare a glob nothing writes and a token count nothing spends in order to get
    /// past the gate, and a gate answered with fiction has stopped measuring anything.
    ///
    /// What is left is not weaker. The title still has to be singular, the dependencies
    /// still have to exist, and the deliverable — a fact in the world rather than a diff
    /// — is reported by a person's signature, which is the one piece of evidence in this
    /// system that was never an agent's word about itself.
    #[must_use]
    pub fn is_dispatched(&self) -> bool {
        !self.is_done_by_a_person()
    }

    /// Whether a recorded signature is the only thing that can finish this.
    ///
    /// A design is signed because passing is not enough: nothing downstream should
    /// proceed on the strength of a document existing. A manual task arrives at the
    /// same gate from the other side — there is no verification to pass, because
    /// nothing ran. The signature is not a review of the work, it *is* the work being
    /// reported, and a person saying so is the only evidence there was ever going to
    /// be. Same state and same gesture either way, so the operator has one thing to
    /// learn and the ledger one shape to record.
    #[must_use]
    pub fn needs_a_signature(&self) -> bool {
        self.kind.needs_a_signature() || self.is_done_by_a_person()
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
    fn a_doer_round_trips_and_answers_to_the_operators_words() {
        for d in [Doer::Agent, Doer::Person] {
            assert_eq!(Doer::parse(d.as_str()), Some(d));
        }
        assert_eq!(Doer::parse("manual"), Some(Doer::Person));
        assert_eq!(
            Doer::parse("human"),
            Some(Doer::Person),
            "the brief's own word"
        );
        assert_eq!(Doer::parse("nobody"), None);
    }

    #[test]
    fn only_a_manual_task_is_a_persons_to_do() {
        let t = Task::new("t", "p", "x").done_by(Doer::Person);
        assert!(t.is_done_by_a_person());
        // A design is written by an agent and only *judged* by a person: the
        // distinction the scheduler turns on is who does the work, not who signs.
        let design = Task::new("t", "p", "x").of_kind(TaskKind::Design);
        assert!(
            !design.is_done_by_a_person(),
            "a design is dispatched to a harness"
        );
    }

    #[test]
    fn who_does_the_work_says_nothing_about_what_the_work_is() {
        // The point of two axes: a manual task is still a chore, or a docs task, or
        // whatever it was — nothing about the kind is spent on saying who holds the
        // keyboard.
        let t = Task::new("rotate", "p", "rotate the signing key")
            .of_kind(TaskKind::Chore)
            .done_by(Doer::Person);
        assert_eq!(t.kind, TaskKind::Chore);
        assert!(t.is_done_by_a_person());
        assert!(!t.is_dispatched(), "a chore is still nobody's to launch");
    }

    #[test]
    fn a_manual_task_advances_only_on_a_signature() {
        // Same gate as a design, reached for the opposite reason: a design is signed
        // because passing is not enough, a manual task because nothing ran at all.
        let manual = Task::new("t", "p", "x").done_by(Doer::Person);
        assert!(manual.needs_a_signature());
        assert!(
            Task::new("t", "p", "x")
                .of_kind(TaskKind::Design)
                .needs_a_signature()
        );
        for k in [TaskKind::Feature, TaskKind::Bug, TaskKind::Spike] {
            let t = Task::new("t", "p", "x").of_kind(k);
            assert!(!t.needs_a_signature(), "{k:?} is finished by passing");
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
        assert_eq!(
            t.doer,
            Doer::Agent,
            "work is an agent's unless said otherwise"
        );
        assert!(t.is_dispatched());
        assert!(!t.needs_a_signature());
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
