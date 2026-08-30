//! The fixtures every end-to-end test is built out of.
//!
//! The suite exists because the three worst bugs so far were all integration bugs
//! that unit tests structurally could not catch — a hardcoded attribution, a
//! per-process audit sequence, and a root-kind being refused admission. Each needed
//! the whole pipeline running, which means each needs a real workspace, a real
//! repository, and the real binary.
//!
//! That apparatus lives here so the suite can be more than one file. Every
//! `tests/*.rs` beside this module is its own test binary covering one area and
//! pulling these fixtures in, which is what lets two people add tests to two areas
//! without ever editing the same file.
//!
//! Helpers narrower than this — the ones a single area leans on — belong in that
//! area's file rather than here, and moving one in is a decision to be made when a
//! second area actually wants it. What is here is what more than one area already
//! shares: the workspace, the fixture repository, and the submodules for the
//! guidance a task reads ([`playbook`]), the agent that does the work ([`agent`]),
//! and landing what it produced ([`merge`]).
//!
//! Every binary compiles the whole module, so whatever a given one does not reach
//! is dead code by construction. The allow below is that, and not licence to leave
//! a genuinely unused fixture lying about.
#![allow(dead_code)]

pub(crate) mod agent;
pub(crate) mod merge;
pub(crate) mod playbook;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Result of one invocation, with both streams decoded.
pub(crate) struct Run {
    pub(crate) status: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

impl Run {
    pub(crate) fn ok(&self) -> bool {
        self.status == 0
    }

    /// Everything the command emitted, for assertions that do not care which
    /// stream carried it.
    pub(crate) fn all(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }

    pub(crate) fn assert_ok(&self, what: &str) -> &Self {
        assert!(
            self.ok(),
            "{what} failed (status {})\nstdout:\n{}\nstderr:\n{}",
            self.status,
            self.stdout,
            self.stderr
        );
        self
    }

    pub(crate) fn assert_contains(&self, needle: &str) -> &Self {
        assert!(
            self.all().contains(needle),
            "expected {needle:?} in output:\n{}",
            self.all()
        );
        self
    }

