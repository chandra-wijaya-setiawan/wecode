//! Where work happens: which task owns a worktree, and what it is called.
//!
//! One worktree per *main* task. Subtasks share their parent's tree, which is what
//! makes the two relations pull their weight separately — `parent` decides which tree
//! you work in, `depends_on` decides when you may start.
//!
//! One refusal lives here too, and it is the one that has to come *before* any of that:
//! a task whose declared credentials expire sooner than the run it is about to be given
//! is not dispatched at all. It is a question about a task and its clock rather than
//! about a process, which is why it is asked here and not in [`crate::spawn`] — see
//! [`admits_secrets`].
//!
//! **Not wired yet.** [`admits_secrets`] is the whole check; joining it to dispatch is two
//! lines in `commands::exec::run_task`, which this task was not allowed to write. Lift
//! `let limits = limits_for(&template, &task);` above the `prepare` call — it is pure, and
//! both halves it reads are already in hand there — and put
//! `work::admits_secrets(&company, &id, &secrets, limits)?` underneath it, above `prepare`
//! for the reason the `unsigned` check is above it: preparation has side effects on the
//! repository, and a tree cut for a run that cannot legally start is a tree left standing.
//! `secrets` is what the task declared — `Task::secrets` once core carries it, and
//! `a.all("needs-secret")` until then — and it must be the same slice
//! [`crate::spawn::run_holding`] is handed, or the front gate and the resolver are being
//! told different things. The `allow(dead_code)` below says the same thing, and the change
//! that adds those two lines deletes it.

use std::path::{Path, PathBuf};

use wecode_core::{Plan, Task, TaskId, TaskStatus};
use wecode_org::Company;
use wecode_org::company::SecretDef;
use wecode_org::workspace::expand_home;

use crate::spawn::Limits;

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

/// Refuses a dispatch whose run could outlive a credential it would hold.
///
/// The argument for refusing at the front rather than re-resolving mid-run belongs to
/// [`SecretDef::admits`], which is also what decides it. What is added here is the two
/// things only dispatch can supply: the check happening early enough to matter — before
/// the worktree, before the envelope, before a token is spent — and the task's name on the
/// refusal, because what the operator typed was `wecode run <task>`.
///
/// **The wall is `limits.wall`, not `task.budget.wall_secs`.** The figure a `ttl` has to
/// survive is the clock the run will *actually* be held to: the task's, capped by the
/// harness template's, as `commands::exec::limits_for` computes it. Taking the whole
/// [`Limits`] the supervisor is handed is what keeps the two from drifting — whatever ever
/// tightens that clock, this reads the same struct the run is held to. The task's own
/// figure would be the wrong one whenever a template caps it: a two-hour task under a
/// half-hour harness cannot outlive a one-hour credential, and refusing it would be
/// refusing arithmetic. `max_wall_secs` is deliberately not in the figure — it is a
/// cumulative session invariant judged on `Action::Spend` after the fact, so it can end a
/// run early but can never make this run's clock longer than the template's.
///
/// No clock is no refusal, matching [`Company::hold`]: a wall nothing declared is one no
/// `ttl` can be shorter than. A run with no bound at all is a budget defect, and it
/// belongs to the admission gate rather than to this one — reported here it would read as
/// a problem with the credential.
///
/// Nothing is resolved: no resolver runs, no value exists, no login lands in anybody's
/// audit trail. So this costs nothing when it passes, cannot itself leak, and is safe to
/// ask before every dispatch whether or not the task declared anything. It does not
/// replace the same check inside [`Company::hold`] — that one guards the mint, and stays
/// where the values are.
#[allow(
    dead_code,
    reason = "the call site in commands::exec is out of this task's scope"
)]
pub(crate) fn admits_secrets(
    company: &Company,
    task: &TaskId,
    ids: &[String],
    limits: Limits,
) -> Result<(), String> {
    let refuse = |why: String| format!("cannot start {task}: {why}");
    // Every id resolved to its block before any of them is judged, so a typo in the
    // second is reported as a typo rather than as whatever the first one's ttl happened to
    // be. Refused rather than skipped: the block is where the `ttl` is, and an id with no
    // block would otherwise pass a gate that never measured it and fail at the resolver,
    // which is the far end of the run this exists to keep it away from.
    let defs = ids
        .iter()
        .map(|id| company.secret(id))
        .collect::<Result<Vec<&SecretDef>, String>>()
        .map_err(&refuse)?;
    let Some(wall) = limits.wall else {
        return Ok(());
    };
    for def in defs {
        def.admits(wall).map_err(&refuse)?;
    }
    Ok(())
}

