//! What a post can ask to do, and whether a breach of it can be undone.

use crate::grant::{ActionKind, Introspect, WorkKind};

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

    pub(super) fn argv_line(&self) -> String {
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
