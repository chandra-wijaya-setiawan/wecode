//! The Broker: one chokepoint that authorises every consequential action, and the
//! ledger that records what it decided and under whose authority.

use std::fmt;

use crate::glob;
use crate::grant::{ActionKind, Effective, Introspect, WorkKind};
use crate::standing::StandingOrder;

/// Something a post wants to do.
///
/// `Spend` carries tokens in the unit [`crate::grant::Grant::tokens`] names, which
/// is the whole of what makes a cap mean anything: a count and a cap in different
/// units compare cleanly and answer nothing.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Action {
    Read { path: String },
    Write { path: String },
    Run { argv: Vec<String> },
    Network { host: String },
    Spend { tokens: u64, wall_secs: u64 },
    Merge { branch: String },
    Approve { kind: ActionKind },
    Define { kind: WorkKind },
    Introspect { level: Introspect },
    Staff,
}

impl Action {
    /// Whether a violation must be made impossible, or may be allowed to happen
    /// and then sanctioned. Split by **reversibility**, not severity.
    #[must_use]
    pub fn control_mode(&self) -> ControlMode {
        match self {
            // No "afterwards" to sanction in.
            Self::Merge { .. }
            | Self::Run { .. }
            | Self::Network { .. }
            | Self::Spend { .. }
            | Self::Approve { .. }
            | Self::Define { .. }
            | Self::Staff => ControlMode::Regimented,
            // Recoverable inside a worktree, and the attempt is diagnostic.
            Self::Read { .. } | Self::Write { .. } | Self::Introspect { .. } => {
                ControlMode::Sanctioned
            }
        }
    }

    fn argv_line(&self) -> String {
        match self {
            Self::Run { argv } => argv.join(" "),
            _ => String::new(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ControlMode {
    /// Blocked before it happens.
    Regimented,
    /// Detected, recorded, penalised. The attempt itself is information.
    Sanctioned,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum DenyReason {
    OutsideWriteScope {
        path: String,
    },
    OutsideReadScope {
        path: String,
    },
    CommandNotPermitted {
        argv: String,
    },
    NetworkNotPermitted {
        host: String,
    },
    BranchNotPermitted {
        branch: String,
    },
    TokenBudgetExhausted {
        cap: u64,
        would_be: u64,
    },
    WallBudgetExhausted {
        cap: u64,
        would_be: u64,
    },
    CapabilityMissing {
        what: &'static str,
    },
    /// A holder who could have signed said no.
    ///
    /// The one denial here that is not a failure of authority but an exercise of it.
    /// Nothing is misconfigured and nobody overreached: the seat entitled to sign was
    /// asked and declined. It is a denial all the same, because the action did not
    /// happen and the reason it did not is a decision somebody made.
    SignatureWithheld {
        kind: ActionKind,
    },
    /// A charter invariant. Always raises an alarm — intermediate levels may be
    /// the thing that misconfigured the grant.
    ///
    /// Never reached by an action a live [`Exception`] excuses. A breach somebody
    /// signed for is not a breach, and does not arrive here to be alarmed about.
    InvariantViolated {
        invariant: String,
    },
    /// An exception to something no invariant forbids, or wider than the one it names.
    ///
    /// Refused rather than filed as a harmless no-op, because both ways of landing
    /// here are worth stopping. A pattern nothing forbids means whoever signed it
    /// believes a task is unblocked when it is not. A pattern wider than the invariant
    /// means a signature carving out more than the charter ever named — `**` under a
    /// charter that forbids `infra/**` takes every secret in the tree with it.
    ///
    /// No alarm, deliberately: an alarm freezes dispatch, and the commonest way to
    /// land here is a typo. Telling the two apart would mean deciding whether two
    /// globs overlap, which [`glob`] does not do and should not start.
    ExceptionLiftsNothing {
        pattern: String,
    },
    /// An exception with no task to expire with.
    ///
    /// The task is the whole of what bounds one: it excuses that task's sessions and
    /// no others, and it is gone when the task is. Asked for without a task, what is
    /// being asked for is not an exception but an amendment — and the charter is
    /// amended in `company.toml`, in the open, rather than on one signature.
    ExceptionUnbounded,
}

impl fmt::Display for DenyReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutsideWriteScope { path } => write!(f, "write outside scope: {path}"),
            Self::OutsideReadScope { path } => write!(f, "read outside scope: {path}"),
            Self::CommandNotPermitted { argv } => write!(f, "command not permitted: {argv}"),
            Self::NetworkNotPermitted { host } => write!(f, "network not permitted: {host}"),
            Self::BranchNotPermitted { branch } => write!(f, "merge not permitted: {branch}"),
            Self::TokenBudgetExhausted { cap, would_be } => {
                write!(f, "token budget exhausted: {would_be} would exceed {cap}")
            }
            Self::WallBudgetExhausted { cap, would_be } => {
                write!(f, "wall budget exhausted: {would_be}s would exceed {cap}s")
            }
            Self::CapabilityMissing { what } => write!(f, "capability missing: {what}"),
            Self::SignatureWithheld { kind } => {
                write!(f, "signature withheld: {}", kind.as_str())
            }
            Self::InvariantViolated { invariant } => write!(f, "invariant violated: {invariant}"),
            Self::ExceptionLiftsNothing { pattern } => {
                write!(f, "exception lifts nothing: {pattern:?}")
            }
            Self::ExceptionUnbounded => write!(f, "an exception needs a task to expire with"),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Decision {
    Allow,
    Deny {
        reason: DenyReason,
        mode: ControlMode,
        alarm: bool,
    },
    RequireApproval {
        by: ActionKind,
    },
}

impl Decision {
    #[must_use]
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow)
    }

    #[must_use]
    pub fn raises_alarm(&self) -> bool {
        matches!(self, Self::Deny { alarm: true, .. })
    }

    /// Whether this is a holder's own refusal rather than a refusal *of* a holder.
    ///
    /// Both are denials of the same action, and the difference is who the authority in
    /// the row is: a seat that may not sign is being told no, and a seat that may sign
    /// is the one saying it. A caller that reported them alike would tell an operator
    /// their configuration is broken when what happened is that they said no.
    #[must_use]
    pub fn is_withheld(&self) -> bool {
        matches!(
            self,
            Self::Deny {
                reason: DenyReason::SignatureWithheld { .. },
                ..
            }
        )
    }
}

/// Hard limits that no grant may override.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Invariant {
    NeverTouch(Vec<String>),
    NeverRun(Vec<String>),
    MaxTokens(u64),
    MaxWallSecs(u64),
    /// Merging these branches needs a holder's signature — per merge, unless a
    /// [`StandingOrder`] says the operator already gave one for merges of this shape.
    ApprovalToMerge(Vec<String>),
}

/// A unit's identity: purpose plus the limits that outrank every grant beneath it.
///
/// The standing orders sit here beside the invariants they answer, and for the reason
/// the signed exceptions do *not* (see [`Broker::exceptions`]): both of these are read
/// from `company.toml`, hold for every session alike, and change only when somebody
/// edits a file in the open. An exception varies by who is asking; neither of these does.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct Charter {
    pub invariants: Vec<Invariant>,
    /// Merges the operator authorised by condition rather than one at a time.
    pub standing: Vec<StandingOrder>,
}

impl Charter {
    #[must_use]
    pub fn with(invariants: Vec<Invariant>) -> Self {
        Self {
            invariants,
            standing: Vec::new(),
        }
    }

