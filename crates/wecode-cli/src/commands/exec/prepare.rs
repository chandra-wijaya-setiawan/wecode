//! Getting a task ready to work on: the worktree, the base branch, the envelope.

use std::path::PathBuf;

use wecode_core::{Plan, Task, TaskId, WORKER_DIR, admission};
use wecode_org::{Company, Workspace};
use wecode_store::Store;
use wecode_store::journal::{self, Resolve, Step};

use crate::commands::ctx::*;
use crate::{cache, git, handoff, identity, render, work};

use super::queue::unsigned;

/// Begins work on a task: prepares the worktree its playbook asks for, marks it
/// running, and prints the envelope for whoever does the work.
/// The branch of the predecessor this task should build on, if it has one.
///
/// The *last* done predecessor by id, and only one: merging several branch points is
/// a real decision — which order, and what to do about a conflict — and guessing at it
/// would be worse than saying so. A task with two predecessors that both changed code
/// wants a merge task between them, which the plan can express.
///
/// A predecessor already on `integration` is passed over. Its branch survives the merge
/// — [`crate::teardown`] keeps it deliberately, so the task can be picked back up — but
/// it stands where it stood when it landed, behind everything that landed beside it.
/// Cutting from it trades a complete base for a partial one: the integration branch
/// holds that predecessor's work *and* the rest, so the only thing the branch offers
/// over it is the absence of the rest. That absence is what a chain of green tasks
/// arrives at a red integration branch through — each one written against a tree
/// missing its neighbours, judged by acceptance run over that tree, and landing as a
/// merge whose other side nobody exercised.
///
/// Quiet, too, because it is not an edge: a branch-owning task only reaches `done` by
/// being merged, so under the ordinary flow every done predecessor with a branch has
/// already landed, and the base was stale every time.
fn predecessor_branch(
    repo: &std::path::Path,
    plan: &Plan,
    task: &Task,
    integration: Option<&str>,
) -> Option<String> {
    let mut candidates: Vec<&Task> = task
        .depends_on
        .iter()
        .filter_map(|d| plan.task(d))
        .filter(|t| t.status.is_done())
        .collect();
    candidates.sort_by(|a, b| a.id.cmp(&b.id));

    candidates.iter().rev().find_map(|t| {
        // The branch belongs to whichever task owns the worktree — a subtask shares its
        // parent's, and there is no branch of its own to build on.
        let owner = work::owner(plan, &t.id)?;
        let branch = work::branch_for(&owner.id);
        if !git::branch_exists(repo, &branch) || landed(repo, integration, &owner.id) {
            return None;
        }
        Some(branch)
    })
}

/// Whether this task's work is already on the integration branch.
///
/// Asked of git rather than of the task's status: `done` is what the plan believes, and
/// `wecode rollback` reverts a merge without disturbing that belief. The merge commit
/// names the task — see [`git::merge_commit_for`] — so history is the record, and there
/// is no second copy of it to disagree with.
///
/// A project with no integration branch has nowhere for work to already be, and neither
/// has a target git cannot resolve. Both answer *not landed*, leaving the predecessor's
/// branch as the base — correctly, since it is then the only place that work is.
fn landed(repo: &std::path::Path, integration: Option<&str>, id: &TaskId) -> bool {
    integration.is_some_and(|target| git::merge_commit_for(repo, target, id.as_str()).is_some())
}

/// A task made ready to work on: where, and with what instructions.
pub(crate) struct Prepared {
    pub(crate) cwd: PathBuf,
    /// The directories this project shares between worktrees, already created.
    ///
    /// Carried rather than looked up again at spawn, so what the notes told the
    /// operator and what the agent is actually given are one value.
    pub(crate) cache: cache::Shared,
    pub(crate) envelope: String,
    /// The same instruction as the protocol models it. `envelope` is one rendering of
    /// this, so the two cannot describe different work.
    pub(crate) a2a: wecode_a2a::Task,
    /// What preparation did, for the operator to read.
    pub(crate) notes: String,
    /// The journal row this preparation opened. Open while this process owns the task,
    /// and what a restart settles if this process does not survive to.
    pub(crate) journal: i64,
    /// The name this dispatch's agent is launched under, so an orphan is findable by
    /// what it is carrying rather than only by a number.
    pub(crate) token: String,
}

