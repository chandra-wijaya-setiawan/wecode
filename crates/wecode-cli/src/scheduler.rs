//! The tick: keeping the stored status honest about what is startable.
//!
//! `Waiting` and `Ready` differ only by whether prerequisites are finished, which the
//! plan can always compute. The stored value is a **cache**, and this is its single
//! author — a missed tick delays a promotion, it cannot lose one.
//!
//! Archived projects are skipped. Archiving parks a project, so its tasks stop being
//! promoted as well as stop being shown.
//!
//! Manual work is promoted somewhere else entirely. A task whose doer is a person is
//! never dispatched — an unblocked one becomes the operator's to do rather than the
//! queue's, so the tick moves it to `needs-approval` and leaves it there. That is the
//! only status this module authors outside the `Waiting`/`Ready` pair, and it is
//! authored here for the same reason the pair is: prerequisites have to be honoured
//! before the work is anyone's, and the graph is what knows.
//!
//! That one move is also the only one anybody has to be *told* about, and it is the
//! caller's to tell: everything here computes moves and writes nothing, so the
//! announcement belongs beside the status write — see
//! [`crate::commands::exec::on_promotion`]. Every other wait in wecode is a message
//! about work already done, and a person could find it on the board a day later
//! without having lost anything. This one is the dispatch. Nothing has happened yet,
//! the doing is theirs, and a promotion that reached only the database is a task
//! assigned to somebody who was never asked.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use wecode_core::{ExecutionStatus, Plan, ProjectStatus, Task, TaskId, TaskStatus};
use wecode_org::company::Budgets;
use wecode_store::Execution;
use wecode_store::execution::OpenRun;

/// One status change a tick implies.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Move {
    pub(crate) task: TaskId,
    pub(crate) from: TaskStatus,
    pub(crate) to: TaskStatus,
}

/// What this tick would change, computed and returned rather than applied.
///
/// Pure so the decision is testable without a database, and so the caller can record
/// each move before making it.
pub(crate) fn transitions(plan: &Plan) -> Vec<Move> {
    let mut moves: Vec<Move> = plan
        .tasks()
        // A hold keeps the project and its work on the board while parking the queue.
        .filter(|t| {
            plan.project(&t.project)
                .is_some_and(|p| !p.archived && p.status != ProjectStatus::Hold)
        })
        .filter_map(|t| {
            let ready = plan.is_ready(&t.id);
            match t.status {
                // Work a person does never joins the queue it would never be taken
                // from. Unblocked, it stops on the operator instead — straight from
                // `Waiting`, without a tick spent in a `Ready` that would be a lie
                // about what could start it.
                //
                // Its prerequisites are honoured first, and that is the whole reason
                // this lives in the tick rather than at the door: a console step
                // waiting on the task that tells the operator what to do in the
                // console must not go off before that task has finished.
                s if s.is_schedulable() && ready && t.is_done_by_a_person() => {
                    Some(TaskStatus::NeedsApproval)
                }
                TaskStatus::Waiting if ready => Some(TaskStatus::Ready),
                // Demotion matters as much as promotion. Reopening a finished
                // prerequisite must put its dependents back, or the queue offers work
                // whose groundwork has been undone.
                TaskStatus::Ready if !ready => Some(TaskStatus::Waiting),
                _ => None,
            }
            .map(|to| Move {
                task: t.id.clone(),
                from: t.status,
                to,
            })
        })
        .collect();
    moves.sort_by(|a, b| a.task.cmp(&b.task));
    moves
}

/// How many tasks may run at once, given what the operator can absorb.
///
/// Concurrency derives from attention, not from cores. `max_open_items` is the number
/// of things the operator is willing to have in flight; a machine limit only ever
/// narrows it further.
#[must_use]
pub(crate) fn parallelism(max_open_items: u64, cores: usize) -> usize {
    let by_attention = usize::try_from(max_open_items.max(1)).unwrap_or(usize::MAX);
    // Leave two: one for wecode, one for the operator's own shell.
    let by_machine = cores.saturating_sub(2).max(1);
    by_attention.min(by_machine)
}

