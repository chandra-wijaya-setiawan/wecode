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
//!
//! # The other thing a run leaves standing
//!
//! A worktree is not the only thing a task creates. One that tests against a real cloud
//! stands the cloud half up as well — a deployed runtime, a bucket, a stack — and that
//! half is not a directory anybody can see: it is a meter that goes on running after the
//! agent is gone. `--teardown` is the line whoever dispatches hands the supervisor for
//! taking it down again, and [`after_agent`] is the supervisor running it.
//!
//! Three properties, and each is a reason a teardown the *agent* ran as its own last
//! step would not do:
//!
//! - **After the agent exits, whatever the exit was.** The runs that leak are the ones
//!   that crashed, hit the wall limit, or were stopped for overspending — precisely the
//!   runs whose agent never reached a last step of its own. So the hook is not
//!   conditioned on the outcome, and [`after_agent`] is not *handed* the outcome: a
//!   function that cannot read how the run ended cannot later be gated on it by
//!   somebody adding one plausible-looking `if`.
//! - **Run by the supervisor, not by the worker.** What the destroy call authenticates
//!   with is laid into this one process's environment and never into the worktree, so a
//!   task can do real work against a cloud account without the agent ever holding the
//!   keys. It is also the only arrangement that survives the agent: a credential the
//!   worker had to spend is a credential a killed worker never spends.
//! - **Its own clock.** The agent's limits have already expired by the time this runs,
//!   so a teardown with no bound of its own would hold the seat open for as long as one
//!   stalled API call cared to hang. See [`HOOK_WALL`].
//!
//! It never changes the verdict. A teardown that failed did not fail the *work* — it
//! left a bill — and recording that as the task's failure invites the one response that
//! makes it worse: a retry, which stands a second set of resources up beside the first.
//! So the outcome is reported loudly, [`Undone::ok`] is there for whoever wants to raise
//! an alarm about it, and judging the diff stays the business of `verify`.
//!
//! **Not wired yet.** This module is the whole mechanism, and `--teardown` needs no
//! parser work — [`crate::args`] reads any `--flag value`, so the value is
//! `a.get("teardown")`. What joins them is three lines in `commands::exec::run_task`,
//! which this task was not allowed to write: [`forbidden`] beside the charter check on
//! the launch line, [`after_agent`] immediately after `spawn::run` returns — above the
//! `outcome.ended.ok()` branch rather than inside either half of it — and
//! [`undone_line`] pushed onto the report `spawn::ran` starts. Each item below carries
//! an `allow(dead_code)` saying so; the change that adds those three lines deletes all
//! of them.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use wecode_core::{Plan, Task, TaskId};
use wecode_org::Company;
use wecode_store::Store;

use crate::{git, notify, work};

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

/// How long a teardown command gets before the supervisor kills it.
///
/// A default the caller passes in rather than a limit read here, so the figure can come
/// from a task or a playbook later without this module changing — and so the tests can
/// hold a `sleep` to a fraction of a second.
///
/// Five minutes because of what the command is: a destroy call against an account,
/// waiting on somebody else's control plane. A minute is short enough to kill a stack
/// that is genuinely being deleted, and an hour is not a limit — the seat is held for the
/// whole of it, after the agent's own clock has already run out.
#[allow(dead_code, reason = "the call site in commands::exec is out of this task's scope")]
pub(crate) const HOOK_WALL: Duration = Duration::from_secs(300);

/// What became of the command a run was told to tear its resources down with.
///
/// The command line is carried on it rather than left with the caller, because every
/// unhappy outcome here ends with a person running that line themselves and the report
/// has to be able to quote it. Where it ran is not carried: the run report names the
/// directory two lines above this one.
pub(crate) struct Undone {
    cmd: String,
    how: How,
}

