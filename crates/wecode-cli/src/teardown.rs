//! Taking a worktree down once nothing needs it any more.
//!
//! A worktree was created and never removed. `wecode start` and `wecode run` make one,
//! `wecode merge` lands what it produced, and then the directory stands there forever —
//! holding a checkout of work that is now on the integration branch, plus whatever
//! `target/` grew while the agent worked. Four such trees on the workspace that found
//! this, all of them for tasks that were done.
//!
//! Removal already existed as a command an operator could type. What was missing is the
//! moment it should happen on its own, which is landing: the instant every commit in the
//! tree is reachable from somewhere else, the tree is a copy rather than the only copy.
//!
//! Two callers, and the difference between them is the whole reason this is a module
//! rather than a function. An operator naming a tree has decided; teardown acting on its
//! own initiative after a merge has to be able to decline, and to say why. So the
//! destructive step is one function both share, and the timidity lives in
//! [`after_landing`] where only the automatic caller gets it.
//!
//! The branch is never deleted. After a `--no-ff` merge it is redundant — every commit on
//! it is reachable from the target — but keeping it is what makes this reversible:
//! `wecode start` on the same task cuts the tree again at the branch tip, so the worst a
//! premature teardown costs is a rebuild.

use std::path::Path;

use wecode_core::{Plan, Task, TaskId};
use wecode_store::Store;

use crate::{git, work};

/// What became of a worktree that was asked to come down.
///
/// Three outcomes rather than a `bool`, because two of them are *not removed* and they
/// call for different things from the reader. An absent tree wants nothing — the row is
/// already corrected. A dirty one wants a decision, and the files are the decision.
pub(crate) enum Torn {
    /// Gone from git, and the registry says so.
    Removed {
        /// Uncommitted files `--force` discarded. Empty on the ordinary path, and worth
        /// carrying separately from the removal: destroying work silently is the one
        /// thing teardown must never do, even when it was told to.
        discarded: Vec<String>,
    },
    /// Nothing stood there. `was_ours` is the difference between a row we have just
    /// corrected and a directory that was never wecode's to begin with.
    Absent { was_ours: bool },
    /// Uncommitted work, which removing the tree would destroy. Nothing was touched.
    Dirty { files: Vec<String> },
}

/// What teardown did about a tree nobody named.
///
/// Distinct from [`Torn`] because it has an answer [`Torn`] cannot have: *somebody is
/// still working here*. That answer is only available to the automatic caller, and it is
/// the most useful thing in its report — an operator reading a merge wants to know
/// whether the directory they had open is still there, and if it is, who kept it.
pub(crate) enum Swept {
    /// There was no tree and no row saying there had been one. The playbook asked for no
    /// worktree, or a previous teardown already finished the job.
    Nothing,
    /// Tasks that have not finished still work here.
    Busy { path: String, by: Vec<String> },
    /// Considered, and this is what became of it.
    Tried { path: String, torn: Torn },
}

/// The tasks sharing the tree `owner` owns that have not finished with it.
///
/// Ownership is asked through [`work::owner`] — the same function `prepare` uses to
/// decide where a task works — rather than by walking children here. A second traversal
/// would be a second answer to one question, and the two disagreeing means a tree
/// removed from under a running agent.
///
/// Closed covers `dropped` as well as `done`: abandoned work is not coming back to the
/// directory, and its commits are on the branch, which teardown keeps.
pub(crate) fn still_working<'a>(plan: &'a Plan, owner: &TaskId) -> Vec<&'a Task> {
    plan.tasks()
        .filter(|t| !t.status.is_closed())
        .filter(|t| work::owner(plan, &t.id).is_some_and(|o| o.id == *owner))
        .collect()
}

/// Removes the worktree at `path`, and records that it is gone.
///
/// Order is load-bearing twice. The registry is closed **after** git agrees, so a
/// removal that failed leaves the row saying the tree stands — because it does. And an
/// absent directory closes its row anyway: a row claiming a directory that is provably
/// not there is worse than no row.
///
/// Occupancy is deliberately *not* checked. This is the function an operator's typed
/// command reaches, and a command is an instruction; [`after_landing`] is where teardown
/// on wecode's own initiative asks first.
pub(crate) fn take_down(
    store: &Store,
    repo: Option<&Path>,
    path: &Path,
    force: bool,
) -> Result<Torn, Box<dyn std::error::Error>> {
    let dir = path.to_string_lossy().into_owned();
    if !path.exists() {
        // Gone by some other hand. The registry must not go on saying it stands.
        return Ok(Torn::Absent {
            was_ours: store.forget_worktree(&dir)?,
        });
    }

    // Uncommitted work in a worktree is unrecoverable once the tree is gone, and nothing
    // has committed it yet — wecode does that, after checks pass.
    let dirty = git::changed_files(path).unwrap_or_default();
    if !dirty.is_empty() && !force {
        return Ok(Torn::Dirty { files: dirty });
    }

    // `git worktree remove` is a command against the *repository*, not against the tree,
    // so a standing directory that no repository in the plan claims cannot come down
    // here. Guessing a repo would run a removal against the wrong one.
    let repo = repo.ok_or_else(|| {
        format!(
            "{dir} stands, but no repository this workspace knows lists it as a worktree\n  \
             remove it with git, where it belongs"
        )
    })?;
    git::worktree_remove(repo, path)?;
    store.forget_worktree(&dir)?;
    Ok(Torn::Removed { discarded: dirty })
}

