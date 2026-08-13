//! Project playbooks: per-kind guidance, read from the project's own repository.
//!
//! A playbook is guidance for whoever *decomposes* work — it shapes the tasks that
//! get created, and is then out of the picture. It is deliberately not a workflow an
//! engine runs.
//!
//! That is why the guidance can be free prose: whatever the orchestrator produces
//! still has to clear the admission gate, so the gate is the backstop and the prose
//! needs no enforcement of its own. Only the two or three fields wecode itself acts
//! on are typed.
//!
//! It lives in the repo rather than the workspace because it describes that code: a
//! Rust project and a TypeScript one differ, and changing the test command should
//! change the guidance in the same commit.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use wecode_core::TaskKind;

/// Where a playbook sits inside the repo it describes.
pub const PLAYBOOK_PATH: &str = ".wecode/playbook.toml";

/// The worker-writable area. Separate from the playbook on purpose: a role granted
/// `.wecode/**` so it could write a result file would also be able to rewrite the
/// guidance it was given.
pub const RUN_DIR: &str = wecode_core::WORKER_DIR;

#[derive(Debug)]
pub enum PlaybookError {
    Parse(toml::de::Error),
    Io(io::Error),
    /// A section that is not a task kind.
    UnknownKind {
        key: String,
        known: Vec<String>,
    },
    /// A field whose value is not one of the ones it accepts.
    BadValue {
        at: String,
        value: String,
        known: String,
    },
    /// A key inside a kind block that is neither one of its fields nor a subtask it
    /// declares. This is what recovers the strictness `deny_unknown_fields` used to
    /// give the block, which `flatten` made unavailable.
    UnknownField {
        at: String,
        key: String,
        known: String,
    },
    /// `subtasks` names one that has no block of its own.
    SubtaskUndeclared {
        at: String,
        name: String,
    },
    /// A subtask ordered after something that is not an earlier sibling.
    SubtaskAfterUnknown {
        at: String,
        after: String,
        earlier: String,
    },
    AlreadyExists(PathBuf),
}

impl fmt::Display for PlaybookError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(e) => write!(f, "{PLAYBOOK_PATH}: {e}"),
            Self::Io(e) => write!(f, "{PLAYBOOK_PATH}: {e}"),
            Self::UnknownKind { key, known } => {
                write!(f, "[{key}] is not a task kind — have: {}", known.join(", "))
            }
            Self::BadValue { at, value, known } => {
                write!(f, "{at}: `{value}` is not one of {known}")
            }
            Self::UnknownField { at, key, known } => write!(
                f,
                "{at}: `{key}` is not a field, and no subtask of that name is declared \
                 — fields are: {known}"
            ),
            Self::SubtaskUndeclared { at, name } => write!(
                f,
                "{at}: subtasks names `{name}`, but there is no [{}.{name}] block",
                at.trim_matches(['[', ']'])
            ),
            Self::SubtaskAfterUnknown { at, after, earlier } => write!(
                f,
                "{at}: after = `{after}` is not an earlier subtask — earlier are: {}",
                if earlier.is_empty() {
                    "none, this is the first"
                } else {
                    earlier
                }
            ),
            Self::AlreadyExists(p) => write!(f, "{} already exists", p.display()),
        }
    }
}

impl std::error::Error for PlaybookError {}

impl From<toml::de::Error> for PlaybookError {
    fn from(e: toml::de::Error) -> Self {
        Self::Parse(e)
    }
}

impl From<io::Error> for PlaybookError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

// ------------------------------------------------------------------ wire ------

/// `deny_unknown_fields` is deliberately absent here: serde cannot combine it with
/// `flatten`. Nothing is lost — an unrecognised section lands in `kinds` and is
/// rejected by name against the real kind list, which is a better message than
/// serde's would have been. The inner blocks keep the strict check.
#[derive(Deserialize, Debug)]
struct Wire {
    #[serde(default)]
    project: ProjectBlock,
    #[serde(flatten)]
    kinds: BTreeMap<String, KindBlock>,
}

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
struct ProjectBlock {
    #[serde(default)]
    language: String,
    #[serde(default)]
    merge_to: Option<String>,
    #[serde(default)]
    merge: Option<String>,
}

/// The fields a kind block has. Named here because the strict check is done by hand
/// against this list — see `KindBlock::steps`.
const KIND_FIELDS: &str = "worktree, assign_to, accept, tokens, wall_secs, guidance, subtasks";

