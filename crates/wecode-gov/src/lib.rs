//! Governance: capability grants and the Broker that authorises every
//! consequential action.
//!
//! Three rules shape this crate:
//!
//! 1. **Enforce, do not prompt.** Authority is checked here, before an action
//!    happens. Nothing relies on an agent respecting an instruction.
//! 2. **Delegation only ever narrows.** [`grant::Grant::narrows`] is both RBAC's
//!    no-escalation constraint and cybernetic variety attenuation.
//! 3. **The rules are not the agent's to edit.** [`CONFIGURES_AGENTS`] is the floor
//!    under both: whatever a company grants, no seat writes the files that decide what
//!    the seats are.
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

/// The files that configure an agent: what a seat may do, and what it is launched as.
///
/// Not a key in `company.toml`, deliberately. Every other invariant is a line an
/// operator writes, which means it is a line an agent holding the file could unwrite —
/// and the first entry here *is* the file the invariants are written in. A charter an
/// agent may edit on its way past is not a charter, so this one is compiled in: it
/// cannot be spelled, narrowed or switched off from configuration, and a company
/// written before it existed has it.
///
/// The line drawn is **authority, not guidance**. These files decide what a seat may
/// write, what it may run, what it may reach and which model sits in it. Instructions —
/// `CLAUDE.md`, a skill, a spec, a README — are ordinary work and are deliberately not
/// here: an agent that rewrites its briefing has told itself something, where an agent
/// that rewrites `company.toml` has granted itself something.
///
/// Every glob is anchored at `**/`, so it holds wherever the file sits: a task working
/// in one repo of a monorepo cannot reach the settings file two directories up, and
/// `wecode`'s own workspace `company.toml` is caught by the same entry as a project's.
///
/// Things already depend on this being true. `[[repos]] installs` carries the authority
/// to write outside every repository, and it may only be written in `company.toml`
/// precisely because that is the file an agent cannot reach — which, until this list,
/// was a claim in a doc comment rather than something the Broker would refuse.
pub const CONFIGURES_AGENTS: &[&str] = &[
    "**/company.toml",
    "**/.wecode/playbook.toml",
    "**/.claude/settings.json",
    "**/.claude/settings.local.json",
    "**/.claude/agents/**",
    "**/.mcp.json",
];

/// [`CONFIGURES_AGENTS`] as the invariant every [`Charter`] carries.
///
/// An ordinary [`Invariant::NeverTouch`], so the Broker needs no new judgement for it
/// and it reads as one more line in `wecode company show` and in every seat's briefing.
/// Being ordinary is also what leaves the escape hatch open: a holder may sign a
/// [`broker::Exception`] for the one task that has to repair a settings file, bounded to
/// that task and on the ledger. What no seat can do is lift it for itself.
#[must_use]
pub fn agent_config() -> Invariant {
    Invariant::NeverTouch(CONFIGURES_AGENTS.iter().map(|p| (*p).to_string()).collect())
}
