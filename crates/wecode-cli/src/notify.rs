//! Telling a person that something has stopped for them.
//!
//! wecode is built to be left running: a task is dispatched under a budget, into a
//! worktree, and judged before anything it produced can land. What it cannot do
//! unattended is the half that was always a person's — signing a merge, answering a
//! question, deciding what happens to work that failed. Until this existed the only
//! way to learn that a task had stopped for you was to *look*: at the loop's output,
//! at the board, at `wecode ready`. Work that finished at 02:14 waited until somebody
//! next looked at a terminal, which on the workspace that found this was the morning.
//!
//! So `[notify] command` runs when a task starts waiting on a human, and the operator
//! decides what "tell me" means: a desktop notification, a message, a line in a file.
//!
//! Three things are load-bearing:
//!
//! - **The edge, not the state.** It fires on the *transition* into waiting, so a task
//!   that has been waiting a week fires once rather than every tick. The loop already
//!   prints the standing condition every pass; a notifier that did the same would be
//!   the thing you turn off.
//! - **It cannot fail the work.** A hook that exits non-zero, hangs, or does not exist
//!   is reported and stepped over. A task is not less finished because a notification
//!   did not arrive, and a supervisor that fell over telling you about a success would
//!   be worse than no supervisor.
//! - **It is bounded.** The hook is killed at `[notify] timeout`. `wecode loop` runs
//!   for days; a notifier blocked on a network call must not take it with it.
//!
//! The task is passed in the environment rather than substituted into the command
//! line. A title is arbitrary prose written by whoever planned the work — pasted into
//! a shell line it is a quoting bug at best, and `wecode` is holding the shell.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use wecode_core::{Task, TaskId, TaskStatus};
use wecode_org::Company;

/// How often to look at a running hook. Short: these finish in milliseconds, and the
/// interval is dead time on every notification.
const POLL: Duration = Duration::from_millis(20);

/// Why a task is waiting on a person.
///
/// Four reasons and not three: the dispatch gate holds a task that is `ready`, so the
/// status alone cannot say why the operator is wanted. What the hook is told is this,
/// not the status, because "what do you want from me" is the question a notification
/// exists to answer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Waiting {
    /// Verified. A holder must sign before it can land.
    Approval,
    /// The agent asked something only a person can answer.
    Input,
    /// Attempts exhausted. What happens next is a decision.
    Failed,
    /// Startable, and the project's dispatch gate wants a signature first.
    Signature,
}

impl Waiting {
    /// The word the hook is handed, in `WECODE_WAITING_FOR`.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Approval => "approval",
            Self::Input => "input",
            Self::Failed => "failed",
            Self::Signature => "signature",
        }
    }

    /// The reason a *status* carries, if that status is one that stops for a person.
    ///
    /// Defined against [`TaskStatus::needs_a_human`] rather than beside it: the board's
    /// "needs you" column, the loop's pause and this hook must not be able to disagree
    /// about what waiting means. The test below is what holds them together.
    fn of(status: TaskStatus) -> Option<Self> {
        match status {
            TaskStatus::NeedsApproval => Some(Self::Approval),
            TaskStatus::NeedsInput => Some(Self::Input),
            TaskStatus::Failed => Some(Self::Failed),
            _ => None,
        }
    }
}

/// The reason to announce, when a status change is a task *starting* to wait.
///
/// `None` when it already was: a failed task re-marked failed, or one moving from
/// `needs-input` to `needs-approval`, has not newly acquired a person — it has had one
/// all along, and telling them twice for one wait is how a notifier becomes noise.
pub(crate) fn crossing(from: TaskStatus, to: TaskStatus) -> Option<Waiting> {
    if from.needs_a_human() {
        return None;
    }
    Waiting::of(to)
}

/// Announces a status change, when it is a task starting to wait on a person.
///
/// The one entry point for every place a status is written, so a new one cannot
/// quietly acquire a status change without the announcement that goes with it.
///
/// Both statuses are passed rather than read off `task`: a caller that has already
/// written one — `run`, which marks a task `running` before spawning — holds a copy
/// that is out of date, and a stale `from` is how an announcement gets swallowed.
pub(crate) fn on_status_change(
    company: &Company,
    org: &Path,
    task: &Task,
    from: TaskStatus,
    to: TaskStatus,
) -> String {
    match crossing(from, to) {
        Some(why) => fire(company, org, task, to, why),
        None => String::new(),
    }
}

/// Announces a task the dispatch gate is holding for a signature.
///
/// Its status is unchanged and stays that way — `ready` is the truth, the task *is*
/// startable — so this is the one announcement whose reason cannot be read off the
/// board. See [`Announced`] for how it fires once.
pub(crate) fn on_signature_wait(company: &Company, org: &Path, task: &Task) -> String {
    fire(company, org, task, task.status, Waiting::Signature)
}

