//! Where work happens: which task owns a worktree, and what it is called.
//!
//! One worktree per *main* task. Subtasks share their parent's tree, which is what
//! makes the two relations pull their weight separately — `parent` decides which tree
//! you work in, `depends_on` decides when you may start.

use std::path::{Path, PathBuf};

use wecode_core::{Plan, Task, TaskId};
use wecode_org::workspace::expand_home;

/// Where worktrees live: `$WECODE_CONFIG/run`, else `~/.wecode/run`.
///
/// Outside the repository, and beside the workspace rather than inside it. Mirrors
/// `workspace::workspaces_root` so tests can redirect it.
///
/// This is hygiene, **not** a boundary, and the difference matters. `run/` and
/// `workspaces/` are siblings, so `../../../workspaces/<org>/company.toml` reaches the
/// file that defines a worker's own grants — and an absolute path reaches it from
/// anywhere regardless of layout. What actually refuses the write is the Broker's
/// scope check. Separating the paths only stops accidents, such as a `**` glob in a
/// worktree sweeping up the config.
#[must_use]
pub(crate) fn run_root() -> PathBuf {
    match std::env::var("WECODE_CONFIG") {
        Ok(dir) => expand_home(&dir).join("run"),
        Err(_) => expand_home("~/.wecode/run"),
    }
}

/// The task whose worktree this task works in: the root of its parent chain.
///
/// Returns `None` only when the task is not in the plan.
#[must_use]
pub(crate) fn owner<'a>(plan: &'a Plan, id: &TaskId) -> Option<&'a Task> {
    let task = plan.task(id)?;
    // `ancestors` is nearest-first, so the last entry is the root.
    Some(plan.ancestors(id).last().copied().unwrap_or(task))
}

/// The branch for a worktree. Namespaced so every agent-authored branch is visible
/// at a glance and `git branch --list 'wecode/*'` finds them all.
#[must_use]
pub(crate) fn branch_for(owner: &TaskId) -> String {
    format!("wecode/{owner}")
}

/// `<run root>/<workspace name>/<owning task>`.
#[must_use]
pub(crate) fn worktree_for(org: &str, owner: &TaskId) -> PathBuf {
    run_root().join(org).join(owner.as_str())
}

/// The checkout a merge borrows to build the integration branch in, so the operator's
/// own working copy is never moved under them.
///
/// Named here rather than at the call site because two commands need it for opposite
/// reasons: merging creates it, and the listing has to recognise it — a name spelled
/// twice is one the two could spell differently.
///
/// It sits in the same directory as the task worktrees and is therefore only *probably*
/// unambiguous: nothing forbids a task called `.merge`. A reader of this path settles
/// that by asking about tasks first.
#[must_use]
pub(crate) fn merge_scratch(org: &str) -> PathBuf {
    run_root().join(org).join(".merge")
}

/// The workspace's short name, used to keep one operator's companies apart under the
/// run root. The directory name, since that is what `--org <name>` resolves against.
#[must_use]
pub(crate) fn org_name(workspace_root: &Path) -> String {
    workspace_root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "default".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Project, ProjectId};

    fn plan() -> Plan {
        let mut p = Plan::new();
        p.add_project(Project::new("proj", "an objective sentence", "repo"))
            .unwrap();
        p.add_task(Task::new("main-task", "proj", "the main task"))
            .unwrap();
        p.add_task(Task::new("sub", "proj", "a subtask").under("main-task"))
            .unwrap();
        p.add_task(Task::new("deep", "proj", "a sub-subtask").under("sub"))
            .unwrap();
        // A dependency must NOT change ownership — only the parent chain does.
        p.add_task(Task::new("next", "proj", "comes after").after("main-task"))
            .unwrap();
        p
    }

    #[test]
    fn a_root_task_owns_its_own_worktree() {
        let p = plan();
        let o = owner(&p, &TaskId::new("main-task")).unwrap();
        assert_eq!(o.id.as_str(), "main-task");
    }

    #[test]
    fn subtasks_share_the_main_tasks_worktree_at_any_depth() {
        let p = plan();
        for id in ["sub", "deep"] {
            let o = owner(&p, &TaskId::new(id)).unwrap();
            assert_eq!(
                o.id.as_str(),
                "main-task",
                "{id} should share the root's tree"
            );
        }
    }

    #[test]
    fn a_dependency_does_not_borrow_its_predecessors_worktree() {
        // The relation that decides the tree is `parent`; `depends_on` only orders.
        // Sharing a tree here would put two concurrent tasks in one checkout.
        let p = plan();
        let o = owner(&p, &TaskId::new("next")).unwrap();
        assert_eq!(o.id.as_str(), "next");
    }

    #[test]
    fn a_task_outside_the_plan_has_no_owner() {
        assert!(owner(&plan(), &TaskId::new("ghost")).is_none());
    }

    #[test]
    fn the_branch_is_namespaced_under_wecode() {
        assert_eq!(
            branch_for(&TaskId::new("store-sqlite")),
            "wecode/store-sqlite"
        );
    }

    #[test]
    fn the_worktree_path_sits_under_the_run_root_not_the_workspace() {
        let path = worktree_for("cws", &TaskId::new("t1"));
        assert!(path.ends_with("cws/t1"), "{path:?}");
        assert!(path.starts_with(run_root()));
        // Not under `workspaces/`, so a glob rooted at the worktree cannot sweep up
        // company.toml. Traversal still reaches it — the Broker is what refuses the
        // write, not the layout.
        assert!(
            !path.to_string_lossy().contains("workspaces"),
            "a worktree must not sit inside the config tree: {path:?}"
        );
    }

    #[test]
    fn the_org_name_comes_from_the_workspace_directory() {
        assert_eq!(org_name(Path::new("/home/x/.wecode/workspaces/cws")), "cws");
        assert_eq!(org_name(Path::new("/")), "default");
    }

    #[test]
    fn projects_and_tasks_do_not_collide_in_the_path() {
        // Task ids are unique per workspace, so the project is not in the path. Two
        // tasks must still never land in the same directory.
        let a = worktree_for("cws", &TaskId::new("t1"));
        let b = worktree_for("cws", &TaskId::new("t2"));
        assert_ne!(a, b);
        assert_ne!(
            worktree_for("cws", &TaskId::new("t1")),
            worktree_for("other", &TaskId::new("t1"))
        );
        let _ = ProjectId::new("unused");
    }
}
