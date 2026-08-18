//! The tick: keeping the stored status honest about what is startable.
//!
//! `Waiting` and `Ready` differ only by whether prerequisites are finished, which the
//! plan can always compute. The stored value is a **cache**, and this is its single
//! author — a missed tick delays a promotion, it cannot lose one.
//!
//! Archived projects are skipped. Archiving parks a project, so its tasks stop being
//! promoted as well as stop being shown.
//!
//! One kind is promoted somewhere else entirely. A manual task's agent is a person, so
//! an unblocked one becomes the operator's to do rather than the queue's: the tick
//! moves it to `needs-approval` and nothing dispatches it, ever. That is the only
//! status this module authors outside the `Waiting`/`Ready` pair, and it is authored
//! here for the same reason the pair is — prerequisites have to be honoured before the
//! work is anyone's, and the graph is what knows.

use std::time::Duration;

use wecode_core::{Plan, Task, TaskId, TaskStatus};

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
        .filter(|t| plan.project(&t.project).is_some_and(|p| !p.archived))
        .filter_map(|t| {
            let ready = plan.is_ready(&t.id);
            match t.status {
                // Work whose agent is a person does not join the queue it would never
                // be taken from. Unblocked, it stops on the operator instead — from
                // `Waiting` directly, without a tick spent in a `Ready` that would be
                // a lie about what could start it.
                //
                // Its prerequisites are honoured first, and that is the whole reason
                // this lives in the tick rather than at the door: a console step
                // waiting on the task that tells the operator what to do in the
                // console must not go off before that task finishes.
                s if s.is_schedulable() && ready && t.kind.is_done_by_a_person() => {
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
        .filter(|t| !t.kind.is_done_by_a_person())
        .filter(|t| plan.project(&t.project).is_some_and(|p| !p.archived))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.truncate(slots);
    out
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

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Measure, Project, Scope, Task, TaskKind};

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
        t.kind = TaskKind::Manual;
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
