//! `[feature]`, `[bug]`, `[refactor]` …: what this project says about one kind of work.
//!
//! One section per [`TaskKind`], and the section a planner actually reads. Most of it
//! is defaults a hand-written task would otherwise have to repeat — the test command,
//! the assignee, a budget — plus the prose, which wecode only carries. A section for a
//! kind nobody wrote is absent rather than empty: the project does not template that
//! work, and nothing is invented on its behalf.

use std::collections::BTreeMap;

use serde::Deserialize;
use wecode_core::TaskKind;

use super::PlaybookError;
use super::subtask::{self, SubtaskTemplate};

/// The fields a kind block has. Named here because the strict check is done by hand
/// against this list — see [`kinds_of`].
const KIND_FIELDS: &str =
    "worktree, design_required, assign_to, accept, tokens, wall_secs, guidance, subtasks";

#[derive(Deserialize, Default, Debug)]
pub(super) struct KindBlock {
    #[serde(default)]
    worktree: bool,
    #[serde(default)]
    design_required: bool,
    #[serde(default)]
    assign_to: Option<String>,
    #[serde(default)]
    accept: Vec<String>,
    #[serde(default)]
    tokens: Option<u64>,
    #[serde(default)]
    wall_secs: Option<u64>,
    #[serde(default)]
    guidance: String,
    /// The subtasks `--expand` emits, in the order they are declared. Order lives in
    /// this list rather than in the blocks because a table has no order.
    #[serde(default)]
    subtasks: Vec<String>,
    /// The `[feature.design]` sub-tables, plus anything else that did not match a
    /// field. `deny_unknown_fields` cannot be combined with `flatten`, so the check
    /// it used to give is done by name in [`kinds_of`]: a key here that `subtasks`
    /// does not declare is refused, which catches a misspelled `worktre` as well as a
    /// stray block, and says more about it than serde would have.
    #[serde(flatten)]
    steps: BTreeMap<String, toml::Value>,
}

/// What this project says about one kind of work.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct KindPlaybook {
    /// Whether work of this kind gets its own git worktree. A docs change usually
    /// does not need one.
    pub worktree: bool,
    /// Whether the admission gate refuses work of this kind unless a `design` task
    /// stands before it. The dependency is the enforcement: a design finishes only
    /// through a recorded signature, so ordering alone keeps the work from running
    /// until someone has signed.
    pub design_required: bool,
    /// The post to assign to when the operator does not say.
    pub assign_to: Option<String>,
    /// Default acceptance commands, so the project's test command is written once
    /// rather than retyped on every task.
    pub accept: Vec<String>,
    /// A default budget. Without one the admission gate refuses every task, so
    /// filling acceptance and assignee but not this would leave the job half done.
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
    /// Prose, read by whoever decomposes the work. wecode only carries it.
    pub guidance: String,
    /// The decomposition `--expand` emits, in declared order. Empty means this
    /// project does not template work of this kind, and `--expand` has nothing to do.
    pub subtasks: Vec<SubtaskTemplate>,
}

