//! Judging finished work from what it actually did.
//!
//! Two questions, both answered without asking the agent:
//!
//! - **Did it stay in scope?** From the branch's own diff, not from a self-report — and
//!   from all of it, including the attempts already committed on it.
//! - **Does it pass?** By running the acceptance commands here, not by being told.
//!
//! That ordering is the design's own rule — the diff always wins. An agent's
//! `result.json` is useful for a summary and inadmissible as evidence, so nothing in
//! this module reads it.
//!
//! Post-hoc rather than intercepted, because wecode cannot hook another process's
//! writes. Confinement is the worktree; this is the check afterwards. It is why a
//! write outside scope is *sanctioned* — recoverable — rather than prevented.
//!
//! Recovered here, and not only recorded. The write has already happened by the time
//! anything looks, but nothing has *landed*: wecode decides what the attempt commits,
//! and a refused path is left out of it. That is the half of enforcement that is not
//! too late, and without it a denial was a sentence in the ledger about a file already
//! sitting on the branch.

use std::path::{Path, PathBuf};
use std::process::Command;

use wecode_core::{Measure, Scope, TaskId};
use wecode_gov::glob;

use crate::git;

/// One acceptance command, run.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Check {
    pub(crate) cmd: String,
    /// `None` when the command could not be started at all.
    pub(crate) status: Option<i32>,
    pub(crate) expected: i32,
}

/// `sh` reports a command it could not find this way. Worth separating: the check
/// did not run, so calling it a failure blames the work for a broken environment.
const NOT_FOUND: i32 = 127;

impl Check {
    pub(crate) fn passed(&self) -> bool {
        self.status == Some(self.expected)
    }

    /// Whether the command could not be found. Never a verdict about the work.
    pub(crate) fn missing(&self) -> bool {
        self.status == Some(NOT_FOUND) && self.expected != NOT_FOUND
    }

    pub(crate) fn describe(&self) -> String {
        match self.status {
            Some(c) if c == self.expected => format!("exit {c}"),
            Some(c) if self.missing() => format!("exit {c} — command not found"),
            Some(c) => format!("exit {c}, wanted {}", self.expected),
            None => "did not start".to_string(),
        }
    }
}

/// What a task's work touched, and the tree it touched it in.
///
/// The tree travels with the paths because the next question asked of them — which of
/// them the scope refuses — is also the last moment anything holds both halves at once.
/// A refusal that cannot name the tree it happened in can be recorded and nothing more;
/// one that can is a refusal the commit afterwards is able to honour. Returning bare
/// strings is what made the finding un-actable, and the finding was already true.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub(crate) struct Changed {
    dir: PathBuf,
    paths: Vec<String>,
}

impl Changed {
    pub(crate) fn paths(&self) -> &[String] {
        &self.paths
    }

    pub(crate) fn len(&self) -> usize {
        self.paths.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }
}

impl<'a> IntoIterator for &'a Changed {
    type Item = &'a String;
    type IntoIter = std::slice::Iter<'a, String>;

    fn into_iter(self) -> Self::IntoIter {
        self.paths.iter()
    }
}

/// Everything observed about one finished task.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub(crate) struct Verdict {
    pub(crate) changed: Changed,
    /// Changed paths the task's write scope does not cover.
    pub(crate) violations: Vec<String>,
    pub(crate) checks: Vec<Check>,
    /// Acceptance measures that no command can settle. A task cannot carry one — the
    /// admission gate refuses `Judged` on a task — so this stays empty in practice
    /// and exists so the count is never silently wrong.
    pub(crate) unjudgeable: Vec<String>,
}

impl Verdict {
    /// Checks that could not run at all. An environment problem, reported apart from
    /// the verdict so a missing toolchain never reads as failing work.
    pub(crate) fn unrunnable(&self) -> Vec<&Check> {
        self.checks.iter().filter(|c| c.missing()).collect()
    }