    /// Adds the standing orders the operator wrote.
    #[must_use]
    pub fn pre_authorising(mut self, standing: Vec<StandingOrder>) -> Self {
        self.standing = standing;
        self
    }

    /// Whether landing `project`'s work on `branch` has to be signed for.
    ///
    /// The one answer to that question, so nothing has to re-derive it: the invariant
    /// says which branches are protected, and a standing order says which of those
    /// merges the operator has already decided about. Asked by the Broker before it
    /// gates a merge, and by anything that wants to say so before offering to.
    #[must_use]
    pub fn demands_signature_to_merge(&self, project: Option<&str>, branch: &str) -> bool {
        let protected = self.invariants.iter().any(|inv| {
            matches!(inv, Invariant::ApprovalToMerge(globs) if glob::any_matches(globs, branch))
        });
        protected && !self.standing.iter().any(|s| s.covers(project, branch))
    }
}

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

/// Consumed budget for one session.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct Spend {
    pub tokens: u64,
    pub wall_secs: u64,
}

/// One post working on one intent, with a subset of its roles activated.
///
/// `occupant` is the agent that acted; `human` is the person in the same seat, when
/// there is one. Both are recorded flatly, with no implied direction between them —
/// the human is not the agent's owner, and the agent is not merely the human's tool.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Session {
    pub id: String,
    pub post: String,
    pub occupant: String,
    pub human: Option<String>,
    /// What the action is for. Both may be set: a task always belongs to a
    /// project, and the ledger is queried by either.
    pub project: Option<String>,
    pub task: Option<String>,
    pub effective: Effective,
    pub spent: Spend,
}

