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
//! One file, and a module per block of it — each holding that block's wire shape, the
//! domain type it becomes, and the typos it refuses:
//!
//! | | |
//! |---|---|
//! | `project` | `[project]` — what holds for every kind here |
//! | `cache` | `[project.build_cache]` — the directories worktrees share |
//! | `kind` | `[feature]`, `[bug]`, … — what this project says about one kind of work |
//! | `subtask` | `[feature.design]`, … — how that kind breaks down |
//! | `starter` | the file `playbook init` writes, which is the only one that writes |
//!
//! What stays here is the file as a whole: where it sits, the error every block reports
//! through, and loading — which is the one machine-dependent step. An `accept` line
//! whose program is not on this machine refuses the playbook at [`Playbook::at`], not
//! in [`Playbook::parse`], because the same file is legal on a machine that has the
//! toolchain. Found at load the mistake costs one edit; left in, verification discovers
//! it as exit 127, once per task and only after each budget is spent.
//!
//! [`CacheDir`] keeps to the same rule from the other end: its `~` is resolved by
//! [`CacheDir::dir`] rather than at parse, so one playbook describes the same cache on
//! two machines with different homes.

mod cache;
mod kind;
mod project;
mod starter;
mod subtask;

pub use cache::CacheDir;
pub use kind::KindPlaybook;
pub use project::{DispatchPolicy, MergePolicy, ProjectSettings};
pub use starter::{Written, init, starter};
pub use subtask::{Subtask, SubtaskTemplate};

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
    project: project::ProjectBlock,
    #[serde(flatten)]
    kinds: BTreeMap<String, kind::KindBlock>,
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
        Ok(Self {
            project: project::settings_of(&w.project)?,
            kinds: kind::kinds_of(w.kinds)?,
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

/// A small playbook that says something about two kinds, shared with the tests in
/// every module below this one. Each of them asserts about the part it owns.
#[cfg(test)]
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

/// A starter with its `subtasks` example uncommented, as a reader would do it.
#[cfg(test)]
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

/// An empty directory of its own, for the tests that touch a repository.
#[cfg(test)]
fn temp(name: &str) -> PathBuf {
    let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
    let dir = Path::new(&base).join(format!("wecode-pb-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_playbook_is_legal_and_empty() {
        let p = Playbook::parse("").unwrap();
        assert!(p.is_empty());
        assert!(p.project.merge_to.is_none());
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
}