    pub(crate) fn passed(&self) -> bool {
        self.violations.is_empty()
            && self.unjudgeable.is_empty()
            && !self.checks.is_empty()
            && self.checks.iter().all(Check::passed)
    }
}

/// The worker-writable area. The task envelope instructs the agent to write its
/// result here, so counting it as a scope violation would fail every task for doing
/// exactly what it was told.
fn is_worker_area(path: &str) -> bool {
    path.starts_with(wecode_core::WORKER_DIR)
}

/// Every path this task's work touched in `dir`, committed attempts included.
///
/// Not the uncommitted diff alone, which is what this used to be and what left a hole
/// exactly one retry wide. wecode commits each attempt, pass or fail, and a retry opens
/// with `git reset --hard`: by the time a second attempt is judged, the first one's
/// writes are *behind* `HEAD`, where `git diff HEAD` cannot see them. So an attempt that
/// added nothing was judged against an empty diff — and an empty diff violates no scope.
/// A first attempt rejected for writing outside its scope passed on the retry that
/// changed nothing, with the out-of-scope file still standing on the branch, on its way
/// to a merge. The retry did not overturn the finding; it stopped looking.
///
/// The acceptance commands never had this problem — they run against the worktree, which
/// carries the committed work whether or not anything is uncommitted. It was only the
/// half of the verdict that reads the diff that could be emptied out this way, which is
/// why the failure is quiet: a passing check beside a blank diff reads as a clean run.
///
/// Attempts are picked out by subject rather than taken wholesale. A subtask shares its
/// parent's branch and its siblings' attempts are in the same log, each already judged
/// against its own scope; and the base carries the predecessor work this task was cut
/// from, which is not this task's to answer for.
///
/// The window is [`git::attempts_on`]'s — the newest twenty commits wecode made here —
/// so a branch carrying more than that behind the current attempt is read from the last
/// twenty. That is the same history `wecode show` and the handoff already read, and
/// widening it belongs there rather than in one caller's copy of the question.
pub(crate) fn changed(dir: &Path, id: &TaskId) -> Result<Changed, git::GitError> {
    let mut all = git::changed_files(dir)?;
    let mine = format!("{id}: attempt");
    for (sha, subject) in git::attempts_on(dir)? {
        if subject.starts_with(&mine) {
            // The file list is the whole of what a scope check wants. The diff body is
            // the handoff's business, so it is asked for at zero bytes and dropped.
            let (files, _) = git::commit_summary(dir, &sha, 0)?;
            all.extend(files);
        }
    }
    all.sort();
    all.dedup();
    Ok(Changed {
        dir: dir.to_path_buf(),
        paths: all,
    })
}

/// Changed paths the scope does not permit — named, and kept out of the commit.
///
/// An empty write scope means the task claimed it would change nothing, so *any*
/// change is a violation — not a free pass. A spike is the kind that legitimately
/// has no scope, and a spike that edited files did something it did not declare.
///
/// Naming a refused write and stopping it from landing are one act, which is why they
/// are one function. Sanctioned means *recoverable*, and until now nothing recovered:
/// wecode commits every attempt, pass or fail, so the file the verdict had just refused
/// went onto the branch in the same breath — and a branch that carries it is a branch
/// that merges it, since a later attempt can pass while the refused write sits behind
/// `HEAD` in an attempt commit nobody re-reads. The record said no and the repository
/// said yes. [`git::refuse`] is the note that settles it, left for the commit that
/// follows this verdict; the writes themselves stay in the tree, where the next verdict
/// can still see them and the retry's reset is what clears them.
///
/// Only in a worktree wecode made — the same line `commit_attempt` draws, and for the
/// same reason. A task the playbook gave no worktree is judged in the operator's own
/// checkout, where wecode commits nothing and therefore has nothing to hold back.
///
/// A note that cannot be written changes nothing about the verdict, which is why the
/// failure is dropped rather than raised: the refusal has already been recorded against
/// the task by the time anything is committed, and the ledger is the half that must not
/// be lost.
pub(crate) fn violations(changed: &Changed, scope: &Scope) -> Vec<String> {
    let refused: Vec<String> = changed
        .paths()
        .iter()
        .filter(|p| !is_worker_area(p) && !glob::any_matches(&scope.write, p))
        .cloned()
        .collect();
    if commits_here(&changed.dir) {
        let _ = git::refuse(&changed.dir, &refused);
    }
    refused
}

