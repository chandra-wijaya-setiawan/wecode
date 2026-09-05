//! Whether two tasks may be in flight at once.
//!
//! Split out of `admission.rs` at the ratchet, for the reason `requirement.rs` was:
//! this is one concept, and the gate that admits a task and the queue that chooses a
//! batch must not be allowed to disagree about what a conflict is. Both ask here.

use crate::id::TaskId;
use crate::{Plan, ProjectId, Task, TaskStatus};

/// Prefix-containment overlap. Deliberately coarse: it errs toward reporting a
/// conflict, and a false positive costs one question while a false negative costs a
/// corrupted worktree.
pub(crate) fn globs_overlap(a: &str, b: &str) -> bool {
    let pa = literal_prefix(a);
    let pb = literal_prefix(b);
    under(&pa, &pb) || under(&pb, &pa)
}

/// Whether `path` is `root` itself or something inside it, comparing **path segments**
/// rather than characters.
///
/// A plain `starts_with` reads `crates/wecode-core-extra` as living inside
/// `crates/wecode-core`, and two sibling crates were refused as colliding for sharing a
/// name prefix. The boundary has to be a `/`, or the whole string.
fn under(path: &str, root: &str) -> bool {
    if root.is_empty() || path == root {
        return true;
    }
    path.strip_prefix(root)
        .is_some_and(|rest| rest.starts_with('/'))
}

fn literal_prefix(glob: &str) -> String {
    let cut = glob.find(['*', '?', '[']).unwrap_or(glob.len());
    glob[..cut].trim_end_matches('/').to_string()
}

/// Whether every file `glob` could reach sits inside a path marked append-only.
///
/// Containment one way only, unlike [`globs_overlap`]: an append-only
/// `src/generated/**` does not exempt a task claiming `src/**`, where most of what it
/// may write is nobody's append. Coarse in the same direction as the check it excuses.
pub(crate) fn appends_only(glob: &str, append_only: &[String]) -> bool {
    let claimed = literal_prefix(glob);
    append_only.iter().any(|marked| {
        let marked = literal_prefix(marked);
        claimed == marked || claimed.starts_with(&format!("{marked}/"))
    })
}

/// Whether two tasks would be editing the same checkout.
///
/// Same project is the common case and settles it without a lookup — a project owns
/// exactly one repo, so its own tasks always agree. Across projects the repo name each
/// one registers decides it; an unregistered or absent project answers no, which keeps
/// this check from inventing conflicts out of missing data. A project with a blank
/// repo is a defect [`check_project`] already reports, and pairing two of them off
/// each other would report it a second time as something else.
pub(crate) fn share_a_repo(plan: &Plan, a: &Task, b: &Task) -> bool {
    if a.project == b.project {
        return true;
    }
    match (plan.project(&a.project), plan.project(&b.project)) {
        (Some(x), Some(y)) => !x.repo.trim().is_empty() && x.repo == y.repo,
        _ => false,
    }
}

/// Whether either task waits on the other, in either direction, at any remove.
///
/// Transitively, because ordering is transitive: if `c` waits on `b` and `b` waits on
/// `a`, then `c` and `a` cannot run at the same time, and refusing them for a scope
/// overlap states something untrue. A chain of tasks each building on the last is the
/// ordinary shape of a slice, and the direct-only version made the third and every
/// later link impossible to admit.
pub(crate) fn sequenced(plan: &Plan, a: &Task, b: &Task) -> bool {
    // Ordering lifts through containment, or expanded units collide with their sequenced siblings.
    let fa: Vec<&Task> = std::iter::once(a).chain(plan.ancestors(&a.id)).collect();
    let fb: Vec<&Task> = std::iter::once(b).chain(plan.ancestors(&b.id)).collect();
    fa.iter().any(|x| fb.iter().any(|y| waits_on(plan, x, &y.id) || waits_on(plan, y, &x.id)))
}

