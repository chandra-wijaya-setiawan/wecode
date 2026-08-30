//! What an acceptance criterion said about the work, and whether it said anything.
//!
//! A criterion that could not run has not failed. It produced no evidence, and no
//! evidence is a third thing beside met and unmet — but a `bool` has room for two, so
//! everything that is not a pass has been read as a failure of the work. A missing
//! toolchain, a probe deferred to a tier nobody asked for, a measure no command can
//! settle: each of them lands today as "did not pass", and "did not pass" is what marks
//! a task `failed` and sends its author looking for a bug that is not there.
//!
//! Recording work a person already did is what makes this ordinary rather than exotic.
//! Work dispatched to an agent is judged in a worktree wecode prepared, where the
//! toolchain is present because wecode put it there. Work that already happened is
//! judged wherever it happened — another machine, another week, a console with no
//! checkout at all — and a criterion that cannot reach it is the normal case, not a
//! broken one. A record that called it failure would be a record saying the person got
//! it wrong.
//!
//! The five ways an answer fails to exist are [`Unrun`], and they differ in one respect
//! that decides the verdict: whether the question was ever put. A live-tier check this
//! invocation did not ask for is unanswered because nobody asked, and holding work to it
//! would mean acceptance that can only pass where the credentials are. Everything else
//! here was asked and came back with nothing, which is a gap in the evidence and has to
//! read as one.
//!
//! [`Standing`] is the fold: what a set of criteria, taken together, establishes.
//! Three-valued, because the honest answer to "did this work pass" is sometimes that
//! nothing has been established either way — and that answer belongs to a person, not to
//! a retry.
//!
//! The [`Broker`] entry point lives here rather than in [`crate::broker`] because it is
//! this concept's door, and because `broker.rs` sits against the file-size ratchet.

use wecode_core::Measure;

use crate::broker::{Action, Broker, Session};

/// How `sh` reports a command it could not find.
///
/// Private on purpose: the number is not the definition, the classification in
/// [`Outcome::from_exit`] is. A second public copy of it is a second place to disagree
/// about what 127 means, and the supervisor's own copy goes when it adopts this.
const NOT_FOUND: i32 = 127;

/// Why a criterion produced no answer.
///
/// | variant | what happened |
/// |---|---|
/// | [`NoCommand`](Self::NoCommand) | the measure is not a command, so there was nothing to run |
/// | [`NotAsked`](Self::NotAsked) | a tier this invocation did not request |
/// | [`NotFound`](Self::NotFound) | the command does not exist where the work is judged |
/// | [`NotStarted`](Self::NotStarted) | the process never began |
/// | [`Refused`](Self::Refused) | authority did not permit the command |
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Unrun {
    /// A [`Measure`] that is not a [`Measure::Command`]. Distinct from
    /// [`Measure::is_executable`], which answers a different question — whether a person
    /// has to form an opinion. A metric and a deliverable need no opinion and still have
    /// no command behind them, so nothing runs and nothing answers.
    NoCommand,
    /// Deferred by the tier the caller asked for, and never started. The one reason here
    /// that is not a gap in the evidence: see [`Self::asked`].
    NotAsked,
    /// The command is not there. A verdict on the environment; never on the work.
    NotFound,
    /// The command exists and never became a process.
    NotStarted,
    /// The Broker refused it. The reason it was refused is on the ledger row the refusal
    /// filed, so it is not carried again here — what this variant is for is the fact
    /// that the criterion is therefore unanswered rather than failed.
    Refused,
}

impl Unrun {
    /// Whether the criterion was actually put to the work.
    ///
    /// The one distinction that changes a [`Standing`]. Unasked is not missing evidence:
    /// nothing was looking for any. Every other reason here means wecode asked and got
    /// nothing back, which is a hole where an answer should be.
    #[must_use]
    pub fn asked(self) -> bool {
        !matches!(self, Self::NotAsked)
    }

    /// The word the ledger and the board use.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoCommand => "no command to run",
            Self::NotAsked => "not asked for",
            Self::NotFound => "command not found",
            Self::NotStarted => "did not start",
            Self::Refused => "not permitted",
        }
    }

    /// Why this measure cannot be run at all, before anything tries.
    #[must_use]
    pub fn of_measure(m: &Measure) -> Option<Self> {
        match m {
            Measure::Command { .. } => None,
            _ => Some(Self::NoCommand),
        }
    }
}

