//! Commands that make work happen: prepare it, run it, judge it, schedule it.
//!
//! The boundary against [`crate::commands::plan`] is deliberate — one module decides
//! what should be true, the other finds out what is.

use std::path::PathBuf;

use wecode_core::{Plan, Task, TaskId, TaskStatus, admission};
use wecode_gov::{Action, Broker, Session, glob};
use wecode_org::{Company, Workspace};

use wecode_store::Store;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{git, render, scheduler, spawn, verify, work};

/// Begins work on a task: prepares the worktree its playbook asks for, marks it
/// running, and prints the envelope for whoever does the work.
/// The branch of the predecessor this task should build on, if it has one.
///
/// The *last* done predecessor by id, and only one: merging several branch points is
/// a real decision — which order, and what to do about a conflict — and guessing at it
/// would be worse than saying so. A task with two predecessors that both changed code
/// wants a merge task between them, which the plan can express.
fn predecessor_branch(repo: &std::path::Path, plan: &Plan, task: &Task) -> Option<String> {
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
        git::branch_exists(repo, &branch).then_some(branch)
    })
}

/// A task made ready to work on: where, and with what instructions.
pub(crate) struct Prepared {
    pub(crate) cwd: PathBuf,
    pub(crate) envelope: String,
    /// The same instruction as the protocol models it. `envelope` is one rendering of
    /// this, so the two cannot describe different work.
    pub(crate) a2a: wecode_a2a::Task,
    /// What preparation did, for the operator to read.
    pub(crate) notes: String,
}