/// Makes the scratch directory the envelope names, and answers with it.
///
/// Every envelope ends by telling the agent to write `.wecode/run/result.json` in its
/// working directory, and nothing made the directory. A worktree is a clean checkout,
/// so a first attempt never had one; `git clean -fd` takes the last attempt's away
/// before a retry, so a second attempt did not either. Every agent had to work out for
/// itself that the parent must be created first, and the one that did not lost its
/// report to a failed open — the run's own account of what it did and what it could
/// not, gone for a missing directory that wecode names and wecode can make.
///
/// Made for the repository too, when the playbook asks for no worktree. The instruction
/// does not change with the tree, so neither can this: an agent told to write its
/// result somewhere is owed the somewhere. What lands in the operator's own checkout is
/// an empty untracked directory — the playbook's standing advice is to gitignore it,
/// git does not record an empty directory in any case, and nothing here puts a file in
/// one. That is well short of committing on the operator's behalf, which is the line
/// [`commit_attempt`] draws and this does not approach.
///
/// A hard error rather than a shrug, for the reason the build cache is one: a directory
/// that cannot be made is otherwise found out by the agent, in the last seconds of its
/// run, at the moment it has no way left to say so.
fn worker_area(cwd: &std::path::Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = cwd.join(WORKER_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "cannot create the worker area {}: {e}\n  \
             the envelope tells the agent to write its result there",
            dir.display()
        )
    })?;
    Ok(dir)
}