/// Runs the hook. Returns what the caller should print: nothing when it ran or when
/// none is configured, a warning when it did not. Never an error — see the module note.
fn fire(company: &Company, org: &Path, task: &Task, status: TaskStatus, why: Waiting) -> String {
    let Some(command) = company.notify.command.as_deref() else {
        return String::new();
    };

    // The same charter check the agent launch line gets, from the same function, so
    // the two cannot drift apart. An invariant outranks every grant, and a config is
    // not an exception: `never_run` is the operator telling themselves no, and a
    // notify hook is one more place the operator writes a command line.
    if let Some(pattern) = crate::commands::exec::forbidden_by_charter(company, command) {
        return warn(&format!(
            "`{command}` is forbidden by the charter: never_run {pattern}"
        ));
    }

    // Through `sh -c`, like acceptance: what an operator writes here is a shell line —
    // a pipe, a quoted argument, a `||` fallback — not an argv this could split.
    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(org)
        // Inherited, like acceptance and unlike an agent's: this is the operator's own
        // command, run on their behalf, and a desktop notifier needs the session it
        // was configured in — DISPLAY, DBUS_SESSION_BUS_ADDRESS, an API token. There is
        // nothing to confine here; the hook is the operator, not a worker.
        .env("WECODE_TASK", task.id.as_str())
        .env("WECODE_TASK_TITLE", &task.title)
        .env("WECODE_TASK_STATUS", status.as_str())
        .env("WECODE_PROJECT", task.project.as_str())
        .env("WECODE_WAITING_FOR", why.as_str())
        .env("WECODE_COMPANY", &company.name)
        // So a hook can call wecode back — `wecode show "$WECODE_TASK"` — from whatever
        // directory it happens to be started in.
        .env("WECODE_ORG", org)
        // Discarded on purpose. The loop's output is the record of the work, and a
        // notifier's chatter interleaved with it made both unreadable. What is worth
        // reporting is whether the hook ran, which is below.
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());

    match cmd.spawn() {
        Err(e) => warn(&format!("could not run `{command}`: {e}")),
        Ok(mut child) => match wait_for(&mut child, company.notify.timeout) {
            Ok(Some(0)) => String::new(),
            Ok(Some(code)) => warn(&format!("`{command}` exited {code}")),
            Ok(None) => warn(&format!(
                "`{command}` was killed after {}s",
                company.notify.timeout.as_secs()
            )),
            Err(e) => warn(&format!("`{command}`: {e}")),
        },
    }
}

/// Waits for the hook, killing it at the limit.
///
/// `Ok(None)` means it was killed. Only the hook itself is signalled, not a process
/// group: a notifier that backgrounds children of its own has decided to outlive its
/// own exit, and that is the hook author's business rather than something wecode
/// should undo.
fn wait_for(child: &mut Child, limit: Duration) -> Result<Option<i32>, String> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Err(e) => return Err(e.to_string()),
            // A hook killed by a signal reports no code. Reported as such rather than
            // as a success, because it did not finish.
            Ok(Some(status)) => return Ok(Some(status.code().unwrap_or(-1))),
            Ok(None) => {}
        }
        if start.elapsed() >= limit {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(POLL);
    }
}

fn warn(what: &str) -> String {
    format!("  ⚠ notify: {what}\n")
}

/// Which tasks this process has already announced as waiting for a signature.
///
/// The dispatch gate is the one wait with no edge to hang a notification on: nothing
/// in the database changes when a signature becomes due, and the condition is
/// recomputed from the ledger on every pass. So the edge is kept here instead, by the
/// loop that computes it, and a task is announced once however long it goes unsigned.
///
/// A restarted loop announces again, which is the honest behaviour for state that only
/// ever lived in one process — and it says what that loop is stuck on, which is what
/// an operator restarting it wants to know anyway.
#[derive(Default, Debug)]
pub(crate) struct Announced(BTreeSet<TaskId>);

impl Announced {
    /// Whether this is the first time `id` has come up. Records it either way.
    pub(crate) fn first_time(&mut self, id: &TaskId) -> bool {
        self.0.insert(id.clone())
    }

