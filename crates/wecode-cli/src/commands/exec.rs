//! Commands that make work happen: prepare it, run it, judge it, schedule it.
//!
//! The boundary against [`crate::commands::plan`] is deliberate — one module decides
//! what should be true, the other finds out what is.

use std::path::PathBuf;

use wecode_core::{Plan, Task, TaskId, TaskStatus, admission};
use wecode_gov::{Action, ActionKind, Broker, Session, glob};
use wecode_org::{Company, Playbook, Workspace};

use wecode_store::Store;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{cache, git, ledger, render, scheduler, spawn, teardown, verify, work};

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
        // Written down after git agreed, and on the reset path as well as the fresh
        // one. A tree standing from before the registry existed is one wecode made and
        // cannot prove; recording it the next time it is prepared is how a workspace
        // that predates this catches up, without backfilling a date nobody observed.
        store.record_worktree(&path.to_string_lossy(), &project.repo, &branch, &owner.id)?;
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

    // After the worktree, because that is what makes the cache worth having: this is
    // the checkout whose `target/` would otherwise start empty. Reported in the notes
    // for the same reason the worktree is — an operator running the task by hand needs
    // the same directories the agent is given, or the two builds do not share one.
    let shared = cache::shared(pb.as_ref());
    cache::ensure(&shared)?;
    for (var, dir) in &shared {
        notes.push_str(&format!("  cache    {var}={}\n", dir.display()));
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
        cache: shared,
        notes,
    })
}

/// Why this task may not be dispatched yet, when its project asks for a signature and
/// the ledger does not hold a current one.
///
/// Returned rather than raised, so the loop can report it as a pause instead of an
/// error: a task waiting for a person is not a failure, and printing it as one sends the
/// operator looking for a bug that is not there.
///
/// A signature older than the last change to the task does not count. `task scope`
/// records a `define`, so widening signed work retracts the signature it was given —
/// otherwise the gate is walked past by signing something small and then changing it.
///
/// A project with no playbook, or one that says nothing, is ungated. The gate is a
/// project's own decision, in the file that describes that project's work.
fn unsigned(
    store: &Store,
    pb: Option<&Playbook>,
    task: &Task,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    if !pb.is_some_and(|p| p.project.dispatch.needs_a_signature()) {
        return Ok(None);
    }
    let id = &task.id;
    let sign = format!("  a holder signs it: wecode approve admission --task {id} --as <post>");
    let signed = ledger::signed_at(store, id, ActionKind::Admission)?;
    let defined = ledger::defined_at(store, id)?;
    Ok(match (signed, defined) {
        (None, _) => Some(format!(
            "{id} has not been signed for — this project dispatches by approval\n\
             {sign}\n  then: wecode run {id}\n"
        )),
        // The signature is on the record and is for a task that no longer exists in
        // that shape. Saying which is the point: "sign it again" without a reason
        // reads as a bug in the gate.
        (Some(s), Some(d)) if s < d => Some(format!(
            "{id} was changed after it was signed — the signature covered the earlier task\n\
             {sign}\n  what changed: wecode audit --task {id}\n"
        )),
        _ => None,
    })
}