/// Who a listed worktree belongs to.
///
/// Four answers rather than two, because *ours with a task*, *ours with none*, and
/// *not ours at all* are different situations calling for different action, and the
/// previous two-way split called all three an orphan.
pub(crate) enum Tenant {
    /// A task in the plan works here.
    Task {
        id: String,
        project: String,
        status: TaskStatus,
    },
    /// wecode made it, and the task it was made for is no longer in the plan. This is
    /// the only real orphan: ours to clean up, with nothing left to ask.
    Orphan { task: String },
    /// The checkout a merge borrows for the integration branch. Created and removed
    /// inside one command, so seeing it means wecode died mid-merge.
    Merge,
    /// Another tool's worktree in the same repository. Not ours to touch — and saying
    /// so is the whole point, because a stranger reported as an orphan invites the
    /// operator to delete somebody else's work.
    Stranger,
}

impl Tenant {
    /// The `task` and `status` cells. Both are `—` for a tree with no task, rather
    /// than borrowing a status the tree does not have.
    fn cells(&self) -> (String, &str, &str) {
        match self {
            Self::Task {
                id,
                project,
                status,
            } => (id.clone(), project.as_str(), status.as_str()),
            Self::Orphan { task } => (format!("— orphan ({task})"), "—", "—"),
            Self::Merge => ("— merge scratch".to_string(), "—", "—"),
            Self::Stranger => ("— not ours".to_string(), "—", "—"),
        }
    }
}

/// One row of `wecode worktree`: where the tree is, and who is in it.
pub(crate) struct WorktreeRow {
    pub path: String,
    pub tenant: Tenant,
}

/// The worktrees of one repository. The repo is the unit a worktree belongs to, so it
/// is the unit the listing is grouped by — several projects sharing a repository share
/// this one set of trees, and each tree appears under it once.
pub(crate) struct RepoTrees {
    /// The `[[repos]]` name.
    pub repo: String,
    /// Where the main checkout is, so the group names a place and not just a label.
    pub path: String,
    pub rows: Vec<WorktreeRow>,
}

/// Every worktree wecode can see, grouped by the repository it was cut from.
#[must_use]
pub(crate) fn worktrees(repos: &[RepoTrees]) -> String {
    let total: usize = repos.iter().map(|r| r.rows.len()).sum();
    if total == 0 {
        return "no worktrees\n".to_string();
    }
    let mut out = format!(
        "  {:<20} {:<12} {:<10} {}\n",
        "task", "project", "status", "path"
    );
    for r in repos.iter().filter(|r| !r.rows.is_empty()) {
        out.push_str(&format!("{} — {}\n", r.repo, r.path));
        for row in &r.rows {
            let (task, project, status) = row.tenant.cells();
            out.push_str(&format!(
                "  {task:<20} {project:<12} {status:<10} {}\n",
                row.path
            ));
        }
    }
    out.push_str(&worktree_tally(repos, total));
    out
}

