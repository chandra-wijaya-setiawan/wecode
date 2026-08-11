//! Judging finished work from what it actually did.
//!
//! Two questions, both answered without asking the agent:
//!
//! - **Did it stay in scope?** From `git diff`, not from a self-report.
//! - **Does it pass?** By running the acceptance commands here, not by being told.
//!
//! That ordering is the design's own rule — the diff always wins. An agent's
//! `result.json` is useful for a summary and inadmissible as evidence, so nothing in
//! this module reads it.
//!
//! Post-hoc rather than intercepted, because wecode cannot hook another process's
//! writes. Confinement is the worktree; this is the check afterwards. It is why a
//! write outside scope is *sanctioned* — recoverable — rather than prevented.

use std::path::Path;
use std::process::Command;

use wecode_core::{Measure, Scope};
use wecode_gov::glob;
use wecode_org::playbook;

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

/// Everything observed about one finished task.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub(crate) struct Verdict {
    pub(crate) changed: Vec<String>,
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
    path.starts_with(playbook::RUN_DIR)
}

/// Changed paths the scope does not permit.
///
/// An empty write scope means the task claimed it would change nothing, so *any*
/// change is a violation — not a free pass. A spike is the kind that legitimately
/// has no scope, and a spike that edited files did something it did not declare.
pub(crate) fn violations(changed: &[String], scope: &Scope) -> Vec<String> {
    changed
        .iter()
        .filter(|p| !is_worker_area(p) && !glob::any_matches(&scope.write, p))
        .cloned()
        .collect()
}

/// Runs the acceptance commands in `dir`.
///
/// Through `sh -c`, because acceptance is written as a shell line — `cargo clippy
/// --all-targets -- -D warnings` is not an argv this could split correctly.
pub(crate) fn run_acceptance(dir: &Path, measures: &[Measure]) -> Verdict {
    let mut v = Verdict::default();
    for m in measures {
        match m {
            Measure::Command { cmd, expect_status } => {
                let status = Command::new("sh")
                    .arg("-c")
                    .arg(cmd)
                    .current_dir(dir)
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

    fn changed(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_change_inside_the_declared_scope_is_clean() {
        let v = violations(
            &changed(&["crates/wecode-cli/src/main.rs"]),
            &scope(&["crates/wecode-cli/src/**"]),
        );
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn a_change_outside_the_declared_scope_is_named() {
        // The exact case this module exists for: a task scoped to the cli crate that
        // quietly edited core.
        let v = violations(
            &changed(&[
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
        let v = violations(&changed(&["src/a.rs"]), &Scope::default());
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn the_workers_own_result_file_is_not_a_violation() {
        // The envelope tells the agent to write .wecode/run/result.json. Counting that
        // against it would fail every task for following instructions.
        let v = violations(
            &changed(&[".wecode/run/result.json", "src/a.rs"]),
            &scope(&["src/**"]),
        );
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn the_playbook_itself_is_still_guarded() {
        // Only the run directory is exempt. A task quietly rewriting the guidance it
        // was given is exactly what the split of .wecode/ exists to prevent.
        let v = violations(&changed(&[".wecode/playbook.toml"]), &scope(&["src/**"]));
        assert_eq!(v, vec![".wecode/playbook.toml".to_string()]);
    }

    #[test]
    fn touching_nothing_is_always_in_scope() {
        assert!(violations(&[], &Scope::default()).is_empty());
    }

    #[test]
    fn a_passing_command_is_recorded_with_its_code() {
        let dir = std::env::temp_dir();
        let v = run_acceptance(
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
        let v = run_acceptance(
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

        let v = run_acceptance(
            &dir,
            &[Measure::Command {
                cmd: "test -f marker".into(),
                expect_status: 0,
            }],
        );
        assert!(v.passed(), "{:?}", v.checks);
    }

    #[test]
    fn a_measure_no_command_can_settle_blocks_the_verdict() {
        let dir = std::env::temp_dir();
        let v = run_acceptance(
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
        let v = run_acceptance(
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
        let v = run_acceptance(
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
        let v = run_acceptance(&std::env::temp_dir(), &[]);
        assert!(!v.passed());
    }
}
