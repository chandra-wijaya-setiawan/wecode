//! Settling the runs a dead supervisor left behind.
//!
//! A dispatch writes `running` on the task, cuts a worktree, opens an execution row and
//! spawns an agent. `Claim`'s `Drop` hands the status back on every ordinary way out —
//! and `Drop` is a courtesy a process pays only while it is alive enough to pay it. A
//! `kill -9`, the OOM killer or a closed laptop lid leaves the row saying `working` and
//! the task saying `running`, which [`crate::scheduler::contended`] refuses to dispatch
//! and [`crate::scheduler::free_slots`] counts against the concurrency limit. The task
//! is unstartable for ever and a seat is gone with it.
//!
//! What this does about it is bounded on purpose: **it settles a run, it does not resume
//! one.** A run's supervisor holds the pipe, the meter and the clock; when it dies the
//! run is over, and the retry that follows is a new attempt with its own row.
//!
//! The one question asked first is who owned the intent, because a hand-run `wecode run
//! t` beside a running `wecode serve` is ordinary. **Owner alive: stop, this is not
//! ours.** Owner dead, in order: stop the orphaned agent, commit what the attempt
//! produced, close the run `canceled`, hand the task back to the status the dispatch
//! took it from, and leave the worktree standing.
//!
//! Every step of that is repeat-safe — killing a dead group, committing a clean tree and
//! closing a closed row are all no-ops the second time — so a reclaim interrupted halfway
//! is finished by the next one, and a second one over settled work does nothing at all.
//!
//! [`command`] acts and [`crate::doctor`] reports. That is the split [`crate::teardown`]
//! already draws: an operator naming a thing has decided, and an automatic caller has to
//! be able to decline and say why.

use std::path::{Path, PathBuf};

use wecode_core::{ExecutionStatus, TaskId, TaskStatus};
use wecode_gov::{Action, Broker, Decision, Effective, Session, Source};
use wecode_org::Company;
use wecode_store::execution::Spend;
use wecode_store::journal::{Doubt, Owner, Resolve, Settled, Step};
use wecode_store::Store;

use crate::args::Args;
use crate::commands::ctx::{Res, open_full};
use crate::identity::{self, Life};
use crate::commands;

/// One run nobody is holding: every open journal row written by one dead process about
/// one task.
///
/// Grouped by owner as well as by task, because two supervisors on one task is a state
/// the identity proof exists to handle — one of them may be alive, and its rows must
/// travel separately from the dead one's.
pub(crate) struct Stranded {
    pub(crate) task: TaskId,
    /// The process that wrote these rows, and is no longer running.
    pub(crate) owner: Owner,
    rows: Vec<Doubt>,
}

impl Stranded {
    /// The run's execution row, from whichever step opened after it existed.
    fn exec(&self) -> Option<i64> {
        self.rows.iter().find_map(|d| d.intent.exec)
    }

    /// Where the work happened — the target the `prepare` step named.
    fn cwd(&self) -> Option<PathBuf> {
        self.rows
            .iter()
            .find(|d| d.intent.step == Step::Prepare)
            .map(|d| PathBuf::from(&d.intent.target))
    }

    /// The status the dispatch took the task from.
    fn prior(&self) -> Option<TaskStatus> {
        self.rows.iter().find_map(|d| d.intent.prior)
    }

    /// The agent, as it was written down the moment it existed.
    fn child(&self) -> Option<&Owner> {
        self.rows.iter().find_map(|d| d.child.as_ref())
    }

    /// The name this dispatch launched its agent under.
    fn token(&self) -> Option<&str> {
        self.rows
            .iter()
            .find(|d| d.intent.step == Step::Spawn)
            .map(|d| d.intent.token.as_str())
    }

    /// What the operator is told this run was doing when it stopped.
    pub(crate) fn describe(&self) -> String {
        let steps: Vec<&str> = self.rows.iter().map(|d| d.intent.step.as_str()).collect();
        format!(
            "{} — supervisor pid {} is gone, in doubt at: {}",
            self.task,
            self.owner.pid,
            steps.join(", ")
        )
    }
}

/// The reason a reclaimed run carries, wherever a run's ending is written down.
fn cause(owner: &Owner) -> String {
    format!(
        "supervisor pid {} died mid-run — reclaimed, no verdict was reached",
        owner.pid
    )
}