/// One line saying what the rows add up to. The fault that prompted this printed 27
/// rows for 4 trees of ours, and a count is what makes that visible at a glance.
fn worktree_tally(repos: &[RepoTrees], total: usize) -> String {
    let n_repos = repos.iter().filter(|r| !r.rows.is_empty()).count();
    let mut counts = (0, 0, 0);
    for row in repos.iter().flat_map(|r| &r.rows) {
        match row.tenant {
            Tenant::Task { .. } => counts.0 += 1,
            Tenant::Orphan { .. } | Tenant::Merge => counts.1 += 1,
            Tenant::Stranger => counts.2 += 1,
        }
    }
    let mut parts = vec![format!(
        "\n  {total} tree{} in {n_repos} repo{}",
        if total == 1 { "" } else { "s" },
        if n_repos == 1 { "" } else { "s" }
    )];
    if counts.0 > 0 {
        parts.push(format!("{} in use", counts.0));
    }
    if counts.1 > 0 {
        parts.push(format!("{} ours to clean up", counts.1));
    }
    if counts.2 > 0 {
        parts.push(format!("{} not ours", counts.2));
    }
    format!("{}\n", parts.join(" · "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
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

    /// A workspace declaring two credentials of very different lifetimes: a session
    /// credential worth an hour, and a token good for a month.
    fn workspace() -> Company {
        Company::parse(
            "[company]\nname = \"cws\"\n\
             \n[secrets.aws-cloud-test]\n\
             command = \"aws configure export-credentials --format env-no-export\"\n\
             vars = [\"AWS_SESSION_TOKEN\"]\n\
             ttl = \"1h\"\n\
             \n[secrets.travelpayouts]\n\
             command = \"pass show travelpayouts/token\"\n\
             vars = [\"TRAVELPAYOUTS_TOKEN\"]\n\
             ttl = \"30d\"\n",
        )
        .expect("the profile parses")
    }

    /// The clock a run is held to, as `limits_for` would have already tightened it.
    fn held_for(secs: u64) -> Limits {
        Limits {
            wall: Some(Duration::from_secs(secs)),
            ..Limits::default()
        }
    }

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_credential_that_dies_before_the_run_can_end_refuses_the_dispatch() {
        // The whole message, because it is the whole product of this gate: an operator
        // who reads it must be able to fix the run without opening either file. The
        // alternative it replaces is an `ExpiredToken` at minute 60 of 90, by which time
        // the budget is gone and it reads as a broken test.
        let why = admits_secrets(
            &workspace(),
            &TaskId::new("ste-p2-w4f"),
            &ids(&["aws-cloud-test"]),
            held_for(5400),
        )
        .expect_err("an hour of credential cannot cover ninety minutes of run");
        assert_eq!(
            why,
            "cannot start ste-p2-w4f: aws-cloud-test lives 1h and the run may take 1h30m\n  \
             shorten the wall budget to 1h, or declare a longer-lived credential"
        );
    }

    #[test]
    fn a_credential_that_lasts_the_whole_run_is_admitted() {
        let c = workspace();
        let t = TaskId::new("ste-p2-w4f");
        // Comfortably longer, and exactly as long. The boundary belongs to
        // `SecretDef::admits`, and it is asserted here because an operator who set both
        // figures to `1h` did the arithmetic right and must not be refused for it.
        for wall in [1800, 3600] {
            assert!(
                admits_secrets(&c, &t, &ids(&["aws-cloud-test"]), held_for(wall)).is_ok(),
                "a 1h credential covers a {wall}s run"
            );
        }
        let both = ids(&["aws-cloud-test", "travelpayouts"]);
        assert!(admits_secrets(&c, &t, &both, held_for(3600)).is_ok());
    }

    #[test]
    fn the_credential_named_is_the_one_that_expires() {
        // Declared second and refused first: a refusal that named whichever id came first
        // would send the operator to edit the token that was fine.
        let why = admits_secrets(
            &workspace(),
            &TaskId::new("ste-p2-w4f"),
            &ids(&["travelpayouts", "aws-cloud-test"]),
            held_for(7200),
        )
        .expect_err("two hours outlives the session credential");
        assert!(why.contains("aws-cloud-test lives 1h"), "{why}");
        assert!(!why.contains("travelpayouts"), "{why}");
    }

    #[test]
    fn a_run_with_no_clock_refuses_nothing() {
        // A wall nothing declared is one no ttl can be shorter than, which is what
        // `Company::hold` decides too — the front gate must not be stricter than the gate
        // it fronts. An unbounded run is a budget defect, and admission's to report.
        assert!(
            admits_secrets(
                &workspace(),
                &TaskId::new("ste-p2-w4f"),
                &ids(&["aws-cloud-test"]),
                Limits::default(),
            )
            .is_ok()
        );
    }

    #[test]
    fn a_task_declaring_no_credentials_is_asked_nothing() {
        // Every dispatch calls this, and almost none of them declare a credential. A
        // workspace with no `[secrets.*]` at all is the common case, and it must not
        // become a reason a docs task cannot start.
        let bare = Company::parse("[company]\nname = \"cws\"\n").expect("the profile parses");
        assert!(admits_secrets(&bare, &TaskId::new("docs-1"), &[], held_for(60)).is_ok());
        assert!(admits_secrets(&workspace(), &TaskId::new("docs-1"), &[], held_for(60)).is_ok());
    }

    #[test]
    fn an_id_no_block_declares_is_refused_here_rather_than_at_the_resolver() {
        // Checked for every id before any ttl is judged, so the typo is reported as a
        // typo. Judged the other way round, this dispatch would have failed on
        // `aws-cloud-test`'s ttl and the misspelling would have surfaced a run later.
        let why = admits_secrets(
            &workspace(),
            &TaskId::new("ste-p2-w4f"),
            &ids(&["aws-clod-test", "aws-cloud-test"]),
            held_for(5400),
        )
        .expect_err("no block declares that id");
        assert_eq!(
            why,
            "cannot start ste-p2-w4f: unknown secret `aws-clod-test` — \
             company.toml declares aws-cloud-test, travelpayouts"
        );
    }

    #[test]
    fn a_worktree_listing_separates_ours_from_a_strangers() {
        // The distinction the whole view exists for. `orphan` and `not ours` used to
        // print identically, and one of them invites deleting somebody else's work.
        let out = worktrees(&[RepoTrees {
            repo: "api".into(),
            path: "/repos/api".into(),
            rows: vec![
                WorktreeRow {
                    path: "/run/cws/cache".into(),
                    tenant: Tenant::Task {
                        id: "cache".into(),
                        project: "export".into(),
                        status: TaskStatus::Running,
                    },
                },
                WorktreeRow {
                    path: "/run/cws/vanished".into(),
                    tenant: Tenant::Orphan {
                        task: "vanished".into(),
                    },
                },
                WorktreeRow {
                    path: "/elsewhere/theirs".into(),
                    tenant: Tenant::Stranger,
                },
            ],
        }]);

        // Asserted whole, because the columns are the point: a reader scans down the
        // first one to see what is theirs to touch.
        assert_eq!(
            out,
            "  task                 project      status     path
api — /repos/api
  cache                export       running    /run/cws/cache
  — orphan (vanished)  —            —          /run/cws/vanished
  — not ours           —            —          /elsewhere/theirs

  3 trees in 1 repo · 1 in use · 1 ours to clean up · 1 not ours
"
        );
    }

    #[test]
    fn a_repo_with_no_worktrees_is_not_printed_as_an_empty_heading() {
        // Every project's repo is asked, and most have no trees. A heading per repo
        // would bury the few rows that matter.
        let out = worktrees(&[
            RepoTrees {
                repo: "api".into(),
                path: "/repos/api".into(),
                rows: vec![WorktreeRow {
                    path: "/run/cws/cache".into(),
                    tenant: Tenant::Merge,
                }],
            },
            RepoTrees {
                repo: "web".into(),
                path: "/repos/web".into(),
                rows: vec![],
            },
        ]);
        assert!(!out.contains("web"), "{out}");
        assert!(out.contains("1 tree in 1 repo"), "{out}");

        assert_eq!(
            worktrees(&[RepoTrees {
                repo: "web".into(),
                path: "/repos/web".into(),
                rows: vec![],
            }]),
            "no worktrees\n"
        );
    }
}
