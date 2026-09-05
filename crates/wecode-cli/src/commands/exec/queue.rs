//! The queue side: which tasks may go now, promotion, and the width left this pass.

use wecode_core::{Plan, Task, TaskId, TaskStatus};
use wecode_gov::{Action, ActionKind, Broker, Session};
use wecode_org::{Company, Playbook};
use wecode_store::Store;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{ledger, notify, scheduler};

/// Why this task may not be dispatched yet, when its project asks for a signature and
/// the ledger does not hold a current one.
///
/// Returned rather than raised, so the loop can report it as a pause instead of an
/// error: a task waiting for a person is not a failure, and printing it as one sends the
/// operator looking for a bug that is not there.
///
/// A signature older than the last change to the task does not count. `task scope`
/// records a `define`, so widening signed work retracts the signature it was given —
/// otherwise the gate is walked past by signing something small and then changing it.
///
/// A project with no playbook, or one that says nothing, is ungated. The gate is a
/// project's own decision, in the file that describes that project's work.
pub(crate) fn unsigned(
    store: &Store,
    pb: Option<&Playbook>,
    task: &Task,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    if !pb.is_some_and(|p| p.project.dispatch.needs_a_signature()) {
        return Ok(None);
    }
    let id = &task.id;
    let sign = format!("  a holder signs it: wecode approve admission --task {id} --as <post>");
    let signed = ledger::signed_at(store, id, ActionKind::Admission)?;
    let defined = ledger::defined_at(store, id)?;
    Ok(match (signed, defined) {
        (None, _) => Some(format!(
            "{id} has not been signed for — this project dispatches by approval\n\
             {sign}\n  then: wecode run {id}\n"
        )),
        // The signature is on the record and is for a task that no longer exists in
        // that shape. Saying which is the point: "sign it again" without a reason
        // reads as a bug in the gate.
        (Some(s), Some(d)) if s < d => Some(format!(
            "{id} was changed after it was signed — the signature covered the earlier task\n\
             {sign}\n  what changed: wecode audit --task {id}\n"
        )),
        _ => None,
    })
}

/// Splits the queue into what may be dispatched now and what is waiting for a
/// signature.
///
/// The cap is applied *after* the gate rather than before, because an unsigned task must
/// not hold a slot: one of them at the head of the queue would otherwise stall
/// everything behind it for as long as nobody signed.
///
/// A playbook that cannot be read counts as ungated here, and the task goes on to
/// `prepare`, which reads it again and refuses properly. Two accounts of the same broken
/// file would be worse than one, and this is not the place that reports it.
///
/// `held` is what makes concurrency *serial per task, parallel across tasks*: the tasks
/// this loop already has supervisors on. A dispatch's first act is to claim its task, so
/// a supervisor on a still-`ready` row is a window one write wide — and offering that
/// row inside the window puts two agents in one worktree, which is the one thing
/// preparation cannot survive. [`scheduler::contended`] is the same refusal one door
/// further in, for the dispatch that is already aimed.
pub(crate) fn triage(
    store: &Store,
    company: &Company,
    plan: &Plan,
    slots: usize,
    held: &[TaskId],
) -> Result<(Vec<TaskId>, Vec<TaskId>), Box<dyn std::error::Error>> {
    let (mut go, mut waiting) = (Vec::new(), Vec::new());
    if slots == 0 {
        return Ok((go, waiting));
    }
    for t in scheduler::dispatchable(plan, usize::MAX)
        .into_iter()
        .filter(|t| !held.contains(&t.id))
    {
        let pb = plan
            .project(&t.project)
            .and_then(|p| playbook_of(company, p).ok().flatten());
        if unsigned(store, pb.as_ref(), t)?.is_some() {
            waiting.push(t.id.clone());
        } else if go.len() < slots {
            go.push(t.id.clone());
        }
    }
    Ok((go, waiting))
}

