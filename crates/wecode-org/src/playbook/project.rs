//! `[project]`: what holds for every kind of work in this repository.
//!
//! Four settings and a sub-table. Two of them are gates — whether a task may be
//! dispatched before anyone signs for it, and whether verified work lands by itself —
//! and both are preferences rather than rules: the charter outranks either, so a
//! project may be stricter than the company and never laxer.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::PlaybookError;
use super::cache::{self, CacheDir};

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct ProjectBlock {
    #[serde(default)]
    language: String,
    #[serde(default)]
    merge_to: Option<String>,
    #[serde(default)]
    merge: Option<String>,
    #[serde(default)]
    dispatch: Option<String>,
    /// Environment variable to directory. A table rather than a list because the
    /// variable is the identity: naming one twice is one setting, not two.
    #[serde(default)]
    build_cache: BTreeMap<String, String>,
}

/// Settings that hold for every kind in this project.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct ProjectSettings {
    /// Free-form, for the reader's benefit. wecode never branches on it.
    pub language: String,
    /// The integration branch: what a task branch is cut from, and where it will
    /// eventually merge back to.
    pub merge_to: Option<String>,
    /// Whether passing work merges by itself.
    pub merge: MergePolicy,
    /// Whether a task may be dispatched before a holder has signed for it.
    pub dispatch: DispatchPolicy,
    /// Directories every worktree of this project shares, in variable order.
    pub build_cache: Vec<CacheDir>,
}

/// Who decides that verified work may land.
///
/// A project preference, not a rule. The charter's `approval_to_merge` outranks it, so
/// a project may be *stricter* than the company — never laxer. Choosing `Auto` for a
/// branch the charter protects changes nothing.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum MergePolicy {
    /// A capability holder signs first. The safe default: a project that has not
    /// thought about it does not get automatic merges by omission.
    #[default]
    Approved,
    /// Verified work lands without asking. Safe only because every merge is one
    /// revertable commit and reports what it did.
    Auto,
}

impl MergePolicy {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Auto => "auto",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "approved" => Self::Approved,
            "auto" => Self::Auto,
            _ => return None,
        })
    }
}

/// Who decides that a task may be worked on at all.
///
/// The same two words as [`MergePolicy`], one door earlier: `approved` means a
/// capability holder signs before anything is spawned, `auto` means the admission gate
/// is the only door. Separate from `merge` because the two questions are separate —
/// "is this the work we want done" is asked of a plan, "may this land" of a diff — and
/// a project may reasonably answer them differently.
///
/// The default is `Auto`, where [`MergePolicy`]'s is `Approved`, and the difference is
/// reversibility rather than a lapse. A dispatched run happens in its own worktree
/// under a budget and is judged before it can reach a shared branch; a merge is the
/// step that cannot be un-decided quietly. Defaulting this to `Approved` would also
/// mean `wecode loop` — which exists to run unattended — stopped on every task in every
/// project that had never heard of the setting.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum DispatchPolicy {
    /// The admission gate is the whole check. What wecode has always done.
    #[default]
    Auto,
    /// A holder signs each task before it may be dispatched: `wecode approve
    /// admission --task <id>`.
    Approved,
}

impl DispatchPolicy {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Approved => "approved",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "auto" => Self::Auto,
            "approved" => Self::Approved,
            _ => return None,
        })
    }

    /// Whether a recorded signature is required before dispatch.
    #[must_use]
    pub fn needs_a_signature(self) -> bool {
        matches!(self, Self::Approved)
    }
}

/// The block as read. A policy nobody defined is refused by name rather than read as
/// its default: `dispatch = "manual"` would otherwise say strict and behave as `auto`.
pub(super) fn settings_of(b: &ProjectBlock) -> Result<ProjectSettings, PlaybookError> {
    Ok(ProjectSettings {
        language: b.language.clone(),
        merge_to: b.merge_to.clone(),
        merge: match b.merge.as_deref() {
            None => MergePolicy::default(),
            Some(v) => MergePolicy::parse(v).ok_or_else(|| PlaybookError::BadValue {
                at: "[project] merge".to_string(),
                value: v.to_string(),
                known: "auto, approved".to_string(),
            })?,
        },
        dispatch: match b.dispatch.as_deref() {
            None => DispatchPolicy::default(),
            Some(v) => DispatchPolicy::parse(v).ok_or_else(|| PlaybookError::BadValue {
                at: "[project] dispatch".to_string(),
                value: v.to_string(),
                known: "auto, approved".to_string(),
            })?,
        },
        build_cache: cache::parse_build_cache(&b.build_cache)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playbook::{Playbook, SAMPLE};

    #[test]
    fn a_project_states_its_language_and_its_integration_branch() {
        let p = Playbook::parse(SAMPLE).unwrap();
        assert_eq!(p.project.language, "rust");
        assert_eq!(p.project.merge_to.as_deref(), Some("dev"));
        // Nothing branches on the language — it is written for whoever reads the file.
        assert_eq!(p.project.merge, MergePolicy::Approved);
    }

    #[test]
    fn dispatch_is_auto_unless_a_project_asks_to_sign_first() {
        // The default is the behaviour every existing project already has; asking for
        // the gate is a deliberate line in the file.
        assert_eq!(
            Playbook::parse(SAMPLE).unwrap().project.dispatch,
            DispatchPolicy::Auto
        );
        assert!(!DispatchPolicy::Auto.needs_a_signature());

        let p = Playbook::parse("[project]\ndispatch = \"approved\"\n").unwrap();
        assert_eq!(p.project.dispatch, DispatchPolicy::Approved);
        assert!(p.project.dispatch.needs_a_signature());
    }

    #[test]
    fn a_dispatch_policy_nobody_defined_is_refused_by_name() {
        // `dispatch = "manual"` would otherwise read as strict and behave as `auto`,
        // which is the one failure mode a gate must not have.
        let msg = Playbook::parse("[project]\ndispatch = \"manual\"\n")
            .unwrap_err()
            .to_string();
        assert!(msg.contains("[project] dispatch"), "{msg}");
        assert!(msg.contains("manual"), "{msg}");
        assert!(msg.contains("auto, approved"), "{msg}");
    }

    #[test]
    fn a_merge_policy_nobody_defined_is_refused_the_same_way() {
        let msg = Playbook::parse("[project]\nmerge = \"whenever\"\n")
            .unwrap_err()
            .to_string();
        assert!(msg.contains("[project] merge"), "{msg}");
        assert!(msg.contains("whenever"), "{msg}");
    }
}
