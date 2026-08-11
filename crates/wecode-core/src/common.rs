//! Value types shared by projects and tasks.

/// How we know something is done. Ordered by trustworthiness: a command either
/// exits zero or it does not; a judgement is an opinion.
#[derive(Clone, PartialEq, Debug)]
pub enum Measure {
    Command {
        cmd: String,
        expect_status: i32,
    },
    Metric {
        name: String,
        target: f64,
        cmp: Cmp,
    },
    Deliverable {
        path: String,
    },
    /// Human-judged. Legal on a project's objective, never on a task.
    Judged {
        note: String,
    },
}

impl Measure {
    /// Whether this can be evaluated without asking anyone.
    #[must_use]
    pub fn is_executable(&self) -> bool {
        !matches!(self, Self::Judged { .. })
    }

    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::Command { cmd, expect_status } => format!("`{cmd}` exits {expect_status}"),
            Self::Metric { name, target, cmp } => format!("{name} {} {target}", cmp.symbol()),
            Self::Deliverable { path } => format!("file exists: {path}"),
            Self::Judged { note } => format!("judged: {note}"),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cmp {
    Lt,
    Lte,
    Gt,
    Gte,
    Eq,
}

impl Cmp {
    #[must_use]
    pub fn symbol(self) -> &'static str {
        match self {
            Self::Lt => "<",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::Eq => "==",
        }
    }
}

/// Paths a piece of work may read and write. Write globs are the enforced guardrail.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct Scope {
    pub read: Vec<String>,
    pub write: Vec<String>,
}

impl Scope {
    #[must_use]
    pub fn write(globs: &[&str]) -> Self {
        Self {
            read: Vec::new(),
            write: globs.iter().map(|g| (*g).to_string()).collect(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.read.is_empty() && self.write.is_empty()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct Budget {
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
}

impl Budget {
    #[must_use]
    pub fn is_set(&self) -> bool {
        self.tokens.is_some() || self.wall_secs.is_some()
    }
}

/// A project's life. A project never runs — its tasks do — so it has no
/// `Running` or `Verifying`.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum ProjectStatus {
    #[default]
    Draft,
    Active,
    Done,
    Dropped,
}

impl ProjectStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Active => "active",
            Self::Done => "done",
            Self::Dropped => "dropped",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "draft" => Self::Draft,
            "active" => Self::Active,
            "done" => Self::Done,
            "dropped" => Self::Dropped,
            _ => return None,
        })
    }

    #[must_use]
    pub fn is_closed(self) -> bool {
        matches!(self, Self::Done | Self::Dropped)
    }
}

/// A task's life, shaped so the scheduler can drive it with one query.
///
/// `Waiting` and `Ready` differ only by whether prerequisites are finished, and the
/// scheduler is the single writer that promotes one to the other on each tick. That
/// makes the stored value a cache with exactly one author: a missed scan delays a
/// promotion, it cannot lose one.
///
/// There is deliberately no `Blocked`. Waiting on a task, waiting on a signature and
/// waiting on an answer are three different situations, resolved by three different
/// people.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum TaskStatus {
    /// Has defects; not workable.
    #[default]
    Draft,
    /// Admitted, but some prerequisite is unfinished.
    Waiting,
    /// Admitted and unblocked — the scheduler's queue.
    Ready,
    /// An execution is in flight.
    Running,
    /// The agent finished; acceptance and scope checks are running.
    Verifying,
    /// A capability holder must sign — a merge, a budget increase.
    NeedsApproval,
    /// A human must answer the agent.
    NeedsInput,
    /// Attempted, retries exhausted. A person decides what happens next.
    Failed,
    Done,
    Dropped,
}

