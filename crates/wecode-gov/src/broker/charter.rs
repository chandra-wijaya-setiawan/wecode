//! The limits that outrank every grant, and the merges signed for in advance.

use crate::glob;
use crate::standing::StandingOrder;

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
///
/// [`Broker::exceptions`]: super::Broker::exceptions
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