/// How a teardown command ended, in the distinctions that change what an operator does
/// next: raise the limit, read an error, look at the console, or nothing at all.
enum How {
    /// Exited 0. The only outcome that says the resources are gone.
    Released { took: Duration },
    /// Ran and failed. `-1` is a death by signal — no exit status on Unix is negative,
    /// so the two cannot be confused — and it reads differently enough to be worth
    /// saying: a killed destroy was interrupted, not refused.
    Failed { status: i32, took: Duration },
    /// Still running when its clock ran out, and killed.
    Killed { after: Duration },
    /// Never got as far as running. Nothing was released, and there is no exit code to
    /// read — the loudest of them, because every other outcome at least tried.
    Unstarted { why: String },
    /// It started, and the supervisor then lost the ability to say how it ended. Only
    /// reachable if something else reaps the child; kept apart from the rest because
    /// "may have worked" is not "failed", and reporting it as either would be a claim
    /// nothing here can support.
    Lost { why: String },
}

impl Undone {
    /// Whether the resources are gone.
    ///
    /// Only a clean exit says so, and everything else — including the almost-impossible
    /// [`How::Lost`] — is treated as a leak. The asymmetry is deliberate: a leak reported
    /// as released costs money quietly until somebody opens a console, and a release
    /// reported as a leak costs one look.
    #[allow(dead_code, reason = "the call site in commands::exec is out of this task's scope")]
    pub(crate) fn ok(&self) -> bool {
        matches!(self.how, How::Released { .. })
    }
}

/// Why this teardown line may not be run at all, if it may not.
///
/// Asked **before the agent starts**, which is the whole point of it being a separate
/// function from [`after_agent`]. A line the charter forbids, discovered after the run,
/// is discovered at the one moment nothing can be done with the answer: the resources
/// exist by then, and refusing to take them down is not a safety property.
///
/// Checked at all because of where the line comes from. Acceptance is committed to the
/// repository and a notify hook is in `company.toml`, both written by an operator; this
/// arrives on a command line, and dispatching is something a delegating agent can hold a
/// grant for. Same check the notify hook gets, on the least trustworthy of the three.
#[allow(dead_code, reason = "the call site in commands::exec is out of this task's scope")]
pub(crate) fn forbidden(company: &Company, cmd: Option<&str>) -> Option<String> {
    let cmd = cmd?;
    let pattern = crate::commands::exec::forbidden_by_charter(company, cmd)?;
    Some(format!(
        "--teardown `{cmd}` is forbidden by the charter: never_run {pattern}"
    ))
}

