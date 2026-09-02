//! What one dispatch holds while it runs: the claim on the task, and the beat that
//! keeps the claim honest.
//!
//! [`Claim`] and [`Beat`] are one object seen from its two ends. The claim is the
//! status write that says *this task is taken*, handed back by `Drop` on every exit
//! the supervisor gets to run code on. The beat is for the exits that run nothing —
//! `kill -9`, a closed laptop, WSL restarting under the loop — where no `Drop` fires
//! and the row is left claiming a watcher for ever: a thread stamps the run's row
//! every [`BEAT`] for as long as the supervisor exists to be stamped for, and
//! [`sweep`] is the loop closing the rows whose stamping stopped and stayed stopped.
//!
//! The clocks live here, beside the mechanism, and are constants rather than
//! configuration: the operator already owns two clocks over a run — the task's
//! `wall_secs` and the template's — and a third knob could be set below them, closing
//! runs that are merely long. These figures are properties of the mechanism.

use std::time::Duration;

use wecode_core::{ExecutionStatus, Task, TaskId, TaskStatus};
use wecode_gov::{Action, Broker, Session};
use wecode_org::{Company, Workspace};
use wecode_store::{Execution, Store};

use crate::args::Args;
use crate::commands::ctx::{Res, actor};
use crate::{notify, scheduler};

/// How often a supervisor says its run is still watched.
pub(crate) const BEAT: Duration = Duration::from_secs(30);

/// Ten missed beats before a run is suspected.
pub(crate) const SILENCE: Duration = Duration::from_secs(BEAT.as_secs() * 10);

/// Two more beat intervals between the first stale reading and the one acted on.
/// Suspend freezes the beating thread while the wall clock runs, so one reading cannot
/// tell frozen from dead; a resumed supervisor has beaten again well inside this.
pub(crate) const CONFIRM: Duration = Duration::from_secs(BEAT.as_secs() * 2);

/// One dispatch's hold on a task: `running`, written before anything is prepared and
/// given back unless an agent actually ran.
///
/// *Before*, because that is what makes it a claim rather than a note. Preparing cuts the
/// tree and resets the last attempt away, so two dispatches that both prepare leave the
/// loser resetting the checkout the winner's agent is working in.
///
/// *Given back*, because a status written that early is written on every way out that
/// reaches no agent — the admission gate, a missing signature, a prerequisite not done, a
/// harness that will not start. Left standing, each of those was a task shown as
/// `running` with nothing running: holding a slot [`scheduler::free_slots`] counts, and
/// untouchable by the tick, which never authors `running`. `Drop` does it, so every `?`
/// in between is covered by construction rather than by remembering.
pub(crate) struct Claim<'a> {
    store: &'a Store,
    id: TaskId,
    /// What the store held when the claim was taken, which is what goes back.
    was: TaskStatus,
    kept: bool,
}

impl<'a> Claim<'a> {
    /// Takes the task, unless [`scheduler::contended`] says somebody else has it.
    pub(crate) fn take(store: &'a Store, task: &Task, runs: &[Execution]) -> Result<Self, String> {
        let (id, was) = (task.id.clone(), task.status);
        if let Some(why) = scheduler::contended(&id, was, runs) {
            return Err(why);
        }
        store
            .set_task_status(&id, TaskStatus::Running)
            .map_err(|e| format!("{id}: {e}"))?;
        Ok(Self {
            store,
            id,
            was,
            kept: false,
        })
    }

    /// Keeps it: an agent is up, and the run owes the task a verdict from here.
    pub(crate) fn kept(mut self) {
        self.kept = true;
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        // Only while it is still ours: anything else in that column is somebody's answer
        // about this task, and putting the old status back over it would erase a fact this
        // dispatch does not own. Quiet and best effort — an error is already on its way to
        // the operator, and a second one about the database would bury the first.
        let held = (self.store.load_plan().ok()).and_then(|p| p.task(&self.id).map(|t| t.status));
        if !self.kept && held == Some(TaskStatus::Running) {
            let _ = self.store.set_task_status(&self.id, self.was);
        }
    }
}

