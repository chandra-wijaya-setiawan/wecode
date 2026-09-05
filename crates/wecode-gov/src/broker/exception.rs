//! One charter invariant, lifted for one task, on one holder's signature.
//!
//! The register and the signing path together, because the three checks that admit an
//! exception read the patterns it will hold and the invariants it comes out of. Every
//! field of an [`Exception`] is private and stays inside this module for the reason the
//! type has no constructor: a signature anyone could write is not a signature.

use crate::glob;
use crate::grant::ActionKind;

use super::{Action, Broker, ControlMode, Decision, DenyReason, Invariant, Session, Source};

/// Which invariant an [`Exception`] lifts.
///
/// Two of the five, and the three omissions are the design rather than a gap. The caps
/// have a signature of their own — `budget-increase` — and raising one is that seat's
/// business in the open, not a hole punched in the charter.
/// [`Invariant::ApprovalToMerge`] is the one no exception may reach: lifting it would
/// land an unsigned merge on a protected branch *on a signature*, which is the very
/// signature it exists to demand, laundered through the thing meant to be exceptional.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lifted {
    /// [`Invariant::NeverTouch`], matched as paths.
    Touch,
    /// [`Invariant::NeverRun`], matched across a whole command line.
    Run,
}

impl Lifted {
    /// Whether `pattern` reaches `target`, in the matching this kind is written in.
    fn reaches(self, pattern: &str, target: &str) -> bool {
        match self {
            Self::Touch => glob::matches(pattern, target),
            Self::Run => glob::wildcard(pattern, target),
        }
    }

    /// What `inv` forbids, when `inv` is the kind this lifts.
    fn forbidden(self, inv: &Invariant) -> Option<&[String]> {
        match (self, inv) {
            (Self::Touch, Invariant::NeverTouch(v)) | (Self::Run, Invariant::NeverRun(v)) => {
                Some(v.as_slice())
            }
            _ => None,
        }
    }
}

/// One charter invariant, lifted for one task, on one holder's signature.
///
/// The narrow answer to work that has to reach a real cloud: the alternative to a
/// charter an agent may breach is a charter that forbids the work, and the alternative
/// to both is a carve-out somebody signed for, bounded to the task that needed it.
///
/// Private fields and no constructor. The only way one exists is
/// [`Broker::sign_exception`] having verified a signature for it — a struct literal
/// anyone could write would be a signature anyone could write.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Exception {
    lifted: Lifted,
    patterns: Vec<String>,
    task: String,
    signed_by: String,
}

impl Exception {
    /// The signature an exception takes.
    ///
    /// `measure-amendment` is the nearest seat that exists and it is the right shape:
    /// what an exception changes is what this task is held to. It wants a kind of its
    /// own, and that name would have to reach the `approve` list of every deployed
    /// `company.toml` before any of them could sign one — so it is not this change's to
    /// invent. When it lands, this constant is the only line that moves, because
    /// nothing below keys off which kind it is.
    pub const SIGNATURE: ActionKind = ActionKind::MeasureAmendment;

    #[must_use]
    pub fn lifted(&self) -> Lifted {
        self.lifted
    }

    /// Exactly what is carved out, and never wider than the invariant it came out of.
    #[must_use]
    pub fn patterns(&self) -> &[String] {
        &self.patterns
    }

    /// The task it belongs to, and expires with.
    #[must_use]
    pub fn task(&self) -> &str {
        &self.task
    }

    /// The post whose signature it rests on. Who was in that seat is on the ledger
    /// row the signature filed, alongside the human in it.
    #[must_use]
    pub fn signed_by(&self) -> &str {
        &self.signed_by
    }

    fn covers(&self, task: &str, lifted: Lifted, target: &str) -> bool {
        self.task == task
            && self.lifted == lifted
            && self.patterns.iter().any(|p| lifted.reaches(p, target))
    }
}