/// Every section the file holds, keyed by the kind it names.
///
/// Two typos are settled here rather than left to fail later, and both would otherwise
/// be silent: a section that is not a kind at all, and a key inside one that is neither
/// a field nor a declared subtask — a `worktre` that would leave a bug fix without the
/// worktree its section asked for.
pub(super) fn kinds_of(
    blocks: BTreeMap<String, KindBlock>,
) -> Result<BTreeMap<TaskKind, KindPlaybook>, PlaybookError> {
    let mut kinds = BTreeMap::new();
    for (key, block) in blocks {
        let kind = TaskKind::parse(&key).ok_or_else(|| PlaybookError::UnknownKind {
            key: key.clone(),
            known: TaskKind::all()
                .iter()
                .map(|k| k.as_str().to_string())
                .collect(),
        })?;
        for name in block.steps.keys() {
            if !block.subtasks.contains(name) {
                return Err(PlaybookError::UnknownField {
                    at: format!("[{key}]"),
                    key: name.clone(),
                    known: KIND_FIELDS.to_string(),
                });
            }
        }
        let subtasks = subtask::templates_of(&key, &block.subtasks, &block.steps)?;
        kinds.insert(
            kind,
            KindPlaybook {
                worktree: block.worktree,
                design_required: block.design_required,
                assign_to: block.assign_to,
                accept: block.accept,
                tokens: block.tokens,
                wall_secs: block.wall_secs,
                guidance: block.guidance.trim().to_string(),
                subtasks,
            },
        );
    }
    Ok(kinds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playbook::{Playbook, SAMPLE};

    #[test]
    fn a_playbook_parses_into_kinds() {
        let p = Playbook::parse(SAMPLE).unwrap();
        let bug = p.for_kind(TaskKind::Bug).unwrap();
        assert!(bug.worktree);
        assert_eq!(bug.assign_to.as_deref(), Some("impl"));
        assert_eq!(bug.accept, vec!["cargo test --workspace".to_string()]);
        assert!(bug.guidance.starts_with("Reproduce first"));
        // Trimmed, so a multi-line TOML string does not render with a blank first line.
        assert!(!bug.guidance.starts_with('\n'));
    }

    #[test]
    fn a_budget_default_is_carried_because_admission_demands_one() {
        let p = Playbook::parse("[bug]\ntokens = 5000\nwall_secs = 60\n").unwrap();
        let k = p.for_kind(TaskKind::Bug).unwrap();
        assert_eq!(k.tokens, Some(5000));
        assert_eq!(k.wall_secs, Some(60));
    }

    #[test]
    fn a_kind_with_no_section_yields_nothing() {
        let p = Playbook::parse(SAMPLE).unwrap();
        assert!(p.for_kind(TaskKind::Feature).is_none());
        assert!(p.for_kind(TaskKind::Refactor).is_none());
    }

    #[test]
    fn worktree_defaults_to_false_so_nothing_touches_git_unasked() {
        let p = Playbook::parse("[chore]\nguidance = \"x\"\n").unwrap();
        assert!(!p.for_kind(TaskKind::Chore).unwrap().worktree);
    }

    #[test]
    fn a_design_gate_is_off_unless_a_kind_asks_for_it() {
        let p = Playbook::parse(SAMPLE).unwrap();
        assert!(!p.for_kind(TaskKind::Bug).unwrap().design_required);
        assert!(p.design_required_kinds().is_empty());

        let p = Playbook::parse("[feature]\ndesign_required = true\n\n[bug]\n").unwrap();
        assert!(p.for_kind(TaskKind::Feature).unwrap().design_required);
        assert_eq!(p.design_required_kinds(), vec![TaskKind::Feature]);
    }

    #[test]
    fn an_unknown_section_is_refused_and_lists_the_real_kinds() {
        let err = Playbook::parse("[buggg]\nworktree = true\n").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("buggg"), "{msg}");
        assert!(msg.contains("refactor"), "should list the kinds: {msg}");
    }

    #[test]
    fn a_misspelled_field_is_refused_and_names_it() {
        // The strict check that `deny_unknown_fields` buys on the inner blocks: a
        // silently-ignored `worktre` would leave a bug fix with no worktree and no
        // warning.
        let err = Playbook::parse("[bug]\nworktre = true\n").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("worktre"), "{msg}");
    }

    #[test]
    fn an_alias_names_the_same_kind() {
        let p = Playbook::parse("[fix]\nworktree = true\n").unwrap();
        assert!(p.for_kind(TaskKind::Bug).unwrap().worktree);
    }

    #[test]
    fn kinds_are_listed_in_lifecycle_order_not_alphabetically() {
        let p = Playbook::parse(SAMPLE).unwrap();
        let order: Vec<&str> = p.kinds().iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(order, vec!["bug", "docs"]);
    }
}