/// Tasks the loop should dispatch this pass, in id order, capped by `slots`.
///
/// Only `Ready`. A `Waiting` task has not been promoted yet, and promoting and
/// dispatching in the same breath would skip the record of it becoming startable.
///
/// Never a manual task, whatever its stored status says. The tick moves those to
/// `needs-approval` before they could be picked up, so this filter should never be
/// the thing that catches one — which is exactly why it is here. The status is a
/// cache and this is the guardrail: a hand-set `ready`, a stale plan read, a tick
/// that has not run yet, and the difference is an agent being handed the console
/// step a person was supposed to do.
pub(crate) fn dispatchable(plan: &Plan, slots: usize) -> Vec<&Task> {
    if slots == 0 {
        return Vec::new();
    }
    let mut out: Vec<&Task> = plan
        .tasks()
        .filter(|t| t.status == TaskStatus::Ready && t.assignee.is_some())
        .filter(|t| !t.is_done_by_a_person())
        // Task holds fail the `Ready` test above; project holds need their own guard.
        .filter(|t| {
            plan.project(&t.project)
                .is_some_and(|p| !p.archived && p.status != ProjectStatus::Hold)
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.truncate(slots);
    out
}

/// Why a dispatch may not take this task, because another one already holds it.
///
/// What it stops is the loser of a race walking into the winner's tree. Preparing resets
/// the checkout an agent is working in, and two agents on one checkout overwrite each
/// other's work — so a dispatch arriving on a task somebody is already running has one
/// safe move, which is to stand down.
///
/// Two facts, and it takes both. `Running` is what a dispatch writes to say the task is
/// taken, but it is a cache, and the same word covers an operator who typed `start` an
/// hour ago and went to lunch. The attempt row is the other half and the harder one: a
/// row still `working` is a process wecode observed itself, in that worktree, now.
///
/// Both, because either alone refuses something legitimate. On the status alone an
/// operator could not `start` their own task twice, and re-preparing is how the tree is
/// reset for a second look. On the row alone a supervisor killed mid-run would hold the
/// task for ever — the row is deliberately left open in that case, since it is the
/// recovery information — and no status anyone could write would say otherwise.
///
/// Returned rather than raised, like [`crate::commands::exec::unsigned`]: a task
/// somebody else is already doing is not a failure of the pass that skipped it.
///
/// The difference from [`dispatchable`] is the point. That decides what the *queue* may
/// offer; this decides what a dispatch already aimed at a task may do with it. A `failed`
/// task is retried by hand and a `waiting` one is taken by hand, so neither is contended
/// — only a run in flight is.
#[must_use]
pub(crate) fn contended(id: &TaskId, held: TaskStatus, runs: &[Execution]) -> Option<String> {
    let in_flight = runs
        .iter()
        .any(|r| r.ended.is_none() && r.status == ExecutionStatus::Working);
    (held == TaskStatus::Running && in_flight).then(|| {
        format!(
            "{id} is already running — another dispatch has it\n  \
             `wecode show {id}` for the attempt in flight, \
             or `wecode status {id} ready` to hand it back"
        )
    })
}

/// Why a dispatch may not take this task, because the seat behind it is burning money.
///
/// The circuit breaker. A token budget is a figure *per attempt*, so three retries of a
/// task budgeted at 200k are each inside their budget and have spent six hundred thousand
/// tokens between them in twenty minutes. Nothing in a per-attempt ceiling can see that,
/// because every attempt it can see was fine — the spike is in the rate, and the rate is
/// what [`crate::usage::per_hour`] reads off the rows the attempts already wrote.
///
/// At the door and not in the run, which is what makes it cheap to be wrong about.
/// `[budgets] enforce` kills a run in flight and destroys the work already paid for; this
/// declines to *start* the next one, so a ceiling set too low costs a queue that stands
/// still rather than a worktree full of half-written change. That is why the two are
/// separate keys and why this one is safe to turn on first.
///
/// It resets itself. The window slides with `now`, so an hour of quiet closes the circuit
/// with nobody clearing anything — the operator who wants it back sooner raises the
/// ceiling, and the one who wants it never raises it takes the key out of the file.
///
/// Returned rather than raised, and beside [`contended`] because it is the same door and
/// the same shape of answer: a task the operator's own budget says to leave alone is not
/// a failure of the pass that skipped it. Off entirely when no ceiling is written, which
/// is what every company that has never heard of this says.
#[allow(
    dead_code,
    reason = "the call site in commands::exec is out of this task's scope"
)]
#[must_use]
pub(crate) fn burning(
    id: &TaskId,
    budgets: Budgets,
    runs: &[Execution],
    now: u64,
) -> Option<String> {
    let ceiling = budgets.max_tokens_per_hour?;
    let spent = crate::usage::per_hour(runs, now);
    (spent > ceiling).then(|| {
        format!(
            "{id} is cut off — its attempts burned {spent} tokens in the last hour, over \
             the {ceiling} `[budgets] max_tokens_per_hour` allows\n  \
             `wecode show {id}` for the attempts that spent it — the hour slides, so \
             this clears itself"
        )
    })
}