/// Splits the queue into what may be dispatched now and what is waiting for a
/// signature.
///
/// The cap is applied *after* the gate rather than before, because an unsigned task must
/// not hold a slot: one of them at the head of the queue would otherwise stall
/// everything behind it for as long as nobody signed.
///
/// A playbook that cannot be read counts as ungated here, and the task goes on to
/// `prepare`, which reads it again and refuses properly. Two accounts of the same broken
/// file would be worse than one, and this is not the place that reports it.
fn triage(
    store: &Store,
    company: &Company,
    plan: &Plan,
    slots: usize,
) -> Result<(Vec<TaskId>, Vec<TaskId>), Box<dyn std::error::Error>> {
    let (mut go, mut waiting) = (Vec::new(), Vec::new());
    if slots == 0 {
        return Ok((go, waiting));
    }
    for t in scheduler::dispatchable(plan, usize::MAX) {
        let pb = plan
            .project(&t.project)
            .and_then(|p| playbook_of(company, p).ok().flatten());
        if unsigned(store, pb.as_ref(), t)?.is_some() {
            waiting.push(t.id.clone());
        } else if go.len() < slots {
            go.push(t.id.clone());
        }
    }
    Ok((go, waiting))
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
    let prepared = prepare(&ws, &store, &company, &plan, &task, &runs)?;

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
            let (ready, awaiting_a_signature) = triage(&store, &company, &plan, slots)?;
            // Named every pass, like the tasks that need an answer: the queue standing
            // still because nobody has signed is the operator's business, and a silent
            // idle loop looks like a loop with nothing to do.
            for id in awaiting_a_signature.iter().take(3) {
                println!("  ⏸ {id} needs your signature — wecode approve admission --task {id}");
            }
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
    let prepared = prepare(&ws, &store, &company, &plan, &task, &runs)?;

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
    let tools = company
        .grant_of(&post)
        .map(spawn::allowed_tools)
        .unwrap_or_default();
    let launch = spawn::argv(&template, "{{prompt}}", &tools).join(" ");

    // Only the charter is consulted here, not the post's `run` grant. That grant says
    // what the *agent* may run while working — `cargo *` for an engineer — and it is
    // handed to the harness as its own allow-list above, so it is enforced there
    // rather than here. Starting the harness is wecode's own action, and
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
    let outcome = spawn::run(
        &template,
        &prepared.envelope,
        &tools,
        &prepared.cwd,
        &prepared.cache,
        limits,
    )?;

    // The exit is a fact we observed, not a claim the agent made. `Allow` even when
    // it exited badly: launching the agent was wecode's own permitted act, and the
    // exit code rides on the line. A denial is authority refusing an action, and a
    // crash is not one — recorded as "denied", it sent the operator into the
    // governance channel after a permissions problem that did not exist.
    let mut broker = Broker::new(company.charter.clone());
    broker.observe(
        &supervisor,
        Action::Run {
            // The configured launch line, not just the binary: `sh` alone says
            // nothing about what was run, and the substituted prompt would bury it.
            argv: vec![format!("{launch} — {}", outcome.ended.describe())],
        },
        wecode_gov::Decision::Allow,
        wecode_gov::Source::Supervisor,
    );
    // What it cost, however it ended: a run killed on its wall limit burned the
    // tokens it burned, and a spend recorded only for clean exits would make the
    // expensive failures the invisible ones.
    //
    // Observed, not authorised — the money is already gone, and a Broker asked to
    // permit it afterwards would be theatre. The provenance is the weaker of the two
    // halves: the clock is ours, but there is nothing between the agent and the model
    // for wecode to count tokens at, so a run that reported one is the harness
    // speaking about itself and the ledger says so.
    broker.observe(
        &supervisor,
        Action::Spend {
            tokens: outcome.spent.unwrap_or(0),
            wall_secs: outcome.took.as_secs(),
        },
        wecode_gov::Decision::Allow,
        match outcome.spent {
            Some(_) => wecode_gov::Source::Harness,
            None => wecode_gov::Source::Supervisor,
        },
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
            outcome.spent,
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
            outcome.spent,
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
            .map(|path| render::WorktreeRow {
                tenant: tenant_of(&plan, &org, &ours, &merge, &path),
                path,
            })
            .collect();
        groups.push(render::RepoTrees {
            repo: repo_name,
            path: repo.to_string_lossy().into_owned(),
            rows,
        });
    }
    Ok(render::worktrees(&groups))
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
) -> render::Tenant {
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
        return render::Tenant::Task {
            id: t.id.to_string(),
            project: t.project.to_string(),
            status: t.status,
        };
    }
    if let Some(w) = ours.iter().find(|w| w.path == path) {
        // Ours, and the task it was made for is gone from the plan. The registry outlives
        // the task deliberately, which is what lets this say whose tree it was.
        return render::Tenant::Orphan {
            task: w.task.clone(),
        };
    }
    if path == merge {
        return render::Tenant::Merge;
    }
    render::Tenant::Stranger
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
        let id = TaskId::new(named);
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
        Aimed {
            repo: Some(repo_path(&company, project)?),
            path: work::worktree_for(&work::org_name(ws.root()), &id),
            branch: Some(work::branch_for(&id)),
        }
    };

    let torn = teardown::take_down(&store, aim.repo.as_deref(), &aim.path, a.has("force"))?;
    let report = render::torn(&aim.path, aim.branch.as_deref(), &torn);
    match torn {
        // A refusal, not a report. The exit code is what stops a script carrying on as
        // though the tree were gone.
        teardown::Torn::Dirty { .. } => Err(report.into()),
        _ => Ok(report),
    }
}