/// Everything both `start` and `run` must do before any work happens.
///
/// One function because they must not drift: a task prepared by hand and a task
/// prepared for an agent have to land in the same directory, on the same branch,
/// with the same instructions.
pub(crate) fn prepare(
    ws: &Workspace,
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
    let defects = admission::check_task(task, plan);
    if !defects.is_empty() {
        return Err(format!(
            "{}\n  a draft cannot be worked on",
            render::admission(&render::task_heading(task), &defects, None)
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

    let project = plan
        .project(&task.project)
        .ok_or_else(|| format!("no such project: {}", task.project))?;
    let pb = playbook_of(company, project)?;

    // The worktree belongs to the main task, so a subtask joins its parent's tree
    // rather than opening a second checkout of the same work.
    let owner = work::owner(plan, &id).expect("task is in the plan");
    let wants_worktree = pb
        .as_ref()
        .and_then(|p| p.for_kind(owner.kind))
        .is_some_and(|k| k.worktree);

    let mut notes = String::new();
    let mut cwd = repo_path(company, project)?;

    if wants_worktree {
        let branch = work::branch_for(&owner.id);
        let path = work::worktree_for(&work::org_name(ws.root()), &owner.id);
        let repo = cwd.clone();
        if !git::is_repo(&repo) {
            return Err(format!("{} is not a git repository", repo.display()).into());
        }
        // Where this branch starts. A predecessor's branch when there is one, so a
        // dependent task *has* the work it comes after rather than merely being told
        // about it — otherwise every chain touching the same files conflicts at merge,
        // and the task would be building on a base that is missing its groundwork.
        //
        // Falling back to the playbook's integration branch, then to wherever the repo
        // is standing. Guessing a name like "dev" would fail on repos without one.
        let base = match predecessor_branch(&repo, plan, task) {
            Some(b) => Some(b),
            None => match pb.as_ref().and_then(|p| p.project.merge_to.clone()) {
                Some(b) => Some(b),
                None => git::current_branch(&repo)?,
            },
        };

        if path.is_dir() {
            git::reset_hard(&path)?;
            notes.push_str(&format!("  worktree {} (reset)\n", path.display()));
        } else {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            git::worktree_add(&repo, &path, &branch, base.as_deref())?;
            notes.push_str(&format!("  worktree {}\n", path.display()));
        }
        notes.push_str(&format!("  branch   {branch}\n"));
        if owner.id != id {
            notes.push_str(&format!("  shared with {} (its main task)\n", owner.id));
        }
        cwd = path;
    } else {
        notes.push_str(&format!(
            "  no worktree — the {} playbook does not ask for one\n  work in {}\n",
            owner.kind.as_str(),
            cwd.display()
        ));
    }

    let a2a = render::a2a_task(
        &company.templates.task_envelope,
        task,
        project,
        plan,
        &cwd,
        runs,
    );
    Ok(Prepared {
        envelope: render::envelope(&a2a),
        a2a,
        cwd,
        notes,
    })
}

/// Begins work on a task by hand: prepares it and hands you the envelope.
///
/// The counterpart to `run`, for when the operator is the worker.
pub(crate) fn start(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let id = TaskId::new(require(a.cmd(1), "task id")?);
    let plan = store.load_plan()?;
    let task = plan
        .task(&id)
        .ok_or_else(|| format!("no such task: {id}"))?
        .clone();

    // The envelope carries what earlier attempts did, so a retry can see its own
    // failure rather than starting blind.
    let runs = store.executions(&id)?;
    let prepared = prepare(&ws, &company, &plan, &task, &runs)?;

    // Starting is staffing: it changes who is expected to act.
    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(task.project.to_string()), Some(id.to_string())),
        &Action::Staff,
        "starting a task",
    )?;
    store.set_task_status(&id, TaskStatus::Running)?;

    // For a caller that speaks the protocol rather than reading prose. The state is
    // `submitted`: prepared, not yet spawned.
    if a.has("json") {
        return Ok(serde_json::to_string_pretty(&prepared.a2a)
            .map_err(|e| format!("cannot render the task as A2A: {e}"))?);
    }

    let mut out = prepared.notes;
    out.push_str(&format!(
        "  status   {} → running\n\n",
        task.status.as_str()
    ));
    out.push_str(&prepared.envelope);
    Ok(out)
}

/// One pass of the scheduler: bring stored statuses in line with the graph.
///
/// Separate from dispatch so it can be run, read and trusted on its own. The loop
/// calls the same function.
pub(crate) fn tick(a: &Args) -> Res {
    let (_, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let moves = scheduler::transitions(&plan);
    if moves.is_empty() {
        return Ok("  nothing to promote\n".to_string());
    }

    // Recorded as observed rather than decided: the scheduler read the graph, it did
    // not choose anything a person could have chosen differently.
    let who = actor(a, &store, &company)?;
    let mut broker = Broker::new(company.charter.clone());
    let mut out = String::new();
    for m in &moves {
        store.set_task_status(&m.task, m.to)?;
        let project = plan.task(&m.task).map(|t| t.project.to_string());
        let session = Session::new(
            who.session.clone(),
            who.post.clone(),
            who.agent.clone(),
            who.effective.clone(),
        )
        .on(project, Some(m.task.to_string()))
        .with_human(who.human.clone());
        broker.observe(
            &session,
            Action::Staff,
            wecode_gov::Decision::Allow,
            wecode_gov::Source::Supervisor,
        );
        out.push_str(&format!(
            "  {}  {} → {}\n",
            m.task,
            m.from.as_str(),
            m.to.as_str()
        ));
    }
    store.append_records(broker.ledger())?;
    Ok(out)
}

/// The background loop: tick, then dispatch, forever.
///
/// Two passes per cycle, kept separate. Promotion is a record of work becoming
/// startable; dispatch is a record of it being started. Collapsing them would lose
/// the first, and it is the one that explains why the second happened.
///
/// Runs in the foreground. Backgrounding is the operator's job — `&`, systemd, a cron
/// entry — because a daemon that forks is a daemon whose logs you cannot find.
pub(crate) fn serve(a: &Args) -> Res {
    let (_, store, company) = open_full(a)?;
    let cores = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let limit = scheduler::parallelism(company.attention.max_open_items, cores);
    let once = a.has("once");

    println!(
        "  watching {} · {limit} at a time ({} open items, {cores} cores)\n  ctrl-c to stop\n",
        company.name, company.attention.max_open_items
    );

    loop {
        let plan = store.load_plan()?;

        // Promotion first, and recorded, so the queue is honest before anything is
        // taken from it.
        let moves = scheduler::transitions(&plan);
        for m in &moves {
            store.set_task_status(&m.task, m.to)?;
            println!("  {}  {} → {}", m.task, m.from.as_str(), m.to.as_str());
        }

        let plan = if moves.is_empty() {
            plan
        } else {
            store.load_plan()?
        };

        // Nothing new while a person is holding something. More work in flight does
        // not help an unanswered question, and the attention budget is the point.
        let blocked = scheduler::awaiting_a_human(&plan);
        if !blocked.is_empty() {
            for t in blocked.iter().take(3) {
                println!("  ⏸ {} needs you — {}", t.id, t.status.as_str());
            }
        } else {
            let slots = scheduler::free_slots(&plan, limit);
            let ready: Vec<TaskId> = scheduler::dispatchable(&plan, slots)
                .iter()
                .map(|t| t.id.clone())
                .collect();
            for id in ready {
                println!("  ▶ {id}");
                // Serially, and one failure does not stop the loop: the next pass
                // sees the new state and decides again.
                match run_task(&forward(a, "run", id.as_str())) {
                    Ok(out) => println!("{}", indent(&out)),
                    Err(e) => println!("    error: {e}"),
                }
            }
        }

        if once {
            return Ok(String::new());
        }
        std::thread::sleep(scheduler::INTERVAL);
    }
}

pub(crate) fn indent(s: &str) -> String {
    s.lines()
        .map(|l| format!("    {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The `never_run` pattern a command line matches, if any.
///
/// Invariants outrank every grant, so this is checked even though the launch line is
/// operator-written: a grant that permits an invariant violation is itself the bug,
/// and so is a config that does.
pub(crate) fn forbidden_by_charter(company: &Company, line: &str) -> Option<String> {
    company.charter.invariants.iter().find_map(|inv| match inv {
        wecode_gov::Invariant::NeverRun(patterns) => patterns
            .iter()
            .find(|p| glob::matches(p, line))
            .map(ToString::to_string),
        _ => None,
    })
}

/// Runs a task: prepares it, spawns the agent that holds its post, then judges it.
///
/// The agent is never given a session. The supervisor opens one and records on its
/// behalf — if workers presented session ids, one could present another's and inherit
/// its authority. Presenting nothing removes that class of escalation entirely.
pub(crate) fn run_task(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let id = TaskId::new(require(a.cmd(1), "task id")?);
    let plan = store.load_plan()?;
    let task = plan
        .task(&id)
        .ok_or_else(|| format!("no such task: {id}"))?
        .clone();

    let post_name = task
        .assignee
        .clone()
        .ok_or_else(|| format!("{id} is unassigned — `wecode assign {id} --to <post>`"))?;
    let post = find_post(&company, &post_name)?;
    let template = company
        .agents
        .get(&post.agent)
        .ok_or_else(|| {
            format!(
                "post `{post_name}` names agent `{}`, which has no template",
                post.agent
            )
        })?
        .clone();

    // Prepare exactly as `start` does, so the two cannot drift apart.
    // The envelope carries what earlier attempts did, so a retry can see its own
    // failure rather than starting blind.
    let runs = store.executions(&id)?;
    let prepared = prepare(&ws, &company, &plan, &task, &runs)?;

    let who = actor(a, &store, &company)?;
    let supervisor = Session::new(
        who.session.clone(),
        post_name.clone(),
        post.agent.clone(),
        company.effective(&post),
    )
    .on(Some(task.project.to_string()), Some(id.to_string()))
    .with_human(who.human.clone());

    // The launch line as configured, with `{{prompt}}` left standing. Substituting
    // first would put the whole envelope into the command being judged — kilobytes of
    // task text, matched as if it were an argument.
    let launch = spawn::argv(&template, "{{prompt}}").join(" ");

    // Only the charter is consulted here, not the post's `run` grant. That grant says
    // what the *agent* may run while working — `cargo *` for an engineer — and wecode
    // cannot intercept those anyway. Starting the harness is wecode's own action, and
    // the harness is named in company.toml, which only the operator writes. Judging
    // the launch against the agent's grant would refuse every real configuration:
    // `claude` is not `cargo`.
    if let Some(pattern) = forbidden_by_charter(&company, &launch) {
        return Err(format!(
            "agent `{}` would run `{launch}`, which the charter forbids: never_run {pattern}",
            post.agent
        )
        .into());
    }

    store.set_task_status(&id, TaskStatus::Running)?;
    // Opened before the process starts, so a crash leaves a row saying `working`
    // rather than no trace of the run at all.
    let exec = store.start_execution(&id, &who.session, prepared.cwd.to_str(), None)?;
    let limits = spawn::Limits::from(&template);
    let outcome = spawn::run(&template, &prepared.envelope, &prepared.cwd, limits)?;

    // The exit is a fact we observed, not a claim the agent made.
    let mut broker = Broker::new(company.charter.clone());
    broker.observe(
        &supervisor,
        Action::Run {
            // The configured launch line, not just the binary: `sh` alone says
            // nothing about what was run, and the substituted prompt would bury it.
            argv: vec![format!("{launch} — {}", outcome.ended.describe())],
        },
        if outcome.ended.ok() {
            wecode_gov::Decision::Allow
        } else {
            wecode_gov::Decision::Deny {
                reason: wecode_gov::DenyReason::CommandNotPermitted {
                    argv: outcome.ended.describe(),
                },
                mode: wecode_gov::ControlMode::Sanctioned,
                alarm: false,
            }
        },
        wecode_gov::Source::Supervisor,
    );
    store.append_records(broker.ledger())?;

    let mut out = render::ran(&task, &post, &prepared.cwd, &outcome);
    if outcome.ended.ok() {
        // Verification is the same code path a hand-run task takes, so the two can
        // never disagree about what passing means.
        out.push('\n');
        let (verdict, why) = judge(a)?;
        // `Rejected` rather than `Failed` when the run itself was clean: the agent
        // finished and we declined what it produced. A2A keeps those apart, and so
        // should the record.
        let after = store
            .load_plan()?
            .task(&id)
            .map(|t| t.status)
            .unwrap_or(TaskStatus::Failed);
        store.finish_execution(
            exec,
            if after == TaskStatus::Failed {
                wecode_core::ExecutionStatus::Rejected
            } else {
                wecode_core::ExecutionStatus::Completed
            },
            // Why it was rejected, not how the process exited. A retry reading
            // "exit 0" learns nothing; the failing check is the whole message.
            &why.unwrap_or_else(|| outcome.ended.describe()),
        )?;
        out.push_str(&verdict);
        out.push_str(&commit_attempt(&store, &id, &prepared.cwd, &outcome)?);
    } else {
        store.set_task_status(&id, TaskStatus::Failed)?;
        store.finish_execution(
            exec,
            match outcome.ended {
                spawn::Ended::Wall | spawn::Ended::Idle | spawn::Ended::Signalled => {
                    wecode_core::ExecutionStatus::Canceled
                }
                spawn::Ended::Exited(_) => wecode_core::ExecutionStatus::Failed,
            },
            &outcome.ended.describe(),
        )?;
        out.push_str("\n  not verified — the agent did not finish cleanly\n");
        out.push_str(&commit_attempt(&store, &id, &prepared.cwd, &outcome)?);
    }
    Ok(out)
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
fn commit_attempt(
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
    let message = format!("{id}: attempt {attempt}\n\n{}", outcome.ended.describe());
    Ok(match git::commit_all(cwd, &message)? {
        Some(sha) => format!("  committed {sha} — attempt {attempt}\n"),
        None => "  nothing to commit — the agent changed no files\n".to_string(),
    })
}

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
fn judge(a: &Args) -> Result<(String, Option<String>), Box<dyn std::error::Error>> {
    let (ws, store, company) = open_full(a)?;
    let id = TaskId::new(require(a.cmd(1), "task id")?);
    let plan = store.load_plan()?;
    let task = plan
        .task(&id)
        .ok_or_else(|| format!("no such task: {id}"))?
        .clone();
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

    let mut v = verify::run_acceptance(&dir, &task.acceptance);
    v.changed = git::changed_files(&dir)?;
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
    for c in &v.checks {
        broker.observe(
            &session,
            Action::Run {
                argv: vec![c.cmd.clone()],
            },
            if c.passed() {
                wecode_gov::Decision::Allow
            } else {
                wecode_gov::Decision::Deny {
                    reason: wecode_gov::DenyReason::CommandNotPermitted {
                        argv: format!("{} — {}", c.cmd, c.describe()),
                    },
                    mode: wecode_gov::ControlMode::Sanctioned,
                    alarm: false,
                }
            },
            wecode_gov::Source::Supervisor,
        );
    }
    store.append_records(broker.ledger())?;

    let next = if v.passed() {
        // Passing acceptance is not the same as landed. A task with a worktree has a
        // branch nobody has merged, and merging is a signature wecode does not yet
        // collect — so it waits for a person rather than claiming to be done.
        //
        // A design waits for the same reason with a different cause: the document
        // exists, which is all a command can check, and whether it is the right
        // design is exactly the part no command can. Dependents must not start on the
        // strength of a file being present.
        if task.kind.needs_a_signature() || dir.starts_with(work::run_root()) {
            TaskStatus::NeedsApproval
        } else {
            TaskStatus::Done
        }
    } else {
        TaskStatus::Failed
    };
    store.set_task_status(&id, next)?;

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

    Ok((render::verdict(&task, &dir, &v, next), reason))
}

pub(crate) fn worktree_list(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let org = work::org_name(ws.root());

    let mut rows = Vec::new();
    // `all_projects`: archiving must not make a checkout unreachable. A worktree you
    // cannot see is one you cannot clean up.
    for p in plan.all_projects() {
        let repo = repo_path(&company, p)?;
        if !git::is_repo(&repo) {
            continue;
        }
        for path in git::worktree_list(&repo)? {
            let owned = plan
                .tasks_of(&p.id)
                .find(|t| work::worktree_for(&org, &t.id).to_string_lossy() == path)
                .map(|t| (t.id.to_string(), t.status));
            rows.push((path, p.id.to_string(), owned));
        }
    }
    Ok(render::worktrees(&rows))
}

pub(crate) fn worktree_remove(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let id = TaskId::new(require(a.cmd(2), "task id")?);
    let plan = store.load_plan()?;
    let task = plan
        .task(&id)
        .ok_or_else(|| format!("no such task: {id}"))?;
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
    let path = work::worktree_for(&work::org_name(ws.root()), &id);
    if !path.exists() {
        return Ok(format!("  no worktree at {}\n", path.display()));
    }
    let repo = repo_path(&company, project)?;

    // Uncommitted work in a worktree is unrecoverable once the tree is gone, and
    // nothing has committed it yet — wecode does that, after checks pass.
    let dirty = git::changed_files(&path).unwrap_or_default();
    if !dirty.is_empty() && !a.has("force") {
        let mut msg = format!(
            "{id} has {} uncommitted change{} — removing the worktree would lose them:\n",
            dirty.len(),
            if dirty.len() == 1 { "" } else { "s" }
        );
        for f in dirty.iter().take(10) {
            msg.push_str(&format!("    {f}\n"));
        }
        msg.push_str("  pass --force to discard them");
        return Err(msg.into());
    }

    git::worktree_remove(&repo, &path)?;
    let mut out = format!("  removed {}\n", path.display());
    if !dirty.is_empty() {
        out.push_str(&format!(
            "  discarded {} uncommitted change(s)\n",
            dirty.len()
        ));
    }
    out.push_str(&format!(
        "  branch {} kept — delete it once merged\n",
        work::branch_for(&id)
    ));
    Ok(out)
}
