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
//!
//! Loading is the one machine-dependent step. An `accept` line whose program is not
//! on this machine refuses the playbook at [`Playbook::at`] — not in [`Playbook::parse`],
//! because the same file is legal on a machine that has the toolchain. Found at load
//! the mistake costs one edit; left in, verification discovers it as exit 127, once
//! per task and only after each budget is spent.
//!
//! [`CacheDir`] keeps to the same rule from the other end: its `~` is resolved by
//! [`CacheDir::dir`] rather than at parse, so one playbook describes the same cache on
//! two machines with different homes.
//!
//! [`starter`] is the other end of the same machine-dependence: what it writes is
//! decided by [`crate::toolchain`], and a starter that names a real test command can
//! name one this machine does not have. That is left to the check above, deliberately —
//! `init` writes the file and reports the refusal, rather than choosing commands by
//! looking at the machine it happens to be run on.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use wecode_core::TaskKind;

use crate::toolchain::{self, Toolchain};

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
    /// A `[project.build_cache]` entry that could not be shared: a key that is no
    /// environment variable, a variable that is not a place to put build output, or a
    /// path that would land inside a worktree instead of outside all of them.
    BadCache {
        var: String,
        why: String,
    },
    /// An `accept` line whose program this machine does not have.
    CommandNotFound {
        at: String,
        cmd: String,
        program: String,
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
            Self::BadCache { var, why } => write!(f, "[project.build_cache] {var}: {why}"),
            Self::CommandNotFound { at, cmd, program } => write!(
                f,
                "{at} accept: `{program}` is not on this machine — `{cmd}` would only \
                 ever come back \"command not found\", after the work is done"
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
    #[serde(default)]
    dispatch: Option<String>,
    /// Environment variable to directory. A table rather than a list because the
    /// variable is the identity: naming one twice is one setting, not two.
    #[serde(default)]
    build_cache: BTreeMap<String, String>,
}

/// The fields a kind block has. Named here because the strict check is done by hand
/// against this list — see `KindBlock::steps`.
const KIND_FIELDS: &str =
    "worktree, design_required, assign_to, accept, tokens, wall_secs, guidance, subtasks";

#[derive(Deserialize, Default, Debug)]
struct KindBlock {
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
    /// Whether a task may be dispatched before a holder has signed for it.
    pub dispatch: DispatchPolicy,
    /// Directories every worktree of this project shares, in variable order.
    pub build_cache: Vec<CacheDir>,
}

/// One directory this project's worktrees share, and the environment variable that
/// hands it to a toolchain.
///
/// A worktree is a fresh checkout with an empty `target/`, so every task pays for a
/// cold build twice — once for the agent, once for acceptance. Nothing about that cost
/// is per-task: the compiler output belongs to the *repository*, which is why the
/// declaration lives in the repository's own playbook and names a directory outside
/// every worktree.
///
/// Which variable does it is the project's business, not wecode's — `CARGO_TARGET_DIR`
/// for Rust, `GOCACHE` for Go, `YARN_CACHE_FOLDER` for a JS project — so this carries a
/// name rather than guessing one from `language`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CacheDir {
    pub var: String,
    /// As written, `~` and all. Resolving it is [`CacheDir::dir`]'s job, so a playbook
    /// parses the same on a machine with a different home.
    pub path: String,
}

impl CacheDir {
    /// The directory itself. Machine-dependent — `~` is this process's home — which is
    /// why it is a method rather than something `parse` settled.
    #[must_use]
    pub fn dir(&self) -> PathBuf {
        crate::workspace::expand_home(&self.path)
    }
}

/// Variables that decide *which program runs* rather than where its output goes.
///
/// A build cache names a directory. Setting one of these from a repository file would
/// be redirecting the toolchain of every agent that works on it, which is a different
/// power wearing this feature's clothes — and one the env allowlist in `company.toml`
/// exists to keep in the operator's hands.
const NOT_A_CACHE: &[&str] = &[
    "PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
];

