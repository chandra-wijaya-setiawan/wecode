//! Judging a finished task from its diff and its acceptance commands, and recording it.

use wecode_core::{TaskId, TaskStatus};
use wecode_gov::{Action, Broker, Session};
use wecode_store::Store;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{cache, git, notify, spawn, verify, work};

/// Judges a finished task from its diff and its acceptance commands.
///
/// Nothing here asks the agent how it went. The diff is ground truth, the exit codes
/// are ours, and both reach the ledger as `Source::Supervisor` — observed, not
/// self-reported, and therefore admissible.
pub(crate) fn verify_task(a: &Args) -> Res {
    Ok(judge(a)?.0)
}

/// The verdict, and a one-line reason when it went against the work.
///
/// Split from `verify_task` so `run` can put the reason on the execution record. The
/// process exit is not the reason a task failed — "exit 0" tells a retry nothing,
/// where "grep -q V2 exited 1" tells it everything.
pub(crate) fn judge(a: &Args) -> Result<(String, Option<String>), Box<dyn std::error::Error>> {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(1), "task id")?)?.clone();
    let id = task.id.clone();
    let project = plan
        .project(&task.project)
        .ok_or_else(|| format!("no such project: {}", task.project))?;

    // Judge wherever the work happened: the task's worktree when it has one, the
    // repository itself when the playbook said it needed none.
    let owner = work::owner(&plan, &id).expect("task is in the plan");
    let wt = work::worktree_for(&work::org_name(ws.root()), &owner.id);
    let dir = if wt.is_dir() {
        wt
    } else {
        repo_path(&company, project)?
    };
    if !git::is_repo(&dir) {
        return Err(format!("{} is not a git repository", dir.display()).into());
    }

    // The playbook again, for the shared build cache. `verify` is reachable on its own
    // — a hand-run task, a re-judged one — so it resolves the cache itself rather than
    // relying on a `prepare` that may have happened in another process, or last week.
    //
    // A playbook that does not load therefore stops a verdict, exactly as it already
    // stops preparation. That is the right way round: the alternative is judging work
    // with a cache the project asked for and did not get, and reporting it as passed.
    let shared = cache::shared(playbook_of(&company, project)?.as_ref());
    cache::ensure(&shared)?;

    let mut v = verify::run_acceptance(&dir, &task.acceptance, &shared);
    // The branch's work, not just what is uncommitted: a retry starts from a
    // `reset --hard` on top of the previous attempt's commit, and asking only the
    // working tree would judge the attempt that changed nothing instead of the work
    // that is actually standing there.
    v.changed = verify::changed(&dir, &id)?;
    v.violations = verify::violations(&v.changed, &task.scope);

    // Record before deciding, so a crash between the two loses the transition rather
    // than the evidence.
    let who = actor(a, &store, &company)?;
    let mut broker = Broker::new(company.charter.clone());
    let session = Session::new(
        who.session.clone(),
        task.assignee.clone().unwrap_or_else(|| who.post.clone()),
        who.agent.clone(),
        who.effective.clone(),
    )
    .on(Some(task.project.to_string()), Some(id.to_string()))
    .with_human(who.human.clone());

    for path in &v.violations {
        broker.observe(
            &session,
            Action::Write { path: path.clone() },
            wecode_gov::Decision::Deny {
                reason: wecode_gov::DenyReason::OutsideWriteScope { path: path.clone() },
                mode: wecode_gov::ControlMode::Sanctioned,
                alarm: false,
            },
            wecode_gov::Source::Supervisor,
        );
    }
    // Every check lands as an `Allow` with its exit code on the line: running it was
    // the supervisor's own permitted act, and the exit is the observation. The
    // verdict a red check earns goes on the *task* — `failed`, below — never on the
    // ledger. Recording it as a denied command put failing work in the governance
    // channel: the board said "denied" about work that was merely wrong, and a real
    // denial had to be picked out from among the red tests. A denial is authority
    // refusing an action, and nothing here was refused.
    for c in &v.checks {
        broker.observe(
            &session,
            Action::Run {
                argv: vec![format!("{} — {}", c.cmd, c.describe())],
            },
            wecode_gov::Decision::Allow,
            wecode_gov::Source::Supervisor,
        );
    }
    store.append_records(broker.ledger())?;

    // Passing acceptance is not the same as landed, but only for work that has
    // something of its own to land: a branch nobody has merged. That is `owner.id ==
    // id` and nothing weaker, because a **subtask has no branch of its own**. Its
    // commits are on the main task's, and `merge` on a subtask would put that whole
    // branch on the integration branch — every step of the expansion, including the
    // ones that have not run — while marking only this task done. So there was no
    // approval to grant, and asking for one stopped the plan: a sibling declared
    // `--after` this step stays `waiting`, since readiness follows `done`, and the
    // loop stops dispatching entirely while anything needs a human. One passing step
    // held up the rest of its own expansion, waiting on a merge that would have been
    // premature. A step that passes is as finished as a step can be; the main task is
    // what lands.
    //
    // A design is the exception at any depth, and for the other reason: the document
    // exists, which is all a command can check, and whether it is the *right* design
    // is exactly the part no command can. Dependents must not start on the strength of
    // a file being present.
    //
    // Asked of the task rather than of its kind, because a manual task reaches the same
    // gate from the other side: its probes may well pass — checking that the bucket
    // exists is exactly the cheap check worth having — but passing is not the work being
    // reported, and only the person who did it can report that.
    let owns_a_branch = owner.id == id && dir.starts_with(work::run_root());
    let next = if !v.passed() {
        TaskStatus::Failed
    } else if task.needs_a_signature() || owns_a_branch {
        TaskStatus::NeedsApproval
    } else {
        TaskStatus::Done
    };
    store.set_task_status(&id, next)?;
    // The two verdicts a person has to act on — verified-and-unlanded, and failed —
    // both end here, which is why this is where the loop's own announcement is made.
    let announced = notify::on_status_change(&company, ws.root(), &task, task.status, next);

    let reason = (!v.passed()).then(|| {
        let mut parts = Vec::new();
        if !v.violations.is_empty() {
            parts.push(format!("outside scope: {}", v.violations.join(", ")));
        }
        for c in v.checks.iter().filter(|c| !c.passed()) {
            parts.push(format!("{} — {}", c.cmd, c.describe()));
        }
        if parts.is_empty() {
            parts.push("nothing to judge by".to_string());
        }
        parts.join("; ")
    });

    Ok((
        format!(
            "{}{announced}",
            verify::verdict(&task, &owner.id, &dir, &v, next)
        ),
        reason,
    ))
}