/// What one criterion said.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    /// It ran and the work satisfied it.
    Met,
    /// It ran and the work did not. The only outcome that is evidence against the work.
    Unmet { status: i32 },
    /// It did not run. Evidence for nothing, in either direction.
    Unrun(Unrun),
}

impl Outcome {
    /// Classifies an exit code against the one the criterion asked for.
    ///
    /// `None` is a command that never became a process. `127` is `sh` saying the command
    /// is not there — unless 127 is what the criterion wanted, in which case it is an
    /// answer like any other and a criterion asserting a command is absent may say so.
    #[must_use]
    pub fn from_exit(status: Option<i32>, expected: i32) -> Self {
        match status {
            None => Self::Unrun(Unrun::NotStarted),
            Some(c) if c == expected => Self::Met,
            Some(NOT_FOUND) => Self::Unrun(Unrun::NotFound),
            Some(c) => Self::Unmet { status: c },
        }
    }

    /// Whether this criterion settled anything.
    #[must_use]
    pub fn answered(self) -> bool {
        !matches!(self, Self::Unrun(_))
    }

    #[must_use]
    pub fn met(self) -> bool {
        matches!(self, Self::Met)
    }

    /// Why it did not run, when it did not.
    #[must_use]
    pub fn unrun(self) -> Option<Unrun> {
        match self {
            Self::Unrun(u) => Some(u),
            _ => None,
        }
    }
}

/// Where work stands on the criteria it was held to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Standing {
    /// Every criterion that was asked came back met, and at least one was asked.
    Passed,
    /// Something came back against the work.
    Failed,
    /// Nothing came back against the work, and something that was asked came back with
    /// nothing at all. Not a failure and not a pass: a question for whoever is judging.
    Unanswered,
}

impl Standing {
    /// What a set of criteria establishes together.
    ///
    /// Failure outranks silence: a criterion that answered against the work has said
    /// something, and a second criterion saying nothing does not take it back. Silence
    /// outranks a pass in the other direction, and for the reason the whole module
    /// exists — work is not shown to be good by the subset of checks that happened to be
    /// runnable.
    ///
    /// An empty set is [`Unanswered`](Self::Unanswered), and so is a set of nothing but
    /// unasked tiers. A pass earned by asking nothing is the outcome wecode refuses
    /// everywhere: acceptance commands are the repository's own and were green before
    /// the work started, so passing on none of them is how a run that did nothing gets
    /// marked delivered.
    #[must_use]
    pub fn over(outcomes: &[Outcome]) -> Self {
        if outcomes.iter().any(|o| matches!(o, Outcome::Unmet { .. })) {
            return Self::Failed;
        }
        if outcomes.iter().filter_map(|o| o.unrun()).any(Unrun::asked) {
            return Self::Unanswered;
        }
        if outcomes.iter().any(|o| o.met()) {
            Self::Passed
        } else {
            Self::Unanswered
        }
    }

    /// The word the board prints.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Unanswered => "unanswered",
        }
    }

    /// Whether this standing is something a command settled, or something a person has
    /// to. Unanswered work stops in front of somebody by design.
    #[must_use]
    pub fn settled(self) -> bool {
        !matches!(self, Self::Unanswered)
    }
}

