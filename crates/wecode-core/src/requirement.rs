//! Requirements as first-class records (ADR-0005): a story states them, tasks
//! serve them, and a task created against one reopens it. Split out of
//! admission.rs at the ratchet — requirements are their own concept.

use crate::{Defect, Plan, Task, TaskId, TaskKind};


/// A task against the obligations its project has stated (ADR-0005).
///
/// A gate beside [`check_task`] on [`check_refusals`]'s terms, and for the same reason:
/// what it needs is not in the plan. Requirements are ledger rows, and core reads no
/// database any more than it reads a file — so the handles are handed in, by the one
/// command group that has them, wherever a requirement is named or read back.
///
/// `named` is the handle this declaration cites, if any; `known` is every handle that
/// answers for this task — a story's own, a task's whole project's. A story is asked
/// the other question, what it *owes*, because a story is where an obligation is
/// stated and one that states none is a container whose completion nothing can settle.
#[must_use]
pub fn check_requirement(t: &Task, named: Option<&str>, known: &[String]) -> Vec<Defect> {
    let mut out = Vec::new();
    // The exemption every gate beside this one makes: an obligation stated after the
    // work finished cannot make the finished work retroactively defective.
    if t.status.is_closed() {
        return out;
    }
    if let Some(id) = named
        && !known.iter().any(|k| k == id)
    {
        out.push(Defect::RequirementUnknown {
            named: id.to_string(),
            known: known.to_vec(),
        });
    }
    if t.kind == TaskKind::Story && known.is_empty() && named.is_none() {
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