/// Every run whose owner is provably gone.
///
/// Provably: [`Life::Unproven`] is not dead. A host that cannot answer, a row written
/// where the start time could not be read, another machine's pid — each of those leaves
/// the run exactly where it is, because the failure this module exists to fix is cheaper
/// than stopping a live sibling's agent.
pub(crate) fn stranded(store: &Store) -> Result<Vec<Stranded>, Box<dyn std::error::Error>> {
    let mut groups: Vec<Stranded> = Vec::new();
    for row in store.unsettled()? {
        if identity::life(&row.intent.owner) != Life::Gone {
            continue;
        }
        let (task, owner) = (row.intent.task.clone(), row.intent.owner.clone());
        match groups
            .iter_mut()
            .find(|g| g.task.as_str() == task && g.owner == owner)
        {
            Some(g) => g.rows.push(row),
            None => groups.push(Stranded {
                task: TaskId::new(&task),
                owner,
                rows: vec![row],
            }),
        }
    }
    Ok(groups)
}

/// `wecode reclaim`.
pub(crate) fn command(a: &Args) -> Res {
    let (_, store, company) = open_full(a)?;
    let found = stranded(&store)?;
    if found.is_empty() {
        return Ok("  nothing to reclaim\n".to_string());
    }
    let mut out = String::new();
    for run in &found {
        out.push_str(&settle(&store, &company, run)?);
    }
    Ok(out)
}

/// Runs it for a caller that did not ask, printing only when it did something.
///
/// `serve` calls this once before its first pass, which is the whole point of the
/// command existing: an unattended restart is exactly the case where nobody is going to
/// type it. Errors are reported and stepped over, like a notify hook that failed — a
/// journal that cannot be read is a reason to keep working, not a reason to refuse to
/// start.
pub(crate) fn at_startup(store: &Store, company: &Company) -> String {
    let found = match stranded(store) {
        Ok(f) => f,
        Err(e) => return format!("  ⚠ reclaim: {e}\n"),
    };
    let mut out = String::new();
    for run in &found {
        match settle(store, company, run) {
            Ok(report) => out.push_str(&report),
            Err(e) => out.push_str(&format!("  ⚠ reclaim {}: {e}\n", run.task)),
        }
    }
    out
}

/// Finishes what one dead supervisor left, in the order the design fixes.
fn settle(store: &Store, company: &Company, run: &Stranded) -> Res {
    let mut out = format!("  ⟲ {}\n", run.describe());

    // 1. The agent. Unsupervised is not a state wecode offers — no clock, no meter, no
    //    budget, no pipe — and adopting it is not on the table, because the output
    //    stream it was being metered through died with the parent.
    out.push_str(&stop_the_agent(run));

    // 2. What the attempt produced, committed exactly as every other way out of a run
    //    commits it. This is what makes reclaiming non-destructive rather than a
    //    decision to throw the work away.
    if let Some(cwd) = run.cwd().filter(|p| p.is_dir()) {
        out.push_str(&commit(store, &run.task, &cwd, &cause(&run.owner))?);
    }

    // 3. The run, closed as `canceled` — stopped from outside, which is precisely what
    //    happened — with a cause naming the crash rather than an exit code nobody
    //    observed. Only while it is still open, so an interrupted reclaim does not
    //    rewrite the row the reclaim before it closed.
    if let Some(exec) = run.exec() {
        let open = store
            .executions(&run.task)?
            .into_iter()
            .any(|e| e.id == exec && e.ended.is_none());
        if open {
            store.finish_execution(
                exec,
                ExecutionStatus::Canceled,
                &cause(&run.owner),
                Spend::default(),
            )?;
            out.push_str("    run closed canceled\n");
        }
    }

    // 4. The task, handed back to where the dispatch found it — and only while the
    //    column still says `running`. Anything else in it is somebody's answer about
    //    this task, and putting the old status back over it would erase a fact this
    //    reclaim does not own. The same rule `Claim`'s `Drop` follows.
    let held = store.load_plan()?.task(&run.task).map(|t| t.status);
    if held == Some(TaskStatus::Running) {
        let back = run.prior().unwrap_or(TaskStatus::Ready);
        store.set_task_status(&run.task, back)?;
        out.push_str(&format!("    {} → {}\n", TaskStatus::Running.as_str(), back.as_str()));
    }

    // 5. The worktree stands. The branch and the tree are the surviving copy of the
    //    work, and taking them down is a separate decision with its own command.

    for row in &run.rows {
        store.settle(row.id, outcome_of(row))?;
    }
    record(store, company, run)?;
    Ok(out)
}