/// The supervisor's side of the bargain an open row states — somebody is watching this
/// run *right now* — said again every [`BEAT`] for as long as it stays true.
///
/// A thread of its own rather than a hook inside `supervise`, because [`crate::spawn`]
/// deliberately knows nothing about the store — and because the beat must keep going
/// while the child is silent: an agent thinking for ten minutes is not a dead
/// supervisor, and a beat coupled to output would say it was. The agent is never asked
/// to report its own liveness; the diff-is-ground-truth rule holds here too, and most
/// harnesses could not be asked anyway.
///
/// On its own connection, opened from the store's path: the main thread is blocked in
/// `spawn::run` with the store, and a SQLite connection is not for sharing across
/// threads. Every write is best effort — the threshold is ten intervals, so a single
/// failed one is absorbed rather than reported. `Drop` stops the thread and joins it.
pub(crate) struct Beat {
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Beat {
    pub(crate) fn start(store: &Store, exec: i64) -> Self {
        let path = store.path().to_path_buf();
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let thread = std::thread::spawn(move || {
            let mut store = None;
            loop {
                // Re-tried every interval rather than given up on: a database busy at
                // the moment the run started is not one busy for ever.
                if store.is_none() {
                    store = Store::open(&path).ok();
                }
                if let Some(s) = &store {
                    let _ = s.beat(exec);
                }
                // The stop is the sender going away; a timeout is just the next beat.
                if !matches!(
                    stopped.recv_timeout(BEAT),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ) {
                    return;
                }
            }
        });
        Self {
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}

impl Drop for Beat {
    fn drop(&mut self) {
        // The sender first, so the thread's wait ends now rather than in thirty seconds.
        drop(self.stop.take());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Closes the open runs whose supervisor has stopped beating — the loop's own pass,
/// once per cycle, before promotion. [`scheduler::stale`] names the candidates and the
/// caller's [`scheduler::Suspects`] holds the confirmation; this is what acting on a
/// confirmed one means.
///
/// It is a verdict written over an *absence* of evidence, and the strongest thing
/// anyone may do on an absence is write down that they no longer know. So: the row
/// closes `canceled` — stopped by us, where `failed` would say the agent failed, which
/// nobody observed — with `ended` at the last beat and the spend left NULL. The task
/// goes to `failed` — *attempted, a person decides what happens next* — only if it is
/// still `running` and this row was its latest attempt, and the move goes through
/// [`notify::on_status_change`] so the operator is told wherever they are.
///
/// Nothing is killed: an orphaned agent may still be writing in that tree, and the only
/// handle to it is a pid that may since have been reused. Nothing is torn down — the
/// worktree is on the record, left for a person to go and look at — and nothing is
/// re-dispatched, because the tree may hold half-finished work. A supervisor that
/// returns after the sweep outranks it and writes its own verdict over both rows: it
/// has evidence, and the sweep had none.
pub(crate) fn sweep(
    a: &Args,
    ws: &Workspace,
    store: &Store,
    company: &Company,
    suspects: &mut scheduler::Suspects,
) -> Res {
    let now = wecode_store::now_secs();
    let open = store.open_runs()?;
    let stale = scheduler::stale(&open, now, SILENCE);
    let ids: Vec<i64> = stale.iter().map(|r| r.exec).collect();
    let confirmed = suspects.confirm(&ids, std::time::Instant::now());
    if confirmed.is_empty() {
        return Ok(String::new());
    }

    let plan = store.load_plan()?;
    let who = actor(a, store, company)?;
    let mut broker = Broker::new(company.charter.clone());
    let mut out = String::new();
    for run in stale.into_iter().filter(|r| confirmed.contains(&r.exec)) {
        let id = TaskId::new(&run.task);
        let heard = run.beat.unwrap_or(run.started);
        let tree = run.worktree.as_deref().unwrap_or("no worktree");
        store.close_execution_at(
            run.exec,
            ExecutionStatus::Canceled,
            &format!(
                "supervisor went silent — last beat {heard} ({}s before the sweep); {tree} left standing",
                now.saturating_sub(heard)
            ),
            heard,
        )?;
        out.push_str(&format!(
            "  ✖ {id} attempt {} — supervisor silent, run closed; {tree} left standing\n",
            run.attempt
        ));
        // Observed rather than decided, like the tick's moves: the loop read a
        // silence, it chose nothing a person could have chosen differently. The row
        // itself is the record, and a second copy would be a second thing to keep in
        // agreement.
        let session = Session::new(
            who.session.clone(),
            who.post.clone(),
            who.agent.clone(),
            who.effective.clone(),
        )
        .on(
            plan.task(&id).map(|t| t.project.to_string()),
            Some(id.to_string()),
        )
        .with_human(who.human.clone());
        broker.observe(
            &session,
            Action::Staff,
            wecode_gov::Decision::Allow,
            wecode_gov::Source::Supervisor,
        );
        // Only while the verdict is still this run's to give: a status something else
        // has moved is somebody's answer about the task, and a later attempt makes
        // this row history rather than the standing claim.
        if store.next_attempt(&id)? == run.attempt + 1
            && let Some(task) = plan.task(&id).filter(|t| t.status == TaskStatus::Running)
        {
            store.set_task_status(&id, TaskStatus::Failed)?;
            out.push_str(&notify::on_status_change(
                company,
                ws.root(),
                task,
                TaskStatus::Running,
                TaskStatus::Failed,
            ));
        }
    }
    store.append_records(broker.ledger())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Measure, Project, Scope};

    /// A store on disk, because the guard's thread opens its own connection — the one
    /// thing an in-memory database cannot hand it.
    fn disk_store(name: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("wecode-claim-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(dir.join("wecode.db")).unwrap();
        s.save_project(&Project::new("p", "an objective sentence", "repo"))
            .unwrap();
        s.save_task(
            &Task::new("t", "p", "do something specific")
                .accepting(Measure::Command {
                    cmd: "true".into(),
                    expect_status: 0,
                })
                .scoped(Scope::write(&["a/**"]))
                .budgeted(Budget {
                    tokens: Some(1),
                    wall_secs: Some(1),
                }),
        )
        .unwrap();
        s
    }

    #[test]
    fn a_supervised_run_is_beaten_from_the_moment_the_guard_stands() {
        let s = disk_store("beat");
        let exec = s.start_execution(&TaskId::new("t"), "s", None, None).unwrap();
        // Backdated, so the guard's first stamp is distinguishable from the row's own.
        s.backdate_run(exec, 100, Some(100)).unwrap();

        // The first stamp precedes the first wait, so dropping the guard — which joins
        // the thread — is enough to have been beaten at least once, with no sleeping.
        drop(Beat::start(&s, exec));

        let beaten = s.open_runs().unwrap()[0].beat.unwrap();
        assert!(beaten > 100, "stamped past the backdated beat: {beaten}");
    }

    #[test]
    fn a_guard_on_a_closed_row_stamps_nothing_and_still_stops_cleanly() {
        // The ordinary end of every run: the row is closed while the guard still
        // stands, and the late stamps between close and drop must change nothing.
        let s = disk_store("beat-closed");
        let exec = s.start_execution(&TaskId::new("t"), "s", None, None).unwrap();
        s.close_execution_at(exec, ExecutionStatus::Canceled, "over", 160)
            .unwrap();
        drop(Beat::start(&s, exec));
        let run = &s.executions(&TaskId::new("t")).unwrap()[0];
        assert_eq!(run.ended, Some(160), "history is not rewritten");
    }
}
