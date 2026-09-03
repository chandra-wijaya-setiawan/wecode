//! `[attention]`, `[invariants]` and `[session]`: the ceilings on a company.
//!
//! Three blocks, one subject — what may be spent. `[attention]` bounds the operator's,
//! which is the binding constraint on concurrency and the scarcest thing here;
//! `[invariants]` bounds every agent's, and outranks every grant that would exceed it;
//! `[session]` bounds how long an interactive one may sit idle.
//!
//! One key here is not a ceiling: `[[invariants.auto_merge]]` is where the operator says
//! yes in advance, by condition, to merges `approval_to_merge` would otherwise stop on
//! them one at a time. It is written beside the invariant it answers because that is the
//! only place it can be written — an amendment to what the charter demands is a
//! hand-edited file, never a signature. See [`wecode_gov::StandingOrder`].

use std::time::Duration;

use serde::Deserialize;
use wecode_gov::{Charter, Invariant, StandingOrder};

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

/// `[budgets]`: whether a spend figure is a ceiling or a reading.
///
/// Off by default, deliberately. A budget killed mid-run destroys the work already
/// paid for — the tree keeps a half-written change nobody can accept — while the
/// overrun it prevents was going to land on the board in red either way. Monitoring
/// is free; enforcement has a body count. An operator who wants the hard stop turns
/// it on knowing that.
#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct BudgetsBlock {
    #[serde(default)]
    enforce: bool,
}

/// Whether a task's token budget stops a run or only measures it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Budgets {
    pub enforce: bool,
}

pub(super) fn budgets_of(b: &BudgetsBlock) -> Budgets {
    Budgets { enforce: b.enforce }
}

/// `[[invariants.auto_merge]]`: one standing merge authorisation.
///
/// Beside `approval_to_merge` because it is the answer to it, and in this file because
/// it can only be written here. A per-task signature can be given by any seat that
/// holds `approve merge`; saying yes to every merge of a shape *in advance* changes what
/// the charter demands, and the charter is amended by hand, in a diff — never on a
/// signature. `[project] merge = "auto"` is the project's own preference and is
/// outranked by the invariant; this is the operator's, and it is what the invariant
/// answers to.
///
/// `projects` is optional and narrows it. Leaving it out authorises every project's
/// merges onto the branch, which is a wide thing to write and is why the narrower form
/// is documented first.
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct StandingBlock {
    to: String,
    #[serde(default)]
    projects: Vec<String>,
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
    /// The merges the operator has already decided about. See [`StandingBlock`].
    #[serde(default)]
    auto_merge: Vec<StandingBlock>,
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
///
/// The standing orders ride along beside them rather than being folded into
/// `approval_to_merge`, because a merge pre-authorisation is not a narrower invariant: it
/// is conditioned on which project's work is landing, which no glob over branch names can
/// say. Folding it in would also lose the distinction a reader needs — `wecode org` shows
/// what is protected and what the operator has already answered as two lines, not one.
///
/// A standing order over a branch nothing protects is inert rather than wrong. Those
/// merges already land, so it grants nothing; it is left in place because deleting the
/// `approval_to_merge` entry is how a protection is withdrawn, and an order that survives
/// the withdrawal is what makes putting it back a one-line change.
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
    Charter::with(out).pre_authorising(
        b.auto_merge
            .iter()
            .map(|s| StandingOrder::to_merge(&s.to).for_projects(&s.projects))
            .collect(),
    )
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

    /// The block as an operator writes it: a protection, and the merges already answered.
    const STANDING: &str = "\n[invariants]\napproval_to_merge = [\"main\", \"release/**\"]\n\n\
         [[invariants.auto_merge]]\nto = \"main\"\nprojects = [\"docs-site\"]\n\n\
         [[invariants.auto_merge]]\nto = \"release/*\"\n";

    #[test]
    fn a_standing_order_is_read_beside_the_invariant_it_answers() {
        let c = Company::parse(&format!("{MINIMAL}{STANDING}")).unwrap();
        // The protection is untouched: this adds an answer to it, not a hole in it.
        let protects =
            Invariant::ApprovalToMerge(vec!["main".to_string(), "release/**".to_string()]);
        assert!(c.charter.invariants.contains(&protects));
        assert_eq!(c.charter.standing.len(), 2);
        assert_eq!(c.charter.standing[0].branch(), "main");
        assert_eq!(c.charter.standing[0].projects(), ["docs-site"]);
        // No `projects` is every project, which is what an empty list means.
        assert!(c.charter.standing[1].projects().is_empty());
    }

    #[test]
    fn the_charter_answers_which_merges_still_stop_on_a_person() {
        let c = Company::parse(&format!("{MINIMAL}{STANDING}")).unwrap();
        let asks = |project, branch| c.charter.demands_signature_to_merge(project, branch);
        assert!(!asks(Some("docs-site"), "main"), "pre-authorised");
        assert!(asks(Some("payments"), "main"), "another project's merge");
        assert!(asks(None, "main"), "a merge that named no project");
        assert!(!asks(Some("payments"), "release/2026-09"), "open to all");
        assert!(
            asks(Some("payments"), "release/hot/fix"),
            "no order reaches it"
        );
        assert!(!asks(Some("payments"), "dev"), "nothing protects it");
    }

    #[test]
    fn a_standing_order_needs_a_branch_to_be_about() {
        // `deny_unknown_fields` catches the typo; this catches the omission. Without it
        // the entry would parse as an order over the empty branch and match nothing,
        // which reads as configured and decides nothing.
        let text = format!("{MINIMAL}\n[[invariants.auto_merge]]\nprojects = [\"docs\"]\n");
        assert!(matches!(
            Company::parse(&text).unwrap_err(),
            OrgError::Parse(_)
        ));
    }
}
