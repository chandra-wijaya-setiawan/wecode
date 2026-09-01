//! Requirements as first-class records (ADR-0005): a story states them, tasks
//! serve them, and a task created against one reopens it. Split out of
//! admission.rs at the ratchet — requirements are their own concept.

use crate::{Defect, Plan, Task, TaskId, TaskKind};


/// A task against the obligations its project has stated (ADR-0005).
///
/// A gate beside [`check_task`] on [`check_refusals`]'s terms, and for the same reason:
/// half of what it needs is not in the plan. The task says what it serves — that is
/// [`Task::requirement`], a field like any other — and `known` is every handle that
/// answers for it, a story's own or a task's whole project's. Those are ledger rows, and
/// core reads no database any more than it reads a file, so they are handed in by the
/// one command group that has them.
///
/// Asked of the task rather than of a handle passed alongside it, so a caller checking a
/// declaration before it is written checks the same object that will be saved. A handle
/// beside the task is a second place for the answer to live, and the two disagree at the
/// first caller that forgets to pass it.
///
/// A story is asked the other question, what it *owes*, because a story is where an
/// obligation is stated and one that states none is a container whose completion nothing
/// can settle.
#[must_use]
pub fn check_requirement(t: &Task, known: &[String]) -> Vec<Defect> {
    let mut out = Vec::new();
    // The exemption every gate beside this one makes: an obligation stated after the
    // work finished cannot make the finished work retroactively defective.
    if t.status.is_closed() {
        return out;
    }
    if let Some(id) = &t.requirement
        && !known.iter().any(|k| k == id)
    {
        out.push(Defect::RequirementUnknown {
            named: id.clone(),
            known: known.to_vec(),
        });
    }
    if t.kind == TaskKind::Story && known.is_empty() && t.requirement.is_none() {
        out.push(Defect::StoryOwesNothing);
    }
    out
}

/// Whether an obligation has been answered, given the tasks that took a run at it.
///
/// ADR-0005 states the rule as a reset — creating a task against a requirement puts it
/// back to `open` — and this is the same rule with nothing to remember: an obligation
/// is met while something has answered it and nothing open still claims it. Derived
/// rather than stored, because a status column is a copy of what the tasks already
/// say, and the two go out of step at the first task somebody moves by hand.
///
/// A task that is no longer in the plan is not a claim on anything: `wecode task rm`
/// erases work that never ran, and a removed attempt holding an obligation open for
/// ever would be an obligation nothing could close.
#[must_use]
pub fn requirement_is_met(served_by: &[TaskId], plan: &Plan) -> bool {
    let mut answered = false;
    for id in served_by {
        let Some(t) = plan.task(id) else { continue };
        if t.status.is_done() {
            answered = true;
        } else if !t.status.is_closed() {
            return false;
        }
    }
    answered
}