/// Takes down the tree a landed task worked in, unless something still needs it.
///
/// The teardown nobody typed, so the thing it must never get wrong is destroying work.
/// Three refusals, each leaving the tree exactly where it was:
///
/// - a task sharing the tree has not finished with it
/// - the tree holds uncommitted work, which the merge did not take
/// - git refused the removal
///
/// The first is why merging a *subtask* removes nothing: the branch belongs to the main
/// task, so a subtask's merge lands the whole tree's work, while its siblings still have
/// somewhere to be. The tree comes down when the last of them closes.
///
/// No separate authorisation. Merging was authorised, this is the merge finishing its own
/// sentence, and a directory whose every commit is on the integration branch is not
/// something anyone needs to sign for.
pub(crate) fn after_landing(
    store: &Store,
    plan: &Plan,
    repo: &Path,
    org: &str,
    owner: &TaskId,
) -> Result<Swept, Box<dyn std::error::Error>> {
    let path = work::worktree_for(org, owner);
    let dir = path.to_string_lossy().into_owned();

    if !path.is_dir() {
        // Correcting the registry destroys nothing, so occupancy does not gate it: a row
        // claiming a directory that is provably absent is worse than no row, whoever is
        // still assigned to the tree.
        return Ok(match take_down(store, Some(repo), &path, false)? {
            // Never made one, and no row to correct. A merge under a playbook that asks
            // for no worktree has nothing to report, and a line saying so is noise.
            Torn::Absent { was_ours: false } => Swept::Nothing,
            torn => Swept::Tried { path: dir, torn },
        });
    }

    let busy = still_working(plan, owner);
    if !busy.is_empty() {
        return Ok(Swept::Busy {
            path: dir,
            by: busy.iter().map(|t| t.id.to_string()).collect(),
        });
    }
    let torn = take_down(store, Some(repo), &path, false)?;
    Ok(Swept::Tried { path: dir, torn })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Project, TaskStatus};

    /// One main task with two subtasks and one unrelated task, all in one project.
    fn plan() -> Plan {
        let mut p = Plan::new();
        p.add_project(Project::new("proj", "an objective sentence", "repo"))
            .unwrap();
        p.add_task(Task::new("feat", "proj", "the main task"))
            .unwrap();
        for id in ["impl", "docs"] {
            p.add_task(Task::new(id, "proj", "a subtask").under("feat"))
                .unwrap();
        }
        p.add_task(Task::new("other", "proj", "an unrelated task"))
            .unwrap();
        p
    }

    fn set(p: &mut Plan, id: &str, status: TaskStatus) {
        let mut t = p.task(&TaskId::new(id)).unwrap().clone();
        t.status = status;
        p.update_task(t).unwrap();
    }

    /// Who still holds `owner`'s tree, by id. Sorted, because `Plan` stores tasks in id
    /// order and a test that depended on insertion order would be testing the map.
    fn open(p: &Plan, owner: &str) -> Vec<String> {
        still_working(p, &TaskId::new(owner))
            .iter()
            .map(|t| t.id.to_string())
            .collect()
    }

    #[test]
    fn the_owner_and_its_subtasks_all_count_as_working_in_the_tree() {
        // The fault this guards: merging one subtask lands the whole tree's branch, and
        // removing the tree then takes the directory out from under its siblings.
        assert_eq!(open(&plan(), "feat"), vec!["docs", "feat", "impl"]);
    }

    #[test]
    fn an_unrelated_task_is_not_working_in_somebody_elses_tree() {
        assert_eq!(open(&plan(), "other"), vec!["other"]);
    }

    #[test]
    fn a_tree_is_free_only_once_every_sharer_has_closed() {
        let mut p = plan();
        set(&mut p, "feat", TaskStatus::Done);
        set(&mut p, "impl", TaskStatus::Done);
        assert_eq!(open(&p, "feat"), vec!["docs"], "one sibling still has it");

        // Dropped, not done: abandoned work is not coming back to the directory, and its
        // commits are on the branch, which teardown keeps.
        set(&mut p, "docs", TaskStatus::Dropped);
        assert!(open(&p, "feat").is_empty(), "nothing needs it now");
    }

    #[test]
    fn a_sub_subtask_holds_the_tree_at_any_depth() {
        // Ownership is the root of the parent chain, so depth must not lose an occupant.
        let mut p = plan();
        p.add_task(Task::new("deep", "proj", "a sub-subtask").under("impl"))
            .unwrap();
        for id in ["feat", "impl", "docs"] {
            set(&mut p, id, TaskStatus::Done);
        }
        assert_eq!(open(&p, "feat"), vec!["deep"]);
    }

    #[test]
    fn a_task_that_merely_depends_on_the_owner_does_not_hold_its_tree() {
        // `depends_on` orders work; `parent` decides where it happens. Confusing the two
        // here would keep a tree standing for a task that will cut its own.
        let mut p = plan();
        let mut next = Task::new("next", "proj", "comes after").after("feat");
        next.status = TaskStatus::Ready;
        p.add_task(next).unwrap();
        for id in ["feat", "impl", "docs"] {
            set(&mut p, id, TaskStatus::Done);
        }
        assert!(open(&p, "feat").is_empty());
    }
}