/// Runs the teardown command, once the agent is gone.
///
/// `cmd` is the `Option` itself and not an unwrapped line, so the call site is one
/// unconditional statement with no `if` of its own for a later reader to hang
/// `outcome.ended.ok()` off. `None` in, `None` out, and a run that declared no teardown
/// says nothing about one.
///
/// Through `sh -c`, like acceptance and like the notify hook: what somebody writes here
/// is a shell line — a `&&`, a redirect, a `|| true` — and not an argv this could split.
///
/// In the task's own worktree, because the useful teardown line is a script in the
/// repository the task was working on. A tree that is not there is [`How::Unstarted`]
/// rather than an error: it means the command could not have run, which is a thing the
/// report has to say rather than a thing the supervisor should abort on.
///
/// `env` is what the command authenticates with, laid over the inherited environment.
/// Inherited, unlike an agent's and like acceptance: this is wecode's own command, run on
/// the operator's behalf, and it needs the `terraform` and `aws` on the operator's `PATH`.
/// The declared pairs win over anything of the same name that was already there, so a
/// credential resolved for this run beats whatever the shell was carrying.
///
/// Its output is left to stream to wecode's own streams rather than captured. Nothing
/// else is printing at this moment — the agent has exited and the verdict has not run —
/// so there is nothing for it to interleave with, and a destroy call's own account of
/// what it could not delete is worth more than any line this module could write about it.
///
/// Never a `Result`, and that is a decision rather than a simplification: `?` at the call
/// site would turn every failed teardown into an early return, skipping the report on the
/// one path where the report is the only thing that says the resources are still there.
#[must_use = "a teardown nobody reports is a leak nobody hears about"]
#[allow(dead_code, reason = "the call site in commands::exec is out of this task's scope")]
pub(crate) fn after_agent(
    cmd: Option<&str>,
    task: &TaskId,
    dir: &Path,
    env: &[(String, String)],
    limit: Duration,
) -> Option<Undone> {
    let cmd = cmd?;
    let undone = |how| {
        Some(Undone {
            cmd: cmd.to_string(),
            how,
        })
    };
    if !dir.is_dir() {
        return undone(How::Unstarted {
            why: format!("{} is not there to run it in", dir.display()),
        });
    }

    let started = Instant::now();
    let spawned = Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .current_dir(dir)
        .envs(env.iter().map(|(k, v)| (k, v)))
        // The two the notify hooks already speak, so a teardown line is written in a
        // vocabulary an operator of this workspace has seen. The task id earns its place
        // twice over: it is how a line that *stood something up* and the line that takes
        // it down agree on which stack they mean, without either of them hard-coding a
        // name that two concurrent runs would then share.
        //
        // After the declared pairs and not before: these two are facts about the run
        // wecode observed, and a caller is not offered the chance to say otherwise.
        .env("WECODE_TASK", task.as_str())
        .env("WECODE_WORKTREE", dir)
        // Nothing to read, and no terminal to read it from — this runs after the agent
        // in a supervisor nobody is necessarily watching. A teardown that prompted would
        // otherwise hang until its clock killed it.
        .stdin(Stdio::null())
        // Deliberately not told how the run ended. A script handed that would sooner or
        // later use it, and "clean up only when the agent succeeded" is the exact bug
        // this hook exists because of.
        .spawn();

    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return undone(How::Unstarted { why: e.to_string() }),
    };
    // The same bounded wait the notify hook and the Telegram fetch are held to — one
    // implementation, so a limit that side has cannot go missing from this one. It
    // signals the command and not its group, which is the bargain that side already
    // struck: a destroy call that backgrounded work of its own has decided to outlive
    // its own exit. Nothing below depends on the kill having finished the job — a
    // killed teardown is reported as a leak, and a grandchild that goes on to succeed
    // is a happy accident rather than the plan.
    match notify::wait_for(&mut child, limit) {
        Ok(Some(0)) => undone(How::Released {
            took: started.elapsed(),
        }),
        Ok(Some(status)) => undone(How::Failed {
            status,
            took: started.elapsed(),
        }),
        Ok(None) => undone(How::Killed { after: limit }),
        Err(why) => undone(How::Lost { why }),
    }
}

/// The line a run says about the resources it was told to release.
///
/// One line on the way past and two when it did not work, and both go in the run report
/// beside `took` and `spent` — a consequence of the run rather than a topic of its own.
/// Nothing at all for a run that declared no teardown, for the reason [`teardown_line`]
/// says nothing about a worktree that never existed.
#[must_use]
#[allow(dead_code, reason = "the call site in commands::exec is out of this task's scope")]
pub(crate) fn undone_line(u: Option<&Undone>) -> String {
    let Some(u) = u else {
        return String::new();
    };
    let cmd = &u.cmd;
    match &u.how {
        How::Released { took } => {
            format!("  teardown ✓ `{cmd}` released it in {}s\n", took.as_secs())
        }
        // A signal, not a status: see [`How::Failed`] on why the two cannot collide.
        How::Failed { status: -1, took } => {
            leak(&format!("`{cmd}` was killed after {}s", took.as_secs()))
        }
        How::Failed { status, took } => {
            leak(&format!("`{cmd}` exited {status} after {}s", took.as_secs()))
        }
        How::Killed { after } => leak(&format!(
            "`{cmd}` was still running after {}s and was stopped",
            after.as_secs()
        )),
        How::Unstarted { why } => leak(&format!("`{cmd}` never ran — {why}")),
        How::Lost { why } => leak(&format!("`{cmd}` ran, and how it ended is unknown — {why}")),
    }
}