/// Whether one task is part of the other, at any depth.
///
/// A subtask almost always writes inside its parent's area — that is what makes it
/// a subtask. Reporting that as a conflict would make the parent relation unusable
/// for anything that touches files.
pub(crate) fn nested(plan: &Plan, a: &Task, b: &Task) -> bool {
    let ancestor_of = |x: &Task, y: &Task| {
        // `x` is fresh and may not be in the plan yet, so walk from `y` upward and
        // also check `x`'s own declared parent chain against `y`.
        plan.ancestors(&y.id).iter().any(|p| p.id == x.id)
    };
    a.parent.as_ref() == Some(&b.id)
        || b.parent.as_ref() == Some(&a.id)
        || ancestor_of(a, b)
        || ancestor_of(b, a)
}

/// Whether a project is archived or held, and so dispatches nothing.
///
/// A project the plan does not hold is treated as live: the task being admitted may
/// name a project that is about to be created, and skipping the whole check on that
/// basis would let the first task of a new project claim anything.
pub(crate) fn parked(plan: &Plan, id: &ProjectId) -> bool {
    plan.project(id)
        .is_some_and(|p| p.archived || p.status == crate::ProjectStatus::Hold)
}

/// Whether two tasks could be in flight at the same moment.
///
/// Everything that is not about *paths*: a closed or held task competes for nothing, a
/// parked project dispatches nothing, two tasks in different repositories share no
/// checkout, and an ordering — direct or through a chain, or through containment —
/// means one finishes before the other starts. What is left is the pair a scope
/// comparison has to decide about.
#[must_use]
pub fn could_run_beside(plan: &Plan, a: &Task, b: &Task) -> bool {
    !(b.status.is_closed()
        || b.status == TaskStatus::Hold
        || a.status == TaskStatus::Hold
        || parked(plan, &a.project)
        || parked(plan, &b.project)
        || !share_a_repo(plan, a, b)
        || sequenced(plan, a, b)
        || nested(plan, a, b))
}

/// Whether two tasks want the same paths, given the project's append-only markings.
///
/// The same comparison [`check_task_appending`] makes, exposed so a dispatcher can ask
/// it about a pair rather than discovering the answer by being refused. One definition,
/// two callers: a gate that admits and a queue that chooses cannot be allowed to
/// disagree about what a conflict is.
#[must_use]
pub fn scopes_collide(a: &Task, b: &Task, append_only: &[String]) -> bool {
    a.scope.write.iter().any(|glob| {
        !(glob.starts_with(crate::WORKER_DIR) || appends_only(glob, append_only))
            && b.scope
                .write
                .iter()
                .any(|o| !appends_only(o, append_only) && globs_overlap(glob, o))
    })
}

/// The largest prefix of `candidates` that can run **together**, in the order given.
///
/// A queue that offers two tasks wanting one file dispatches the first and watches the
/// second refused — the churn of 4–5 Sep, where signing four tasks made each the
/// others' competitor and none of them ran. Choosing the set up front is the whole
/// difference between concurrency and thrash.
///
/// Greedy on purpose. The maximum independent set is NP-hard and the caller has already
/// expressed what it wants most by the order it passes; taking each task that fits
/// beside those already taken respects that, and never returns a set that cannot run.
#[must_use]
pub fn conflict_free<'a>(
    plan: &Plan,
    candidates: &[&'a Task],
    slots: usize,
    append_only: &[String],
) -> Vec<&'a Task> {
    let mut taken: Vec<&Task> = Vec::new();
    for c in candidates {
        if taken.len() >= slots {
            break;
        }
        let fits = taken
            .iter()
            .all(|t| !could_run_beside(plan, c, t) || !scopes_collide(c, t, append_only));
        if fits {
            taken.push(c);
        }
    }
    taken
}

/// Whether `t` waits on `target`, directly or through other tasks.
///
/// Seeded from `t`'s own declared dependencies rather than looked up by id: the task
/// being admitted is not in the plan yet, so looking it up would find nothing.
fn waits_on(plan: &Plan, t: &Task, target: &TaskId) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    let mut stack: Vec<TaskId> = t.depends_on.clone();
    while let Some(id) = stack.pop() {
        if &id == target {
            return true;
        }
        // A cycle is its own defect, reported by another check. This walk has to
        // terminate whether or not that check has run yet.
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(next) = plan.task(&id) {
            stack.extend(next.depends_on.iter().cloned());
        }
    }
    false
}