/// How many slots are free, given what is already running.
#[must_use]
pub(crate) fn free_slots(plan: &Plan, limit: usize) -> usize {
    let running = plan
        .tasks()
        .filter(|t| t.status == TaskStatus::Running)
        .count();
    limit.saturating_sub(running)
}

/// Whether anything is waiting on a person. The loop pauses rather than piling more
/// on: unanswered questions are the one thing more work cannot help with.
#[must_use]
pub(crate) fn awaiting_a_human(plan: &Plan) -> Vec<&Task> {
    let mut out: Vec<&Task> = plan
        .tasks()
        .filter(|t| t.status.needs_a_human())
        .filter(|t| plan.project(&t.project).is_some_and(|p| !p.archived))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// How long to sleep between passes.
pub(crate) const INTERVAL: Duration = Duration::from_secs(5);

/// The open runs whose supervisor has stopped saying so: no beat for `silence`.
///
/// Pure and returned rather than applied, exactly as [`transitions`] is: the decision
/// is testable without a database, and the caller records each close before making it.
/// A `NULL` beat on an open row reads as `started` — the row predates the beat, and
/// the claim is dated from the last evidence anyone actually holds.
///
/// Ages are computed saturating, so a beat that reads future-dated — a wall clock
/// stepped backwards under the beating thread — reads *fresh*, and a backwards step
/// delays the sweep rather than making it wrong.
pub(crate) fn stale(runs: &[OpenRun], now: u64, silence: Duration) -> Vec<&OpenRun> {
    runs.iter()
        .filter(|r| now.saturating_sub(r.beat.unwrap_or(r.started)) >= silence.as_secs())
        .collect()
}

/// The sweep's memory between passes: which runs read stale, and when each was first
/// seen to.
///
/// Held in the loop's process rather than in the database, beside `Announced` and
/// `Rhythm` and for their reason: an edge with nothing in the database to be the edge
/// of belongs to the process that watches for it. It is also what makes the sweep safe
/// on a laptop — suspend freezes the beating thread while the wall clock runs on, so a
/// machine resuming after eight hours holds live runs whose beats read eight hours
/// old. One reading may not close anything; a run still stale a whole window later is
/// one whose resumed supervisor had every chance to speak.
///
/// It follows that only `wecode loop` sweeps. A one-shot `wecode tick` has one pass
/// and was not there to hear the silence, so it may not judge it — and this memory
/// dies with the process, so it cannot.
pub(crate) struct Suspects {
    window: Duration,
    seen: HashMap<i64, Instant>,
}

impl Suspects {
    pub(crate) fn new(window: Duration) -> Self {
        Self {
            window,
            seen: HashMap::new(),
        }
    }

    /// Which of `stale` have now read stale for the whole window, this pass running at
    /// `now`. A run that stopped reading stale — beaten again, or closed by a
    /// returning supervisor — is forgotten entirely, so a later suspicion of the same
    /// run starts the window over.
    pub(crate) fn confirm(&mut self, stale: &[i64], now: Instant) -> Vec<i64> {
        self.seen.retain(|id, _| stale.contains(id));
        let mut due: Vec<i64> = stale
            .iter()
            .filter(|&&id| {
                now.duration_since(*self.seen.entry(id).or_insert(now)) >= self.window
            })
            .copied()
            .collect();
        due.sort_unstable();
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::task::Doer;
    use wecode_core::{Budget, Measure, Project, Scope, Task};

    fn task(id: &str) -> Task {
        Task::new(id, "p", "do something specific here")
            .accepting(Measure::Command {
                cmd: "true".into(),
                expect_status: 0,
            })
            .scoped(Scope::write(&[&format!("{id}/**")]))
            .budgeted(Budget {
                tokens: Some(10),
                wall_secs: Some(1),
            })
    }

    /// `a` then `b`, both waiting.
    fn plan() -> Plan {
        let mut p = Plan::new();
        p.add_project(Project::new("p", "an objective sentence", "repo"))
            .unwrap();
        let mut a = task("a");
        a.status = TaskStatus::Waiting;
        p.add_task(a).unwrap();
        let mut b = task("b").after("a");
        b.status = TaskStatus::Waiting;
        p.add_task(b).unwrap();
        p
    }

    fn set(p: &mut Plan, id: &str, s: TaskStatus) {
        let mut t = p.task(&TaskId::new(id)).unwrap().clone();
        t.status = s;
        p.update_task(t).unwrap();
    }

    fn make_manual(p: &mut Plan, id: &str) {
        let mut t = p.task(&TaskId::new(id)).unwrap().clone();
        t.doer = Doer::Person;
        p.update_task(t).unwrap();
    }

    #[test]
    fn an_unblocked_waiting_task_is_promoted_and_a_blocked_one_is_not() {
        let m = transitions(&plan());
        assert_eq!(m.len(), 1, "{m:?}");
        assert_eq!(m[0].task.as_str(), "a");
        assert_eq!(m[0].to, TaskStatus::Ready);
    }

    #[test]
    fn finishing_a_prerequisite_releases_its_dependent_on_the_next_tick() {
        let mut p = plan();
        set(&mut p, "a", TaskStatus::Done);
        let m = transitions(&p);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].task.as_str(), "b");
        assert_eq!(m[0].to, TaskStatus::Ready);
    }

    #[test]
    fn reopening_a_prerequisite_puts_its_dependent_back() {
        // Without demotion the queue would keep offering work whose groundwork has
        // been undone.
        let mut p = plan();
        set(&mut p, "a", TaskStatus::Done);
        set(&mut p, "b", TaskStatus::Ready);
        assert!(transitions(&p).is_empty(), "settled");

        set(&mut p, "a", TaskStatus::Waiting);
        let m = transitions(&p);
        assert_eq!(m.len(), 2, "{m:?}");
        let b = m.iter().find(|x| x.task.as_str() == "b").unwrap();
        assert_eq!(b.from, TaskStatus::Ready);
        assert_eq!(b.to, TaskStatus::Waiting);
    }

    #[test]
    fn a_tick_over_a_settled_plan_changes_nothing() {
        // Idempotence is what makes running this on a timer safe.
        let mut p = plan();
        set(&mut p, "a", TaskStatus::Ready);
        assert!(transitions(&p).is_empty());
    }

    #[test]
    fn statuses_the_scheduler_does_not_own_are_left_alone() {
        // Running, verifying, needs-approval, failed and done all belong to someone
        // else. A tick that touched them would fight the thing that set them.
        for s in [
            TaskStatus::Draft,
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
            TaskStatus::NeedsInput,
            TaskStatus::Failed,
            TaskStatus::Done,
            TaskStatus::Dropped,
        ] {
            let mut p = plan();
            set(&mut p, "a", s);
            assert!(
                !transitions(&p).iter().any(|m| m.task.as_str() == "a"),
                "{s:?} should not be touched"
            );
        }
    }

    #[test]
    fn an_archived_project_is_not_scanned() {
        // Archiving parks the work, so promotion stops with visibility.
        let mut p = plan();
        let mut proj = p.project(&"p".into()).unwrap().clone();
        proj.archived = true;
        p.update_project(proj).unwrap();
        assert!(transitions(&p).is_empty());
    }

    #[test]
    fn a_held_project_is_visible_but_not_scanned_or_dispatched() {
        let mut p = plan();
        let mut task = p.task(&TaskId::new("a")).unwrap().clone();
        task.status = TaskStatus::Ready;
        task.assignee = Some("impl".into());
        p.update_task(task).unwrap();
        let mut project = p.project(&"p".into()).unwrap().clone();
        project.status = ProjectStatus::Hold;
        p.update_project(project).unwrap();
        assert!(transitions(&p).is_empty());
        assert!(dispatchable(&p, 10).is_empty());
        assert!(p.project(&"p".into()).is_some());
    }

    #[test]
    fn a_held_task_is_not_promoted_or_dispatched() {
        let mut p = plan();
        let mut task = p.task(&TaskId::new("a")).unwrap().clone();
        task.status = TaskStatus::Hold;
        task.assignee = Some("impl".into());
        p.update_task(task).unwrap();
        assert!(transitions(&p).is_empty());
        assert!(dispatchable(&p, 10).is_empty());
        assert!(p.task(&TaskId::new("a")).is_some());
    }

    #[test]
    fn concurrency_comes_from_attention_and_is_narrowed_by_the_machine() {
        // The operator's capacity is the binding constraint; cores only ever reduce it.
        assert_eq!(parallelism(5, 32), 5);
        assert_eq!(parallelism(5, 4), 2, "cores - 2");
        assert_eq!(parallelism(1, 64), 1);
        // Never zero: a degenerate config must not silently stop all work.
        assert_eq!(parallelism(0, 1), 1);
    }

    #[test]
    fn only_ready_assigned_tasks_are_dispatched() {
        let mut p = plan();
        set(&mut p, "a", TaskStatus::Ready);
        // Unassigned: there is no post, so no agent to launch.
        assert!(dispatchable(&p, 10).is_empty());

        let mut a = p.task(&TaskId::new("a")).unwrap().clone();
        a.assignee = Some("impl".into());
        p.update_task(a).unwrap();
        let d = dispatchable(&p, 10);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].id.as_str(), "a");
    }

    #[test]
    fn dispatch_is_capped_by_the_slots_given() {
        let mut p = plan();
        for id in ["a", "b"] {
            let mut t = p.task(&TaskId::new(id)).unwrap().clone();
            t.status = TaskStatus::Ready;
            t.assignee = Some("impl".into());
            p.update_task(t).unwrap();
        }
        assert_eq!(dispatchable(&p, 1).len(), 1);
        assert_eq!(dispatchable(&p, 2).len(), 2);
        assert!(dispatchable(&p, 0).is_empty(), "no slots, no dispatch");
    }

    #[test]
    fn running_work_consumes_slots() {
        let mut p = plan();
        set(&mut p, "a", TaskStatus::Running);
        assert_eq!(free_slots(&p, 3), 2);
        set(&mut p, "b", TaskStatus::Running);
        assert_eq!(free_slots(&p, 3), 1);
        // Never negative, however many were started by hand.
        assert_eq!(free_slots(&p, 1), 0);
    }

    /// One attempt row, as the store would hold it: `ended` is what tells an open run
    /// from a finished one.
    fn attempt(status: ExecutionStatus, ended: Option<u64>) -> Execution {
        Execution {
            id: 1,
            task: "a".into(),
            session: "s".into(),
            attempt: 1,
            attested_by: None,
            status,
            worktree: None,
            pid: Some(42),
            started: 0,
            ended,
            wall_secs: None,
            spent_tokens: None,
            replayed_tokens: None,
            detail: String::new(),
        }
    }

    #[test]
    fn a_second_dispatch_onto_a_run_in_flight_is_told_to_stand_down() {
        let open = [attempt(ExecutionStatus::Working, None)];
        let why =
            contended(&TaskId::new("a"), TaskStatus::Running, &open).expect("a run is in flight");
        assert!(why.contains("already running"), "{why}");
        // And a way back, because the other half of this is a supervisor that died
        // holding the claim: nothing else moves a `running` task on its own.
        assert!(why.contains("wecode status a ready"), "{why}");
    }

    #[test]
    fn taking_your_own_claim_again_is_not_a_race_you_lost() {
        // `start` writes `running` and opens no attempt: the operator has it, and
        // starting again is how the tree is reset for a second look. Refusing that
        // would strand a task nothing else moves.
        let id = TaskId::new("a");
        assert_eq!(contended(&id, TaskStatus::Running, &[]), None);
        // A finished attempt is not a claim either, whatever it finished as.
        let done = [attempt(ExecutionStatus::Completed, Some(9))];
        assert_eq!(contended(&id, TaskStatus::Running, &done), None);
    }

    #[test]
    fn a_run_in_flight_over_a_status_that_moved_on_holds_nothing() {
        // The status is the claim; the row only says a process was seen. Once something
        // has written a verdict over it, this dispatch is not the one that lost a race —
        // a retry of a failed task is exactly this shape.
        let open = [attempt(ExecutionStatus::Working, None)];
        for s in [
            TaskStatus::Draft,
            TaskStatus::Waiting,
            TaskStatus::Ready,
            TaskStatus::Hold,
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
            TaskStatus::NeedsInput,
            TaskStatus::Failed,
            TaskStatus::Done,
            TaskStatus::Dropped,
        ] {
            assert_eq!(contended(&TaskId::new("a"), s, &open), None, "{s:?}");
        }
    }

    /// One closed attempt with a clock and a spend, for the breaker's tests.
    fn burnt(n: i64, started: u64, ended: u64, spent: u64) -> Execution {
        let mut r = attempt(ExecutionStatus::Completed, Some(ended));
        r.attempt = n;
        r.started = started;
        r.spent_tokens = Some(spent);
        r
    }

    /// The ceiling an operator wrote, or none at all.
    fn ceiling(n: Option<u64>) -> Budgets {
        Budgets {
            enforce: false,
            max_tokens_per_hour: n,
        }
    }

    #[test]
    fn a_seat_that_burned_the_hours_ceiling_is_cut_off_before_the_next_dispatch() {
        // Three retries, each inside a 200k per-attempt budget, six hundred thousand
        // tokens in twenty minutes. The budget saw nothing wrong with any of them.
        let runs = [
            burnt(1, 0, 400, 200_000),
            burnt(2, 400, 800, 200_000),
            burnt(3, 800, 1200, 200_000),
        ];
        let why = burning(&TaskId::new("a"), ceiling(Some(500_000)), &runs, 1200)
            .expect("the rate is over the ceiling");
        assert!(why.contains("600000 tokens in the last hour"), "{why}");
        assert!(why.contains("500000"), "the ceiling it crossed: {why}");
        // And where the figure came from, because the refusal is a number on its own.
        assert!(why.contains("wecode show a"), "{why}");
    }

    #[test]
    fn a_seat_inside_the_rate_is_dispatched_exactly_as_before() {
        let runs = [burnt(1, 0, 400, 200_000)];
        assert_eq!(
            burning(&TaskId::new("a"), ceiling(Some(500_000)), &runs, 400),
            None
        );
        // Equal is not over: a ceiling is the most that may be spent, not the least
        // that trips.
        let spent = [burnt(1, 0, 400, 500_000)];
        assert_eq!(
            burning(&TaskId::new("a"), ceiling(Some(500_000)), &spent, 400),
            None
        );
    }

    #[test]
    fn no_ceiling_is_no_breaker_rather_than_a_breaker_at_zero() {
        // What every company written before the key says, and it must keep meaning
        // exactly what it meant.
        let runs = [burnt(1, 0, 400, 9_000_000)];
        assert_eq!(burning(&TaskId::new("a"), ceiling(None), &runs, 400), None);
    }

    #[test]
    fn the_circuit_closes_itself_an_hour_later() {
        // A breaker, not a fuse. Nothing is latched, so nothing has to be cleared —
        // the same rows stop being a spike as the window slides off them.
        let runs = [burnt(1, 0, 60, 900_000)];
        let cut = |now| burning(&TaskId::new("a"), ceiling(Some(500_000)), &runs, now);
        assert!(cut(100).is_some(), "still inside the hour");
        assert!(cut(3661).is_none(), "and out the other side");
    }

    #[test]
    fn work_stuck_on_a_person_is_reported() {
        let mut p = plan();
        set(&mut p, "a", TaskStatus::NeedsApproval);
        set(&mut p, "b", TaskStatus::Failed);
        let waiting: Vec<&str> = awaiting_a_human(&p).iter().map(|t| t.id.as_str()).collect();
        assert_eq!(waiting, vec!["a", "b"]);
    }

    #[test]
    fn an_archived_project_is_never_dispatched_from() {
        let mut p = plan();
        let mut a = p.task(&TaskId::new("a")).unwrap().clone();
        a.status = TaskStatus::Ready;
        a.assignee = Some("impl".into());
        p.update_task(a).unwrap();
        assert_eq!(dispatchable(&p, 10).len(), 1, "control");

        let mut proj = p.project(&"p".into()).unwrap().clone();
        proj.archived = true;
        p.update_project(proj).unwrap();
        assert!(dispatchable(&p, 10).is_empty());
        assert!(awaiting_a_human(&p).is_empty());
    }

    #[test]
    fn an_unblocked_manual_task_stops_on_a_person_instead_of_joining_the_queue() {
        let mut p = plan();
        make_manual(&mut p, "a");
        let m = transitions(&p);
        assert_eq!(m.len(), 1, "{m:?}");
        assert_eq!(m[0].task.as_str(), "a");
        assert_eq!(m[0].from, TaskStatus::Waiting);
        assert_eq!(
            m[0].to,
            TaskStatus::NeedsApproval,
            "a person's work never passes through ready"
        );
    }

    #[test]
    fn a_manual_task_waits_for_its_prerequisites_like_any_other() {
        // The reason this belongs in the tick: a console step whose instructions come
        // from an earlier task must not reach the operator before that task finishes.
        let mut p = plan();
        make_manual(&mut p, "b");
        assert!(
            !transitions(&p).iter().any(|m| m.task.as_str() == "b"),
            "b is blocked on a"
        );

        set(&mut p, "a", TaskStatus::Done);
        let m = transitions(&p);
        let b = m.iter().find(|x| x.task.as_str() == "b").unwrap();
        assert_eq!(b.to, TaskStatus::NeedsApproval);
    }

    #[test]
    fn a_manual_task_already_stored_as_ready_is_taken_out_of_the_queue() {
        // Whatever put it there — a hand-edited status, a kind changed after
        // promotion — the tick corrects it rather than leaving it dispatchable.
        let mut p = plan();
        make_manual(&mut p, "a");
        set(&mut p, "a", TaskStatus::Ready);
        let m = transitions(&p);
        assert_eq!(m.len(), 1, "{m:?}");
        assert_eq!(m[0].from, TaskStatus::Ready);
        assert_eq!(m[0].to, TaskStatus::NeedsApproval);
    }

    #[test]
    fn a_manual_task_blocked_again_is_demoted_rather_than_handed_over() {
        // Demotion still wins over the stop-for-a-person rule: unfinished groundwork
        // is not something to go and ask the operator about.
        let mut p = plan();
        make_manual(&mut p, "b");
        set(&mut p, "b", TaskStatus::Ready);
        let m = transitions(&p);
        let b = m.iter().find(|x| x.task.as_str() == "b").unwrap();
        assert_eq!(b.to, TaskStatus::Waiting);
    }

    #[test]
    fn a_manual_task_is_never_dispatched_and_the_tick_settles() {
        let mut p = plan();
        make_manual(&mut p, "a");
        let mut a = p.task(&TaskId::new("a")).unwrap().clone();
        a.status = TaskStatus::Ready;
        // Assigned to a post and unblocked: everything a dispatch needs, except that
        // the work is a person's. The guardrail holds without the tick having run.
        a.assignee = Some("owner".into());
        p.update_task(a).unwrap();
        assert!(
            dispatchable(&p, 10).is_empty(),
            "no agent is handed a person's task"
        );

        // Once the tick has moved it, it is the operator's and nothing else runs.
        set(&mut p, "a", TaskStatus::NeedsApproval);
        assert!(transitions(&p).is_empty(), "settled on the person");
        let waiting: Vec<&str> = awaiting_a_human(&p).iter().map(|t| t.id.as_str()).collect();
        assert_eq!(waiting, vec!["a"]);
    }

    /// One open row as the sweep reads it, with only the clocks varying.
    fn open_run(exec: i64, started: u64, beat: Option<u64>) -> OpenRun {
        OpenRun {
            exec,
            task: "a".into(),
            attempt: 1,
            started,
            beat,
            worktree: None,
        }
    }

    /// Ten missed beats, as the design fixed it.
    const SILENCE: Duration = Duration::from_secs(300);

    #[test]
    fn a_run_is_stale_only_after_the_whole_silence() {
        // 299 seconds of quiet is an agent thinking, not a dead supervisor: the
        // in-run limits already cover a child gone quiet under a watcher that is fine.
        let runs = [open_run(1, 0, Some(700)), open_run(2, 0, Some(701))];
        let found: Vec<i64> = stale(&runs, 1000, SILENCE).iter().map(|r| r.exec).collect();
        assert_eq!(found, vec![1]);
    }

    #[test]
    fn a_row_nobody_ever_beat_is_dated_from_its_start() {
        // NULL beat is a row from before the beat existed, or a wecode that does not
        // write one. The last evidence anyone holds is the insert itself.
        let runs = [open_run(1, 100, None)];
        assert_eq!(stale(&runs, 400, SILENCE).len(), 1);
        assert!(stale(&runs, 399, SILENCE).is_empty());
    }

    #[test]
    fn a_future_dated_beat_reads_fresh_rather_than_wrapping() {
        // A wall clock stepped backwards must delay the sweep, never trigger it.
        let runs = [open_run(1, 0, Some(5000))];
        assert!(stale(&runs, 1000, SILENCE).is_empty());
    }

    #[test]
    fn suspicion_is_confirmed_a_whole_window_later_and_never_on_one_reading() {
        let mut s = Suspects::new(Duration::from_secs(60));
        let t = Instant::now();
        assert!(s.confirm(&[7], t).is_empty(), "a first sighting only remembers");
        assert!(s.confirm(&[7], t + Duration::from_secs(59)).is_empty());
        assert_eq!(s.confirm(&[7], t + Duration::from_secs(60)), vec![7]);
    }

    #[test]
    fn a_run_that_beats_between_readings_is_forgotten() {
        // The case the confirmation exists for: suspend freezes the beating thread
        // while the wall clock runs on, so a resumed machine's live runs all read
        // stale once. The resumed supervisor beats again before the window is out,
        // and the suspicion has to die with that rather than wait to pounce.
        let mut s = Suspects::new(Duration::from_secs(60));
        let t = Instant::now();
        s.confirm(&[7], t);
        assert!(s.confirm(&[], t + Duration::from_secs(30)).is_empty());
        assert!(
            s.confirm(&[7], t + Duration::from_secs(120)).is_empty(),
            "a fresh suspicion starts the window over"
        );
    }

    #[test]
    fn a_missed_pass_delays_a_sweep_rather_than_losing_or_doubling_one() {
        // The property that makes running this on a timer safe, restated for the
        // sweep: confirmation is recomputed from the first sighting every time.
        let mut s = Suspects::new(Duration::from_secs(60));
        let t = Instant::now();
        s.confirm(&[7], t);
        let late = t + Duration::from_secs(600);
        assert_eq!(s.confirm(&[7], late), vec![7]);
        assert_eq!(s.confirm(&[7], late), vec![7], "still due until acted on");
    }

    #[test]
    fn a_missed_tick_delays_a_promotion_rather_than_losing_it() {
        // The property that makes the cache safe: readiness is recomputed from the
        // graph every time, never accumulated.
        let mut p = plan();
        set(&mut p, "a", TaskStatus::Done);
        let once = transitions(&p);
        let twice = transitions(&p);
        assert_eq!(once, twice, "the same tick twice says the same thing");
    }
}
