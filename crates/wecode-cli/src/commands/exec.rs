//! Commands that make work happen: prepare it, run it, judge it, schedule it.
//!
//! The boundary against [`crate::commands::plan`] is deliberate — one module decides
//! what should be true, the other finds out what is.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use wecode_core::{Plan, Task, TaskId, TaskStatus, WORKER_DIR, admission};
use wecode_gov::{Action, ActionKind, Broker, Session, glob};
use wecode_org::{AgentTemplate, Company, Playbook, Workspace};

use wecode_store::{Store, execution::Spend};

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{
    cache, git, handoff, ledger, notify, render, scheduler, spawn, teardown, telegram, verify, work,
};

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
    // task with a worktree works somewhere else, and the handoff still has to be able to
    // read what a predecessor left here — a design asks for no worktree, so this is
    // where its document was written.
    let repo = repo_path(company, project)?;
    let mut cwd = repo.clone();

    if wants_worktree {
        let branch = work::branch_for(&owner.id);
        let path = work::worktree_for(&work::org_name(ws.root()), &owner.id);
        if !git::is_repo(&repo) {
            return Err(format!("{} is not a git repository", repo.display()).into());
        }
        // Where this branch starts. A predecessor's branch when it has one still standing
        // apart, so a dependent task *has* the work it comes after rather than merely
        // being told about it — otherwise every chain touching the same files conflicts
        // at merge, and the task would be building on a base that is missing its
        // groundwork.
        //
        // Falling back to the playbook's integration branch, then to wherever the repo
        // is standing. Guessing a name like "dev" would fail on repos without one. The
        // integration branch is the *first* answer rather than the last for a predecessor
        // that has already landed there — [`predecessor_branch`] says why.
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
        cwd = path;
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
pub(crate) fn unsigned(
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
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(1), "task id")?)?.clone();
    let id = task.id.clone();

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
    let (ws, store, company) = open_full(a)?;
    let cores = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let limit = scheduler::parallelism(company.attention.max_open_items, cores);
    let once = a.has("once");
    // The dispatch gate is the one wait with nothing in the database to be the edge
    // of, so the loop that recomputes it keeps the edge itself. The digest's clock is
    // held here for the same reason: a rhythm has no edge in the database either.
    let mut announced = notify::Announced::default();
    let mut digest = notify::Rhythm::of(&company);

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

        let mut stale = !moves.is_empty();

        // Then the replies, and before anything is dispatched. What a bare `approve`
        // means is read off the task, so this has to come after promotion — a task
        // still recorded as `waiting` has nothing outstanding to sign for, and would be
        // answered with a refusal one second before becoming the thing that was meant.
        // Coming before dispatch is the other half: a signature that arrived on
        // somebody's phone releases work on the pass that finds it, not the one after.
        //
        // Printed only when it did something, unlike the pauses below: this runs every
        // pass whether or not anybody has replied, and a loop that says `nothing to
        // sign` five seconds apart forever is a loop whose output nobody reads.
        if company.telegram.fetch.is_some() {
            match telegram::drain_channel(&ws, &store, &company, false) {
                Ok(report) if report.trim() == "nothing to sign" => {}
                Ok(report) => {
                    print!("{report}");
                    // Signing a design finishes it. Nothing else here changes a status,
                    // but reloading on any report is cheaper than being wrong about
                    // which ones do.
                    stale = true;
                }
                // Reported and stepped over, like a notify hook that failed. A channel
                // that cannot be reached is a reason to keep working unattended, not a
                // reason to stop.
                Err(e) => println!("  ⚠ telegram: {e}"),
            }
        }

        let plan = if stale { store.load_plan()? } else { plan };

        // Nothing new while a person is holding something. More work in flight does
        // not help an unanswered question, and the attention budget is the point.
        let blocked = scheduler::awaiting_a_human(&plan);
        // Asked on every pass and not only on the ones that dispatch: work held behind
        // an unsigned gate is standing in front of the operator either way, and the
        // digest below is one message about all of it.
        let slots = scheduler::free_slots(&plan, limit);
        let (ready, awaiting_a_signature) = triage(&store, &company, &plan, slots)?;
        let gated: Vec<&Task> = awaiting_a_signature
            .iter()
            .filter_map(|id| plan.task(id))
            .collect();

        // The standing condition, on the rhythm `[attention] digest_interval_mins`
        // promises. Every announcement around it fires on an edge and never again; this
        // is what is still waiting an hour later, sent where the operator actually is.
        if digest.due(Instant::now()) {
            print!("{}", notify::on_digest(&company, ws.root(), &blocked, &gated));
        }

        if !blocked.is_empty() {
            // Printed every pass, and announced on none of them: each of these was
            // announced as it stopped, by whatever wrote the status. This is the
            // standing condition, and a notification per tick is a notifier nobody
            // leaves switched on.
            for t in blocked.iter().take(3) {
                println!("  ⏸ {} needs you — {}", t.id, t.status.as_str());
            }
        } else {
            // Named every pass, like the tasks that need an answer: the queue standing
            // still because nobody has signed is the operator's business, and a silent
            // idle loop looks like a loop with nothing to do.
            announced.keep_only(&awaiting_a_signature);
            for id in awaiting_a_signature.iter().take(3) {
                println!("  ⏸ {id} needs your signature — wecode approve admission --task {id}");
            }
            // Announced in full, not just the three that were printed: the list is
            // truncated to keep the log readable, and a notification the operator
            // never gets is not a readability problem.
            for id in &awaiting_a_signature {
                if announced.first_time(id)
                    && let Some(task) = plan.task(id)
                {
                    print!("{}", notify::on_signature_wait(&company, ws.root(), task));
                }
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

/// What one run is held to: the harness's limits, tightened by the budget its task
/// declared — both halves of it.
///
/// A task states a wall. `--wall` writes it, a playbook's default for the kind fills it
/// in, the admission gate refuses a task that declares no budget at all, and `wecode
/// show` prints it back as `wall 60s`. None of that ever reached the process: the only
/// wall a run was held to was the agent template's, one figure in `company.toml` shared
/// by every task that harness runs. A chore given sixty seconds ran to the harness's
/// thirty minutes, and the number on the task was decoration — read by the operator,
/// answered by nobody.
///
/// The **tighter** of the two walls, not the task's outright. The template's wall is the
/// harness's own stop, the backstop under every task whatever its plan says, and a task
/// must not widen its way past it by declaring a longer one. Either may be absent, and
/// then the other is the whole answer.
///
/// The token half was decoration for one turn longer, and for a better reason: a token
/// count is the agent's own report and arrives after the tokens are gone, so no limit
/// can refuse the spend that crosses it. What it can do is refuse the *next* one. The
/// meter is filled while the output streams past — see [`crate::usage`] — so the
/// supervisor already holds a running figure, and a task budgeted at 1000 tokens now
/// stops shortly after 1000 instead of running to whatever the agent felt like. The
/// overrun is still real and still lands on the board in red; what changes is its size.
/// There is no template figure to take the tighter of: a budget is per-task by nature,
/// and a machine-wide token cap would be too small for the large tasks or no cap at all.
///
/// Idle stays the template's. A budget says how long the work may take, not how long the
/// harness may go quiet in the middle of it — different questions, and only the agent's
/// own output stream can answer the second one.
fn limits_for(template: &AgentTemplate, task: &Task) -> spawn::Limits {
    let mut limits = spawn::Limits::from(template);
    if let Some(declared) = task.budget.wall_secs.map(Duration::from_secs) {
        limits.wall = Some(limits.wall.map_or(declared, |cap| cap.min(declared)));
    }
    limits.tokens = task.budget.tokens;
    limits
}

/// Runs a task: prepares it, spawns the agent that holds its post, then judges it.
///
/// The agent is never given a session. The supervisor opens one and records on its
/// behalf — if workers presented session ids, one could present another's and inherit
/// its authority. Presenting nothing removes that class of escalation entirely.
pub(crate) fn run_task(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(1), "task id")?)?.clone();
    let id = task.id.clone();

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
    // Which model, from the seat's declared level rather than from whatever the
    // operator's terminal last remembered. On the launch line for the same reason the
    // tools are: the ledger records the command as configured, and the most expensive
    // variable in the system should not be the one thing missing from it.
    let model = company.model_for(&post).map(ToString::to_string);
    let launch = spawn::argv(&template, "{{prompt}}", &tools, model.as_deref()).join(" ");

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
    // The harness's clock, tightened by the wall this task declared and `wecode show`
    // has been printing all along.
    let limits = limits_for(&template, &task);
    let outcome = spawn::run(
        &template,
        &prepared.envelope,
        &tools,
        model.as_deref(),
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

    let mut out = spawn::ran(
        &task,
        &post,
        model.as_deref(),
        &prepared.cwd,
        limits,
        &outcome,
    );
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
            spend_of(&outcome),
        )?;
        out.push_str(&verdict);
        out.push_str(&commit_attempt(&store, &id, &prepared.cwd, &outcome)?);
    } else {
        store.set_task_status(&id, TaskStatus::Failed)?;
        store.finish_execution(
            exec,
            match outcome.ended {
                // Stopped from outside, whichever limit did it: the agent did not decide
                // to end, so none of these is a failure it reported.
                spawn::Ended::Wall
                | spawn::Ended::Idle
                | spawn::Ended::Tokens
                | spawn::Ended::Signalled => wecode_core::ExecutionStatus::Canceled,
                spawn::Ended::Exited(_) => wecode_core::ExecutionStatus::Failed,
            },
            // Why it ended, not only how — the same principle as the rejected branch
            // above, applied to the half of it that had no verdict to borrow one from.
            // `exit 1` is what a crash, a refusal and a machine with no credential on
            // it all look like from outside, and the sentence telling them apart was
            // written by the harness and printed to a terminal nobody was watching.
            // This is the copy that reaches the retry's envelope and the operator's
            // phone. See [`spawn::Outcome::cause`].
            &outcome.cause(),
            spend_of(&outcome),
        )?;
        out.push_str("\n  not verified — the agent did not finish cleanly\n");
        // The other way a run ends in front of a person: no verdict was reached at
        // all. `Running` is what the store held, whatever the loaded copy says — a
        // retry of an already-failed task is a new wait, not a continuing one.
        out.push_str(&notify::on_status_change(
            &company,
            ws.root(),
            &task,
            TaskStatus::Running,
            TaskStatus::Failed,
        ));
        out.push_str(&commit_attempt(&store, &id, &prepared.cwd, &outcome)?);
    }
    Ok(out)
}

