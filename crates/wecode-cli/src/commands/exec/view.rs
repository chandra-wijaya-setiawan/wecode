//! Seeing and removing the worktrees in play, whoever owns them.

use std::path::PathBuf;

use wecode_core::{Plan, TaskId};
use wecode_org::Company;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{git, teardown, work};

/// Every repository some project in the plan is built from, each named once.
///
/// The unit of a worktree is the repository, not the project: `git worktree list` answers
/// per repo, so asking once per project printed every tree once per project sharing it —
/// 27 rows for 4 trees, on the workspace that found this. Two projects on one repo are one
/// question with one answer.
///
/// `all_projects`, because archiving must not make a checkout unreachable: a worktree you
/// cannot see is one you cannot clean up.
///
/// Keyed on the canonical path so two `[[repos]]` entries spelling one directory two ways
/// still collapse; named by the first `[[repos]]` name that reached it, since a repo has
/// one identity in the config even when the config disagrees with itself.
fn repos_in_play(
    company: &Company,
    plan: &Plan,
) -> Result<Vec<(String, PathBuf)>, Box<dyn std::error::Error>> {
    let mut seen = std::collections::HashSet::new();
    let mut repos = Vec::new();
    for p in plan.all_projects() {
        let path = repo_path(company, p)?;
        let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.insert(key) {
            repos.push((p.repo.clone(), path));
        }
    }
    Ok(repos)
}

pub(crate) fn worktree_list(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let org = work::org_name(ws.root());
    // Only the trees still standing. A tombstone says a directory used to be ours, which
    // is a fact about the past — git is being asked what is there now.
    let ours: Vec<wecode_store::Worktree> = store
        .worktrees()?
        .into_iter()
        .filter(|w| w.removed.is_none())
        .collect();
    let merge = work::merge_scratch(&org).to_string_lossy().into_owned();

    let mut groups = Vec::new();
    for (repo_name, repo) in repos_in_play(&company, &plan)? {
        if !git::is_repo(&repo) {
            continue;
        }
        let rows = git::worktree_list(&repo)?
            .into_iter()
            .map(|path| work::WorktreeRow {
                tenant: tenant_of(&plan, &org, &ours, &merge, &path),
                path,
            })
            .collect();
        groups.push(work::RepoTrees {
            repo: repo_name,
            path: repo.to_string_lossy().into_owned(),
            rows,
        });
    }
    Ok(work::worktrees(&groups))
}

/// Who the tree at `path` belongs to.
///
/// Asked in this order on purpose. A task in the plan comes first, because that is the
/// answer an operator can act on and it settles the ambiguous cases — a task whose id
/// happens to be `.merge`, or a registry row for a task that turns out to still exist.
///
/// The registry is what makes the last arm honest. Before it, anything wecode could not
/// place was called an orphan, which reads as *we made this and lost track of it* —
/// and for another tool's worktree in the same repository that is a lie inviting the
/// operator to delete somebody else's work.
fn tenant_of(
    plan: &Plan,
    org: &str,
    ours: &[wecode_store::Worktree],
    merge: &str,
    path: &str,
) -> work::Tenant {
    // Across the whole plan, not one project's tasks: the tree is found via the repo now,
    // and the path names its owning task without saying which project that task is in.
    // Matching a computed path also covers a tree made before the registry existed.
    let owner = plan
        .tasks()
        .find(|t| work::worktree_for(org, &t.id).to_string_lossy() == path)
        .or_else(|| {
            ours.iter()
                .find(|w| w.path == path)
                .and_then(|w| plan.task(&TaskId::new(&w.task)))
        });
    if let Some(t) = owner {
        return work::Tenant::Task {
            id: t.id.to_string(),
            project: t.project.to_string(),
            status: t.status,
        };
    }
    if let Some(w) = ours.iter().find(|w| w.path == path) {
        // Ours, and the task it was made for is gone from the plan. The registry outlives
        // the task deliberately, which is what lets this say whose tree it was.
        return work::Tenant::Orphan {
            task: w.task.clone(),
        };
    }
    if path == merge {
        return work::Tenant::Merge;
    }
    work::Tenant::Stranger
}