/// What became of one step, given that its run is over.
///
/// The resolve class the step declared is what decides it, which is the whole reason
/// the class is written down before the step runs.
fn outcome_of(row: &Doubt) -> Settled {
    match (row.intent.resolve, row.intent.step) {
        // Neither repeatable nor checkable. Settled honestly and left as an operator's
        // question rather than guessed at.
        (Resolve::Refuse, _) => Settled::Abandoned,
        // The tree stands and the commit is made: both are steps that happened.
        (_, Step::Prepare | Step::Commit | Step::Reclaim) => Settled::Done,
        // The agent it started is not running, and no verdict was reached.
        (_, Step::Spawn | Step::Verdict) => Settled::Undone,
    }
}

/// Stops the agent this run left behind, by its recorded identity and by its token.
///
/// Both, and in that order. The pid is the precise answer and covers every spawn that
/// got as far as writing its number down. The token covers the window that number was
/// written in: it is in the child's environment, `env_clear` means wecode owns that
/// environment completely, and an orphan whose pid was never recorded is still findable
/// by what it is carrying.
fn stop_the_agent(run: &Stranded) -> String {
    let mut stopped = Vec::new();
    // What the recorded pid turned out to be, so an operator reading "already gone"
    // can tell *nothing was left running* from *the number named somebody else*. The
    // second is the one that would mean the identity proof is drawn wrongly, and
    // without this line the two look identical.
    let recorded = match run.child() {
        None => " — no pid was recorded".to_string(),
        Some(child) => match identity::life(child) {
            Life::Alive => {
                // Only when the recorded identity still matches something live. A pid
                // handed on since belongs to somebody else, and this is the one place
                // in wecode that would kill it.
                if identity::stop(child.pid) {
                    stopped.push(child.pid);
                }
                String::new()
            }
            Life::Gone => format!(" — pid {} had already ended", child.pid),
            Life::Unproven => format!(" — pid {} cannot be proved to be ours", child.pid),
        },
    };
    for pid in run.token().map(identity::holding).unwrap_or_default() {
        // Carrying this run's token is proof enough on its own: nothing else on the
        // machine was launched with it.
        if !stopped.contains(&pid) && identity::stop(pid) {
            stopped.push(pid);
        }
    }
    if stopped.is_empty() {
        return format!("    agent already gone{recorded}\n");
    }
    let named: Vec<String> = stopped.iter().map(i64::to_string).collect();
    format!("    stopped the orphaned agent: pid {}\n", named.join(", "))
}

/// Commits the attempt, through the same function every other way out of a run uses.
fn commit(store: &Store, id: &TaskId, cwd: &Path, why: &str) -> Res {
    let report = commands::exec::commit_attempt(store, id, cwd, why)?;
    Ok(report
        .lines()
        .map(|l| format!("  {l}\n"))
        .collect::<String>())
}

/// One ledger row per run reclaimed.
///
/// `Source::Supervisor` and `Decision::Allow`, because that is what happened: nothing
/// was authorised and nothing was refused — wecode observed a process that was gone and
/// finished what it left. [`Action::Staff`] for the same reason `tick` files a promotion
/// under it: what changed is who is expected to act on this task.
///
/// The session is the supervisor's own rather than a seat's, and it is built here rather
/// than resolved from the command line. A restart cannot wait for somebody to be logged
/// in, and attributing an automatic settlement to whichever seat happened to be open
/// would put a person's name on an act they did not perform. No grants, because nothing
/// here is being authorised.
fn record(
    store: &Store,
    company: &Company,
    run: &Stranded,
) -> Result<(), Box<dyn std::error::Error>> {
    let project = store
        .load_plan()?
        .task(&run.task)
        .map(|t| t.project.to_string());
    let mut broker = Broker::new(company.charter.clone());
    let session = Session::new(
        "reclaim".to_string(),
        "supervisor".to_string(),
        "wecode".to_string(),
        Effective::of(vec![]),
    )
    .on(project, Some(run.task.to_string()));
    broker.observe(&session, Action::Staff, Decision::Allow, Source::Supervisor);
    store.append_records(broker.ledger())?;
    Ok(())
}