#[derive(Deserialize, Default, Debug)]
struct KindBlock {
    #[serde(default)]
    worktree: bool,
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
    /// it used to give is done by name in `parse`: a key here that `subtasks` does
    /// not declare is refused, which catches a misspelled `worktre` as well as a
    /// stray block, and says more about it than serde would have.
    #[serde(flatten)]
    steps: BTreeMap<String, toml::Value>,
}

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
struct SubtaskBlock {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    after: Vec<String>,
    #[serde(default)]
    write: Vec<String>,
    #[serde(default)]
    read: Vec<String>,
    #[serde(default)]
    accept: Vec<String>,
    #[serde(default)]
    assign_to: Option<String>,
    #[serde(default)]
    tokens: Option<u64>,
    #[serde(default)]
    wall_secs: Option<u64>,
}

// ---------------------------------------------------------------- domain ------

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

/// What this project says about one kind of work.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct KindPlaybook {
    /// Whether work of this kind gets its own git worktree. A docs change usually
    /// does not need one.
    pub worktree: bool,
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

/// One subtask a kind declares, before it is resolved against a main task.
///
/// Everything left unset falls through to the playbook for the subtask's *own* kind,
/// exactly as a hand-written task of that kind would. So a template states what makes
/// this step different, and nothing else.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct SubtaskTemplate {
    /// The suffix: the emitted task is `<main task id>-<name>`.
    pub name: String,
    /// Defaults to the kind being expanded — a template names it only when the step
    /// is a different sort of work, as a `design` step of a `feature` is.
    pub kind: Option<TaskKind>,
    /// May use the placeholders. Without one the title is derived from the main
    /// task's, which has already cleared the gate.
    pub title: Option<String>,
    /// Sibling names, resolved to task ids at expansion. Siblings only: a template
    /// cannot know the ids of tasks outside the expansion it belongs to.
    pub after: Vec<String>,
    pub write: Vec<String>,
    pub read: Vec<String>,
    pub accept: Vec<String>,
    pub assign_to: Option<String>,
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
}

/// A subtask template resolved against one main task: ids, not names, and every
/// placeholder filled.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Subtask {
    pub id: String,
    pub kind: TaskKind,
    pub title: String,
    /// Task ids, already prefixed.
    pub after: Vec<String>,
    pub write: Vec<String>,
    pub read: Vec<String>,
    pub accept: Vec<String>,
    pub assign_to: Option<String>,
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
}

