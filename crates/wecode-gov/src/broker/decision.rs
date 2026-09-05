//! The verdict, and every reason there is for a refusal.

use std::fmt;

use crate::grant::ActionKind;

use super::ControlMode;

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
    ///
    /// [`Exception`]: super::Exception
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
    ///
    /// [`glob`]: crate::glob
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