/// A teardown that did not finish, and what that costs.
///
/// The second line is the whole value of the first. `teardown ✗ exited 1` reads as a
/// tidy-up that did not tidy up, which is a shrug; what actually happened is that
/// something is still running in an account somebody pays for, and the only person who
/// can end that is the one reading this.
fn leak(what: &str) -> String {
    format!(
        "  teardown ✗ {what}\n    \
         whatever this run stood up is likely still standing — and still billing\n"
    )
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

    // ---- the teardown a run's own resources get -------------------------------

    /// A scratch worktree for a teardown to run in.
    fn tree(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wecode-teardown-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    /// The hook as a run calls it. A real `sh` and a real process, because a stand-in
    /// would test this module against its own idea of how a command ends.
    fn hook(cmd: &str, dir: &Path) -> Option<Undone> {
        after_agent(
            Some(cmd),
            &TaskId::new("feat"),
            dir,
            &[],
            Duration::from_secs(30),
        )
    }

    #[test]
    fn a_run_that_declared_no_teardown_runs_nothing_and_says_nothing() {
        let nothing = after_agent(
            None,
            &TaskId::new("feat"),
            &tree("unasked"),
            &[],
            Duration::from_secs(30),
        );
        assert!(nothing.is_none());
        assert_eq!(undone_line(nothing.as_ref()), "");
    }

    #[test]
    fn a_teardown_that_worked_says_so_and_says_it_once() {
        let u = hook("true", &tree("clean")).expect("a teardown was asked for");
        assert!(u.ok());
        let line = undone_line(Some(&u));
        assert!(line.starts_with("  teardown ✓ `true` released it in"), "{line}");
        assert_eq!(line.lines().count(), 1, "nothing to warn about: {line}");
    }

    #[test]
    fn it_runs_in_the_worktree_the_task_worked_in() {
        // The useful teardown line is a script in the repository the task was working
        // on, so a relative path has to resolve there and nowhere else.
        let dir = tree("cwd");
        std::fs::write(dir.join("cloud-down.sh"), "#!/bin/sh\n").expect("a script to find");
        assert!(hook("test -f cloud-down.sh", &dir).expect("asked for").ok());
    }

    #[test]
    fn a_failed_teardown_names_the_exit_code_and_what_it_costs() {
        let u = hook("exit 2", &tree("failed")).expect("asked for");
        assert!(!u.ok(), "nothing was released");
        let line = undone_line(Some(&u));
        assert!(line.contains("✗ `exit 2` exited 2 after"), "{line}");
        // The second line is the point of the first: `exited 2` alone reads as a
        // tidy-up that did not tidy up, which is a shrug.
        assert!(line.contains("still standing — and still billing"), "{line}");
    }

    #[test]
    fn a_teardown_killed_by_a_signal_reads_as_interrupted_rather_than_refused() {
        // No exit status is negative, which is what makes the sentinel unambiguous.
        let u = hook("kill -TERM $$", &tree("signalled")).expect("asked for");
        assert!(matches!(u.how, How::Failed { status: -1, .. }), "signalled");
        let line = undone_line(Some(&u));
        assert!(line.contains("`kill -TERM $$` was killed after"), "{line}");
        assert!(!line.contains("exited -1"), "not an exit status: {line}");
    }

    #[test]
    fn a_teardown_that_hangs_is_stopped_on_its_own_clock() {
        // The agent's limits have already expired by now, so this is the only thing
        // between a stalled destroy call and a seat held open indefinitely.
        let started = Instant::now();
        let u = after_agent(
            Some("sleep 30"),
            &TaskId::new("feat"),
            &tree("hung"),
            &[],
            Duration::from_millis(300),
        )
        .expect("asked for");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "stopped promptly: {:?}",
            started.elapsed()
        );
        assert!(!u.ok());
        let line = undone_line(Some(&u));
        assert!(line.contains("still running after 0s and was stopped"), "{line}");
        assert!(line.contains("still billing"), "{line}");
    }

    #[test]
    fn what_the_destroy_call_authenticates_with_reaches_it_and_the_toolchain_does_too() {
        // Both halves of the bargain: the credential is wecode's to inject, and the
        // `terraform` on the operator's PATH is theirs — this command is run on their
        // behalf, unlike an agent's, whose environment is built from nothing.
        let dir = tree("env");
        let env = [("CLOUD_TOKEN".to_string(), "shhh".to_string())];
        let u = after_agent(
            Some("test \"$CLOUD_TOKEN\" = shhh && test -n \"$PATH\""),
            &TaskId::new("feat"),
            &dir,
            &env,
            Duration::from_secs(30),
        )
        .expect("asked for");
        assert!(u.ok(), "{}", undone_line(Some(&u)));
    }

    #[test]
    fn a_credential_resolved_for_this_run_outranks_an_inherited_one() {
        // Otherwise the ambient value wins and the run authenticates as whoever the
        // operator's shell was. `HOME` stands in for a credential variable because it is
        // the one this process is guaranteed to have inherited.
        let env = [("HOME".to_string(), "/tmp/declared-wins".to_string())];
        let u = after_agent(
            Some("test \"$HOME\" = /tmp/declared-wins"),
            &TaskId::new("feat"),
            &tree("override"),
            &env,
            Duration::from_secs(30),
        )
        .expect("asked for");
        assert!(u.ok(), "{}", undone_line(Some(&u)));
    }

    #[test]
    fn the_command_is_told_which_task_and_where() {
        // How a line that stood something up and the line that takes it down agree on
        // which stack they mean, without either hard-coding a name two runs would share.
        let dir = tree("named");
        let cmd = format!(
            "test \"$WECODE_TASK\" = feat && test \"$WECODE_WORKTREE\" = {}",
            dir.display()
        );
        let u = after_agent(
            Some(&cmd),
            &TaskId::new("feat"),
            &dir,
            &[],
            Duration::from_secs(30),
        )
        .expect("asked for");
        assert!(u.ok(), "{}", undone_line(Some(&u)));
    }

    #[test]
    fn a_teardown_with_nowhere_to_run_reports_that_nothing_was_released() {
        // Not an error: that the command could not have run is a thing the report has to
        // say, and a supervisor that aborted here would say nothing at all.
        let u = hook("scripts/cloud-down.sh", Path::new("/run/cws/never-existed"))
            .expect("asked for");
        assert!(!u.ok());
        let line = undone_line(Some(&u));
        assert!(line.contains("never ran — /run/cws/never-existed"), "{line}");
        assert!(line.contains("still billing"), "{line}");
    }

    #[test]
    fn a_teardown_line_the_charter_forbids_is_refused_before_the_agent_starts() {
        // After the run the answer is useless: the resources exist by then, and refusing
        // to take them down is not a safety property.
        let company = Company::parse(
            "[company]\nname = \"cws\"\n\
             \n[invariants]\nnever_run = [\"terraform apply*\"]\n",
        )
        .expect("the profile parses");

        let refused = forbidden(&company, Some("terraform apply -auto-approve"))
            .expect("the charter forbids it");
        assert!(refused.contains("never_run terraform apply*"), "{refused}");
        // The destroy half is not the forbidden half, and a charter that stopped it
        // would forbid every cloud task from cleaning up after itself.
        assert!(
            forbidden(&company, Some("terraform destroy -auto-approve")).is_none(),
            "destroy is what this hook is for"
        );
        assert!(forbidden(&company, None).is_none(), "nothing to judge");
    }
}