/// Reads a kind's sub-tables into templates, in the order `subtasks` declares.
///
/// Three things are settled here rather than left to fail later, because all three
/// are typos and a typo found at planning time costs nothing:
///
/// - a key that is neither a field nor a declared subtask
/// - a declared subtask with no block
/// - an `after` that names no sibling
fn parse_subtasks(key: &str, block: &KindBlock) -> Result<Vec<SubtaskTemplate>, PlaybookError> {
    let at = format!("[{key}]");
    for name in block.steps.keys() {
        if !block.subtasks.contains(name) {
            return Err(PlaybookError::UnknownField {
                at: at.clone(),
                key: name.clone(),
                known: KIND_FIELDS.to_string(),
            });
        }
    }

    let mut out = Vec::with_capacity(block.subtasks.len());
    for name in &block.subtasks {
        let value = block
            .steps
            .get(name)
            .ok_or_else(|| PlaybookError::SubtaskUndeclared {
                at: at.clone(),
                name: name.clone(),
            })?;
        let s: SubtaskBlock = value.clone().try_into()?;

        // Earlier, not merely a sibling: the emitted tasks are created in this order,
        // so a step ordered after a later one names a task that does not exist yet.
        for a in &s.after {
            if !out.iter().any(|e: &SubtaskTemplate| &e.name == a) {
                return Err(PlaybookError::SubtaskAfterUnknown {
                    at: format!("[{key}.{name}]"),
                    after: a.clone(),
                    earlier: out
                        .iter()
                        .map(|e: &SubtaskTemplate| e.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                });
            }
        }
        let kind = match &s.kind {
            None => None,
            Some(k) => Some(TaskKind::parse(k).ok_or_else(|| {
                PlaybookError::BadValue {
                    at: format!("[{key}.{name}] kind"),
                    value: k.clone(),
                    known: TaskKind::all()
                        .iter()
                        .map(|k| k.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                }
            })?),
        };
        out.push(SubtaskTemplate {
            name: name.clone(),
            kind,
            title: s.title,
            after: s.after,
            write: s.write,
            read: s.read,
            accept: s.accept,
            assign_to: s.assign_to,
            tokens: s.tokens,
            wall_secs: s.wall_secs,
        });
    }
    Ok(out)
}

/// The placeholders a template may use: the main task's id and its title.
///
/// Deliberately two. A template that could reach further into the plan would be a
/// small language, and this is a scaffold that runs once.
fn fill(text: &str, task: &str, title: &str) -> String {
    text.replace("{{task}}", task).replace("{{title}}", title)
}

impl KindPlaybook {
    /// What `--expand` would emit for a main task, in declared order.
    ///
    /// Pure. It produces values and schedules nothing — the tasks it describes still
    /// face the admission gate, and may be edited or dropped before anything runs.
    /// `parent_kind` is the kind being expanded, used for a step that names none.
    #[must_use]
    pub fn expand(&self, parent_kind: TaskKind, task: &str, title: &str) -> Vec<Subtask> {
        self.subtasks
            .iter()
            .map(|s| Subtask {
                id: format!("{task}-{}", s.name),
                kind: s.kind.unwrap_or(parent_kind),
                title: s
                    .title
                    .as_ref()
                    .map_or_else(|| format!("{}: {title}", s.name), |t| fill(t, task, title)),
                after: s.after.iter().map(|a| format!("{task}-{a}")).collect(),
                write: s.write.iter().map(|g| fill(g, task, title)).collect(),
                read: s.read.iter().map(|g| fill(g, task, title)).collect(),
                accept: s.accept.iter().map(|c| fill(c, task, title)).collect(),
                assign_to: s.assign_to.clone(),
                tokens: s.tokens,
                wall_secs: s.wall_secs,
            })
            .collect()
    }
}

#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct Playbook {
    pub project: ProjectSettings,
    kinds: BTreeMap<TaskKind, KindPlaybook>,
}

impl Playbook {
    pub fn parse(text: &str) -> Result<Self, PlaybookError> {
        let w: Wire = toml::from_str(text)?;
        let mut kinds = BTreeMap::new();
        for (key, block) in w.kinds {
            let kind = TaskKind::parse(&key).ok_or_else(|| PlaybookError::UnknownKind {
                key: key.clone(),
                known: TaskKind::all()
                    .iter()
                    .map(|k| k.as_str().to_string())
                    .collect(),
            })?;
            let subtasks = parse_subtasks(&key, &block)?;
            kinds.insert(
                kind,
                KindPlaybook {
                    worktree: block.worktree,
                    assign_to: block.assign_to,
                    accept: block.accept,
                    tokens: block.tokens,
                    wall_secs: block.wall_secs,
                    guidance: block.guidance.trim().to_string(),
                    subtasks,
                },
            );
        }
        Ok(Self {
            project: ProjectSettings {
                language: w.project.language,
                merge_to: w.project.merge_to,
                merge: match w.project.merge.as_deref() {
                    None => MergePolicy::default(),
                    Some(v) => MergePolicy::parse(v).ok_or_else(|| PlaybookError::BadValue {
                        at: "[project] merge".to_string(),
                        value: v.to_string(),
                        known: "auto, approved".to_string(),
                    })?,
                },
            },
            kinds,
        })
    }

    /// Reads the playbook from a repository. A repo without one is `Ok(None)`, not an
    /// error — playbooks are opt-in and every project worked before they existed.
    pub fn at(repo: &Path) -> Result<Option<Self>, PlaybookError> {
        let path = repo.join(PLAYBOOK_PATH);
        match fs::read_to_string(&path) {
            Ok(text) => Ok(Some(Self::parse(&text)?)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(PlaybookError::Io(e)),
        }
    }

    #[must_use]
    pub fn for_kind(&self, kind: TaskKind) -> Option<&KindPlaybook> {
        self.kinds.get(&kind)
    }

    /// Kinds this project has written guidance for, in lifecycle order.
    #[must_use]
    pub fn kinds(&self) -> Vec<(TaskKind, &KindPlaybook)> {
        TaskKind::all()
            .iter()
            .filter_map(|k| self.kinds.get(k).map(|p| (*k, p)))
            .collect()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.kinds.is_empty()
    }
}

/// Writes a starter playbook into a repository. Refuses to overwrite.
///
/// The guidance is left as prompts rather than invented: only whoever works on this
/// project knows how its work should be broken down.
pub fn init(repo: &Path, language: &str) -> Result<PathBuf, PlaybookError> {
    let path = repo.join(PLAYBOOK_PATH);
    if path.exists() {
        return Err(PlaybookError::AlreadyExists(path));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, starter(language))?;
    Ok(path)
}

/// The starter file. Kept as one string so `init` and the tests agree by
/// construction.
#[must_use]
pub fn starter(language: &str) -> String {
    format!(
        r#"# How work is broken down in this project.
#
# Read by whoever decomposes a request into tasks — usually an orchestrator agent,
# via `wecode playbook <kind>`. It is guidance, not a workflow anything runs: the
# tasks it produces are still checked by the admission gate.
#
# Committed to the repo on purpose, so it is versioned with the code it describes.
# `.wecode/run/` is the worker-writable area and should be gitignored; this file
# should not be.

[project]
language = "{language}"
# The integration branch. Task branches are cut from it, and merge back into it.
# merge_to = "dev"
#
# Whether verified work lands by itself. `approved` (the default) waits for a
# signature; `auto` merges and reports what it did. The charter still outranks this —
# a branch it protects needs a signature whatever this says.
# merge = "approved"

[feature]
worktree  = true
assign_to = "impl"
tokens    = 120000
wall_secs = 5400
accept    = []            # e.g. ["cargo test --workspace"]
guidance  = """
TODO: how should a feature be broken down here?
Acceptance must be an executable command, never a description.
"""
# The decomposition `wecode task add <id> ... --expand` emits. Uncomment to use it;
# without `subtasks` there is nothing to expand and the flag is refused.
#
# Order is this list. Every name needs a block, and each block states only what
# makes that step different — kind, accept, budget and assignee otherwise fall
# through to the playbook for the step's own kind, as a hand-written task would.
# `{{{{task}}}}` is the main task's id and `{{{{title}}}}` its title.
#
# subtasks = ["design", "build", "docs"]
#
# [feature.design]
# kind   = "design"                 # not finished when it passes: it waits for a signature
# write  = ["docs/wecode/{{{{task}}}}/design.md"]
# accept = ["test -f docs/wecode/{{{{task}}}}/design.md"]
#
# [feature.build]
# after  = ["design"]               # sibling names, not task ids
# write  = ["src/**"]
#
# [feature.docs]
# after  = ["build"]
# kind   = "docs"
# write  = ["README.md", "docs/**"]

[bug]
worktree  = true
assign_to = "impl"
tokens    = 60000
wall_secs = 2700
accept    = []
guidance  = """
TODO. A shape that works well: reproduce first, then a failing regression test,
then the fix. One cause per task. If the cause is unclear, make a spike subtask
first — a spike needs no write scope.
"""

[refactor]
worktree  = true
assign_to = "impl"
tokens    = 90000
wall_secs = 3600
accept    = []
guidance  = """
TODO. Behaviour must not change, so the acceptance is the existing suite passing
unchanged. Needing to edit a test means this is not a refactor.
"""

[chore]
worktree  = true
assign_to = "impl"
tokens    = 40000
wall_secs = 1800
accept    = []
guidance  = "TODO."

[spike]
worktree  = false
assign_to = "impl"
tokens    = 30000
wall_secs = 1800
guidance  = """
TODO. A spike answers a question and needs no write scope. Say where the answer
should be written down.
"""

[design]
worktree  = false
assign_to = "impl"
tokens    = 40000
wall_secs = 1800
accept    = ["test -f docs/wecode/{{{{task}}}}/design.md"]
guidance  = """
TODO. A design proposes a change and writes no code. It is the only kind that is not
finished when it passes: it goes to needs-approval and waits for a signature, because
whether a design is right is the part no command can check.

Say what a design here must decide before anyone builds against it.
"""

[docs]
worktree  = false
assign_to = "impl"
tokens    = 30000
wall_secs = 1800
guidance  = "TODO."
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[project]
language = "rust"
merge_to = "dev"

[bug]
worktree = true
assign_to = "impl"
accept = ["cargo test --workspace"]
guidance = """
Reproduce first. Main task is the fix.
"""

[docs]
worktree = false
guidance = "Single task, no subtasks."
"#;

    #[test]
    fn a_playbook_parses_into_kinds() {
        let p = Playbook::parse(SAMPLE).unwrap();
        assert_eq!(p.project.language, "rust");
        assert_eq!(p.project.merge_to.as_deref(), Some("dev"));

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
    fn every_starter_kind_carries_a_budget() {
        // Without one the gate refuses the task, and the starter would produce
        // nothing admissible.
        let p = Playbook::parse(&starter("rust")).unwrap();
        for (kind, k) in p.kinds() {
            assert!(k.tokens.is_some(), "{kind:?} has no token budget");
            assert!(k.wall_secs.is_some(), "{kind:?} has no wall budget");
        }
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

    #[test]
    fn an_empty_playbook_is_legal_and_empty() {
        let p = Playbook::parse("").unwrap();
        assert!(p.is_empty());
        assert!(p.project.merge_to.is_none());
    }

    // ----------------------------------------------------------- subtasks ------

    const TEMPLATED: &str = r#"
[feature]
worktree  = true
assign_to = "impl"
accept    = ["cargo test --workspace"]
tokens    = 120000
wall_secs = 5400
subtasks  = ["design", "build", "docs"]

[feature.design]
kind   = "design"
title  = "decide how {{task}} should work"
write  = ["docs/wecode/{{task}}/design.md"]
accept = ["test -f docs/wecode/{{task}}/design.md"]

[feature.build]
after  = ["design"]
write  = ["src/**"]

[feature.docs]
after  = ["build"]
kind   = "docs"
write  = ["README.md"]
"#;

    #[test]
    fn a_template_expands_in_declared_order_with_the_placeholders_filled() {
        let p = Playbook::parse(TEMPLATED).unwrap();
        let k = p.for_kind(TaskKind::Feature).unwrap();
        let out = k.expand(TaskKind::Feature, "retry", "retry a failed task once");

        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["retry-design", "retry-build", "retry-docs"]);

        let design = &out[0];
        assert_eq!(design.kind, TaskKind::Design);
        assert_eq!(design.title, "decide how retry should work");
        assert_eq!(
            design.write,
            vec!["docs/wecode/retry/design.md".to_string()]
        );
        assert_eq!(
            design.accept,
            vec!["test -f docs/wecode/retry/design.md".to_string()]
        );
        // A sibling name becomes a task id — a template cannot know ids itself.
        assert_eq!(out[1].after, vec!["retry-design".to_string()]);
        assert_eq!(out[2].after, vec!["retry-build".to_string()]);
    }

    #[test]
    fn a_step_that_names_no_kind_is_the_kind_being_expanded() {
        let p = Playbook::parse(TEMPLATED).unwrap();
        let out = p.for_kind(TaskKind::Feature).unwrap().expand(
            TaskKind::Feature,
            "retry",
            "retry a failed task once",
        );
        assert_eq!(out[1].kind, TaskKind::Feature);
        assert_eq!(out[2].kind, TaskKind::Docs);
    }

    #[test]
    fn a_step_without_a_title_derives_one_from_the_main_task() {
        // The main task's title has already cleared the gate, so a prefix of it is
        // the cheapest title that will too. Inventing prose here would not.
        let p = Playbook::parse(TEMPLATED).unwrap();
        let out = p.for_kind(TaskKind::Feature).unwrap().expand(
            TaskKind::Feature,
            "retry",
            "retry a failed task once",
        );
        assert_eq!(out[1].title, "build: retry a failed task once");
    }

    #[test]
    fn a_template_states_only_what_differs() {
        // Everything unset is left unset here, so `task add` can fill it from the
        // playbook for the step's own kind — the same path a hand-written task takes.
        let p = Playbook::parse(TEMPLATED).unwrap();
        let out = p.for_kind(TaskKind::Feature).unwrap().expand(
            TaskKind::Feature,
            "retry",
            "retry a failed task once",
        );
        assert!(out[1].accept.is_empty());
        assert!(out[1].assign_to.is_none());
        assert_eq!(out[1].tokens, None);
    }

    #[test]
    fn a_kind_with_no_subtasks_expands_to_nothing() {
        let p = Playbook::parse(SAMPLE).unwrap();
        let k = p.for_kind(TaskKind::Bug).unwrap();
        assert!(k.subtasks.is_empty());
        assert!(k.expand(TaskKind::Bug, "fix-it", "a title").is_empty());
    }

    #[test]
    fn a_declared_subtask_with_no_block_is_refused() {
        let err = Playbook::parse("[feature]\nsubtasks = [\"design\"]\n").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("design"), "{msg}");
        assert!(msg.contains("feature.design"), "{msg}");
    }

    #[test]
    fn a_block_the_list_does_not_declare_is_refused() {
        // Order lives in `subtasks`, so a block missing from it would silently never
        // be emitted — the same class of bug as a misspelled field.
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\"]\n\n[feature.build]\n\n[feature.tests]\nwrite = [\"tests/**\"]\n",
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("tests"), "{msg}");
    }

    #[test]
    fn an_after_that_names_no_sibling_is_refused() {
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\"]\n\n[feature.build]\nafter = [\"desgin\"]\n",
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("desgin"), "{msg}");
        assert!(msg.contains("feature.build"), "{msg}");
    }

    #[test]
    fn an_after_that_points_forward_is_refused() {
        // The tasks are created in the declared order, so ordering a step after a
        // later one names a task that does not exist yet — `NoSuchTask`, halfway
        // through creating an expansion, rather than a question about the playbook.
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\", \"design\"]\n\n[feature.build]\nafter = [\"design\"]\n\n[feature.design]\n",
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("earlier"), "{msg}");
    }

    #[test]
    fn a_step_kind_that_is_not_a_kind_is_refused() {
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\"]\n\n[feature.build]\nkind = \"buld\"\n",
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("buld"), "{msg}");
        assert!(msg.contains("refactor"), "should list the kinds: {msg}");
    }

    #[test]
    fn a_misspelled_field_inside_a_step_is_refused() {
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\"]\n\n[feature.build]\nwrites = [\"src/**\"]\n",
        )
        .unwrap_err();
        assert!(err.to_string().contains("writes"), "{err}");
    }

    #[test]
    fn the_starter_ships_the_template_commented_out() {
        // Uncommenting it must work: the example sits after `guidance`, so the
        // sub-tables it introduces do not swallow the fields above them.
        let text = starter("rust");
        let lines: Vec<&str> = text.lines().collect();
        let from = lines
            .iter()
            .position(|l| l.starts_with("# subtasks"))
            .expect("the starter offers a subtasks example");
        let to = from
            + lines[from..]
                .iter()
                .position(|l| l.starts_with("[bug]"))
                .expect("the example ends before the next kind");
        let live: String = lines
            .iter()
            .enumerate()
            .map(|(i, l)| {
                if (from..to).contains(&i) {
                    l.strip_prefix("# ").unwrap_or(l.trim_start_matches('#'))
                } else {
                    l
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let p = Playbook::parse(&live).expect("the commented example is valid TOML");
        let k = p.for_kind(TaskKind::Feature).unwrap();
        assert_eq!(k.subtasks.len(), 3);
        assert!(
            !k.guidance.is_empty(),
            "uncommenting must not move guidance into a sub-table"
        );
        assert_eq!(
            k.expand(TaskKind::Feature, "retry", "a title")[0].write,
            vec!["docs/wecode/retry/design.md".to_string()]
        );
    }

    fn temp(name: &str) -> PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-pb-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_repo_without_a_playbook_is_not_an_error() {
        let repo = temp("absent");
        assert!(Playbook::at(&repo).unwrap().is_none());
    }

    #[test]
    fn init_writes_a_file_that_parses_and_refuses_to_overwrite() {
        let repo = temp("init");
        let path = init(&repo, "rust").unwrap();
        assert!(path.ends_with(PLAYBOOK_PATH));

        // The starter must be valid, or adoption fails at the first step.
        let loaded = Playbook::at(&repo)
            .unwrap()
            .expect("written playbook loads");
        assert_eq!(loaded.project.language, "rust");
        assert!(loaded.for_kind(TaskKind::Bug).unwrap().worktree);
        assert!(!loaded.for_kind(TaskKind::Docs).unwrap().worktree);

        assert!(matches!(
            init(&repo, "rust").unwrap_err(),
            PlaybookError::AlreadyExists(_)
        ));
    }

    #[test]
    fn the_starter_covers_every_kind() {
        // A kind added to core without a starter section would silently get no
        // guidance in every new project.
        let p = Playbook::parse(&starter("rust")).unwrap();
        for k in TaskKind::all() {
            assert!(p.for_kind(*k).is_some(), "{k:?} missing from the starter");
        }
    }
}