impl Broker {
    /// A holder signing one task's exception to one charter invariant.
    ///
    /// The third thing a seat can do about an invariant, after obeying it and breaching
    /// it. Built like [`Self::withhold`] — the same grant question asked of the same
    /// seat, filed as the approval it is — because an exception is a signature, and a
    /// signature nobody was entitled to give has to be refused before it is recorded.
    ///
    /// Three things bound it, and each is a refusal rather than a note:
    ///
    /// * A seat that may sign, asked through [`Self::decide`] — so no post excepts
    ///   itself, and the reason a refused one gets is the reason its signature
    ///   would have got.
    /// * A task, taken from the signing session rather than from the request. This is
    ///   the expiry: an exception excuses that task's sessions and no others, so it
    ///   cannot outlive work nobody is doing, and there is no exception without a task
    ///   to end.
    /// * Patterns the charter actually forbids, and no wider than the invariant naming
    ///   them — so an exception only ever carves out of an invariant, never reaches
    ///   past one, and never lands lifting nothing.
    ///
    /// What it is not is a grant. The task still has to hold the write or the run: the
    /// charter and the grant are two locks, and this opens one of them.
    ///
    /// The ledger row is the signature — a seat, a human, a task, a kind — and the
    /// register is what was excepted, because an [`Action::Approve`] has room for a
    /// kind and not for the patterns. Read together they answer "who let this happen";
    /// the row alone answers "did anybody".
    pub fn sign_exception(
        &mut self,
        signer: &Session,
        lifted: Lifted,
        patterns: &[&str],
    ) -> Decision {
        let decision = match self.admits(signer, lifted, patterns) {
            Ok(task) => {
                self.exceptions.push(Exception {
                    lifted,
                    patterns: patterns.iter().map(|p| (*p).to_string()).collect(),
                    task,
                    signed_by: signer.post.clone(),
                });
                Decision::Allow
            }
            Err(refusal) => refusal,
        };
        self.file(
            signer,
            Action::Approve {
                kind: Exception::SIGNATURE,
            },
            decision.clone(),
            Source::Broker,
        );
        decision
    }

    /// The three checks, and the task an admitted exception belongs to.
    fn admits(
        &self,
        signer: &Session,
        lifted: Lifted,
        patterns: &[&str],
    ) -> Result<String, Decision> {
        // Regimented, and not because of what is being excepted: what is refused here is
        // the permission rather than the deed, and there is no afterwards to sanction in.
        let refused = |reason| Decision::Deny {
            reason,
            mode: ControlMode::Regimented,
            alarm: false,
        };

        let signature = self.decide(
            signer,
            &Action::Approve {
                kind: Exception::SIGNATURE,
            },
        );
        if !signature.is_allowed() {
            return Err(signature);
        }
        let Some(task) = signer.task.clone() else {
            return Err(refused(DenyReason::ExceptionUnbounded));
        };
        // Nothing asked for is nothing lifted, and it would sit in the register as a
        // signature excusing no action anybody could take.
        if patterns.is_empty() {
            return Err(refused(DenyReason::ExceptionLiftsNothing {
                pattern: String::new(),
            }));
        }
        for p in patterns {
            if !self.charter_forbids(lifted, p) {
                return Err(refused(DenyReason::ExceptionLiftsNothing {
                    pattern: (*p).to_string(),
                }));
            }
        }
        Ok(task)
    }

    /// Whether some invariant of this kind forbids everything `pattern` names.
    ///
    /// [`glob::covers`] and [`glob::wildcard`] are both conservative — they answer
    /// `false` for pairs that may genuinely nest — and that direction is the safe one
    /// here too. The exception is refused, and whoever signs the next one names the
    /// paths plainly, which is what an exception should read like anyway.
    fn charter_forbids(&self, lifted: Lifted, pattern: &str) -> bool {
        self.charter
            .invariants
            .iter()
            .filter_map(|inv| lifted.forbidden(inv))
            .flatten()
            .any(|f| match lifted {
                Lifted::Touch => glob::covers(f, pattern),
                Lifted::Run => f == pattern || glob::wildcard(f, pattern),
            })
    }

    /// Whether a signed exception excuses this action for the task this session is on.
    ///
    /// A session naming no task is never excused, which is the other half of the
    /// expiry: there is nothing for an exception to be keyed to.
    pub(super) fn excused(&self, session: &Session, lifted: Lifted, target: &str) -> bool {
        let Some(task) = session.task.as_deref() else {
            return false;
        };
        self.exceptions
            .iter()
            .any(|e| e.covers(task, lifted, target))
    }

    /// Drops every exception belonging to `task`, and answers how many.
    ///
    /// The expiry an exception is named for, made an operation somebody can call when a
    /// task closes. It is not what makes one single-task — an exception is already inert
    /// in every other task's sessions — it is what stops a finished task's signature
    /// covering a later one that reuses its id, and what lets the register read empty
    /// when the work is done. Expiring a task twice is not an error; it drops nothing.
    pub fn expire(&mut self, task: &str) -> usize {
        let before = self.exceptions.len();
        self.exceptions.retain(|e| e.task != task);
        before - self.exceptions.len()
    }