/// Commits whatever the attempt produced, pass or fail.
///
/// **After** the verdict, never before: `verify` reads the *uncommitted* diff, so
/// committing first would leave it nothing to check and every run would pass its
/// scope check trivially.
///
/// A failed attempt is committed too, and that is the point. The failed diff is what
/// a retry learns from — left uncommitted, the next attempt's `git reset --hard`
/// destroys the only evidence of what went wrong.
///
/// Only inside a worktree. Committing into the operator's own checkout would be
/// taking a decision that is not wecode's to take.
pub(crate) fn commit_attempt(
    store: &Store,
    id: &TaskId,
    cwd: &std::path::Path,
    outcome: &spawn::Outcome,
) -> Result<String, Box<dyn std::error::Error>> {
    if !cwd.starts_with(work::run_root()) {
        return Ok(String::new());
    }
    // `next_attempt` is what the *next* run would be, so this run is one below it.
    let attempt = store.next_attempt(id)?.saturating_sub(1).max(1);
    // The cause in the body, and the subject untouched: `attempts_on` matches attempts
    // by their first line, and the handoff and the scope check both read that match.
    // A failed attempt's commit is the thing a retry is handed as a diff — the reason
    // it failed belongs beside the diff rather than only in the database next door.
    let message = format!("{id}: attempt {attempt}\n\n{}", outcome.cause());
    Ok(match git::commit_all(cwd, &message)? {
        Some(sha) => format!("  committed {sha} — attempt {attempt}\n"),
        None => "  nothing to commit — the agent changed no files\n".to_string(),
    })
}