/// What `wecode doctor` prints: the same runs, and nothing done about them.
#[must_use]
pub(crate) fn would_do(found: &[Stranded]) -> String {
    if found.is_empty() {
        return "no run is in doubt".to_string();
    }
    let each: Vec<String> = found.iter().map(Stranded::describe).collect();
    format!("{} to reclaim — {}", found.len(), each.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_store::journal::Intent;

    fn owner(pid: i64) -> Owner {
        Owner {
            host: identity::host(),
            boot: identity::boot(),
            pid,
            start: 1,
        }
    }

    fn doubt(step: Step, resolve: Resolve) -> Doubt {
        Doubt {
            id: 1,
            intent: Intent {
                task: "t".into(),
                exec: None,
                step,
                resolve,
                target: "/wt/t".into(),
                token: "tok".into(),
                owner: owner(1),
                prior: None,
            },
            child: None,
            opened: 0,
        }
    }

    #[test]
    fn a_step_that_can_be_redone_is_settled_as_having_happened() {
        // The tree is still standing, and `worktree add` then `reset --hard` is
        // idempotent — so the honest reading is that the step stands.
        assert_eq!(
            outcome_of(&doubt(Step::Prepare, Resolve::Redo)),
            Settled::Done
        );
    }

    #[test]
    fn a_spawn_and_a_verdict_are_settled_as_undone() {
        // The agent this run started is not running, and no verdict was reached. Both
        // are what the retry after this reclaim has to be able to assume.
        assert_eq!(
            outcome_of(&doubt(Step::Spawn, Resolve::Verify)),
            Settled::Undone
        );
        assert_eq!(
            outcome_of(&doubt(Step::Verdict, Resolve::Verify)),
            Settled::Undone
        );
    }

    #[test]
    fn a_step_that_can_be_neither_repeated_nor_checked_is_abandoned() {
        // The honest class, and the class the resolve column exists to make visible: a
        // teardown hook or an outbound notification costs real money twice. Settling it
        // as `abandoned` makes it an operator's question rather than a silent redo.
        assert_eq!(
            outcome_of(&doubt(Step::Commit, Resolve::Refuse)),
            Settled::Abandoned
        );
    }

    #[test]
    fn a_run_in_doubt_names_the_task_the_owner_and_the_steps() {
        // What the operator reads on the way past, and what `doctor` prints without
        // touching anything.
        let run = Stranded {
            task: TaskId::new("cache-tests"),
            owner: owner(4242),
            rows: vec![
                doubt(Step::Prepare, Resolve::Redo),
                doubt(Step::Spawn, Resolve::Verify),
            ],
        };
        let said = run.describe();
        assert!(said.contains("cache-tests"), "{said}");
        assert!(said.contains("4242"), "{said}");
        assert!(said.contains("prepare, spawn"), "{said}");
        assert!(would_do(&[run]).starts_with("1 to reclaim"));
    }

    #[test]
    fn nothing_in_doubt_is_said_as_nothing_rather_than_as_an_empty_list() {
        assert_eq!(would_do(&[]), "no run is in doubt");
    }

    #[test]
    fn a_run_carries_where_it_worked_and_where_the_task_came_from() {
        let mut prepare = doubt(Step::Prepare, Resolve::Redo);
        prepare.intent.prior = Some(TaskStatus::Waiting);
        let mut spawn = doubt(Step::Spawn, Resolve::Verify);
        spawn.intent.exec = Some(7);
        spawn.child = Some(owner(5150));
        let run = Stranded {
            task: TaskId::new("t"),
            owner: owner(1),
            rows: vec![prepare, spawn],
        };
        assert_eq!(run.cwd(), Some(PathBuf::from("/wt/t")));
        assert_eq!(run.prior(), Some(TaskStatus::Waiting));
        assert_eq!(run.exec(), Some(7));
        assert_eq!(run.child().map(|c| c.pid), Some(5150));
        assert_eq!(run.token(), Some("tok"));
    }

    #[test]
    fn the_reason_a_reclaimed_run_carries_names_the_crash_not_an_exit_code() {
        // "exit 1" is what a crash, a refusal and a machine with no credential all look
        // like from outside — and here nobody observed an exit at all.
        let why = cause(&owner(4242));
        assert!(why.contains("4242"), "{why}");
        assert!(why.contains("no verdict"), "{why}");
    }
}
