//! Governance: capability grants and the Broker that authorises every
//! consequential action.
//!
//! Two rules shape this crate:
//!
//! 1. **Enforce, do not prompt.** Authority is checked here, before an action
//!    happens. Nothing relies on an agent respecting an instruction.
//! 2. **Delegation only ever narrows.** [`grant::Grant::narrows`] is both RBAC's
//!    no-escalation constraint and cybernetic variety attenuation.
//!
//! Like [`wecode_core`], this crate has no dependencies beyond it: an
//! authorisation decision must be a pure function of its inputs, or it cannot be
//! audited. [`criterion`] holds to the same rule for the other half of the record:
//! what the evidence about a piece of work amounts to, including when there is none, and
//! so does [`standing`], which is how the operator says yes once instead of every time.

pub mod broker;
pub mod criterion;
pub mod glob;
pub mod grant;
pub mod standing;

pub use broker::{
    Action, Broker, Charter, ControlMode, Decision, DenyReason, Invariant, Record, Session, Source,
    Spend,
};
pub use criterion::{Outcome, Standing, Unrun};
pub use grant::{ActionKind, Effective, Escalation, Grant, Introspect, Network, WorkKind};
pub use standing::StandingOrder;