/// Everything both `start` and `run` must do before any work happens.
///
/// One function because they must not drift: a task prepared by hand and a task
/// prepared for an agent have to land in the same directory, on the same branch,
/// with the same instructions. Recording the worktree is here for that reason too —
/// hung on the caller instead, one of the two would eventually forget, and a tree
/// wecode made but did not write down is exactly the thing this closes.
pub(crate) fn prepare(
    ws: &Workspace,
    store: &Store,
    company: &Company,
    plan: &Plan,
    task: &Task,
    runs: &[wecode_store::Execution],
) -> Result<Prepared, Box<dyn std::error::Error>> {
    let id = task.id.clone();
    if task.status.is_closed() {
        return Err(format!(
            "{id} is {} — reopen it with `wecode status {id} waiting` first",
            task.status.as_str()
        )
        .into());
    }
    // Nothing here has anything to prepare for a manual task: no worktree, no branch,
    if task.is_done_by_a_person() {
        return Err(format!(
            "{id} is done by a person — nothing is dispatched to it and no tree is cut\n  \
             it sits in needs-approval until a signature reports the work done"
        )
        .into());
    }
    let project = plan
        .project(&task.project)
        .ok_or_else(|| format!("no such project: {}", task.project))?;
    // Loaded before the admission re-check, which needs the playbook's design gate:
    // dispatch is the last door, and it must refuse what `task add` would.
    let pb = playbook_of(company, project)?;
    let gate = pb
        .as_ref()
        .map(wecode_org::Playbook::design_required_kinds)
        .unwrap_or_default();

    let defects = admission::check_task(task, plan, &gate);
    if !defects.is_empty() {
        return Err(format!(
            "{}\n  a draft cannot be worked on",
            render::plan::admission(&render::plan::task_heading(task), &defects, None)
        )
        .into());
    }
    let blockers = plan.blockers(&id);
    if !blockers.is_empty() {
        let mut msg = format!("{id} is not ready\n");
        for b in &blockers {
            msg.push_str(&format!("    waiting on {}\n", blocker_note(b)));
        }
        return Err(msg.into());
    }

    // Before the worktree, not after: preparation has side effects on the repository,
    // and a tree cut for work nobody has signed for is a tree left standing.
    if let Some(why) = unsigned(store, pb.as_ref(), task)? {
        return Err(why.into());
    }

    // The worktree belongs to the main task, so a subtask joins its parent's tree
    // rather than opening a second checkout of the same work.
    let owner = work::owner(plan, &id).expect("task is in the plan");
    let wants_worktree = pb
        .as_ref()
        .and_then(|p| p.for_kind(owner.kind))
        .is_some_and(|k| k.worktree);

    let mut notes = String::new();
    // The project's own checkout, kept apart from `cwd` rather than shadowed by it: a
    let repo = repo_path(company, project)?;
    // Resolved before anything is cut, because the row below has to name the tree it is
    // about to make and has to be committed first.
    let cwd = if wants_worktree {
        work::worktree_for(&work::org_name(ws.root()), &owner.id)
    } else {
        repo.clone()
    };

    // The rule, at the first step it applies to: cutting a worktree changes something
    // outside this database, so the intent goes in before it and is settled after — see
    // [`crate::reclaim`]. `redo`, because `worktree add` followed by `reset --hard` is
    // already idempotent, so a second preparation overwrites the first rather than
    // leaving two trees.
    //
    // This row stays open for as long as *this process* owns the task, which is longer
    // than the step: it is what tells a restart there is a tree standing and a claim to
    // hand back. `start` settles it on the way out, because from there the tree is an
    // operator's and an operator is not a process whose liveness anything can prove.
    let token = identity::token(&id);
    let journal = store.open_intent(
        &journal::Intent::new(&id, Step::Prepare, Resolve::Redo, &cwd.to_string_lossy(), &token)
            .owned_by(identity::me())
            // The one row that carries it. `Claim` recorded this status in memory, and
            // memory is exactly what the crash took.
            .taking(task.status),
    )?;

    if wants_worktree {
        let branch = work::branch_for(&owner.id);
        let path = cwd.clone();
        if !git::is_repo(&repo) {
            return Err(format!("{} is not a git repository", repo.display()).into());
        }
        // Where this branch starts. A predecessor's branch when it has one still standing
        let integration = pb.as_ref().and_then(|p| p.project.merge_to.clone());
        let from_predecessor = predecessor_branch(&repo, plan, task, integration.as_deref());
        let base = match from_predecessor.or(integration) {
            Some(b) => Some(b),
            None => git::current_branch(&repo)?,
        };

        if path.is_dir() {
            git::reset_hard(&path)?;
            notes.push_str(&format!("  worktree {} (reset)\n", path.display()));
        } else {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // Asked before the branch is cut, because afterwards the answer is always
            // yes — and reported, because which base a task was given is the one thing
            // about preparation the operator could not see, while being what decides
            // both what the work is written against and what acceptance is run over.
            // Only on a branch being created: `worktree_add` reuses an existing one and
            // ignores the base, so naming it for a task picked back up would name a
            // commit nothing was taken from.
            let fresh = !git::branch_exists(&repo, &branch);
            git::worktree_add(&repo, &path, &branch, base.as_deref())?;
            notes.push_str(&format!("  worktree {}\n", path.display()));
            if let Some(b) = base.as_deref().filter(|_| fresh) {
                notes.push_str(&format!("  base     {b}\n"));
            }
        }
        // Written down after git agreed, and on the reset path as well as the fresh
        // one. A tree standing from before the registry existed is one wecode made and
        // cannot prove; recording it the next time it is prepared is how a workspace
        // that predates this catches up, without backfilling a date nobody observed.
        store.record_worktree(&path.to_string_lossy(), &project.repo, &branch, &owner.id)?;
        notes.push_str(&format!("  branch   {branch}\n"));
        if owner.id != id {
            notes.push_str(&format!("  shared with {} (its main task)\n", owner.id));
        }
    } else {
        notes.push_str(&format!(
            "  no worktree — the {} playbook does not ask for one\n  work in {}\n",
            owner.kind.as_str(),
            cwd.display()
        ));
    }

    // After the branch above has settled what is standing in `cwd`, and after the reset
    // in particular: `clean -fd` removes this directory along with the rest of the last
    // attempt's untracked work, so making it any earlier would be making it twice, the
    // second time in vain.
    //
    // Reported like the worktree and the cache, and for the same reason — an operator
    // working the task by hand is reading these notes to find out where the run is
    // laid out, and the file the envelope asks them for goes here.
    let run_dir = worker_area(&cwd)?;
    notes.push_str(&format!("  run dir  {}\n", run_dir.display()));

    // After the worktree, because that is what makes the cache worth having: this is
    // the checkout whose `target/` would otherwise start empty. Reported in the notes
    // for the same reason the worktree is — an operator running the task by hand needs
    // the same directories the agent is given, or the two builds do not share one.
    let shared = cache::shared(pb.as_ref());
    cache::ensure(&shared)?;
    for (var, dir) in &shared {
        notes.push_str(&format!("  cache    {var}={}\n", dir.display()));
    }

    let a2a = handoff::a2a_task(
        &company.templates.task_envelope,
        task,
        project,
        plan,
        &cwd,
        &repo,
        runs,
    );
    Ok(Prepared {
        envelope: handoff::envelope(&a2a),
        a2a,
        cwd,
        cache: shared,
        notes,
        journal,
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::exec::test_support::{chain, chain_repo};

    #[test]
    fn a_predecessor_still_standing_apart_is_the_base() {
        // Unchanged, and the reason the branch is consulted at all: work that is only
        // on `wecode/first` is nowhere else, so that is where the successor starts.
        let repo = chain_repo("base-unmerged", false);
        let (plan, second) = chain();
        assert_eq!(
            predecessor_branch(&repo, &plan, &second, Some("main")),
            Some("wecode/first".to_string())
        );
    }

    #[test]
    fn a_predecessor_already_on_the_integration_branch_is_not_the_base() {
        // The whole defect. The branch survives the merge on purpose, so it was still
        // found and still cut from — at the commit it stood on when it landed, missing
        // everything that landed beside it. `None` here sends `prepare` to the
        // integration branch, which has the predecessor's work *and* the rest.
        let repo = chain_repo("base-merged", true);
        let (plan, second) = chain();
        assert!(git::branch_exists(&repo, "wecode/first"), "kept on purpose");
        assert_eq!(predecessor_branch(&repo, &plan, &second, Some("main")), None);
    }

    #[test]
    fn a_project_with_no_integration_branch_still_builds_on_its_predecessor() {
        // Nowhere for work to already be. Answering anything but the branch here would
        // drop the predecessor's work on the strength of a question nobody can ask.
        let repo = chain_repo("base-no-target", true);
        let (plan, second) = chain();
        assert_eq!(
            predecessor_branch(&repo, &plan, &second, None),
            Some("wecode/first".to_string())
        );
    }

    #[test]
    fn the_directory_the_envelope_names_is_standing_before_the_agent_is() {
        // The whole defect: the envelope said "write .wecode/run/result.json" into a
        // clean checkout where no such directory existed, and an agent that did not
        // think to create the parent had nowhere to file its report.
        let cwd = std::env::temp_dir().join("wecode-exec-worker-area");
        let _ = std::fs::remove_dir_all(&cwd);
        std::fs::create_dir_all(&cwd).unwrap();

        let dir = worker_area(&cwd).unwrap();
        assert_eq!(dir, cwd.join(WORKER_DIR));
        assert!(dir.is_dir(), "{dir:?}");

        // Idempotent: a retry prepares the same tree again, and the reset before it
        // may or may not have taken this away.
        assert!(worker_area(&cwd).is_ok());
    }

    #[test]
    fn a_worker_area_that_cannot_be_made_says_what_it_was_for() {
        // Left to the agent, this surfaces as a failed open in the last seconds of a
        // run, when there is no longer any way to report it.
        let file = std::env::temp_dir().join("wecode-exec-not-a-dir");
        let _ = std::fs::remove_dir_all(&file);
        std::fs::write(&file, "x").unwrap();
        let e = worker_area(&file).unwrap_err().to_string();
        assert!(e.contains(WORKER_DIR), "{e}");
        assert!(e.contains("the envelope"), "{e}");
    }
}
