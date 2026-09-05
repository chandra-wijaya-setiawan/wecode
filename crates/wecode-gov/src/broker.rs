//! The Broker: one chokepoint that authorises every consequential action, and the
//! ledger that records what it decided and under whose authority.
//!
//! One chokepoint, but not one subject, so it is split by what would make each part
//! change:
//!
//! | | |
//! |---|---|
//! | `action` | what a post can ask to do, and whether a breach of it can be undone |
//! | `decision` | the verdict, and every reason there is for a refusal |
//! | `charter` | the limits that outrank every grant, and the merges signed for once |
//! | `session` | who is acting, on what, and what they have spent |
//! | `decide` | the evaluation: invariants, then the signatures, then the grant |
//! | `exception` | one invariant lifted for one task, on one holder's signature |
//! | `ledger` | what was recorded, by whom, and the questions asked of it |
//!
//! What stays here is the [`Broker`] itself and the two entry points a session reaches
//! it through — [`Broker::authorize`] and [`Broker::withhold`] — because both are the
//! same pair of steps in the same order: decide, then file. No path decides without
//! recording, and keeping that pairing in one place is what makes it checkable.

mod action;
mod charter;
mod decide;
mod decision;
mod exception;
mod ledger;
mod session;

#[cfg(test)]
mod fixture;

pub use action::{Action, ControlMode};
pub use charter::{Charter, Invariant};
pub use decision::{Decision, DenyReason};
pub use exception::{Exception, Lifted};
pub use ledger::{Record, Source};
pub use session::{Session, Spend};

use crate::grant::ActionKind;

/// Authorises actions and records every decision.
///
/// Holds the ledger in memory; persistence belongs to the store crate. Keeping it
/// here would make authorisation depend on I/O, and authorisation must be a pure
/// function of its inputs.
#[derive(Clone, Default, Debug)]
pub struct Broker {
    charter: Charter,
    /// Signed exceptions, live for as long as their tasks are.
    ///
    /// Beside the charter and deliberately not in it. A charter is what a unit *is* —
    /// read from `company.toml`, the same for every session — and folding one task's
    /// signature into it would make the invariants a thing that varies by who is
    /// asking. Like the ledger it is held in memory; persisting it belongs to the store
    /// crate, for the reason authorisation cannot depend on I/O.
    exceptions: Vec<Exception>,
    ledger: Vec<Record>,
    seq: u64,
}

impl Broker {
    #[must_use]
    pub fn new(charter: Charter) -> Self {
        Self {
            charter,
            exceptions: Vec::new(),
            ledger: Vec::new(),
            seq: 0,
        }
    }

    /// Decides, records, and returns. There is no path that decides without
    /// recording.
    pub fn authorize(&mut self, session: &Session, action: &Action) -> Decision {
        let decision = self.decide(session, action);
        self.file(session, action.clone(), decision.clone(), Source::Broker);
        decision
    }

    /// A holder who was asked to sign, and said no.
    ///
    /// The other half of [`Self::authorize`] for approvals, and here rather than at the
    /// call site because a refusal has to be *decided* before it can be recorded. A "no"
    /// from a seat that could not have said yes is not a refusal — it is an opinion — so
    /// the same grant question is asked first, and a seat that would have been refused
    /// its signature is recorded as refused, exactly as its "yes" would have been.
    ///
    /// Filed as a denial of `Approve`, which is what it is: the approval did not happen,
    /// and the authority that stopped it is the holder's own. The alternative — an
    /// `Allow` with a note on it — would put a row on the record that every gate asking
    /// "is this signed" reads as a signature.
    ///
    /// What it is not is a status change or a lock. Nothing about the work moved, and a
    /// later signature is a later row: this says who said no and when, and that is the
    /// whole of it.
    pub fn withhold(&mut self, session: &Session, kind: ActionKind) -> Decision {
        let action = Action::Approve { kind };
        let decision = match self.decide(session, &action) {
            Decision::Allow => Decision::Deny {
                reason: DenyReason::SignatureWithheld { kind },
                // Regimented: there is no "afterwards" to sanction in, because the thing
                // being refused is the permission and not the deed.
                mode: ControlMode::Regimented,
                alarm: false,
            },
            // The seat may not sign this. Passed through untouched, so the refusal it
            // gets is word for word the one its signature would have got.
            refused => refused,
        };
        self.file(session, action, decision.clone(), Source::Broker);
        decision
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::fixture::{confined, session};
    use crate::grant::{Effective, Grant};

    #[test]
    fn a_holder_who_says_no_leaves_a_record_of_saying_it() {
        // The point of recording it at all: without this row, "nobody has looked at
        // this yet" and "somebody looked and said no" are the same silence.
        let mut b = Broker::new(Charter::default());
        let s = session(Effective::of(vec![
            Grant::writer(&["src/**"]).with_approve(&[ActionKind::Merge]),
        ]));
        let d = b.withhold(&s, ActionKind::Merge);
        assert!(d.is_withheld(), "got {d:?}");
        assert!(!d.raises_alarm(), "a holder saying no is not an incident");

        let r = &b.ledger()[0];
        // Filed against the approval it refused, under the seat that refused it — so
        // the row is findable by the same task and kind the signature would have been.
        assert_eq!(
            r.action,
            Action::Approve {
                kind: ActionKind::Merge
            }
        );
        assert_eq!(r.post, "impl-api");
        assert_eq!(r.task.as_deref(), Some("cache-layer"));
        assert_eq!(r.source, Source::Broker);
        assert_eq!(b.denials().count(), 1);
    }

    #[test]
    fn a_seat_that_could_not_have_signed_cannot_withhold_either() {
        // An account says who somebody is; the post is what says whether their answer
        // decides anything. A "no" from a seat with no `approve` is not a refusal that
        // holds the work — it is the same nothing its "yes" would have been, and it
        // reaches the ledger saying so rather than as a holder's decision.
        let mut b = Broker::new(Charter::default());
        let s = confined(); // approves nothing
        let d = b.withhold(&s, ActionKind::Merge);
        assert!(!d.is_withheld(), "got {d:?}");
        assert!(matches!(
            d,
            Decision::Deny {
                reason: DenyReason::CapabilityMissing { what: "approve" },
                ..
            }
        ));
        assert_eq!(b.ledger().len(), 1, "the attempt is still on the record");
    }

    #[test]
    fn a_withheld_signature_is_not_a_signature() {
        // The failure that would matter most. Every gate asks the ledger whether an
        // approval of this kind was *allowed*; a refusal recorded as anything else
        // would land the very work somebody said no to.
        let mut b = Broker::new(Charter::default());
        let s = session(Effective::of(vec![
            Grant::writer(&["src/**"]).with_approve(&[ActionKind::Merge]),
        ]));
        b.withhold(&s, ActionKind::Merge);
        assert!(!b.ledger()[0].decision.is_allowed());

        // And it locks nothing: the same holder signing afterwards is a later row, and
        // that one is allowed. A refusal is a record of a moment, not a state.
        let d = b.authorize(
            &s,
            &Action::Approve {
                kind: ActionKind::Merge,
            },
        );
        assert_eq!(d, Decision::Allow);
    }
}