impl Session {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        post: impl Into<String>,
        occupant: impl Into<String>,
        effective: Effective,
    ) -> Self {
        Self {
            id: id.into(),
            post: post.into(),
            occupant: occupant.into(),
            human: None,
            project: None,
            task: None,
            effective,
            spent: Spend::default(),
        }
    }

    /// Names the work this session is acting on.
    #[must_use]
    pub fn on(mut self, project: Option<String>, task: Option<String>) -> Self {
        self.project = project;
        self.task = task;
        self
    }

    /// Names the human in this seat alongside the agent.
    #[must_use]
    pub fn with_human(mut self, human: Option<String>) -> Self {
        self.human = human;
        self
    }
}

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
    fn excused(&self, session: &Session, lifted: Lifted, target: &str) -> bool {
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

    /// One line onto the ledger.
    ///
    /// Every path that records goes through here — deciding, withholding, observing — so
    /// a record cannot be written with a field left off it by the newest caller.
    fn file(&mut self, session: &Session, action: Action, decision: Decision, source: Source) {
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

    /// Charter invariants are checked before grants, because a grant that permits
    /// an invariant violation is itself the bug.
    fn decide(&self, session: &Session, action: &Action) -> Decision {
        if let Some(reason) = self.invariant_violation(session, action) {
            return Decision::Deny {
                reason,
                mode: ControlMode::Regimented,
                alarm: true,
            };
        }
        if let Some(kind) = self.approval_required(session, action) {
            return Decision::RequireApproval { by: kind };
        }

        let g = &session.effective;
        let deny = |reason: DenyReason| Decision::Deny {
            reason,
            mode: action.control_mode(),
            alarm: false,
        };

        match action {
            Action::Read { path } => {
                if g.allows_read(path) {
                    Decision::Allow
                } else {
                    deny(DenyReason::OutsideReadScope { path: path.clone() })
                }
            }
            Action::Write { path } => {
                if g.allows_write(path) {
                    Decision::Allow
                } else {
                    deny(DenyReason::OutsideWriteScope { path: path.clone() })
                }
            }
            Action::Run { .. } => {
                let argv = action.argv_line();
                if g.allows_run(&argv) {
                    Decision::Allow
                } else {
                    deny(DenyReason::CommandNotPermitted { argv })
                }
            }
            Action::Network { host } => {
                if g.allows_host(host) {
                    Decision::Allow
                } else {
                    deny(DenyReason::NetworkNotPermitted { host: host.clone() })
                }
            }
            Action::Merge { branch } => {
                if g.allows_merge(branch) {
                    Decision::Allow
                } else {
                    deny(DenyReason::BranchNotPermitted {
                        branch: branch.clone(),
                    })
                }
            }
            Action::Spend { tokens, wall_secs } => self.check_spend(session, *tokens, *wall_secs),
            Action::Approve { kind } => {
                if g.allows_approve(*kind) {
                    Decision::Allow
                } else {
                    deny(DenyReason::CapabilityMissing { what: "approve" })
                }
            }
            Action::Define { kind } => {
                if g.allows_define(*kind) {
                    Decision::Allow
                } else {
                    deny(DenyReason::CapabilityMissing { what: "define" })
                }
            }
            Action::Introspect { level } => {
                if *level <= g.introspect() && g.introspect() != Introspect::None {
                    Decision::Allow
                } else {
                    deny(DenyReason::CapabilityMissing { what: "introspect" })
                }
            }
            Action::Staff => {
                if g.allows_staff() {
                    Decision::Allow
                } else {
                    deny(DenyReason::CapabilityMissing { what: "staff" })
                }
            }
        }
    }

    fn check_spend(&self, session: &Session, tokens: u64, wall_secs: u64) -> Decision {
        let next_tokens = session.spent.tokens.saturating_add(tokens);
        let next_wall = session.spent.wall_secs.saturating_add(wall_secs);

        if let Some(cap) = session.effective.token_cap()
            && next_tokens > cap
        {
            return Decision::Deny {
                reason: DenyReason::TokenBudgetExhausted {
                    cap,
                    would_be: next_tokens,
                },
                mode: ControlMode::Regimented,
                alarm: next_tokens > cap.saturating_mul(3) / 2,
            };
        }
        if let Some(cap) = session.effective.wall_cap()
            && next_wall > cap
        {
            return Decision::Deny {
                reason: DenyReason::WallBudgetExhausted {
                    cap,
                    would_be: next_wall,
                },
                mode: ControlMode::Regimented,
                alarm: false,
            };
        }
        Decision::Allow
    }

    /// A signed [`Exception`] is consulted here and nowhere else, because this is the
    /// only place an invariant decides anything. It excuses the breach; it does not
    /// remove the invariant, which still binds every other task's sessions.
    fn invariant_violation(&self, session: &Session, action: &Action) -> Option<DenyReason> {
        for inv in &self.charter.invariants {
            match (inv, action) {
                (Invariant::NeverTouch(globs), Action::Write { path })
                    if glob::any_matches(globs, path)
                        && !self.excused(session, Lifted::Touch, path) =>
                {
                    return Some(DenyReason::InvariantViolated {
                        invariant: format!("never_touch {path}"),
                    });
                }
                (Invariant::NeverRun(patterns), Action::Run { .. }) => {
                    let argv = action.argv_line();
                    if patterns.iter().any(|p| glob::wildcard(p, &argv))
                        && !self.excused(session, Lifted::Run, &argv)
                    {
                        return Some(DenyReason::InvariantViolated {
                            invariant: format!("never_run {argv}"),
                        });
                    }
                }
                (Invariant::MaxTokens(cap), Action::Spend { tokens, .. })
                    if session.spent.tokens.saturating_add(*tokens) > *cap =>
                {
                    return Some(DenyReason::InvariantViolated {
                        invariant: format!("max_tokens {cap}"),
                    });
                }
                (Invariant::MaxWallSecs(cap), Action::Spend { wall_secs, .. })
                    if session.spent.wall_secs.saturating_add(*wall_secs) > *cap =>
                {
                    return Some(DenyReason::InvariantViolated {
                        invariant: format!("max_wall_secs {cap}"),
                    });
                }
                _ => {}
            }
        }
        None
    }

    /// Whether this action stops on a person, and which signature it stops on.
    ///
    /// A [`StandingOrder`] is consulted here and nowhere else, because this is the only
    /// place a signature is demanded. It does not remove the invariant: every merge the
    /// operator did not pre-authorise still stops here, and the seat still has to hold
    /// the branch either way.
    fn approval_required(&self, session: &Session, action: &Action) -> Option<ActionKind> {
        let Action::Merge { branch } = action else {
            return None;
        };
        self.charter
            .demands_signature_to_merge(session.project.as_deref(), branch)
            .then_some(ActionKind::Merge)
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
    use crate::grant::Grant;

    fn session(effective: Effective) -> Session {
        Session::new("s1", "impl-api", "claude-code", effective)
            .on(Some("caching".into()), Some("cache-layer".into()))
    }

    fn confined() -> Session {
        session(Effective::of(vec![
            Grant::writer(&["crates/export/**"])
                .with_run(&["cargo *"])
                .with_spend(100_000, 1800),
        ]))
    }

    fn broker() -> Broker {
        Broker::new(Charter::with(vec![
            Invariant::NeverTouch(vec![".github/**".into(), "**/*.pem".into()]),
            Invariant::NeverRun(vec!["git push --force*".into(), "npm publish*".into()]),
            Invariant::ApprovalToMerge(vec!["main".into()]),
        ]))
    }

    #[test]
    fn allows_a_write_inside_scope() {
        let mut b = broker();
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Write {
                path: "crates/export/cache.rs".into(),
            },
        );
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn denies_a_write_outside_scope_as_sanctioned() {
        let mut b = broker();
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Write {
                path: "crates/auth/token.rs".into(),
            },
        );
        match d {
            Decision::Deny { mode, alarm, .. } => {
                assert_eq!(mode, ControlMode::Sanctioned, "scope creep is recoverable");
                assert!(!alarm);
            }
            other => panic!("expected deny, got {other:?}"),
        }
    }

    #[test]
    fn invariant_beats_a_grant_and_raises_an_alarm() {
        let mut b = broker();
        // A grant wide enough to permit it — the invariant must still win.
        let s = session(Effective::of(vec![Grant::root()]));
        let d = b.authorize(
            &s,
            &Action::Write {
                path: ".github/workflows/ci.yml".into(),
            },
        );
        assert!(d.raises_alarm(), "got {d:?}");
        match d {
            Decision::Deny { mode, .. } => assert_eq!(mode, ControlMode::Regimented),
            other => panic!("expected deny, got {other:?}"),
        }
        assert_eq!(b.alarms().count(), 1);
    }

    #[test]
    fn secrets_are_never_writable_even_at_root() {
        let mut b = broker();
        let s = session(Effective::of(vec![Grant::root()]));
        let d = b.authorize(
            &s,
            &Action::Write {
                path: "deploy/key.pem".into(),
            },
        );
        assert!(d.raises_alarm());
    }

    #[test]
    fn permitted_command_runs() {
        let mut b = broker();
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Run {
                argv: vec!["cargo".into(), "test".into(), "--workspace".into()],
            },
        );
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn unpermitted_command_is_regimented() {
        let mut b = broker();
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Run {
                argv: vec!["curl".into(), "evil.sh".into()],
            },
        );
        match d {
            Decision::Deny { mode, alarm, .. } => {
                assert_eq!(mode, ControlMode::Regimented);
                assert!(!alarm);
            }
            other => panic!("expected deny, got {other:?}"),
        }
    }

    #[test]
    fn forbidden_command_raises_an_alarm() {
        let mut b = broker();
        let s = session(Effective::of(vec![Grant::root()]));
        let d = b.authorize(
            &s,
            &Action::Run {
                argv: vec!["git".into(), "push".into(), "--force".into()],
            },
        );
        assert!(d.raises_alarm(), "got {d:?}");
    }

    #[test]
    fn spend_within_cap_is_allowed() {
        let mut b = broker();
        let s = confined();
        assert_eq!(
            b.authorize(
                &s,
                &Action::Spend {
                    tokens: 50_000,
                    wall_secs: 300
                }
            ),
            Decision::Allow
        );
    }

    #[test]
    fn spend_over_cap_is_denied() {
        let mut b = broker();
        let mut s = confined();
        s.spent = Spend {
            tokens: 90_000,
            wall_secs: 0,
        };
        let d = b.authorize(
            &s,
            &Action::Spend {
                tokens: 20_000,
                wall_secs: 0,
            },
        );
        assert!(matches!(
            d,
            Decision::Deny {
                reason: DenyReason::TokenBudgetExhausted { .. },
                ..
            }
        ));
    }

    #[test]
    fn spend_far_over_cap_raises_an_alarm() {
        let mut b = Broker::new(Charter::default());
        let mut s = confined();
        s.spent = Spend {
            tokens: 100_000,
            wall_secs: 0,
        };
        // 260k against a 100k cap is past 150%, so the allocator itself is suspect.
        let d = b.authorize(
            &s,
            &Action::Spend {
                tokens: 60_000,
                wall_secs: 0,
            },
        );
        assert!(d.raises_alarm(), "got {d:?}");
    }

    #[test]
    fn merging_a_protected_branch_needs_approval() {
        let mut b = broker();
        let s = session(Effective::of(vec![Grant::root()]));
        assert_eq!(
            b.authorize(
                &s,
                &Action::Merge {
                    branch: "main".into()
                }
            ),
            Decision::RequireApproval {
                by: ActionKind::Merge
            }
        );
    }

    #[test]
    fn merging_an_unprotected_branch_is_allowed_with_the_capability() {
        let mut b = broker();
        let s = session(Effective::of(vec![Grant::root()]));
        assert_eq!(
            b.authorize(
                &s,
                &Action::Merge {
                    branch: "wecode/run-1".into()
                }
            ),
            Decision::Allow
        );
    }

    #[test]
    fn a_post_without_merge_capability_cannot_merge() {
        let mut b = Broker::new(Charter::default());
        let s = confined(); // merge_to is empty
        let d = b.authorize(
            &s,
            &Action::Merge {
                branch: "topic".into(),
            },
        );
        assert!(matches!(
            d,
            Decision::Deny {
                reason: DenyReason::BranchNotPermitted { .. },
                ..
            }
        ));
    }

    #[test]
    fn introspection_is_denied_by_default() {
        let mut b = Broker::new(Charter::default());
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Introspect {
                level: Introspect::Own,
            },
        );
        assert!(matches!(
            d,
            Decision::Deny {
                reason: DenyReason::CapabilityMissing { what: "introspect" },
                ..
            }
        ));
    }

    #[test]
    fn introspection_is_capped_at_the_granted_level() {
        let mut b = Broker::new(Charter::default());
        let s = session(Effective::of(vec![
            Grant::writer(&["src/**"]).with_introspect(Introspect::Own),
        ]));
        assert_eq!(
            b.authorize(
                &s,
                &Action::Introspect {
                    level: Introspect::Own
                }
            ),
            Decision::Allow
        );
        assert!(
            !b.authorize(
                &s,
                &Action::Introspect {
                    level: Introspect::Tree
                }
            )
            .is_allowed()
        );
    }

    #[test]
    fn a_post_cannot_define_measures() {
        let mut b = Broker::new(Charter::default());
        let s = confined();
        // The executor-never-defines rule, enforced rather than requested.
        let d = b.authorize(
            &s,
            &Action::Define {
                kind: WorkKind::Task,
            },
        );
        assert!(matches!(
            d,
            Decision::Deny {
                reason: DenyReason::CapabilityMissing { what: "define" },
                ..
            }
        ));
    }

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
