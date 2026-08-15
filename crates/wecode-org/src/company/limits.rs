//! `[attention]`, `[invariants]` and `[session]`: the ceilings on a company.
//!
//! Three blocks, one subject — what may be spent. `[attention]` bounds the operator's,
//! which is the binding constraint on concurrency and the scarcest thing here;
//! `[invariants]` bounds every agent's, and outranks every grant that would exceed it;
//! `[session]` bounds how long an interactive one may sit idle.

use std::time::Duration;

use serde::Deserialize;
use wecode_gov::{Charter, Invariant};

use super::agent::Intelligence;
use super::{OrgError, parse_duration};

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct AttentionBlock {
    #[serde(default = "five")]
    max_open_items: u64,
    #[serde(default = "three")]
    max_interrupts_per_hour: u64,
    #[serde(default = "twenty")]
    digest_interval_mins: u64,
}

fn five() -> u64 {
    5
}
fn three() -> u64 {
    3
}
fn twenty() -> u64 {
    20
}

impl Default for AttentionBlock {
    fn default() -> Self {
        Self {
            max_open_items: 5,
            max_interrupts_per_hour: 3,
            digest_interval_mins: 20,
        }
    }
}

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct InvariantBlock {
    #[serde(default)]
    never_touch: Vec<String>,
    #[serde(default)]
    never_run: Vec<String>,
    #[serde(default)]
    approval_to_merge: Vec<String>,
    max_tokens: Option<u64>,
    max_wall_secs: Option<u64>,
    /// The strongest model any seat may be staffed with, as a level.
    ///
    /// Beside `max_tokens`, and for the same reason: the two are the expensive
    /// variables, and an invariant outranks every grant that would exceed it.
    max_intelligence: Option<Intelligence>,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct SessionBlock {
    #[serde(default = "eight_hours")]
    ttl: String,
}

fn eight_hours() -> String {
    "8h".to_string()
}

impl Default for SessionBlock {
    fn default() -> Self {
        Self { ttl: eight_hours() }
    }
}

/// The operator's attention budget — the binding constraint on concurrency.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Attention {
    pub max_open_items: u64,
    pub max_interrupts_per_hour: u64,
    pub digest_interval_mins: u64,
}

pub(super) fn attention_of(b: &AttentionBlock) -> Attention {
    Attention {
        max_open_items: b.max_open_items,
        max_interrupts_per_hour: b.max_interrupts_per_hour,
        digest_interval_mins: b.digest_interval_mins,
    }
}

/// How long an interactive session may sit idle before it is over.
pub(super) fn session_ttl(b: &SessionBlock) -> Result<Duration, OrgError> {
    parse_duration(&b.ttl).ok_or_else(|| OrgError::BadValue {
        at: "[session] ttl".into(),
        value: b.ttl.clone(),
    })
}

/// The invariants as the Broker judges them: only the ones actually written.
///
/// An empty list is not an invariant of "nothing", so a key nobody wrote contributes
/// nothing rather than a rule that permits everything.
pub(super) fn charter_of(b: &InvariantBlock) -> Charter {
    let mut out = Vec::new();
    if !b.never_touch.is_empty() {
        out.push(Invariant::NeverTouch(b.never_touch.clone()));
    }
    if !b.never_run.is_empty() {
        out.push(Invariant::NeverRun(b.never_run.clone()));
    }
    if !b.approval_to_merge.is_empty() {
        out.push(Invariant::ApprovalToMerge(b.approval_to_merge.clone()));
    }
    if let Some(n) = b.max_tokens {
        out.push(Invariant::MaxTokens(n));
    }
    if let Some(n) = b.max_wall_secs {
        out.push(Invariant::MaxWallSecs(n));
    }
    Charter::with(out)
}

/// The ceiling on how clever a seat may be staffed.
///
/// Carried out of the block rather than into the [`Charter`] because it is enforced
/// where it is written — a post above it is refused at load, by
/// [`super::agent::check`], and there is no run-time action for the Broker to judge.
/// The other invariants describe things an agent does; this one describes what it is.
pub(super) fn max_intelligence(b: &InvariantBlock) -> Option<Intelligence> {
    b.max_intelligence
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::{Company, MINIMAL};

    #[test]
    fn a_bad_ttl_names_where_it_was() {
        let text = format!("{MINIMAL}\n[session]\nttl = \"whenever\"\n");
        match Company::parse(&text).unwrap_err() {
            OrgError::BadValue { at, value } => {
                assert!(at.contains("ttl"), "{at}");
                assert_eq!(value, "whenever");
            }
            other => panic!("expected BadValue, got {other}"),
        }
    }

    #[test]
    fn the_attention_budget_defaults_to_five_open_items() {
        // The number the whole design is sized against, and it has to hold for a
        // company that never wrote the block.
        let c = Company::parse(MINIMAL).unwrap();
        assert_eq!(c.attention.max_open_items, 5);
        assert_eq!(c.attention.max_interrupts_per_hour, 3);
        assert_eq!(c.attention.digest_interval_mins, 20);
    }

    #[test]
    fn invariants_are_collected() {
        let text =
            format!("{MINIMAL}\n[invariants]\nnever_touch = [\"**/*.pem\"]\nmax_tokens = 500\n");
        let c = Company::parse(&text).unwrap();
        assert!(
            c.charter
                .invariants
                .contains(&Invariant::NeverTouch(vec!["**/*.pem".to_string()]))
        );
        assert!(c.charter.invariants.contains(&Invariant::MaxTokens(500)));
    }
}
