//! One run of one task.
//!
//! A *task* is planned work; an **execution** is an attempt at it. The distinction is
//! what lets a task be retried without losing what happened last time, and it is
//! where the A2A protocol's own task lifecycle maps — A2A has no notion of
//! planned-but-unstarted work, so its `Task` is this, not ours.

/// A2A's eight states, so a protocol bridge stays a mapping rather than a redesign.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum ExecutionStatus {
    /// Accepted, not yet started.
    #[default]
    Submitted,
    /// A process is running.
    Working,
    /// Stopped to ask a person something.
    InputRequired,
    /// Stopped needing a credential.
    AuthRequired,
    Completed,
    Failed,
    /// Stopped by us — a timeout, or an operator.
    Canceled,
    /// It finished, and we declined the result. A scope violation is the usual
    /// reason: the work exists but is not acceptable.
    Rejected,
}

impl ExecutionStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::Working => "working",
            Self::InputRequired => "input-required",
            Self::AuthRequired => "auth-required",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::Rejected => "rejected",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "submitted" => Self::Submitted,
            "working" => Self::Working,
            "input-required" => Self::InputRequired,
            "auth-required" => Self::AuthRequired,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "canceled" => Self::Canceled,
            "rejected" => Self::Rejected,
            _ => return None,
        })
    }

    #[must_use]
    pub fn all() -> &'static [Self] {
        &[
            Self::Submitted,
            Self::Working,
            Self::InputRequired,
            Self::AuthRequired,
            Self::Completed,
            Self::Failed,
            Self::Canceled,
            Self::Rejected,
        ]
    }

    /// Whether this run is over, whatever the verdict.
    #[must_use]
    pub fn is_finished(self) -> bool {
        !matches!(self, Self::Submitted | Self::Working)
    }

    /// Whether the work was accepted. `Rejected` is deliberately excluded: the agent
    /// finished, and we declined what it produced.
    #[must_use]
    pub fn succeeded(self) -> bool {
        self == Self::Completed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_state_round_trips() {
        for s in ExecutionStatus::all() {
            assert_eq!(ExecutionStatus::parse(s.as_str()), Some(*s));
        }
        assert_eq!(ExecutionStatus::parse("nonsense"), None);
    }

    #[test]
    fn there_are_exactly_the_eight_a2a_states() {
        // Pinned so a bridge stays a mapping. Adding a ninth is a protocol decision.
        assert_eq!(ExecutionStatus::all().len(), 8);
    }

    #[test]
    fn only_a_completed_run_counts_as_success() {
        assert!(ExecutionStatus::Completed.succeeded());
        // The distinction that matters: it ran, it exited cleanly, and we said no.
        assert!(!ExecutionStatus::Rejected.succeeded());
        assert!(ExecutionStatus::Rejected.is_finished());
        assert!(!ExecutionStatus::Working.is_finished());
        assert!(!ExecutionStatus::Submitted.is_finished());
    }
}
