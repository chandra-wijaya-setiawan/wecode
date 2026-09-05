//! Running the work: the background loop, one run's supervisor, and the limits it holds.

use std::time::{Duration, Instant};

use wecode_core::{Task, TaskId, TaskStatus};
use wecode_gov::{Action, Broker, Session};
use wecode_org::AgentTemplate;
use wecode_store::execution::Spend;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::claim::{self, Claim};
use crate::{notify, scheduler, spawn, telegram};

use super::judge::{commit_attempt, judge};
use super::prepare::prepare;
use super::queue::{on_promotion, slots_free, triage};
use super::{forbidden_by_charter, indent};

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
    // The same claim `run` takes, before the same preparation, because the two are one
    // door: a tree reset under a running agent does not care which of them reset it.
    let claim = Claim::take(&store, &task, &runs)?;
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
    // The operator has it now, and nothing after this can fail in a way that means they
    // do not.
    claim.kept();

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

/// One run this loop is carrying: the task it holds, and the thread that supervises it.
///
/// The thread is transport and never the record. What identifies the run is the
/// `task_executions` row [`run_task`] opens before the agent starts — attempt, pid,
/// worktree, beat — on disk, and enumerable by `wecode board` from another terminal
/// while it is in flight. This handle says only which task this process is carrying, so
/// losing it to a crash costs the carrying and nothing else: the row is already written,
/// and [`claim::sweep`] closes the ones whose beat stopped. docs/design/concurrency.md
/// forbids the other arrangement, where a thread's own stack is all there is.
struct Dispatch<'s> {
    task: TaskId,
    thread: std::thread::ScopedJoinHandle<'s, Result<String, String>>,
}

/// The dispatches that have finished: reported, and taken out of `live`.
///
/// A pass takes only what is already done, which is what keeps the cycle turning while
/// agents work — the sweep, the promotions and the replies all happen beside runs in
/// flight rather than after them. `wait` is `--once`, where a single pass still owes a
/// verdict for what it started and so joins instead of stepping over.
///
/// Whole reports rather than a stream: several agents' output interleaved on one
/// terminal is output nobody can attribute. `▶` goes out, `◀` comes back.
fn reap(live: &mut Vec<Dispatch<'_>>, wait: bool) -> String {
    let (mut out, mut still) = (String::new(), Vec::new());
    for d in std::mem::take(live) {
        if !wait && !d.thread.is_finished() {
            still.push(d);
            continue;
        }
        let Dispatch { task, thread } = d;
        out.push_str(&format!("  ◀ {task}\n"));
        out.push_str(&match thread.join() {
            Ok(Ok(report)) => format!("{}\n", indent(&report)),
            Ok(Err(e)) => format!("    error: {e}\n"),
            // A panicking supervisor is a bug in wecode, not a verdict on the task, so
            // nothing here writes one: the row stays open and the sweep closes it, the
            // same way it closes a supervisor that was killed.
            Err(_) => format!("    error: supervisor panicked — {task} left to the sweep\n"),
        });
    }
    *live = still;
    out
}