/// Both halves of what the run reported, for the row that outlives the terminal.
///
/// The replay used to end here: `spawn::ran` printed it once, on a line the operator
/// may or may not have been looking at, and nothing wrote it down. That was defensible
/// while the figure was only a caveat on the spend — it is not budgeted, so nothing
/// needed to query it. But cache reads are billed, at a tenth of the rate, and a
/// forty-turn conversation replays enough of them to be the larger bill. What was
/// missing was not a budget for it, only a record: `wecode show` can now say which
/// attempt of three was the long conversation, and not just which one added the most.
///
/// Kept in two columns rather than summed, for the reason [`crate::usage`] gives at
/// length: added together they make a number in no unit, and the one it most resembles
/// is the one budgets are checked against.
fn spend_of(outcome: &spawn::Outcome) -> Spend {
    Spend {
        tokens: outcome.spent,
        replayed: outcome.replayed,
    }
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
    let owns_a_branch = owner.id == id && dir.starts_with(work::run_root());
    let next = if !v.passed() {
        TaskStatus::Failed
    } else if task.kind.needs_a_signature() || owns_a_branch {
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

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Project};

    /// git, insisting it worked. A real repository is the only way to ask the question
    /// these tests are about — git is a subprocess here, so a fake would test itself.
    fn git_in(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repository where `first` did its work on `wecode/first`, and `main` is the
    /// integration branch. When `merged`, that branch landed the way `wecode merge`
    /// lands one — `--no-ff`, subject `<task>: <title>` — and `main` then moved on,
    /// which is what leaves the branch standing behind it.
    fn chain_repo(name: &str, merged: bool) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wecode-exec-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for argv in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["commit", "-qm", "start", "--allow-empty"],
            &["checkout", "-q", "-b", "wecode/first"],
            &["commit", "-qm", "first: attempt 1", "--allow-empty"],
            &["checkout", "-q", "main"],
        ] {
            git_in(&dir, argv);
        }
        if merged {
            let msg = "first: lay the groundwork";
            git_in(&dir, &["merge", "-q", "--no-ff", "-m", msg, "wecode/first"]);
            // What makes the branch stale rather than merely redundant.
            git_in(&dir, &["commit", "-qm", "other: alongside", "--allow-empty"]);
        }
        dir
    }

    /// `second` after a done `first`, which is the whole graph these tests need.
    fn chain() -> (Plan, Task) {
        let mut plan = Plan::new();
        plan.add_project(Project::new("caching", "cache things", "app"))
            .unwrap();
        let mut first = Task::new("first", "caching", "lay the groundwork");
        first.status = TaskStatus::Done;
        plan.add_task(first).unwrap();
        let second = Task::new("second", "caching", "build on the groundwork").after("first");
        plan.add_task(second.clone()).unwrap();
        (plan, second)
    }

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

    /// A harness with whatever clock the test is about.
    fn harness(wall: Option<u64>, idle: Option<u64>) -> AgentTemplate {
        AgentTemplate {
            command: "sh".to_string(),
            protocol: String::new(),
            args: vec![],
            env_allowlist: vec![],
            wall_secs: wall,
            idle_secs: idle,
            models: vec![],
            model_flag: "--model".to_string(),
        }
    }

    fn budgeted(wall: Option<u64>) -> Task {
        Task::new("t", "caching", "append a marker comment to the source").budgeted(Budget {
            tokens: Some(1000),
            wall_secs: wall,
        })
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

    #[test]
    fn a_task_is_held_to_the_wall_it_declared() {
        // The whole defect: this number was printed by `wecode show` and enforced by
        // nothing, so a task budgeted at a minute ran to the harness's half hour.
        let l = limits_for(&harness(Some(1800), Some(300)), &budgeted(Some(60)));
        assert_eq!(l.wall, Some(Duration::from_secs(60)));
        // And only the wall: a budget has nothing to say about silence.
        assert_eq!(l.idle, Some(Duration::from_secs(300)));
    }

    #[test]
    fn a_task_cannot_declare_its_way_past_the_harnesss_wall() {
        // The tighter of the two, in both directions. The template's wall is the stop
        // under every run this harness makes, and a budget is not a way to lift it.
        let l = limits_for(&harness(Some(600), None), &budgeted(Some(5400)));
        assert_eq!(l.wall, Some(Duration::from_secs(600)));
    }

    #[test]
    fn a_task_is_held_to_the_tokens_it_was_budgeted() {
        // The other half of the same defect: the figure the admission gate demanded and
        // the board coloured rows against never reached the run it was written for.
        let l = limits_for(&harness(Some(1800), Some(300)), &budgeted(Some(60)));
        assert_eq!(l.tokens, Some(1000));
    }

    #[test]
    fn a_budget_with_no_token_figure_caps_no_spend() {
        // Nothing invented from the harness's clocks: a template declares no budget,
        // and a task that names only a wall is asking to be held to a wall.
        let t =
            Task::new("t", "caching", "append a marker comment to the source").budgeted(Budget {
                tokens: None,
                wall_secs: Some(60),
            });
        assert_eq!(limits_for(&harness(Some(1800), Some(300)), &t).tokens, None);
    }

    #[test]
    fn either_wall_alone_is_the_whole_answer() {
        // A harness with no clock is held to the task's...
        let l = limits_for(&harness(None, Some(300)), &budgeted(Some(90)));
        assert_eq!(l.wall, Some(Duration::from_secs(90)));

        // ...and a task budgeted in tokens alone is held to the harness's, which is
        // what every task got before this and is still right when there is nothing
        // tighter to apply.
        let l = limits_for(&harness(Some(1800), Some(300)), &budgeted(None));
        assert_eq!(l.wall, Some(Duration::from_secs(1800)));

        // Neither declares one: nothing to enforce, and no invented limit either.
        let l = limits_for(&harness(None, None), &budgeted(None));
        assert_eq!(l.wall, None);
    }
}