fn is_env_name(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with(|c: char| c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Reads the shared directories, refusing the three ways one could fail to be shared.
///
/// The relative-path rule is the load-bearing one: `target/shared` looks like a cache
/// and resolves against whatever directory the toolchain was started in — which is the
/// worktree, so every task would get its own copy under a name promising the opposite.
/// A silent non-sharing cache is worse than none, because nothing about it looks wrong.
fn parse_build_cache(map: &BTreeMap<String, String>) -> Result<Vec<CacheDir>, PlaybookError> {
    let mut out = Vec::with_capacity(map.len());
    for (var, path) in map {
        let bad = |why: String| PlaybookError::BadCache {
            var: var.clone(),
            why,
        };
        if !is_env_name(var) {
            return Err(bad(
                "not an environment variable name — letters, digits and underscore, \
                 and never a leading digit"
                    .to_string(),
            ));
        }
        if NOT_A_CACHE.contains(&var.as_str()) {
            return Err(bad(
                "decides which program runs, not where its output goes — a shared cache \
                 names a directory, and this belongs to the env allowlist in company.toml"
                    .to_string(),
            ));
        }
        if !(path.starts_with('/') || path.starts_with("~/")) {
            return Err(bad(format!(
                "`{path}` is relative, so it would resolve inside whichever worktree is \
                 running — the one place a shared cache cannot be. Give an absolute path, \
                 or one under `~/`"
            )));
        }
        out.push(CacheDir {
            var: var.clone(),
            path: path.clone(),
        });
    }
    Ok(out)
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

// ------------------------------------------------------------- machine ------

/// What `sh` runs without consulting `PATH`. Only the names `program_of` can read
/// are listed — `[` and `:` never get that far.
const SH_BUILTINS: &[&str] = &[
    "cd", "command", "echo", "eval", "exec", "exit", "export", "false", "printf", "read", "set",
    "shift", "test", "true", "type", "umask", "unset", "wait",
];

/// The program an acceptance line would run: its first word, past any `VAR=value`
/// prefixes. `None` when reading it would take a shell — quoting, substitution, a
/// path into the worktree — and a word this cannot read is left to verification
/// rather than guessed at. First word only, deliberately: resolving what follows
/// `&&` or `|` is the same rabbit hole.
fn program_of(line: &str) -> Option<&str> {
    let word = line.split_whitespace().find(|w| !w.contains('='))?;
    word.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
        .then_some(word)
}

/// Whether `sh -c` could start `program` here: a builtin, or a file on `PATH`.
fn machine_has(program: &str) -> bool {
    SH_BUILTINS.contains(&program)
        || std::env::var_os("PATH")
            .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(program).is_file()))
}

fn known_program(at: &str, cmd: &str) -> Result<(), PlaybookError> {
    match program_of(cmd) {
        Some(p) if !machine_has(p) => Err(PlaybookError::CommandNotFound {
            at: at.to_string(),
            cmd: cmd.to_string(),
            program: p.to_string(),
        }),
        _ => Ok(()),
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
                dispatch: match w.project.dispatch.as_deref() {
                    None => DispatchPolicy::default(),
                    Some(v) => DispatchPolicy::parse(v).ok_or_else(|| PlaybookError::BadValue {
                        at: "[project] dispatch".to_string(),
                        value: v.to_string(),
                        known: "auto, approved".to_string(),
                    })?,
                },
                build_cache: parse_build_cache(&w.project.build_cache)?,
            },
            kinds,
        })
    }

    /// Reads the playbook from a repository. A repo without one is `Ok(None)`, not an
    /// error — playbooks are opt-in and every project worked before they existed.
    ///
    /// This is where the machine check runs: acceptance will execute here, so here
    /// is where an absent program is a fact rather than a maybe.
    pub fn at(repo: &Path) -> Result<Option<Self>, PlaybookError> {
        let path = repo.join(PLAYBOOK_PATH);
        match fs::read_to_string(&path) {
            Ok(text) => {
                let pb = Self::parse(&text)?;
                pb.programs_exist()?;
                Ok(Some(pb))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(PlaybookError::Io(e)),
        }
    }

    /// Refuses an `accept` line whose program this machine does not have — the
    /// kinds' own defaults and every subtask template's, where one wrong command
    /// lands in every expansion. Verification already distinguishes exit 127 from a
    /// failure, but by then the budget is spent; this finds the same fact while the
    /// fix is still one edit to one file.
    fn programs_exist(&self) -> Result<(), PlaybookError> {
        for (kind, k) in self.kinds() {
            for cmd in &k.accept {
                known_program(&format!("[{}]", kind.as_str()), cmd)?;
            }
            for s in &k.subtasks {
                for cmd in &s.accept {
                    known_program(&format!("[{}.{}]", kind.as_str(), s.name), cmd)?;
                }
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn for_kind(&self, kind: TaskKind) -> Option<&KindPlaybook> {
        self.kinds.get(&kind)
    }

    /// The kinds this project refuses without a design behind them — what the
    /// admission gate takes. Computed here so every gate site asks the playbook
    /// the same question.
    #[must_use]
    pub fn design_required_kinds(&self) -> Vec<TaskKind> {
        self.kinds
            .iter()
            .filter(|(_, k)| k.design_required)
            .map(|(kind, _)| *kind)
            .collect()
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

/// What `init` wrote, and what it decided along the way.
///
/// Returned rather than printed here: which language was used and where it came from is
/// the part a person has to check, and this crate does not own the terminal.
#[derive(Debug)]
pub struct Written {
    pub path: PathBuf,
    /// What went into `[project] language` — given, read off the repository, or empty.
    pub language: String,
    /// The manifest the language was read from, when nobody said. `None` means the
    /// caller named it, or nothing named it.
    pub detected_from: Option<&'static str>,
    /// The toolchain the file was written for, if the language named one. `None` means
    /// the starter is the prompts-and-TODO one.
    pub toolchain: Option<&'static Toolchain>,
    /// The build cache the file declares, resolved for this repository.
    pub cache: Vec<(&'static str, String)>,
}

/// Writes a starter playbook into a repository. Refuses to overwrite.
///
/// The language decides everything that can be stated without knowing the project: the
/// acceptance commands, the shared build cache, the write scope a build dirties. It is
/// read off the repository's own manifest when the caller does not say, because the
/// repository already knows and asking twice is how `--language` gets left off.
///
/// The guidance itself is still left as prompts rather than invented: only whoever works
/// on this project knows how its work should be broken down.
pub fn init(repo: &Path, language: &str) -> Result<Written, PlaybookError> {
    let path = repo.join(PLAYBOOK_PATH);
    if path.exists() {
        return Err(PlaybookError::AlreadyExists(path));
    }
    // Nobody said is the common case, and the repository can answer it. A language that
    // *was* given wins even where it disagrees with the manifest: a repo carrying two of
    // them is exactly where a person needs the last word.
    let (language, detected_from) = match (language.trim(), toolchain::detect(repo)) {
        ("", Some((t, from))) => (t.name.to_string(), Some(from)),
        (given, _) => (given.to_string(), None),
    };
    let name = slug(repo.file_name().map_or("", |n| n.to_str().unwrap_or("")));
    let toolchain = toolchain::of(&language);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, starter(&language, &name))?;
    Ok(Written {
        path,
        language,
        detected_from,
        toolchain,
        cache: toolchain.map(|t| t.cache(&name)).unwrap_or_default(),
    })
}

/// A repository's directory name, reduced to what a path and a TOML string can both
/// hold. Empty becomes `project`, so the cache path never has an empty segment.
fn slug(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "project".to_string()
    } else {
        cleaned
    }
}

/// Wraps generated prose to the width the rest of the file is written at.
///
/// The toolchain table states each sentence as one line, because a table is not the
/// place to decide line breaks. Pasted in unbroken they would be the only 150-column
/// lines in a file whose whole purpose is being read and edited by hand.
fn wrap(text: &str, width: usize) -> String {
    let mut out = String::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > width {
            out.push_str(&line);
            out.push('\n');
            line.clear();
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    out.push_str(&line);
    out
}

/// One TOML list of strings. The values come from this crate's own table and from a
/// directory name that [`slug`] has already reduced, so there is nothing here to escape.
fn toml_list(items: &[&str]) -> String {
    format!(
        "[{}]",
        items
            .iter()
            .map(|i| format!("\"{i}\""))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// The `[project.build_cache]` block a toolchain gets: live, not commented.
///
/// Commented-out would have been the timid choice and the wrong one — the cost this
/// closes is paid by the *first* task, before anyone has read far enough down the file
/// to uncomment anything. A project that would rather have cold builds deletes two
/// lines, and the block says so.
fn cache_block(t: &Toolchain, repo: &str) -> String {
    let mut out = String::from(
        "# Directories every worktree of this project shares, so a task is not a cold
# build. Each key is the environment variable a toolchain reads; each value is a
# directory outside every worktree. wecode creates them and sets them on the agent and
# on the acceptance commands alike, since both build.
#
# The path is keyed on this repository's directory name: change it if two repositories
# here share one, and delete the block to give every worktree its own build from
# scratch.

[project.build_cache]
",
    );
    for (var, dir) in t.cache(repo) {
        out.push_str(&format!("{var} = \"{dir}\"\n"));
    }
    out
}

/// The commented example a project with no known toolchain gets instead.
fn cache_example() -> String {
    String::from(
        "# Directories every worktree of this project shares, so a task does not pay for a cold
# build. Each key is the environment variable a toolchain reads; each value is a
# directory outside every worktree — absolute, or under `~/`. Set on the agent and on
# the acceptance commands alike, since both build.
#
# [project.build_cache]
# CARGO_TARGET_DIR = \"~/.cache/wecode/this-repo/target\"
",
    )
}

/// The starter file. Kept as one string so `init` and the tests agree by
/// construction.
///
/// `language` decides which toolchain's commands are written; `repo` is the repository's
/// directory name, which the shared cache path is keyed on. A language no toolchain
/// answers to gets the prompts-and-TODO file this always wrote, and a line at the top
/// saying which languages would have got more.
#[must_use]
pub fn starter(language: &str, repo: &str) -> String {
    let tc = toolchain::of(language);
    let repo = slug(repo);

    let header = match tc {
        Some(t) => format!(
            "# The accept lines below are {}'s usual commands rather than this project's:\n\
             # run them once before you trust them, and change whatever this repo does\n\
             # differently.\n{}",
            t.name, t.hint
        ),
        None if language.trim().is_empty() => format!(
            "# No language was given and none could be read off this repository, so the\n\
             # accept lines are empty and every guidance is TODO. wecode can write a\n\
             # starter that knows: {}.\n",
            toolchain::known()
        ),
        None => format!(
            "# wecode has no toolchain for `{language}`, so the accept lines are empty and\n\
             # every guidance is TODO. It knows: {}.\n",
            toolchain::known()
        ),
    };
    let accept = tc.map_or_else(
        || "accept    = []            # e.g. [\"cargo test --workspace\"]".to_string(),
        |t| format!("accept    = {}", toml_list(t.accept)),
    );
    let cache = tc.map_or_else(cache_example, |t| cache_block(t, &repo));
    // The dirt line goes in every kind that changes code, because a planner reads one
    // kind and not the file. The seam note goes only where decomposition is decided.
    let dirt = tc.map_or_else(String::new, |t| format!("\n{}\n", wrap(&t.dirt(), 85)));
    let note = tc.map_or_else(String::new, |t| {
        format!("\n{}\n{}\n", wrap(&t.dirt(), 85), wrap(t.note, 85))
    });
    let sources = tc.map_or_else(|| toml_list(&["src/**"]), |t| toml_list(t.sources));

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
#
{header}
[project]
language = "{language}"
# The integration branch. Task branches are cut from it, and merge back into it.
# merge_to = "dev"
#
# Whether verified work lands by itself. `approved` (the default) waits for a
# signature; `auto` merges and reports what it did. The charter still outranks this —
# a branch it protects needs a signature whatever this says.
# merge = "approved"
#
# Whether a task may be dispatched before anyone signs for it. `auto` (the default)
# lets the admission gate be the only door; `approved` means no agent is spawned until
# a holder signs — `wecode approve admission --task <id>`. Turn it on where the work is
# planned by an agent, so a person sees each task before its budget is spent.
# dispatch = "approved"

{cache}
[feature]
worktree  = true
# Refuse a feature at admission unless a `design` task stands before it. A design
# waits for a signature once it passes, so nothing is built until a person signs.
# design_required = true
assign_to = "impl"
tokens    = 120000
wall_secs = 5400
{accept}
guidance  = """
TODO: how should a feature be broken down here?
Acceptance must be an executable command, never a description.
{note}"""
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
# write  = {sources}
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
{accept}
guidance  = """
TODO. A shape that works well: reproduce first, then a failing regression test,
then the fix. One cause per task. If the cause is unclear, make a spike subtask
first — a spike needs no write scope.
{dirt}"""

[refactor]
worktree  = true
assign_to = "impl"
tokens    = 90000
wall_secs = 3600
{accept}
guidance  = """
TODO. Behaviour must not change, so the acceptance is the existing suite passing
unchanged. Needing to edit a test means this is not a refactor.
{dirt}"""

[chore]
worktree  = true
assign_to = "impl"
tokens    = 40000
wall_secs = 1800
{accept}
guidance  = """
TODO.
{dirt}"""

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
        // nothing admissible. Checked for every toolchain and for none of them, since
        // the file is now assembled differently in each case.
        for language in languages() {
            let p = Playbook::parse(&starter(language, "app")).unwrap();
            for (kind, k) in p.kinds() {
                assert!(
                    k.tokens.is_some(),
                    "{language}: {kind:?} has no token budget"
                );
                assert!(
                    k.wall_secs.is_some(),
                    "{language}: {kind:?} has no wall budget"
                );
            }
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
    fn a_design_gate_is_off_unless_a_kind_asks_for_it() {
        let p = Playbook::parse(SAMPLE).unwrap();
        assert!(!p.for_kind(TaskKind::Bug).unwrap().design_required);
        assert!(p.design_required_kinds().is_empty());

        let p = Playbook::parse("[feature]\ndesign_required = true\n\n[bug]\n").unwrap();
        assert!(p.for_kind(TaskKind::Feature).unwrap().design_required);
        assert_eq!(p.design_required_kinds(), vec![TaskKind::Feature]);
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

    // -------------------------------------------------------- build cache ------

    #[test]
    fn a_project_declares_the_directories_its_worktrees_share() {
        let p = Playbook::parse(
            "[project.build_cache]\nCARGO_TARGET_DIR = \"~/.cache/w/target\"\nSCCACHE_DIR = \"/var/cache/sccache\"\n",
        )
        .unwrap();
        let c = &p.project.build_cache;
        assert_eq!(c.len(), 2);
        // Variable order, so two readings of one file cannot disagree about which
        // directory is reported first.
        assert_eq!(c[0].var, "CARGO_TARGET_DIR");
        assert_eq!(c[1].var, "SCCACHE_DIR");
    }

    #[test]
    fn declaring_nothing_shares_nothing() {
        // The default has to be "no cache" rather than a guessed one: a directory
        // wecode picked would be a build cache nobody asked for, in a place nobody
        // knows to clean up.
        assert!(
            Playbook::parse(SAMPLE)
                .unwrap()
                .project
                .build_cache
                .is_empty()
        );
    }

    #[test]
    fn the_home_in_a_cache_path_is_resolved_at_use_not_at_parse() {
        // Same rule as the accept check: parsing must not consult the machine, so one
        // playbook describes the same cache on two machines with different homes.
        let p =
            Playbook::parse("[project.build_cache]\nCARGO_TARGET_DIR = \"~/.cache/w\"\n").unwrap();
        let c = &p.project.build_cache[0];
        assert_eq!(c.path, "~/.cache/w", "kept as written");
        let dir = c.dir();
        assert!(dir.is_absolute(), "{dir:?}");
        assert!(!dir.to_string_lossy().contains('~'), "{dir:?}");
    }

    #[test]
    fn a_relative_cache_path_is_refused_and_says_why() {
        // The failure this rule exists for: `target/shared` resolves against the
        // running worktree, so every task would get its own copy under a name
        // promising the opposite — and nothing about it would look wrong.
        let msg = Playbook::parse("[project.build_cache]\nCARGO_TARGET_DIR = \"target/shared\"\n")
            .unwrap_err()
            .to_string();
        assert!(msg.contains("CARGO_TARGET_DIR"), "{msg}");
        assert!(msg.contains("relative"), "{msg}");
        assert!(
            msg.contains("worktree"),
            "should say where it would land: {msg}"
        );
    }

    #[test]
    fn a_key_that_is_not_an_environment_variable_is_refused() {
        let msg = Playbook::parse("[project.build_cache]\n\"cargo target\" = \"/tmp/t\"\n")
            .unwrap_err()
            .to_string();
        assert!(msg.contains("cargo target"), "{msg}");
        assert!(msg.contains("environment variable"), "{msg}");
    }

    #[test]
    fn a_variable_that_redirects_the_toolchain_is_not_a_cache() {
        // A build cache says where output goes. `PATH` says which program runs, and a
        // repository file that could set it would be choosing the toolchain for every
        // agent — which is what the env allowlist in company.toml is for.
        for var in ["PATH", "LD_PRELOAD"] {
            let msg = Playbook::parse(&format!("[project.build_cache]\n{var} = \"/tmp/t\"\n"))
                .unwrap_err()
                .to_string();
            assert!(msg.contains(var), "{msg}");
            assert!(msg.contains("which program runs"), "{msg}");
        }
    }

    #[test]
    fn a_known_toolchain_declares_its_cache_rather_than_offering_it() {
        // Live, not commented: the cost this closes is paid by the first task, which
        // starts before anybody has read far enough down the file to uncomment
        // anything. The sub-table must still sit after [project]'s scalar keys.
        let p = Playbook::parse(&starter("rust", "app")).unwrap();
        assert_eq!(p.project.build_cache.len(), 1);
        assert_eq!(p.project.build_cache[0].var, "CARGO_TARGET_DIR");
        assert_eq!(p.project.build_cache[0].path, "~/.cache/wecode/app/target");
        assert_eq!(
            p.project.language, "rust",
            "the sub-table must not swallow the keys above it"
        );
    }

    #[test]
    fn a_project_with_no_toolchain_is_offered_the_cache_commented_out() {
        // Uncommenting must work: same placement rule, and nothing is declared on a
        // project's behalf when wecode does not know what its toolchain reads.
        let text = starter("cobol", "app");
        assert!(
            Playbook::parse(&text)
                .unwrap()
                .project
                .build_cache
                .is_empty()
        );
        let live = text.replace(
            "# [project.build_cache]\n# CARGO_TARGET_DIR = \"~/.cache/wecode/this-repo/target\"",
            "[project.build_cache]\nCARGO_TARGET_DIR = \"~/.cache/wecode/this-repo/target\"",
        );
        assert_ne!(live, text, "the starter offers a build_cache example");
        let p = Playbook::parse(&live).expect("the commented example is valid TOML");
        assert_eq!(p.project.build_cache[0].var, "CARGO_TARGET_DIR");
        assert_eq!(p.project.language, "cobol");
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

    /// A starter with its `subtasks` example uncommented, as a reader would do it.
    fn with_the_template_live(text: &str) -> String {
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
        lines
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
            .join("\n")
    }

    #[test]
    fn the_starter_ships_the_template_commented_out() {
        // Uncommenting it must work: the example sits after `guidance`, so the
        // sub-tables it introduces do not swallow the fields above them.
        for language in languages() {
            let text = starter(language, "app");
            let p =
                Playbook::parse(&with_the_template_live(&text)).expect("the example is valid TOML");
            let k = p.for_kind(TaskKind::Feature).unwrap();
            assert_eq!(k.subtasks.len(), 3, "{language}");
            assert!(
                !k.guidance.is_empty(),
                "{language}: uncommenting must not move guidance into a sub-table"
            );
            assert_eq!(
                k.expand(TaskKind::Feature, "retry", "a title")[0].write,
                vec!["docs/wecode/retry/design.md".to_string()]
            );
        }
    }

    #[test]
    fn the_build_step_is_scoped_to_what_this_toolchain_builds_from() {
        // Including the files a build rewrites. `src/**` was the old answer for every
        // language, and a task that touched the lock file was reported as reaching
        // outside its scope — after its budget was spent.
        let p = Playbook::parse(&with_the_template_live(&starter("rust", "app"))).unwrap();
        let build =
            &p.for_kind(TaskKind::Feature)
                .unwrap()
                .expand(TaskKind::Feature, "retry", "a title")[1];
        assert!(build.write.contains(&"crates/**".to_string()), "{build:?}");
        assert!(build.write.contains(&"Cargo.lock".to_string()), "{build:?}");
    }

    fn temp(name: &str) -> PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-pb-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ---------------------------------------------------- machine check ------

    /// A repo with this text planted as its playbook, for the load-time checks.
    fn planted(name: &str, text: &str) -> PathBuf {
        let repo = temp(name);
        let path = repo.join(PLAYBOOK_PATH);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
        repo
    }

    const NO_SUCH: &str = "definitely-not-a-real-binary-xyz";

    #[test]
    fn parse_never_consults_the_machine() {
        // The purity pin: the same file must still parse on a machine without the
        // toolchain, so the machine check belongs to loading, not parsing.
        let p = Playbook::parse(&format!("[bug]\naccept = [\"{NO_SUCH} --check\"]\n")).unwrap();
        assert_eq!(p.for_kind(TaskKind::Bug).unwrap().accept.len(), 1);
    }

    #[test]
    fn an_accept_program_the_machine_lacks_refuses_the_playbook_at_load() {
        let repo = planted(
            "no-such-program",
            &format!("[bug]\naccept = [\"{NO_SUCH} --check\"]\n"),
        );
        let msg = Playbook::at(&repo).unwrap_err().to_string();
        assert!(msg.contains(NO_SUCH), "{msg}");
        assert!(msg.contains("[bug]"), "should say which kind: {msg}");
        assert!(msg.contains("not on this machine"), "{msg}");
    }

    #[test]
    fn a_subtask_accept_is_checked_too() {
        // Template drift multiplies one wrong default into every expansion, which
        // is where the check pays most.
        let repo = planted(
            "no-such-in-step",
            &format!(
                "[feature]\nsubtasks = [\"build\"]\n\n[feature.build]\naccept = [\"{NO_SUCH}\"]\n"
            ),
        );
        let msg = Playbook::at(&repo).unwrap_err().to_string();
        assert!(msg.contains(NO_SUCH), "{msg}");
        assert!(msg.contains("[feature.build]"), "{msg}");
    }

    #[test]
    fn an_env_prefix_does_not_hide_the_program() {
        let repo = planted(
            "env-prefix",
            &format!("[bug]\naccept = [\"RUST_LOG=debug {NO_SUCH}\"]\n"),
        );
        let msg = Playbook::at(&repo).unwrap_err().to_string();
        assert!(msg.contains(NO_SUCH), "{msg}");
    }

    #[test]
    fn a_builtin_and_a_real_program_both_load() {
        // `test` may be a builtin with no file behind it; `sh` is on any machine
        // these tests run on. Neither is a refusal.
        let repo = planted(
            "programs-exist",
            "[bug]\naccept = [\"test -f README.md\", \"sh -c 'exit 0'\"]\n",
        );
        assert!(Playbook::at(&repo).unwrap().is_some());
    }

    #[test]
    fn a_line_the_check_cannot_read_is_left_to_verification() {
        // A path into the worktree or a substitution takes a shell (and a worktree)
        // to resolve. Refusing on a guess would refuse working playbooks, so the
        // check stays silent wherever it cannot be sure.
        let repo = planted(
            "unreadable-lines",
            "[bug]\naccept = [\"./scripts/check.sh --all\", \"\\\"$CHECK\\\" --all\"]\n",
        );
        assert!(Playbook::at(&repo).unwrap().is_some());
    }

    #[test]
    fn a_repo_without_a_playbook_is_not_an_error() {
        let repo = temp("absent");
        assert!(Playbook::at(&repo).unwrap().is_none());
    }

    #[test]
    fn init_writes_a_file_that_parses_and_refuses_to_overwrite() {
        let repo = temp("init");
        let w = init(&repo, "rust").unwrap();
        assert!(w.path.ends_with(PLAYBOOK_PATH));

        // The starter must be valid, or adoption fails at the first step. Parsed rather
        // than loaded: whether this machine has `cargo` is a separate question, and the
        // one `playbook init` reports rather than decides.
        let loaded = Playbook::parse(&fs::read_to_string(&w.path).unwrap())
            .expect("the written playbook parses");
        assert_eq!(loaded.project.language, "rust");
        assert!(loaded.for_kind(TaskKind::Bug).unwrap().worktree);
        assert!(!loaded.for_kind(TaskKind::Docs).unwrap().worktree);

        assert!(matches!(
            init(&repo, "rust").unwrap_err(),
            PlaybookError::AlreadyExists(_)
        ));
    }

    // -------------------------------------------------------- per language ------

    /// Every language the starter is written for, plus one it is not.
    fn languages() -> Vec<&'static str> {
        let mut all: Vec<&str> = toolchain::all().iter().map(|t| t.name).collect();
        all.push("cobol");
        all
    }

    #[test]
    fn the_starter_covers_every_kind() {
        // A kind added to core without a starter section would silently get no
        // guidance in every new project — in any language.
        for language in languages() {
            let p = Playbook::parse(&starter(language, "app")).unwrap();
            for k in TaskKind::all() {
                assert!(
                    p.for_kind(*k).is_some(),
                    "{language}: {k:?} missing from the starter"
                );
            }
        }
    }

    #[test]
    fn a_known_language_arrives_with_the_commands_that_judge_it() {
        // The gap this closes: `accept = []` in every new project, so the first task
        // of every kind was accepted by nothing until somebody typed a command in.
        let p = Playbook::parse(&starter("rust", "app")).unwrap();
        for kind in [
            TaskKind::Feature,
            TaskKind::Bug,
            TaskKind::Refactor,
            TaskKind::Chore,
        ] {
            assert_eq!(
                p.for_kind(kind).unwrap().accept,
                vec![
                    "cargo test --workspace".to_string(),
                    "cargo clippy --all-targets -- -D warnings".to_string(),
                ],
                "{kind:?}"
            );
        }
        // A design is judged by its file existing, whatever the language is.
        assert_eq!(
            p.for_kind(TaskKind::Design).unwrap().accept,
            vec!["test -f docs/wecode/{{task}}/design.md".to_string()]
        );
    }

    #[test]
    fn an_unknown_language_gets_the_file_it_always_got_and_says_so() {
        let text = starter("cobol", "app");
        let p = Playbook::parse(&text).unwrap();
        assert_eq!(p.project.language, "cobol");
        assert!(p.for_kind(TaskKind::Bug).unwrap().accept.is_empty());
        assert!(p.project.build_cache.is_empty());
        // And the file names what it could have written instead, since a person who
        // mistyped `rsut` has no other way to find out.
        assert!(text.contains("no toolchain for `cobol`"), "{text}");
        assert!(text.contains("rust"), "{text}");
    }

    #[test]
    fn every_toolchain_writes_a_playbook_that_parses_whole() {
        // One table row with a stray quote or a relative cache path would produce a
        // file that refuses itself, in a repository that has nothing else yet.
        for t in toolchain::all() {
            let p = Playbook::parse(&starter(t.name, "app"))
                .unwrap_or_else(|e| panic!("{}: {e}", t.name));
            assert_eq!(p.project.language, t.name);
            assert_eq!(p.for_kind(TaskKind::Feature).unwrap().accept, t.accept);
            assert_eq!(p.project.build_cache.len(), t.cache("app").len());
        }
    }

    #[test]
    fn every_accept_command_a_starter_writes_can_be_checked_against_the_machine() {
        // The load-time check reads a line's first word and stays silent where it
        // cannot. A table entry it could not read would be a command promising a
        // toolchain with nothing verifying the machine has it.
        for t in toolchain::all() {
            for cmd in t.accept {
                assert!(
                    program_of(cmd).is_some(),
                    "{}: `{cmd}` is not readable by the machine check",
                    t.name
                );
            }
        }
    }

    /// Guidance as one line, so an assertion is about the words and not about where
    /// the wrapping happened to break them.
    fn flat(text: &str) -> String {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn a_code_kind_says_what_a_build_rewrites() {
        // The trap that cost a task: `uv.lock` changed by the build, no such glob in
        // the write scope, and the work reported as reaching outside it. The planner
        // reads one kind, so the sentence goes in each kind that changes code.
        let p = Playbook::parse(&starter("python", "app")).unwrap();
        for kind in [TaskKind::Feature, TaskKind::Bug, TaskKind::Chore] {
            let g = flat(&p.for_kind(kind).unwrap().guidance);
            assert!(g.contains("rewrites uv.lock"), "{kind:?}: {g}");
            assert!(g.contains("write scope"), "{kind:?}: {g}");
        }
        // And where the decomposition is decided, how the work splits.
        assert!(flat(&p.for_kind(TaskKind::Feature).unwrap().guidance).contains("uv add"));
    }

    #[test]
    fn generated_prose_is_wrapped_to_the_width_the_file_is_written_at() {
        // A 150-column line in a file whose whole purpose is being read and edited by
        // hand. The table states each sentence as one line; the wrapping is here.
        for language in languages() {
            for line in starter(language, "app").lines() {
                assert!(
                    line.chars().count() <= 100,
                    "{language}: {} columns: {line}",
                    line.chars().count()
                );
            }
        }
    }

    #[test]
    fn init_reads_the_language_off_the_repository_when_nobody_says() {
        let repo = temp("init-detect");
        fs::write(repo.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();

        let w = init(&repo, "").unwrap();
        assert_eq!(w.language, "rust");
        assert_eq!(w.detected_from, Some("Cargo.toml"));
        assert_eq!(w.toolchain.map(|t| t.name), Some("rust"));
        assert_eq!(w.cache[0].0, "CARGO_TARGET_DIR");
        // The cache is keyed on the repository's directory name, so two projects on
        // this machine do not queue behind one another's build lock for no reason.
        assert!(
            w.cache[0].1.ends_with("/wecode-pb-init-detect/target"),
            "{:?}",
            w.cache
        );
    }

    #[test]
    fn a_language_that_was_given_beats_the_one_that_can_be_seen() {
        // A repository carrying two manifests is exactly where a person needs the last
        // word, and saying it must not be silently overruled by a file.
        let repo = temp("init-override");
        fs::write(repo.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();

        let w = init(&repo, "python").unwrap();
        assert_eq!(w.language, "python");
        assert_eq!(w.detected_from, None, "nothing was detected — it was told");
        assert_eq!(
            Playbook::parse(&fs::read_to_string(&w.path).unwrap())
                .unwrap()
                .for_kind(TaskKind::Bug)
                .unwrap()
                .accept[0],
            "uv run pytest -q"
        );
    }

    #[test]
    fn a_repository_that_names_no_language_still_gets_a_playbook() {
        let repo = temp("init-nothing");
        let w = init(&repo, "").unwrap();
        assert!(w.language.is_empty());
        assert!(w.toolchain.is_none());
        assert!(w.cache.is_empty());

        // And it loads, because nothing in it names a program: the TODO file is the
        // one that could never be refused by the machine check.
        let loaded = Playbook::at(&repo).unwrap().expect("the starter loads");
        assert!(
            loaded
                .for_kind(TaskKind::Feature)
                .unwrap()
                .accept
                .is_empty()
        );
    }

    #[test]
    fn a_repository_name_that_is_not_a_path_segment_is_reduced_to_one() {
        // The cache path is a directory and a TOML string at once. A repo called
        // `my repo "2"` must break neither.
        let repo = temp("init slug \"x\"");
        let w = init(&repo, "rust").unwrap();
        assert_eq!(
            w.cache[0].1,
            "~/.cache/wecode/wecode-pb-init-slug--x-/target"
        );
        Playbook::parse(&fs::read_to_string(&w.path).unwrap()).expect("still valid TOML");
    }
}