impl TaskStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Waiting => "waiting",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::Verifying => "verifying",
            Self::NeedsApproval => "needs-approval",
            Self::NeedsInput => "needs-input",
            Self::Failed => "failed",
            Self::Done => "done",
            Self::Dropped => "dropped",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "draft" => Self::Draft,
            "waiting" => Self::Waiting,
            "ready" => Self::Ready,
            "running" => Self::Running,
            "verifying" => Self::Verifying,
            "needs-approval" => Self::NeedsApproval,
            "needs-input" => Self::NeedsInput,
            "failed" => Self::Failed,
            "done" => Self::Done,
            "dropped" => Self::Dropped,
            _ => return None,
        })
    }

    #[must_use]
    pub fn is_done(self) -> bool {
        matches!(self, Self::Done)
    }

    /// Finished with, either way. Closed tasks are ignored by the scheduler and by
    /// scope-conflict checks.
    #[must_use]
    pub fn is_closed(self) -> bool {
        matches!(self, Self::Done | Self::Dropped)
    }

    /// Whether the scheduler may consider promoting or dispatching this.
    #[must_use]
    pub fn is_schedulable(self) -> bool {
        matches!(self, Self::Waiting | Self::Ready)
    }

    /// Whether a person has to act before anything else can happen. Drives the
    /// board's "needs you" column.
    #[must_use]
    pub fn needs_a_human(self) -> bool {
        matches!(self, Self::NeedsApproval | Self::NeedsInput | Self::Failed)
    }

    /// Every status, in lifecycle order. Exists so an error message can list them
    /// without a second hand-maintained copy drifting out of sync.
    #[must_use]
    pub fn all() -> &'static [Self] {
        &[
            Self::Draft,
            Self::Waiting,
            Self::Ready,
            Self::Running,
            Self::Verifying,
            Self::NeedsApproval,
            Self::NeedsInput,
            Self::Failed,
            Self::Done,
            Self::Dropped,
        ]
    }

    #[must_use]
    pub fn mark(self) -> char {
        match self {
            Self::Draft => '·',
            Self::Waiting => '⋯',
            Self::Ready => '○',
            Self::Running => '>',
            Self::Verifying => '?',
            Self::NeedsApproval => '!',
            Self::NeedsInput => '!',
            Self::Failed => 'x',
            Self::Done => '✓',
            Self::Dropped => '-',
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_judged_measures_need_a_person() {
        assert!(
            !Measure::Judged {
                note: "looks right".into()
            }
            .is_executable()
        );
        assert!(
            Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 0
            }
            .is_executable()
        );
        assert!(
            Measure::Metric {
                name: "p99".into(),
                target: 500.0,
                cmp: Cmp::Lt
            }
            .is_executable()
        );
    }

    #[test]
    fn measures_describe_themselves_for_the_terminal() {
        let m = Measure::Metric {
            name: "p99_ms".into(),
            target: 500.0,
            cmp: Cmp::Lt,
        };
        assert_eq!(m.describe(), "p99_ms < 500");
    }

    #[test]
    fn closed_covers_dropped_as_well_as_done() {
        assert!(TaskStatus::Done.is_done());
        assert!(!TaskStatus::Dropped.is_done());
        assert!(TaskStatus::Dropped.is_closed());
        assert!(!TaskStatus::Running.is_closed());
    }

    #[test]
    fn every_status_round_trips_through_its_name() {
        for s in [
            TaskStatus::Draft,
            TaskStatus::Waiting,
            TaskStatus::Ready,
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
            TaskStatus::NeedsInput,
            TaskStatus::Failed,
            TaskStatus::Done,
            TaskStatus::Dropped,
        ] {
            assert_eq!(TaskStatus::parse(s.as_str()), Some(s), "{s:?}");
        }
        for s in [
            ProjectStatus::Draft,
            ProjectStatus::Active,
            ProjectStatus::Done,
            ProjectStatus::Dropped,
        ] {
            assert_eq!(ProjectStatus::parse(s.as_str()), Some(s), "{s:?}");
        }
    }

    #[test]
    fn only_waiting_and_ready_are_schedulable() {
        assert!(TaskStatus::Waiting.is_schedulable());
        assert!(TaskStatus::Ready.is_schedulable());
        for s in [
            TaskStatus::Draft,
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::Done,
        ] {
            assert!(!s.is_schedulable(), "{s:?} must not be picked up");
        }
    }

    #[test]
    fn the_three_states_that_need_a_person_are_distinguished() {
        // No single "blocked": waiting on a signature, on an answer, and on a
        // decision after failure are different situations.
        for s in [
            TaskStatus::NeedsApproval,
            TaskStatus::NeedsInput,
            TaskStatus::Failed,
        ] {
            assert!(s.needs_a_human(), "{s:?}");
        }
        for s in [TaskStatus::Waiting, TaskStatus::Ready, TaskStatus::Running] {
            assert!(!s.needs_a_human(), "{s:?} resolves without a person");
        }
    }
}