/// Which worktree a removal was aimed at: where it is, which repository it belongs to,
/// and the branch standing in it.
///
/// `repo` is optional because a directory that is already gone needs none — closing its
/// registry row is a write to our own database, not a git operation.
struct Aimed {
    repo: Option<PathBuf>,
    path: PathBuf,
    branch: Option<String>,
}

/// Whether a name on the command line is a worktree path rather than a task id.
///
/// A task id is a kebab-case slug — `TaskId::new` strips everything else — so a separator
/// or a leading `~` cannot occur in one. Told apart by shape rather than by trying the
/// plan first, because a mistyped path used to be slugified into a plausible id and
/// refused as *no such task*, which named the wrong problem entirely.
fn is_path(named: &str) -> bool {
    named.contains('/') || named.contains(std::path::MAIN_SEPARATOR) || named.starts_with('~')
}

/// The repository that lists `path` as one of its worktrees, if one in the plan does.
///
/// Asked of git rather than derived from the path, because a path names no project: the
/// trees a removal must now reach — an orphan's, the merge scratch — are exactly the ones
/// with no task to look a repo up through.
///
/// Compared after canonicalisation on both sides. git prints the path it resolved when the
/// tree was added, and the operator is as likely to have typed a symlinked spelling of it.
fn repo_listing(
    company: &Company,
    plan: &Plan,
    path: &std::path::Path,
) -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
    let real = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let wanted = real(path);
    for (_, repo) in repos_in_play(company, plan)? {
        if !git::is_repo(&repo) {
            continue;
        }
        if git::worktree_list(&repo)?
            .iter()
            .any(|p| real(std::path::Path::new(p)) == wanted)
        {
            return Ok(Some(repo));
        }
    }
    Ok(None)
}

/// Removes a worktree, named either by the task that owns it or by its path.
///
/// A path is accepted because the listing can now name trees a task id cannot reach: an
/// orphan's task is gone from the plan — that is what makes it an orphan — and the merge
/// scratch never had one. Seeing a tree you cannot remove is a worse place to be than not
/// seeing it, and `worktree-view` left it there deliberately for this task to settle.
pub(crate) fn worktree_remove(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let named = require(a.cmd(2), "task id or worktree path")?;
    let plan = store.load_plan()?;

    let aim = if is_path(named) {
        // Resolved before anything is done with it. `git -C <repo> worktree remove` takes
        // the directory relative to the *repository*, so a relative path typed at a shell
        // would name a different place than the one the operator is looking at.
        // Unresolvable means it does not exist, which is a reportable outcome rather than
        // an error, so the spelling as given carries through to the message.
        let path = wecode_org::workspace::expand_home(named);
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        // The branch from the registry, since a path does not imply one. `None` for a
        // stranger's tree or the merge scratch, and the report then says nothing about a
        // branch rather than guessing at a name.
        let branch = store
            .worktree_at(&path.to_string_lossy())?
            .map(|w| w.branch);
        Aimed {
            repo: repo_listing(&company, &plan, &path)?,
            path,
            branch,
        }
    } else {
        let task = the_task(&plan, named)?;
        let id = task.id.clone();
        let project = plan
            .project(&task.project)
            .ok_or_else(|| format!("no such project: {}", task.project))?;
        let owner = work::owner(&plan, &id).expect("task is in the plan");
        if owner.id != id {
            return Err(format!(
                "{id} shares {}'s worktree — remove that one instead",
                owner.id
            )
            .into());
        }
        Aimed {
            repo: Some(repo_path(&company, project)?),
            path: work::worktree_for(&work::org_name(ws.root()), &id),
            branch: Some(work::branch_for(&id)),
        }
    };

    let torn = teardown::take_down(&store, aim.repo.as_deref(), &aim.path, a.has("force"))?;
    let report = teardown::torn(&aim.path, aim.branch.as_deref(), &torn);
    match torn {
        // A refusal, not a report. The exit code is what stops a script carrying on as
        // though the tree were gone.
        teardown::Torn::Dirty { .. } => Err(report.into()),
        _ => Ok(report),
    }
}