/// What a promotion has to tell a person, for the two callers that make one.
///
/// Most moves a tick makes are between two statuses nobody is waiting on, and
/// [`notify::on_status_change`] is the thing that knows it: `waiting → ready` announces
/// nothing, and this is only ever a message for the one move that stops on somebody.
/// That move is a manual task's — see [`scheduler::transitions`] — and it is the wait
/// with nothing behind it, so the announcement *is* the dispatch. Without it a person's
/// task became theirs in a database, and the operator found out by opening the board.
///
/// Shared by [`tick`] and [`serve`] rather than written twice, because the two apply the
/// same moves and a notification only one of them made would be an operator whose phone
/// depends on which command is running.
pub(crate) fn on_promotion(
    company: &Company,
    org: &std::path::Path,
    plan: &Plan,
    m: &scheduler::Move,
) -> String {
    plan.task(&m.task).map_or_else(String::new, |task| {
        notify::on_status_change(company, org, task, m.from, m.to)
    })
}

/// One pass of the scheduler: bring stored statuses in line with the graph.
///
/// Separate from dispatch so it can be run, read and trusted on its own. The loop
/// calls the same function.
pub(crate) fn tick(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let moves = scheduler::transitions(&plan);
    if moves.is_empty() {
        return Ok("  nothing to promote\n".to_string());
    }

    // Recorded as observed rather than decided: the scheduler read the graph, it did
    // not choose anything a person could have chosen differently.
    let who = actor(a, &store, &company)?;
    let mut broker = Broker::new(company.charter.clone());
    let mut out = String::new();
    for m in &moves {
        store.set_task_status(&m.task, m.to)?;
        let project = plan.task(&m.task).map(|t| t.project.to_string());
        let session = Session::new(
            who.session.clone(),
            who.post.clone(),
            who.agent.clone(),
            who.effective.clone(),
        )
        .on(project, Some(m.task.to_string()))
        .with_human(who.human.clone());
        broker.observe(
            &session,
            Action::Staff,
            wecode_gov::Decision::Allow,
            wecode_gov::Source::Supervisor,
        );
        out.push_str(&format!(
            "  {}  {} → {}\n",
            m.task,
            m.from.as_str(),
            m.to.as_str()
        ));
        // After the write, like every other announcement: the message names a status,
        // and a hook that fired first could be answered before the status was true.
        out.push_str(&on_promotion(&company, ws.root(), &plan, m));
    }
    store.append_records(broker.ledger())?;
    Ok(out)
}

/// The width left this pass: the slots [`scheduler::free_slots`] counts from the stored
/// statuses, less the dispatches this loop is carrying whose claim has not landed yet.
///
/// The status is the shared answer, and that is why the width is derived rather than
/// counted in memory: `running` is what any dispatch in any process writes, so a second
/// terminal's `wecode run` narrows the loop exactly as one of its own runs does. What
/// the store cannot know is the instant between a supervisor leaving here and its claim
/// arriving there — one write wide, and enough to give a slot away twice. Counted as a
/// union, so a held task the store already calls `running` is one slot and not two.
pub(crate) fn slots_free(plan: &Plan, limit: usize, held: &[TaskId]) -> usize {
    let unclaimed = held
        .iter()
        .filter(|id| {
            plan.task(id)
                .is_some_and(|t| t.status != TaskStatus::Running)
        })
        .count();
    scheduler::free_slots(plan, limit).saturating_sub(unclaimed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::exec::test_support::chain;

    #[test]
    fn a_dispatch_holds_a_slot_before_its_claim_lands_and_never_two() {
        // The window between a supervisor leaving and its `running` write arriving:
        // counted from memory inside it, from the status afterwards, and once either
        // way. Without the first half a pass gives the same slot away twice; without
        // the union the second half takes a slot off the width for nothing.
        let (mut plan, _) = chain();
        let held = [TaskId::new("second")];
        assert_eq!(slots_free(&plan, 3, &held), 2, "claim not landed yet");

        let mut t = plan.task(&TaskId::new("second")).unwrap().clone();
        t.status = TaskStatus::Running;
        plan.update_task(t).unwrap();
        assert_eq!(slots_free(&plan, 3, &held), 2, "and once it has");
        assert_eq!(slots_free(&plan, 3, &[]), 2, "the status alone says the same");
        // Never negative, however narrow the budget.
        assert_eq!(slots_free(&plan, 1, &held), 0);
    }
}
