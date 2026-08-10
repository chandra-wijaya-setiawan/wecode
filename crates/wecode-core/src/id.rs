//! Typed identifiers.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Identifier for an [`crate::Intent`].
///
/// Human-readable on purpose: ids appear in prompts, audit records and the TUI,
/// so `oauth-device-flow` beats a UUID for every one of those readers.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct IntentId(String);

impl IntentId {
    /// Builds an id, normalising to a lowercase kebab-case slug.
    pub fn new(raw: impl AsRef<str>) -> Self {
        let mut out = String::new();
        let mut prev_dash = true; // leading dashes are dropped
        for ch in raw.as_ref().chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch.to_ascii_lowercase());
                prev_dash = false;
            } else if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
        while out.ends_with('-') {
            out.pop();
        }
        Self(out)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Display for IntentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for IntentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "IntentId({})", self.0)
    }
}

impl FromStr for IntentId {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self::new(s))
    }
}

impl From<&str> for IntentId {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies() {
        assert_eq!(IntentId::new("OAuth Device Flow").as_str(), "oauth-device-flow");
        assert_eq!(IntentId::new("cut p99 latency!").as_str(), "cut-p99-latency");
    }

    #[test]
    fn collapses_and_trims_separators() {
        assert_eq!(IntentId::new("  a // b  ").as_str(), "a-b");
        assert_eq!(IntentId::new("---").as_str(), "");
    }

    #[test]
    fn round_trips_through_json() {
        let id = IntentId::new("ship-it");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"ship-it\"");
        assert_eq!(serde_json::from_str::<IntentId>(&json).unwrap(), id);
    }
}
