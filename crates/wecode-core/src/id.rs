//! Typed identifiers.

use std::fmt;
use std::str::FromStr;

/// Declares a human-readable identifier newtype.
///
/// Readable on purpose: ids appear in prompts, audit records and the TUI, so
/// `oauth-device-flow` beats a UUID for every one of those readers.
macro_rules! slug_id {
    ($name:ident) => {
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            /// Builds an id, normalising to a lowercase kebab-case slug.
            pub fn new(raw: impl AsRef<str>) -> Self {
                Self(slugify(raw.as_ref()))
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

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0)
            }
        }

        impl FromStr for $name {
            type Err = std::convert::Infallible;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self::new(s))
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self::new(s)
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self::new(s)
            }
        }
    };
}

slug_id!(ProjectId);
slug_id!(TaskId);

fn slugify(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = true; // leading dashes are dropped
    for ch in raw.chars() {
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies() {
        assert_eq!(
            ProjectId::new("OAuth Device Flow").as_str(),
            "oauth-device-flow"
        );
        assert_eq!(TaskId::new("cut p99 latency!").as_str(), "cut-p99-latency");
    }

    #[test]
    fn collapses_and_trims_separators() {
        assert_eq!(TaskId::new("  a // b  ").as_str(), "a-b");
        assert_eq!(TaskId::new("---").as_str(), "");
        assert!(TaskId::new("---").is_empty());
    }

    #[test]
    fn displays_as_its_slug() {
        assert_eq!(ProjectId::new("Ship It").to_string(), "ship-it");
        assert_eq!("Ship It".parse::<TaskId>().unwrap().as_str(), "ship-it");
    }

    #[test]
    fn project_and_task_ids_are_distinct_types() {
        // They slugify identically but cannot be swapped, which is the point of
        // having two newtypes rather than one.
        let p = ProjectId::new("x");
        let t = TaskId::new("x");
        assert_eq!(p.as_str(), t.as_str());
    }
}
