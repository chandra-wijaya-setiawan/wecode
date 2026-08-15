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
/// The first is why a merge with a step still open removes nothing. The branch belongs to
/// the main task and every subtask shares it, so landing it takes the whole tree's work
/// while those subtasks still have somewhere to be — a passing one is `done` and holds
/// nothing, but an unfinished sibling has the directory open. The tree comes down when the
/// last of them closes.
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

/// What became of a worktree that was asked to come down.
///
/// One formatter for all three outcomes, and the caller decides which of them is an
/// error. The refusal and the report have to be written together or they drift: it was
/// the refusal that had to name the files, and the report that had to name the branch.
#[must_use]
pub(crate) fn torn(path: &std::path::Path, branch: Option<&str>, t: &Torn) -> String {
    let mut out = String::new();
    match t {
        Torn::Removed { discarded } => {
            out.push_str(&format!("  removed {}\n", path.display()));
            if !discarded.is_empty() {
                out.push_str(&format!(
                    "  discarded {} uncommitted change(s)\n",
                    discarded.len()
                ));
            }
            // Said every time. The tree going and the branch staying is exactly the part
            // an operator would otherwise assume the other way round.
            if let Some(b) = branch {
                out.push_str(&format!(
                    "  branch {b} kept — its commits are safe there, and `wecode start` cuts the tree again\n"
                ));
            }
        }
        Torn::Absent { was_ours } => {
            out.push_str(&format!("  no worktree at {}\n", path.display()));
            if *was_ours {
                out.push_str("  it was ours — recorded as gone\n");
            }
        }
        Torn::Dirty { files } => {
            // Unindented and first, because this one is printed as an error and the
            // reason has to lead.
            out.push_str(&format!(
                "{} has {} uncommitted change{} — removing the worktree would lose them:\n",
                path.display(),
                files.len(),
                if files.len() == 1 { "" } else { "s" }
            ));
            for f in files.iter().take(10) {
                out.push_str(&format!("    {f}\n"));
            }
            out.push_str("  pass --force to discard them");
        }
    }
    out
}

/// The one line a merge says about the tree its work came out of.
///
/// In the summary rather than a section of its own, because it is a consequence of the
/// merge and not a topic: an operator scanning the report needs to know whether the
/// directory they had open is still there, and that is one line's worth.
///
/// Nothing at all when there was no tree. A merge under a playbook that asks for no
/// worktree would otherwise carry a line about something that never existed.
pub(crate) fn teardown_line(swept: &Swept) -> String {
    match swept {
        Swept::Nothing => String::new(),
        // Who, not just that. The next thing an operator does about a kept tree depends
        // entirely on which task is still in it.
        Swept::Busy { path, by } => format!(
            "  worktree   kept — {} still working in {path}\n",
            by.join(", ")
        ),
        Swept::Tried { path, torn } => match torn {
            Torn::Removed { .. } => format!("  worktree   removed {path}\n"),
            Torn::Absent { .. } => format!("  worktree   already gone — {path}\n"),
            // Never discarded on this path: teardown nobody asked for does not get to
            // decide that uncommitted work was worthless.
            Torn::Dirty { files } => format!(
                "  worktree   kept — {} uncommitted change{} the merge did not take, in {path}\n",
                files.len(),
                if files.len() == 1 { "" } else { "s" }
            ),
        },
    }
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
        // The fault this guards: landing the main task lands the whole tree's branch, and
        // removing the tree then takes the directory out from under its open steps.
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

    #[test]
    fn a_removed_tree_says_the_branch_survived_it() {
        // The part an operator would otherwise assume the other way round, and the
        // reason teardown is safe to do without asking.
        let out = torn(
            std::path::Path::new("/run/cws/cache"),
            Some("wecode/cache"),
            &Torn::Removed {
                discarded: Vec::new(),
            },
        );
        assert!(out.contains("removed /run/cws/cache"), "{out}");
        assert!(out.contains("branch wecode/cache kept"), "{out}");
        assert!(!out.contains("discarded"), "nothing was discarded: {out}");
    }

    #[test]
    fn discarding_uncommitted_work_is_never_silent() {
        // `--force` was typed, so this is not a refusal — but destroying work without
        // saying so is the one thing teardown must not do, even when told to.
        let out = torn(
            std::path::Path::new("/run/cws/cache"),
            None,
            &Torn::Removed {
                discarded: vec!["a.rs".into(), "b.rs".into()],
            },
        );
        assert!(out.contains("discarded 2 uncommitted change(s)"), "{out}");
        // No branch was known — a path names none — so none is claimed.
        assert!(!out.contains("branch"), "{out}");
    }

    #[test]
    fn a_refused_removal_names_the_files_and_the_way_past_it() {
        let out = torn(
            std::path::Path::new("/run/cws/cache"),
            Some("wecode/cache"),
            &Torn::Dirty {
                files: vec!["half-done.rs".into()],
            },
        );
        // Singular, and the reason leads: this one is printed as an error.
        assert!(
            out.starts_with("/run/cws/cache has 1 uncommitted change —"),
            "{out}"
        );
        assert!(out.contains("half-done.rs"), "{out}");
        assert!(out.ends_with("pass --force to discard them"), "{out}");
    }

    #[test]
    fn an_absent_tree_reports_whether_the_registry_was_corrected() {
        let ours = torn(
            std::path::Path::new("/run/cws/cache"),
            None,
            &Torn::Absent { was_ours: true },
        );
        assert!(ours.contains("no worktree at /run/cws/cache"), "{ours}");
        assert!(ours.contains("recorded as gone"), "{ours}");

        let theirs = torn(
            std::path::Path::new("/elsewhere/theirs"),
            None,
            &Torn::Absent { was_ours: false },
        );
        assert!(!theirs.contains("recorded as gone"), "{theirs}");
    }

    #[test]
    fn a_merge_says_what_became_of_the_tree_and_why() {
        // Each of the three refusals reads differently on purpose: what the operator
        // does next depends entirely on which one it was.
        assert_eq!(
            teardown_line(&Swept::Nothing),
            "",
            "a playbook that asks for no worktree gets no line about one"
        );
        let busy = teardown_line(&Swept::Busy {
            path: "/run/cws/feat".into(),
            by: vec!["impl".into(), "docs".into()],
        });
        assert!(busy.contains("kept — impl, docs still working"), "{busy}");
        assert!(busy.contains("/run/cws/feat"), "{busy}");

        let dirty = teardown_line(&Swept::Tried {
            path: "/run/cws/feat".into(),
            torn: Torn::Dirty {
                files: vec!["scratch.txt".into()],
            },
        });
        assert!(
            dirty.contains("1 uncommitted change the merge did not take"),
            "{dirty}"
        );

        let gone = teardown_line(&Swept::Tried {
            path: "/run/cws/feat".into(),
            torn: Torn::Removed {
                discarded: Vec::new(),
            },
        });
        assert_eq!(gone, "  worktree   removed /run/cws/feat\n");
    }
}
