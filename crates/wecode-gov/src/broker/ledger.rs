//! One line per decision, and the questions asked of the lot of them.

use crate::glob;

use super::{Action, Broker, Decision, Session};

/// Provenance. A harness's own account of what it did is useful for debugging and
/// inadmissible as evidence, so the distinction is recorded at write time.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    /// We decided it.
    Broker,
    /// We observed it: exit code, diff, spend.
    Supervisor,
    /// The agent said so.
    Harness,
}

/// One line of the audit ledger.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Record {
    pub seq: u64,
    pub session: String,
    pub post: String,
    pub occupant: String,
    pub human: Option<String>,
    pub project: Option<String>,
    pub task: Option<String>,
    pub action: Action,
    pub decision: Decision,
    pub source: Source,
}

impl Broker {
    /// One line onto the ledger.
    ///
    /// Every path that records goes through here — deciding, withholding, observing — so
    /// a record cannot be written with a field left off it by the newest caller.
    pub(super) fn file(
        &mut self,
        session: &Session,
        action: Action,
        decision: Decision,
        source: Source,
    ) {
        self.seq += 1;
        self.ledger.push(Record {
            seq: self.seq,
            session: session.id.clone(),
            post: session.post.clone(),
            occupant: session.occupant.clone(),
            human: session.human.clone(),
            project: session.project.clone(),
            task: session.task.clone(),
            action,
            decision,
            source,
        });
    }

    /// Records something we observed rather than decided.
    ///
    /// The decision passed in states what the observation means for *authority*, not
    /// how the work went. A diff outside scope is a denial the supervisor saw. A
    /// command that ran and exited wrong is an [`Decision::Allow`] whose target
    /// carries the exit code — running it was permitted, and failing is a verdict on
    /// the work, which the task's status already holds. Filing failures as denials
    /// would turn the denial channel into a list of red tests.
    pub fn observe(
        &mut self,
        session: &Session,
        action: Action,
        decision: Decision,
        source: Source,
    ) {
        self.file(session, action, decision, source);
    }

    #[must_use]
    pub fn ledger(&self) -> &[Record] {
        &self.ledger
    }

    /// Denied actions, for `wecode audit --denied`.
    ///
    /// A withheld signature is one of them. It is not a breach and nobody overreached,
    /// but an approval was refused and the refusal is the answer to "why did this not
    /// land" — which is the question this list is read to answer. The reason on the row
    /// says which of the two it was.
    pub fn denials(&self) -> impl Iterator<Item = &Record> {
        self.ledger.iter().filter(|r| {
            !r.decision.is_allowed() && !matches!(r.decision, Decision::RequireApproval { .. })
        })
    }

    /// Records that raised an alarm.
    pub fn alarms(&self) -> impl Iterator<Item = &Record> {
        self.ledger.iter().filter(|r| r.decision.raises_alarm())
    }

    /// Everything touching a path, regardless of which harness produced it.
    pub fn touching<'a>(&'a self, pattern: &'a str) -> impl Iterator<Item = &'a Record> {
        self.ledger.iter().filter(move |r| match &r.action {
            Action::Write { path } | Action::Read { path } => glob::matches(pattern, path),
            _ => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::fixture::{broker, confined};
    use crate::broker::{Charter, ControlMode, DenyReason};
    use crate::grant::{Effective, Grant};

    #[test]
    fn every_decision_is_recorded_with_its_authority() {
        let mut b = broker();
        let s = confined();
        b.authorize(
            &s,
            &Action::Write {
                path: "crates/export/a.rs".into(),
            },
        );
        b.authorize(
            &s,
            &Action::Write {
                path: "secrets/x.pem".into(),
            },
        );
        assert_eq!(b.ledger().len(), 2);
        assert_eq!(b.ledger()[0].seq, 1);
        assert_eq!(b.ledger()[1].seq, 2);
        assert_eq!(b.ledger()[0].post, "impl-api");
        assert_eq!(b.ledger()[0].occupant, "claude-code");
        assert_eq!(b.denials().count(), 1);
    }

    #[test]
    fn observed_facts_are_marked_by_source() {
        let mut b = Broker::new(Charter::default());
        let s = confined();
        b.observe(
            &s,
            Action::Write {
                path: "crates/export/a.rs".into(),
            },
            Decision::Allow,
            Source::Supervisor,
        );
        b.observe(
            &s,
            Action::Run {
                argv: vec!["cargo".into()],
            },
            Decision::Allow,
            Source::Harness,
        );
        let sources: Vec<_> = b.ledger().iter().map(|r| r.source).collect();
        assert_eq!(sources, vec![Source::Supervisor, Source::Harness]);
    }

    #[test]
    fn an_observed_violation_is_a_denial_the_supervisor_saw() {
        // A write outside scope found in the diff is not a decision we made — it
        // already happened. It still has to reach the ledger as a denial, or the
        // post-hoc check has nowhere to report.
        let mut b = Broker::new(Charter::default());
        let s = confined();
        b.observe(
            &s,
            Action::Write {
                path: "somewhere/else.rs".into(),
            },
            Decision::Deny {
                reason: DenyReason::OutsideWriteScope {
                    path: "somewhere/else.rs".into(),
                },
                mode: ControlMode::Sanctioned,
                alarm: false,
            },
            Source::Supervisor,
        );
        assert_eq!(b.denials().count(), 1);
        assert_eq!(b.ledger()[0].source, Source::Supervisor);
    }

    #[test]
    fn an_observed_failure_is_not_a_denial() {
        // The counterpart to the violation above. An acceptance command that ran and
        // exited wrong breached no authority — the supervisor ran it itself. It
        // reaches the ledger allowed, with the exit code on the line, so the denial
        // channel stays about authority rather than filling with red tests.
        let mut b = Broker::new(Charter::default());
        let s = confined();
        b.observe(
            &s,
            Action::Run {
                argv: vec!["cargo test — exit 101, wanted 0".into()],
            },
            Decision::Allow,
            Source::Supervisor,
        );
        assert_eq!(b.denials().count(), 0);
        assert_eq!(b.ledger().len(), 1, "the failure is still on the record");
    }

    #[test]
    fn ledger_answers_cross_harness_path_questions() {
        let mut b = Broker::new(Charter::default());
        let a = Session::new(
            "s1",
            "impl",
            "claude-code",
            Effective::of(vec![Grant::root()]),
        );
        let c = Session::new("s2", "test", "codex", Effective::of(vec![Grant::root()]));
        b.authorize(
            &a,
            &Action::Write {
                path: "crates/auth/token.rs".into(),
            },
        );
        b.authorize(
            &c,
            &Action::Write {
                path: "crates/auth/tests.rs".into(),
            },
        );
        b.authorize(
            &c,
            &Action::Write {
                path: "docs/readme.md".into(),
            },
        );

        let touched: Vec<_> = b
            .touching("crates/auth/**")
            .map(|r| r.occupant.as_str())
            .collect();
        assert_eq!(touched, vec!["claude-code", "codex"]);
    }
}
