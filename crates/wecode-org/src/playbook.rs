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

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
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
            kinds.insert(
                kind,
                KindPlaybook {
                    worktree: block.worktree,
                    assign_to: block.assign_to,
                    accept: block.accept,
                    tokens: block.tokens,
                    wall_secs: block.wall_secs,
                    guidance: block.guidance.trim().to_string(),
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