    pub(crate) fn assert_lacks(&self, needle: &str) -> &Self {
        assert!(
            !self.all().contains(needle),
            "did not expect {needle:?} in output:\n{}",
            self.all()
        );
        self
    }
}

pub(crate) fn decode(out: Output) -> Run {
    Run {
        status: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

/// A company workspace scoped to one test.
pub(crate) struct Org {
    pub(crate) dir: PathBuf,
}

impl Org {
    /// Creates a fresh workspace. Each test gets its own: they run in parallel,
    /// and the store is append-only shared state.
    ///
    /// `name` has to be unique across the whole suite, not just across this file —
    /// the directory is derived from it, and the binaries share a temp directory.
    pub(crate) fn new(name: &str, template: &str) -> Self {
        let org = Self::unattended(name, template);
        // Most tests act as somebody. The few that check the refusal path use
        // `unattended` instead.
        org.run(&["login", "you"]).assert_ok("login");
        org
    }

    /// A workspace with nobody logged in.
    pub(crate) fn unattended(name: &str, template: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("wecode-e2e-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        let org = Self { dir };
        org.run(&["init", org.dir.to_str().unwrap(), "--template", template])
            .assert_ok("init");
        org
    }

    /// Runs the binary against this workspace.
    pub(crate) fn run(&self, args: &[&str]) -> Run {
        self.run_env(&[], args)
    }

    /// The same, with variables laid over the environment the binary is given.
    ///
    /// For the few things wecode reads at the door rather than out of the plan.
    /// `WECODE_LIVE` is one and cannot be asked for any other way, deliberately: a tier
    /// written into the plan would be a standing instruction, where a variable set on one
    /// invocation cannot outlive it. A test that wants the second tier therefore has to
    /// ask for it exactly as an operator does — and `set_var` is not that, since it would
    /// also set it for every other test sharing the process.
    pub(crate) fn run_env(&self, env: &[(&str, &str)], args: &[&str]) -> Run {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_wecode"));
        // `init` names its own target directory, so --org would be wrong there.
        if args.first() != Some(&"init") {
            cmd.arg("--org").arg(&self.dir);
        }
        cmd.args(args);
        // Never inherit — or clobber — anything from the developer's environment.
        // WECODE_CONFIG in particular: `use` writes a default there, and without
        // isolation a test run overwrites the real one.
        cmd.env_remove("WECODE_ORG");
        // The acceptance tier for the same reason: a `WECODE_LIVE` exported in whatever
        // shell runs the suite would otherwise send every verdict here at the real
        // infrastructure a `live:` check names, on that person's own credentials.
        cmd.env_remove("WECODE_LIVE");
        cmd.env("WECODE_CONFIG", self.dir.join("config"));
        cmd.envs(env.iter().copied());
        decode(cmd.output().expect("binary runs"))
    }

    /// Plants the committed toy fixture as a real git repository, and points the
    /// workspace's `app` repo at it.
    ///
    /// Copied from `fixtures/toy/` rather than generated inline: a fixture that lives
    /// in the tree can be read, changed deliberately, and reproduced by hand a week
    /// later. It cannot be committed *as* a repository — nested repos — so `git init`
    /// happens here.
    pub(crate) fn repo(&self) -> PathBuf {
        let repo = self.dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        copy_dir(&fixture_root().join("toy"), &repo);
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            git(&repo, &args);
        }
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "the toy fixture"]);

        let conf = self.path("company.toml");
        let text = std::fs::read_to_string(&conf).unwrap();
        std::fs::write(
            &conf,
            text.replace("~/projects/your-repo", repo.to_str().unwrap()),
        )
        .unwrap();
        repo
    }

    /// Replaces the agent template so a test can stand in a shell script for a
    /// coding CLI. Real process, real supervision — only the binary differs.
    pub(crate) fn agent(&self, script: &str) {
        let conf = self.path("company.toml");
        let text = std::fs::read_to_string(&conf).unwrap();
        // Matched by shape rather than by literal, so adding a flag to the shipped
        // template does not silently turn every stub agent into `sh --allowedTools`.
        let args = format!("args = [\"-c\", \"{}\"]", script.replace('"', "\\\""));
        let replaced: String = text
            .replace("command = \"claude\"", "command = \"sh\"")
            .lines()
            .map(|l| {
                if l.starts_with("args = [\"-p\"") {
                    args.clone()
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_ne!(replaced, text, "agent template was not replaced");
        std::fs::write(&conf, replaced).unwrap();
    }

    /// The fixture with its playbook removed, for the tests about not having one.
    pub(crate) fn repo_without_playbook(&self) -> PathBuf {
        let repo = self.repo();
        std::fs::remove_file(repo.join(".wecode/playbook.toml")).unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "no playbook"]);
        repo
    }

    /// Writes a playbook into the repo. Explicit rather than via `playbook init`, so
    /// a test states exactly the guidance it depends on.
    pub(crate) fn playbook(&self, repo: &Path, body: &str) {
        let dir = repo.join(".wecode");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("playbook.toml"), body).unwrap();
        // Committed, as it would be in a real repo. Left uncommitted it shows up in
        // every diff as a change the task did not make.
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "playbook"]);
    }

    pub(crate) fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }

    /// Every worktree the workspace has recorded, tombstones included.
    ///
    /// Read out of the database the binary wrote, because no command prints it yet —
    /// making it visible is `worktree-view`'s job, and it depends on this. Until then
    /// opening the file is the only way to prove the writes actually happen.
    pub(crate) fn recorded(&self) -> Vec<wecode_store::Worktree> {
        wecode_store::Store::open(self.dir.join("wecode.db"))
            .expect("the workspace database")
            .worktrees()
            .expect("the registry")
    }

    /// Builds the project and tasks used by several tests.
    ///
    /// `bench` depends on `cache-tests` so the dependency relation is exercised
    /// end to end, not just in unit tests.
    pub(crate) fn seed(&self) {
        self.run(&[
            "project",
            "add",
            "caching",
            "add response caching to the export endpoint",
            "--repo",
            "app",
            "--measure-cmd",
            "cargo test",
            "--tokens",
            "200000",
            "--wall",
            "1800",
        ])
        .assert_ok("add project");
        self.run(&[
            "task",
            "add",
            "cache-tests",
            "cover the cache layer with tests",
            "--project",
            "caching",
            "--accept-cmd",
            "cargo test",
            "--write",
            "tests/**",
            "--tokens",
            "50000",
        ])
        .assert_ok("add task");
        self.run(&[
            "task",
            "add",
            "bench",
            "benchmark the cache under load",
            "--project",
            "caching",
            "--after",
            "cache-tests",
            "--accept-cmd",
            "cargo bench",
            // Under tests/, so the tester's grant covers it. It overlaps
            // cache-tests, which is legal precisely because it is sequenced after.
            "--write",
            "tests/bench/**",
            "--tokens",
            "20000",
        ])
        .assert_ok("add dependent task");
    }
}

/// Where the committed fixtures live, independent of the test's working directory.
fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/wecode-cli has a workspace root")
        .join("fixtures")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).expect("fixture exists").flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if src.is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

pub(crate) fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Trimmed stdout of a read-only git command, for asserting on what actually landed.
pub(crate) fn git_out(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A well-formed `project add`, for tests about sessions and authority rather
/// than about the plan. Defined once so a change to admission does not need
/// editing in a dozen places.
pub(crate) const ADD_PROJECT: &[&str] = &[
    "project",
    "add",
    "v",
    "add response caching to the export endpoint",
    "--repo",
    "app",
    "--measure-cmd",
    "cargo test",
    "--tokens",
    "100",
    "--wall",
    "60",
];

/// Runs the binary with no workspace at all.
pub(crate) fn bare(args: &[&str]) -> Run {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wecode"));
    cmd.args(args);
    cmd.env_remove("WECODE_ORG");
    cmd.env(
        "WECODE_CONFIG",
        std::env::temp_dir().join("wecode-e2e-noconfig"),
    );
    // A directory guaranteed to contain no company.toml, and no parent that does.
    cmd.current_dir(Path::new("/"));
    decode(cmd.output().expect("binary runs"))
}

/// Whether `sh` could start this program here. The same question the playbook's
/// load-time check asks, asked by a test that must pass on either kind of machine.
pub(crate) fn which(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|p| p.is_file())
    })
}