impl Broker {
    /// Whether authority bars this criterion from running, and files the answer.
    ///
    /// `None` when it may run — the caller runs it and classifies the exit with
    /// [`Outcome::from_exit`] — and `Some(Unrun::Refused)` when it may not. The refusal
    /// is a real authority event and reaches the ledger as one, through the same
    /// [`Broker::authorize`] every other action comes through; what this adds is the
    /// reading of it, which is that the criterion is now unanswered and the work has not
    /// failed. A criterion the seat may not run says nothing about the work, and a task
    /// marked `failed` for it would be a task blamed for its own governance.
    pub fn refuses_criterion(&mut self, session: &Session, argv: Vec<String>) -> Option<Unrun> {
        let decision = self.authorize(session, &Action::Run { argv });
        (!decision.is_allowed()).then_some(Unrun::Refused)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::{Charter, Invariant};
    use crate::grant::{Effective, Grant};

    fn session() -> Session {
        Session::new(
            "s1",
            "impl-api",
            "claude-code",
            Effective::of(vec![Grant::default().with_run(&["cargo *"])]),
        )
        .on(Some("record".into()), Some("a-task".into()))
    }

    fn argv(line: &str) -> Vec<String> {
        line.split(' ').map(str::to_string).collect()
    }

    #[test]
    fn a_command_that_exits_as_asked_is_met() {
        assert_eq!(Outcome::from_exit(Some(0), 0), Outcome::Met);
        assert_eq!(Outcome::from_exit(Some(3), 3), Outcome::Met);
    }

    #[test]
    fn a_command_that_exits_otherwise_is_evidence_against_the_work() {
        let o = Outcome::from_exit(Some(1), 0);
        assert_eq!(o, Outcome::Unmet { status: 1 });
        assert!(o.answered());
        assert!(!o.met());
    }

    #[test]
    fn a_command_that_is_not_there_did_not_run() {
        let o = Outcome::from_exit(Some(127), 0);
        assert_eq!(o.unrun(), Some(Unrun::NotFound));
        assert!(!o.answered());
    }

    #[test]
    fn a_criterion_asking_for_127_is_answered_by_127() {
        assert_eq!(Outcome::from_exit(Some(127), 127), Outcome::Met);
    }

    #[test]
    fn a_command_that_never_started_did_not_run() {
        assert_eq!(Outcome::from_exit(None, 0).unrun(), Some(Unrun::NotStarted));
    }

    #[test]
    fn a_measure_with_no_command_behind_it_cannot_run() {
        assert_eq!(
            Unrun::of_measure(&Measure::Judged {
                note: "reads well".into()
            }),
            Some(Unrun::NoCommand)
        );
        assert_eq!(
            Unrun::of_measure(&Measure::Deliverable {
                path: "docs/x.md".into()
            }),
            Some(Unrun::NoCommand)
        );
        assert_eq!(
            Unrun::of_measure(&Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 0,
            }),
            None
        );
    }

    #[test]
    fn only_the_unasked_tier_is_not_a_gap_in_the_evidence() {
        assert!(!Unrun::NotAsked.asked());
        for u in [
            Unrun::NoCommand,
            Unrun::NotFound,
            Unrun::NotStarted,
            Unrun::Refused,
        ] {
            assert!(u.asked(), "{u:?} was put to the work");
        }
    }

    #[test]
    fn work_passes_only_on_criteria_that_answered() {
        assert_eq!(Standing::over(&[Outcome::Met]), Standing::Passed);
        assert_eq!(
            Standing::over(&[Outcome::Met, Outcome::Unrun(Unrun::NotAsked)]),
            Standing::Passed
        );
    }

    #[test]
    fn a_criterion_that_could_not_run_leaves_the_work_unanswered() {
        assert_eq!(
            Standing::over(&[Outcome::Met, Outcome::Unrun(Unrun::NotFound)]),
            Standing::Unanswered
        );
        assert_eq!(
            Standing::over(&[Outcome::Met, Outcome::Unrun(Unrun::Refused)]),
            Standing::Unanswered
        );
    }

    #[test]
    fn a_criterion_that_failed_outranks_one_that_could_not_run() {
        assert_eq!(
            Standing::over(&[
                Outcome::Unmet { status: 1 },
                Outcome::Unrun(Unrun::NotFound)
            ]),
            Standing::Failed
        );
    }

    #[test]
    fn nothing_asked_is_never_a_pass() {
        assert_eq!(Standing::over(&[]), Standing::Unanswered);
        assert_eq!(
            Standing::over(&[Outcome::Unrun(Unrun::NotAsked)]),
            Standing::Unanswered
        );
        assert!(!Standing::Unanswered.settled());
    }

    #[test]
    fn a_criterion_authority_permits_is_left_to_run() {
        let mut b = Broker::default();
        let s = session();
        assert_eq!(
            b.refuses_criterion(&s, argv("cargo test --workspace")),
            None
        );
        assert_eq!(b.ledger().len(), 1, "the permission is still recorded");
    }

    #[test]
    fn a_criterion_the_seat_may_not_run_is_unanswered_rather_than_failed() {
        let mut b = Broker::default();
        let s = session();
        assert_eq!(
            b.refuses_criterion(&s, argv("terraform apply")),
            Some(Unrun::Refused)
        );
        assert_eq!(
            Standing::over(&[Outcome::Unrun(Unrun::Refused)]),
            Standing::Unanswered
        );
        assert_eq!(b.denials().count(), 1, "the refusal is on the ledger");
    }

    #[test]
    fn a_criterion_the_charter_forbids_is_unanswered_too() {
        let mut b = Broker::new(Charter::with(vec![Invariant::NeverRun(vec![
            "cargo publish*".into(),
        ])]));
        let s = session();
        assert_eq!(
            b.refuses_criterion(&s, argv("cargo publish --dry-run")),
            Some(Unrun::Refused)
        );
    }
}