    /// The live exceptions: what was signed, for which task, by whom.
    #[must_use]
    pub fn exceptions(&self) -> &[Exception] {
        &self.exceptions
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::Charter;
    use crate::broker::fixture::confined;
    use crate::grant::{Effective, Grant};

    /// A charter that forbids exactly what a cloud task needs, which is the situation
    /// an exception exists for: the invariants are right, and the work is real.
    fn cloud() -> Broker {
        Broker::new(Charter::with(vec![
            Invariant::NeverTouch(vec!["infra/**".into(), "**/*.pem".into()]),
            Invariant::NeverRun(vec!["terraform apply*".into(), "aws * rm *".into()]),
        ]))
    }

    /// The seat that signs. A holder, and not the one doing the work.
    fn chief(task: Option<&str>) -> Session {
        let root = Effective::of(vec![Grant::root()]);
        Session::new("s-chief", "chief", "operator", root)
            .on(Some("infra".into()), task.map(String::from))
            .with_human(Some("ada".into()))
    }

    /// The seat that works: it may write and run inside `infra/`, and the two things it
    /// actually needs are the two the charter forbids.
    fn deployer(task: &str) -> Session {
        let g = Grant::writer(&["infra/**"]).with_run(&["terraform *", "aws *"]);
        Session::new("s-dep", "impl-infra", "claude-code", Effective::of(vec![g]))
            .on(Some("infra".into()), Some(task.into()))
    }

    /// The path and the command line the charter forbids and a signature carves out.
    const DB: &str = "infra/prod/db.tf";
    const CARVE: &str = "terraform apply infra/staging*";
    const APPLY: &str = "terraform apply infra/staging";

    fn signs(b: &mut Broker, task: &str, lifted: Lifted, patterns: &[&str]) -> Decision {
        b.sign_exception(&chief(Some(task)), lifted, patterns)
    }

    fn write(path: &str) -> Action {
        Action::Write { path: path.into() }
    }

    fn runs(line: &str) -> Action {
        Action::Run {
            argv: line.split(' ').map(String::from).collect(),
        }
    }

    /// Whether `d` is a denial for exactly `reason`, which is what these care about.
    fn refused(d: &Decision, reason: DenyReason) -> bool {
        matches!(d, Decision::Deny { reason: r, .. } if *r == reason)
    }

    #[test]
    fn a_signed_exception_lets_one_task_do_what_the_charter_forbids() {
        let mut b = cloud();
        let d = signs(&mut b, "provision", Lifted::Touch, &[DB]);
        assert_eq!(d, Decision::Allow);

        let e = &b.exceptions()[0];
        assert_eq!(e.lifted(), Lifted::Touch);
        assert_eq!(e.patterns(), [DB].as_slice());
        assert_eq!(e.task(), "provision");
        assert_eq!(e.signed_by(), "chief");

        let s = deployer("provision");
        assert_eq!(b.authorize(&s, &write(DB)), Decision::Allow);
    }

    #[test]
    fn a_run_exception_carves_one_command_out_of_never_run() {
        // The case the whole feature is for: a task that has to really call the cloud,
        // under a charter that forbids the verb to everyone.
        let mut b = cloud();
        let d = signs(&mut b, "provision", Lifted::Run, &[CARVE]);
        assert_eq!(d, Decision::Allow);

        let s = deployer("provision");
        assert_eq!(b.authorize(&s, &runs(APPLY)), Decision::Allow);

        // Everything else the invariant names is still an alarm, signature or no. What
        // was excepted is what was written down, not the invariant it came out of.
        let d = b.authorize(&s, &runs("terraform apply infra/prod"));
        assert!(d.raises_alarm(), "got {d:?}");
    }

    #[test]
    fn an_exception_does_not_reach_the_task_next_door() {
        // The bound that makes signing one defensible at all. Same project, same seat,
        // same path — and only the task somebody signed for.
        let mut b = cloud();
        signs(&mut b, "provision", Lifted::Touch, &[DB]);
        let d = b.authorize(&deployer("tidy-readme"), &write(DB));
        assert!(d.raises_alarm(), "got {d:?}");
    }

    #[test]
    fn an_exception_expires_with_its_task() {
        let mut b = cloud();
        signs(&mut b, "provision", Lifted::Touch, &[DB]);
        signs(&mut b, "rotate-keys", Lifted::Run, &["aws s3 rm *"]);

        assert_eq!(b.expire("provision"), 1);
        assert_eq!(b.exceptions().len(), 1, "the other task's signature stands");
        assert_eq!(b.expire("provision"), 0, "expiring twice drops none");

        let d = b.authorize(&deployer("provision"), &write(DB));
        assert!(d.raises_alarm(), "got {d:?}");
    }

    #[test]
    fn an_exception_is_not_a_grant() {
        // Two locks, and this opens one. The charter no longer names this path for this
        // task, and the seat still may not write there — so what comes back is the
        // ordinary scope refusal, sanctioned and unalarming, because no invariant was
        // breached by the attempt.
        let mut b = cloud();
        signs(&mut b, "provision", Lifted::Touch, &[DB]);
        let staging = Effective::of(vec![Grant::writer(&["infra/staging/**"])]);
        let s = Session::new("s-dep", "impl-infra", "claude-code", staging)
            .on(Some("infra".into()), Some("provision".into()));

        let d = b.authorize(&s, &write(DB));
        let scope = DenyReason::OutsideWriteScope { path: DB.into() };
        assert!(refused(&d, scope), "got {d:?}");
        assert!(!d.raises_alarm());
    }

    #[test]
    fn a_seat_that_may_not_sign_cannot_except_itself() {
        // The failure that would matter most: an exception a post could grant itself is
        // a charter each agent edits on its way past.
        let mut b = cloud();
        let d = b.sign_exception(&confined(), Lifted::Run, &["terraform apply*"]);
        let missing = DenyReason::CapabilityMissing { what: "approve" };
        assert!(refused(&d, missing), "got {d:?}");
        assert!(b.exceptions().is_empty());
        assert_eq!(b.ledger().len(), 1, "the attempt is still on the record");
        assert_eq!(b.denials().count(), 1);
    }

    #[test]
    fn an_exception_with_no_task_has_nothing_to_expire_with() {
        let mut b = cloud();
        let d = b.sign_exception(&chief(None), Lifted::Touch, &[DB]);
        assert!(refused(&d, DenyReason::ExceptionUnbounded), "got {d:?}");
        assert!(b.exceptions().is_empty());
    }

    #[test]
    fn an_exception_cannot_reach_past_the_invariant_it_lifts() {
        let mut b = cloud();
        let signer = chief(Some("provision"));
        let lifts_nothing = |d: &Decision, p: &str| {
            let reason = DenyReason::ExceptionLiftsNothing { pattern: p.into() };
            assert!(refused(d, reason), "got {d:?} for {p:?}");
        };

        // Wider than any one invariant: `**` would carve out `**/*.pem` along with it.
        let d = b.sign_exception(&signer, Lifted::Touch, &["**"]);
        lifts_nothing(&d, "**");
        // Forbidden by nothing, so it unblocks nothing — refused rather than left in the
        // register for whoever signed it to rely on.
        let d = b.sign_exception(&signer, Lifted::Touch, &["docs/**"]);
        lifts_nothing(&d, "docs/**");
        // Nor by halves: one pattern past the charter refuses the whole request, and the
        // reason names which one it was.
        let asked = &["terraform apply -auto-approve*", "kubectl delete*"];
        let d = b.sign_exception(&signer, Lifted::Run, asked);
        lifts_nothing(&d, "kubectl delete*");
        // And an exception to nothing at all is nothing at all.
        let d = b.sign_exception(&signer, Lifted::Run, &[]);
        lifts_nothing(&d, "");

        assert!(b.exceptions().is_empty());
        assert_eq!(b.denials().count(), 4, "every refusal is on the record");
    }

    #[test]
    fn excepted_work_is_recorded_as_an_approval_rather_than_a_breach() {
        // What the ledger has to say afterwards, which is the point of doing it this way
        // rather than widening the charter. Somebody signed, the work went through, and
        // `audit --denied` and `audit --alarms` are both empty — because this was not a
        // breach nobody caught, it was an exception somebody approved.
        let mut b = cloud();
        signs(&mut b, "provision", Lifted::Touch, &[DB]);
        b.authorize(&deployer("provision"), &write(DB));

        let sig = &b.ledger()[0];
        assert_eq!(
            sig.action,
            Action::Approve {
                kind: Exception::SIGNATURE
            }
        );
        assert!(sig.decision.is_allowed());
        assert_eq!(sig.post, "chief");
        assert_eq!(sig.occupant, "operator");
        assert_eq!(sig.human.as_deref(), Some("ada"));
        // Filed against the task it is bounded to, so the signature and the work it
        // covers answer the same query.
        assert_eq!(sig.task.as_deref(), Some("provision"));
        assert_eq!(sig.source, Source::Broker);

        assert_eq!(b.ledger()[1].post, "impl-infra");
        assert_eq!(b.denials().count(), 0);
        assert_eq!(b.alarms().count(), 0);
    }
}