    /// Forgets everything not still waiting, so a task that is signed, run, and later
    /// rejected back into the queue is announced again rather than silently held.
    pub(crate) fn keep_only(&mut self, still: &[TaskId]) {
        self.0.retain(|id| still.contains(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use wecode_core::{Budget, Measure, Scope};

    fn task() -> Task {
        Task::new("t", "p", "cover the cache layer with tests")
            .accepting(Measure::Command {
                cmd: "true".into(),
                expect_status: 0,
            })
            .scoped(Scope::write(&["tests/**"]))
            .budgeted(Budget {
                tokens: Some(10),
                wall_secs: Some(1),
            })
    }

    /// A company with the given `[notify]` body, or none at all.
    fn company(notify: &str) -> Company {
        Company::parse(&format!(
            "[company]\nname = \"cws\"\n\n[roles.engineer]\nwrite = [\"src/**\"]\n{notify}"
        ))
        .expect("the profile parses")
    }

    fn dir() -> PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn every_status_that_needs_a_human_has_a_reason_to_give_them() {
        // The two definitions are in different crates and must agree exactly: a status
        // that stops for a person and carries no reason would stop silently, and a
        // reason for a status the board does not think is waiting would announce work
        // nobody is holding.
        for s in TaskStatus::all() {
            assert_eq!(
                Waiting::of(*s).is_some(),
                s.needs_a_human(),
                "{} disagrees",
                s.as_str()
            );
        }
    }

    #[test]
    fn becoming_stuck_announces_and_staying_stuck_does_not() {
        assert_eq!(
            crossing(TaskStatus::Verifying, TaskStatus::NeedsApproval),
            Some(Waiting::Approval)
        );
        assert_eq!(
            crossing(TaskStatus::Running, TaskStatus::Failed),
            Some(Waiting::Failed)
        );
        // Already had a person: a second reason is not a second wait.
        assert_eq!(
            crossing(TaskStatus::NeedsInput, TaskStatus::NeedsApproval),
            None
        );
        assert_eq!(crossing(TaskStatus::Failed, TaskStatus::Failed), None);
        // Freed rather than stuck.
        assert_eq!(crossing(TaskStatus::NeedsApproval, TaskStatus::Done), None);
        assert_eq!(crossing(TaskStatus::Waiting, TaskStatus::Ready), None);
    }

    #[test]
    fn no_hook_configured_runs_nothing_and_says_nothing() {
        let out = on_status_change(
            &company(""),
            &dir(),
            &task(),
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
        );
        assert!(out.is_empty(), "{out}");
    }

    #[test]
    fn a_hook_is_told_which_task_stopped_and_what_it_wants() {
        // The status reported is the one being written, not the one the task still
        // carries: a hook told `running` about a task that just failed would say the
        // opposite of what happened.
        let out = std::env::temp_dir().join("wecode-notify-env.txt");
        let _ = std::fs::remove_file(&out);
        let c = company(&format!(
            "\n[notify]\ncommand = \"echo $WECODE_TASK $WECODE_WAITING_FOR $WECODE_TASK_STATUS \
             $WECODE_PROJECT $WECODE_TASK_TITLE > {}\"\n",
            out.display()
        ));
        let t = task();
        assert!(
            on_status_change(&c, &dir(), &t, TaskStatus::Running, TaskStatus::Failed).is_empty(),
            "ran clean"
        );
        let written = std::fs::read_to_string(&out).expect("the hook wrote its file");
        assert_eq!(
            written.trim(),
            "t failed failed p cover the cache layer with tests"
        );
    }

    #[test]
    fn a_hook_that_fails_is_reported_and_nothing_else() {
        let c = company("\n[notify]\ncommand = \"exit 3\"\n");
        let out = on_status_change(&c, &dir(), &task(), TaskStatus::Running, TaskStatus::Failed);
        assert!(out.contains("⚠ notify"), "{out}");
        assert!(out.contains("exited 3"), "{out}");
    }

    #[test]
    fn a_hook_that_hangs_is_killed_at_its_timeout() {
        // The property that makes it safe on a loop that runs for days.
        let c = company("\n[notify]\ncommand = \"sleep 60\"\ntimeout = \"1s\"\n");
        let began = Instant::now();
        let out = on_status_change(
            &c,
            &dir(),
            &task(),
            TaskStatus::Running,
            TaskStatus::NeedsInput,
        );
        assert!(out.contains("killed after 1s"), "{out}");
        assert!(
            began.elapsed() < Duration::from_secs(30),
            "did not wait it out"
        );
    }

    #[test]
    fn a_hook_the_charter_forbids_is_not_run() {
        // An invariant outranks every grant, and company.toml is not above its own
        // charter — the notify line is a command wecode itself executes.
        let c = company(
            "\n[invariants]\nnever_run = [\"curl *\"]\n\n[notify]\ncommand = \"curl example.invalid\"\n",
        );
        let out = on_status_change(
            &c,
            &dir(),
            &task(),
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
        );
        assert!(out.contains("never_run"), "{out}");
    }

    #[test]
    fn a_task_held_for_a_signature_is_announced_as_the_signature_it_is() {
        // `ready` is the truth about the status and says nothing about the wait, so
        // the reason is what carries it.
        let out = std::env::temp_dir().join("wecode-notify-signature.txt");
        let _ = std::fs::remove_file(&out);
        let c = company(&format!(
            "\n[notify]\ncommand = \"echo $WECODE_WAITING_FOR $WECODE_TASK_STATUS > {}\"\n",
            out.display()
        ));
        let mut t = task();
        t.status = TaskStatus::Ready;
        assert!(on_signature_wait(&c, &dir(), &t).is_empty(), "ran clean");
        assert_eq!(
            std::fs::read_to_string(&out)
                .expect("the hook wrote its file")
                .trim(),
            "signature ready"
        );
    }

    #[test]
    fn a_signature_wait_is_announced_once_and_again_after_it_clears() {
        let mut seen = Announced::default();
        let (a, b) = (TaskId::new("a"), TaskId::new("b"));
        assert!(seen.first_time(&a));
        assert!(!seen.first_time(&a), "still the same wait");
        assert!(seen.first_time(&b));

        // `a` was signed and left the queue; `b` is still unsigned.
        seen.keep_only(std::slice::from_ref(&b));
        assert!(!seen.first_time(&b), "b never stopped waiting");
        assert!(seen.first_time(&a), "a is a new wait, not the old one");
    }
}