/// The background loop: sweep, tick, then dispatch as widely as the attention budget
/// allows, forever.
///
/// Two passes per cycle, kept separate. Promotion is a record of work becoming
/// startable; dispatch is a record of it being started. Collapsing them would lose
/// the first, and it is the one that explains why the second happened.
///
/// Dispatch does not hold the cycle. Every run gets a supervisor of its own and the
/// pass goes on, so the next one sweeps, promotes, reads replies and tops the width back
/// up while agents are still working. That is what makes `[attention] max_open_items`
/// the number of agents at once rather than the number the loop may start and then wait
/// out one at a time — drained serially, a five in the config bought one agent.
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
    // The sweep's memory, in the process rather than the database — which is also why
    // only the loop sweeps: a one-shot pass was not there for the silence it would judge.
    let mut suspects = scheduler::Suspects::new(claim::CONFIRM);

    println!(
        "  watching {} · {limit} at a time ({} open items, {cores} cores)\n  ctrl-c to stop\n",
        company.name, company.attention.max_open_items
    );

    // Scoped, so no supervisor can outlive the loop accountable for it: every thread
    // still standing is joined before `serve` returns, whichever way it returns.
    // Nothing is detached, and there is no `'static` handle nobody holds.
    std::thread::scope(|threads| -> Res {
        let mut live: Vec<Dispatch<'_>> = Vec::new();
        loop {
            // The verdicts that landed while the loop slept, before anything reads a
            // slot count: a finished supervisor still in `live` holds a slot nothing can
            // use.
            print!("{}", reap(&mut live, false));

            // The sweep before promotion, so the queue is honest before anything is
            // taken from it: a run whose supervisor is gone holds a slot until its row
            // closes. Reported and stepped over on error, like the reply channel below
            // — the loop keeps working unattended.
            match claim::sweep(a, &ws, &store, &company, &mut suspects) {
                Ok(swept) => print!("{swept}"),
                Err(e) => println!("  ⚠ sweep: {e}"),
            }

            let plan = store.load_plan()?;

            // Promotion first, and recorded, so the queue is honest before anything is
            // taken from it.
            let moves = scheduler::transitions(&plan);
            for m in &moves {
                store.set_task_status(&m.task, m.to)?;
                println!("  {}  {} → {}", m.task, m.from.as_str(), m.to.as_str());
                // The loop announces its own promotions, which is what makes the claim
                // below — that everything in `blocked` was announced by whatever wrote
                // its status — true of a manual task as well. It was not: the tick wrote
                // that status and said nothing, so the one wait whose message is the
                // work itself was the only wait nobody was told about.
                print!("{}", on_promotion(&company, ws.root(), &plan, m));
            }

            let mut stale = !moves.is_empty();

            // Then the replies, and before anything is dispatched. What a bare `approve`
            // means is read off the task, so this has to come after promotion — a task
            // still recorded as `waiting` has nothing outstanding to sign for, and would
            // be answered with a refusal one second before becoming the thing that was
            // meant. Coming before dispatch is the other half: a signature that arrived
            // on somebody's phone releases work on the pass that finds it, not the next.
            //
            // Printed only when it did something, unlike the pauses below: this runs
            // every pass whether or not anybody has replied, and a loop that says
            // `nothing to sign` five seconds apart forever is a loop nobody reads.
            if company.telegram.fetch.is_some() {
                match telegram::drain_channel(&ws, &store, &company, false) {
                    Ok(report) if report.trim() == "nothing to sign" => {}
                    Ok(report) => {
                        print!("{report}");
                        // Signing a design finishes it. Nothing else here changes a
                        // status, but reloading on any report is cheaper than being
                        // wrong about which ones do.
                        stale = true;
                    }
                    // Reported and stepped over, like a notify hook that failed. A
                    // channel that cannot be reached is a reason to keep working
                    // unattended, not a reason to stop.
                    Err(e) => println!("  ⚠ telegram: {e}"),
                }
            }

            let plan = if stale { store.load_plan()? } else { plan };

            // Named and carried in the digest, and no more than that: work stopped on a
            // person is in front of them either way, and holding the queue behind it
            // starved everything unrelated to it.
            let blocked = scheduler::awaiting_a_human(&plan);
            // Asked on every pass and not only on the ones that dispatch: work held
            // behind an unsigned gate is standing in front of the operator either way,
            // and the digest below is one message about all of it. The width is asked of
            // the plan *and* of what this loop is carrying — see [`slots_free`].
            let held: Vec<TaskId> = live.iter().map(|d| d.task.clone()).collect();
            let slots = slots_free(&plan, limit, &held);
            let (ready, awaiting_a_signature) = triage(&store, &company, &plan, slots, &held)?;
            let gated: Vec<&Task> = awaiting_a_signature
                .iter()
                .filter_map(|id| plan.task(id))
                .collect();

            // The standing condition, on the rhythm `[attention] digest_interval_mins`
            // promises. Every announcement around it fires on an edge and never again;
            // this is what is still waiting an hour later, sent where the operator is.
            if digest.due(Instant::now()) {
                print!("{}", notify::on_digest(&company, ws.root(), &blocked, &gated));
            }

            for t in blocked.iter().take(3) {
                println!("  ⏸ {} needs you — {}", t.id, t.status.as_str());
            }

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
            // All of them, at once, and the pass waits for none of them. The permit
            // comes before the claim: `slots` above is this pass's whole allowance, and
            // the claim is taken inside the run — a supervisor that took the row first
            // and then queued for a slot would hold a task nothing else could take. One
            // failure touches no other and none of them stops the loop: each report
            // arrives on its own at [`reap`], and the next pass decides again.
            for id in ready {
                println!("  ▶ {id}");
                let args = forward(a, "run", id.as_str());
                live.push(Dispatch {
                    task: id,
                    // A `String`, because `Box<dyn Error>` is not `Send` and the report
                    // has to cross back to the thread that prints.
                    thread: threads.spawn(move || run_task(&args).map_err(|e| e.to_string())),
                });
            }

            if once {
                // One pass, and then the runs it started: a `--once` that returned
                // before its own dispatches had verdicts would report nothing at all
                // about the work it did.
                print!("{}", reap(&mut live, true));
                return Ok(String::new());
            }
            std::thread::sleep(scheduler::INTERVAL);
        }
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
///
/// `[budgets] enforce` decides whether the token half is a ceiling or a reading, and it
/// is off unless the company turned it on. A kill mid-run destroys the work already paid
/// for — the heartbeat build died at 25 lines this way, its schema column merged and its
/// feature absent — while the overrun it prevents lands on the board in red either way.
/// The wall clock is not behind the flag: time is the operator's, tokens are money.
fn limits_for(template: &AgentTemplate, task: &Task, enforce_tokens: bool) -> spawn::Limits {
    let mut limits = spawn::Limits::from(template);
    if let Some(declared) = task.budget.wall_secs.map(Duration::from_secs) {
        limits.wall = Some(limits.wall.map_or(declared, |cap| cap.min(declared)));
    }
    limits.tokens = if enforce_tokens { task.budget.tokens } else { None };
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
    // Before preparation, which is the whole of what makes it a claim — see [`Claim`].
    let claim = Claim::take(&store, &task, &runs)?;
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

    // Opened before the process starts, so a crash leaves a row saying `working`
    // rather than no trace of the run at all.
    let exec = store.start_execution(&id, &who.session, prepared.cwd.to_str(), None)?;
    // The row now claims a live watcher, and the beat keeps that claim true for
    // exactly as long as this process is here to make it — see [`claim::Beat`]. Held
    // to the end of the run, verdict included: the row is open until then.
    let _beat = claim::Beat::start(&store, exec);
    // The harness's clock, tightened by the wall this task declared and `wecode show`
    // has been printing all along.
    let limits = limits_for(&template, &task, company.budgets.enforce);
    let outcome = spawn::run(
        &template,
        &prepared.envelope,
        &tools,
        model.as_deref(),
        &prepared.cwd,
        &prepared.cache,
        limits,
    )?;
    // The agent ran, however it ended. From here the status is this run's to author, so
    // the claim is not something to hand back.
    claim.kept();

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::exec::test_support::{budgeted, harness};
    use wecode_core::Budget;

    #[test]
    fn a_task_is_held_to_the_wall_it_declared() {
        // The whole defect: this number was printed by `wecode show` and enforced by
        // nothing, so a task budgeted at a minute ran to the harness's half hour.
        let l = limits_for(&harness(Some(1800), Some(300)), &budgeted(Some(60)), false);
        assert_eq!(l.wall, Some(Duration::from_secs(60)));
        // And only the wall: a budget has nothing to say about silence.
        assert_eq!(l.idle, Some(Duration::from_secs(300)));
    }

    #[test]
    fn a_task_cannot_declare_its_way_past_the_harnesss_wall() {
        // The tighter of the two, in both directions. The template's wall is the stop
        // under every run this harness makes, and a budget is not a way to lift it.
        let l = limits_for(&harness(Some(600), None), &budgeted(Some(5400)), false);
        assert_eq!(l.wall, Some(Duration::from_secs(600)));
    }

    #[test]
    fn a_task_is_held_to_the_tokens_it_was_budgeted() {
        // The figure reaches the run only under [budgets] enforce: measured always,
        // a kill switch only where the company said so.
        let l = limits_for(&harness(Some(1800), Some(300)), &budgeted(Some(60)), true);
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
        assert_eq!(limits_for(&harness(Some(1800), Some(300)), &t, true).tokens, None);
    }

    #[test]
    fn a_token_budget_stops_a_run_only_where_the_company_said_so() {
        // Off is the default and off means measured, not enforced: the figure still
        // reaches the ledger through the meter, but no run is killed over it.
        let l = limits_for(&harness(Some(1800), Some(300)), &budgeted(Some(60)), false);
        assert_eq!(l.tokens, None);
        let l = limits_for(&harness(Some(1800), Some(300)), &budgeted(Some(60)), true);
        assert_eq!(l.tokens, Some(1000));
    }

    #[test]
    fn either_wall_alone_is_the_whole_answer() {
        // A harness with no clock is held to the task's...
        let l = limits_for(&harness(None, Some(300)), &budgeted(Some(90)), false);
        assert_eq!(l.wall, Some(Duration::from_secs(90)));

        // ...and a task budgeted in tokens alone is held to the harness's, which is
        // what every task got before this and is still right when there is nothing
        // tighter to apply.
        let l = limits_for(&harness(Some(1800), Some(300)), &budgeted(None), false);
        assert_eq!(l.wall, Some(Duration::from_secs(1800)));

        // Neither declares one: nothing to enforce, and no invented limit either.
        let l = limits_for(&harness(None, None), &budgeted(None), false);
        assert_eq!(l.wall, None);
    }
}