/// Whether wecode is the one that commits in this tree.
///
/// The same line `commit_attempt` draws, named rather than repeated as a path test: a
/// verdict holds back only what it would otherwise have committed itself.
fn commits_here(dir: &Path) -> bool {
    dir.starts_with(crate::work::run_root())
}

/// Runs the acceptance commands in `dir`.
///
/// Through `sh -c`, because acceptance is written as a shell line — `cargo clippy
/// --all-targets -- -D warnings` is not an argv this could split correctly.
///
/// `env` is the project's shared build cache — see [`crate::cache`]. Acceptance is the
/// second cold build a worktree pays for and usually the larger one: the agent may
/// have run `cargo check`, this runs the suite. Setting it on the agent alone would
/// have shared half a cache.
///
/// Unlike a spawned agent's, this environment is inherited: these commands are the
/// operator's own, run by wecode, and they need the toolchain the operator has. The
/// declared variables are laid over it, so a project's answer for this repository beats
/// whatever the shell was carrying.
pub(crate) fn run_acceptance(
    dir: &Path,
    measures: &[Measure],
    env: &[(String, std::path::PathBuf)],
) -> Verdict {
    let mut v = Verdict::default();
    for m in measures {
        match m {
            Measure::Command { cmd, expect_status } => {
                let status = Command::new("sh")
                    .arg("-c")
                    .arg(cmd)
                    .current_dir(dir)
                    .envs(env.iter().map(|(k, v)| (k, v)))
                    .status()
                    .ok()
                    .and_then(|s| s.code());
                v.checks.push(Check {
                    cmd: cmd.clone(),
                    status,
                    expected: *expect_status,
                });
            }
            // Nothing here can settle these. Naming them beats counting a task as
            // passed on the strength of the measures that happened to be runnable.
            other => v.unjudgeable.push(other.describe()),
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::Cmp;

    fn scope(globs: &[&str]) -> Scope {
        Scope::write(globs)
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    /// A diff read from nowhere. The scope half of a verdict is a question about names,
    /// so most of these tests have no tree to point at — and one that is not under the
    /// run root is one wecode never commits in, which is exactly the guard.
    fn touched(list: &[&str]) -> Changed {
        Changed {
            dir: PathBuf::new(),
            paths: paths(list),
        }
    }

    /// Acceptance with no shared cache — what a project that declares none gets.
    fn ran(dir: &Path, measures: &[Measure]) -> Verdict {
        run_acceptance(dir, measures, &[])
    }

    fn cmd(line: &str) -> Measure {
        Measure::Command {
            cmd: line.to_string(),
            expect_status: 0,
        }
    }

    /// A real repository, standing where a task's worktree would. git is a subprocess,
    /// so faking it would test nothing — least of all the part that only shows up once
    /// a commit is between the work and `HEAD`.
    fn worktree(name: &str) -> std::path::PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-verify-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let run = |args: &[&str]| {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "operator@localhost"]);
        run(&["config", "user.name", "operator"]);
        // Base history, by a hand other than wecode's: what the branch was cut from is
        // never the task's answer to give.
        write(&dir, "README.md", "the project\n");
        run(&["add", "-A"]);
        run(&["commit", "-qm", "the base this branch was cut from"]);
        dir
    }

    fn write(dir: &Path, path: &str, body: &str) {
        let full = dir.join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, body).unwrap();
    }

    /// One finished attempt, committed exactly as `run` commits one.
    fn attempt(dir: &Path, id: &str, n: u32, files: &[(&str, &str)]) {
        for (path, body) in files {
            write(dir, path, body);
        }
        git::commit_all(dir, &format!("{id}: attempt {n}\n\nexit 0"))
            .unwrap()
            .expect("the attempt changed something");
    }

    /// The retry itself: wecode resets the tree before handing it to the next agent.
    fn retry(dir: &Path) {
        git::reset_hard(dir).unwrap();
    }

    #[test]
    fn a_retry_that_added_nothing_is_still_judged_on_what_the_branch_carries() {
        // The whole point. Attempt 1 wrote outside its scope and was rejected for it;
        // attempt 2 did nothing at all. Reading only the working tree, the second
        // verdict saw an empty diff, found no violation in it, and passed work whose
        // out-of-scope file was still sitting on the branch waiting to be merged.
        let dir = worktree("retry-adds-nothing");
        attempt(
            &dir,
            "t1",
            1,
            &[("src/a.rs", "fn a() {}\n"), ("Cargo.toml", "[package]\n")],
        );
        retry(&dir);

        let changed = changed(&dir, &TaskId::new("t1")).unwrap();
        assert_eq!(changed.paths(), ["Cargo.toml", "src/a.rs"]);
        assert_eq!(
            violations(&changed, &scope(&["src/**"])),
            vec!["Cargo.toml".to_string()]
        );
    }

    #[test]
    fn the_work_a_retry_did_add_joins_the_work_it_inherited() {
        // Both halves, once, in one list: the retry's own uncommitted writes and the
        // attempt underneath them. A file touched by both is one path, not two.
        let dir = worktree("retry-adds-more");
        attempt(
            &dir,
            "t1",
            1,
            &[("src/a.rs", "fn a() {}\n"), ("docs/note.md", "why\n")],
        );
        retry(&dir);
        // One file the retry rewrote, one it added, and one it left exactly as the
        // attempt underneath it wrote it.
        write(&dir, "src/a.rs", "fn a() { todo!() }\n");
        write(&dir, "src/b.rs", "fn b() {}\n");

        assert_eq!(
            changed(&dir, &TaskId::new("t1")).unwrap().paths(),
            ["docs/note.md", "src/a.rs", "src/b.rs"]
        );
    }

    #[test]
    fn a_siblings_attempts_on_a_shared_branch_are_not_this_tasks_to_answer_for() {
        // A subtask works in its parent's tree, so the log carries its siblings'
        // attempts. Each was judged against its own scope, and charging them here would
        // fail every step after the first for work that was already accepted.
        let dir = worktree("shared-branch");
        attempt(&dir, "step-one", 1, &[("docs/one.md", "one\n")]);
        attempt(&dir, "step-two", 1, &[("src/two.rs", "fn two() {}\n")]);
        retry(&dir);

        assert_eq!(
            changed(&dir, &TaskId::new("step-two")).unwrap().paths(),
            ["src/two.rs"]
        );
        assert!(
            violations(
                &changed(&dir, &TaskId::new("step-two")).unwrap(),
                &scope(&["src/**"])
            )
            .is_empty()
        );
    }

    #[test]
    fn work_that_came_with_the_base_is_not_this_tasks_work() {
        // A branch cut from a predecessor's carries that predecessor's commits. They
        // are not in this diff, and a task is not asked to declare a scope covering the
        // ground it was handed.
        let dir = worktree("base-history");
        let changed = changed(&dir, &TaskId::new("t1")).unwrap();
        assert!(changed.is_empty(), "{changed:?}");
    }

    #[test]
    fn a_first_attempt_is_read_exactly_as_before() {
        // Judging happens before the commit, so on the first run there is nothing
        // behind HEAD and this is the plain working-tree diff it has always been.
        let dir = worktree("first-attempt");
        write(&dir, "src/a.rs", "fn a() {}\n");
        assert_eq!(
            changed(&dir, &TaskId::new("t1")).unwrap().paths(),
            git::changed_files(&dir).unwrap()
        );
    }

    #[test]
    fn only_a_tree_wecode_commits_in_is_held_back() {
        // Which trees those are, stated once. The worktrees wecode cuts live under the
        // run root and nothing else does — a repository the operator keeps anywhere
        // else is theirs, and wecode neither commits there nor withholds anything.
        let ours = crate::work::run_root().join("an-org").join("t1");
        assert!(commits_here(&ours));
        assert!(!commits_here(&std::env::temp_dir().join("their-checkout")));
        assert!(!commits_here(Path::new("")));
    }

    #[test]
    fn a_verdict_in_the_operators_own_checkout_holds_nothing_back() {
        // The line `commit_attempt` draws, seen from this side. A task the playbook
        // gave no worktree is judged where the operator is standing, and wecode commits
        // nothing there — so there is nothing to hold back, and a note left in their
        // repository would be one nothing ever reads.
        let dir = worktree("no-worktree");
        write(&dir, "src/a.rs", "fn a() {}\n");
        write(&dir, "Cargo.toml", "[package]\n");

        let c = changed(&dir, &TaskId::new("t1")).unwrap();
        assert_eq!(violations(&c, &scope(&["src/**"])), ["Cargo.toml"]);

        let sha = git::commit_all(&dir, "t1: attempt 1").unwrap().unwrap();
        let (files, _) = git::commit_summary(&dir, &sha, 0).unwrap();
        assert_eq!(files, ["Cargo.toml", "src/a.rs"], "nothing was withheld");
    }

    #[test]
    fn a_change_inside_the_declared_scope_is_clean() {
        let v = violations(
            &touched(&["crates/wecode-cli/src/main.rs"]),
            &scope(&["crates/wecode-cli/src/**"]),
        );
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn a_change_outside_the_declared_scope_is_named() {
        // The exact case this module exists for: a task scoped to the cli crate that
        // quietly edited core.
        let v = violations(
            &touched(&[
                "crates/wecode-cli/src/render.rs",
                "crates/wecode-core/src/plan.rs",
            ]),
            &scope(&["crates/wecode-cli/**"]),
        );
        assert_eq!(v, vec!["crates/wecode-core/src/plan.rs".to_string()]);
    }

    #[test]
    fn an_empty_scope_permits_nothing_rather_than_everything() {
        // A spike declares no write scope. One that edited files did something it
        // never said it would, so the fail-closed reading is the correct one.
        let v = violations(&touched(&["src/a.rs"]), &Scope::default());
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn the_workers_own_result_file_is_not_a_violation() {
        // The envelope tells the agent to write .wecode/run/result.json. Counting that
        // against it would fail every task for following instructions.
        let v = violations(
            &touched(&[".wecode/run/result.json", "src/a.rs"]),
            &scope(&["src/**"]),
        );
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn the_playbook_itself_is_still_guarded() {
        // Only the run directory is exempt. A task quietly rewriting the guidance it
        // was given is exactly what the split of .wecode/ exists to prevent.
        let v = violations(&touched(&[".wecode/playbook.toml"]), &scope(&["src/**"]));
        assert_eq!(v, vec![".wecode/playbook.toml".to_string()]);
    }

    #[test]
    fn touching_nothing_is_always_in_scope() {
        assert!(violations(&touched(&[]), &Scope::default()).is_empty());
    }

    #[test]
    fn a_passing_command_is_recorded_with_its_code() {
        let dir = std::env::temp_dir();
        let v = ran(
            &dir,
            &[Measure::Command {
                cmd: "true".into(),
                expect_status: 0,
            }],
        );
        assert!(v.passed());
        assert_eq!(v.checks[0].status, Some(0));
        assert_eq!(v.checks[0].describe(), "exit 0");
    }

    #[test]
    fn a_failing_command_fails_the_verdict_and_says_what_it_wanted() {
        let dir = std::env::temp_dir();
        let v = ran(
            &dir,
            &[
                Measure::Command {
                    cmd: "true".into(),
                    expect_status: 0,
                },
                Measure::Command {
                    cmd: "exit 3".into(),
                    expect_status: 0,
                },
            ],
        );
        assert!(!v.passed());
        assert!(
            v.checks[1].describe().contains("wanted 0"),
            "{:?}",
            v.checks[1]
        );
    }

    #[test]
    fn a_command_runs_in_the_directory_it_is_given() {
        // Acceptance must judge the worktree, not wherever wecode happens to be.
        let dir = std::env::temp_dir().join("wecode-verify-cwd");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker"), "x").unwrap();

        let v = ran(
            &dir,
            &[Measure::Command {
                cmd: "test -f marker".into(),
                expect_status: 0,
            }],
        );
        assert!(v.passed(), "{:?}", v.checks);
    }

    #[test]
    fn the_shared_build_cache_is_set_on_the_acceptance_commands_too() {
        // Acceptance is the second cold build a worktree pays for, and usually the
        // larger one: the agent may have run `cargo check`, this runs the suite.
        let v = run_acceptance(
            &std::env::temp_dir(),
            &[cmd("test \"$CARGO_TARGET_DIR\" = /tmp/shared-target")],
            &[(
                "CARGO_TARGET_DIR".to_string(),
                std::path::PathBuf::from("/tmp/shared-target"),
            )],
        );
        assert!(v.passed(), "{:?}", v.checks);
    }

    #[test]
    fn acceptance_still_inherits_the_environment_it_needs_to_run_at_all() {
        // Unlike a spawned agent's, this environment is not built from an allowlist:
        // the commands are the operator's own, and one without `PATH` could not find
        // the toolchain it is supposed to be judging with.
        let v = run_acceptance(
            &std::env::temp_dir(),
            &[cmd("test -n \"$PATH\"")],
            &[(
                "CARGO_TARGET_DIR".to_string(),
                std::path::PathBuf::from("/tmp/shared-target"),
            )],
        );
        assert!(v.passed(), "{:?}", v.checks);
    }

    #[test]
    fn a_measure_no_command_can_settle_blocks_the_verdict() {
        let dir = std::env::temp_dir();
        let v = ran(
            &dir,
            &[Measure::Metric {
                name: "p99".into(),
                target: 500.0,
                cmp: Cmp::Lt,
            }],
        );
        assert!(!v.passed(), "an unjudgeable measure is not a pass");
        assert_eq!(v.unjudgeable.len(), 1);
    }

    #[test]
    fn a_missing_command_is_reported_as_missing_not_as_a_failure() {
        // 127 from `sh` means the toolchain is absent, not that the work is wrong.
        let v = ran(
            &std::env::temp_dir(),
            &[Measure::Command {
                cmd: "definitely-not-a-real-binary-xyz".into(),
                expect_status: 0,
            }],
        );
        assert!(!v.passed());
        assert_eq!(v.unrunnable().len(), 1);
        assert!(
            v.checks[0].describe().contains("not found"),
            "{:?}",
            v.checks[0]
        );
    }

    #[test]
    fn a_check_that_wants_127_is_not_mistaken_for_a_missing_command() {
        let v = ran(
            &std::env::temp_dir(),
            &[Measure::Command {
                cmd: "exit 127".into(),
                expect_status: 127,
            }],
        );
        assert!(v.passed());
        assert!(v.unrunnable().is_empty());
    }

    #[test]
    fn a_task_with_no_acceptance_never_passes() {
        // Vacuously-true verification is worse than none: it would mark work done on
        // the strength of having asked nothing.
        let v = ran(&std::env::temp_dir(), &[]);
        assert!(!v.passed());
    }
}
