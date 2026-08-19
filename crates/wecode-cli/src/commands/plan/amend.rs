//! `task scope`, `task budget`, `task add --amend` — re-declaring one field of a task
//! that already exists.
//!
//! Three commands, one shape: read the task, replace exactly what was named, re-run the
//! admission check the original faced, and print what it was beside what it now is. The
//! reason they exist at all is that the way out before them was `task rm` and `task add`
//! again, which stops working at the moment it is wanted — a task that has run is
//! history and refuses to be removed, and a budget, a scope or a grouping is rarely
//! known to be wrong until something has run to prove it.
//!
//! Each is recorded as a `define`, the same capability that created the task, because
//! that is what it is: a signature given to a task budgeted at 100k did not cover the
//! same task at 400k, and the dispatch gate reads the ledger to work that out.
//!
//! What is deliberately not here is acceptance. Amending what counts as done, after
//! seeing what was produced, is how criteria drift to fit the work — so the one field
//! with no amendment command is the one the work is judged by.

use wecode_core::{Budget, Plan, Scope, TaskId, TaskStatus, admission};
use wecode_gov::{Action, WorkKind};

use super::scope_from;
use crate::args::Args;
use crate::commands::ctx::*;
use crate::render;

/// Replaces a task's write and read scope.
///
/// Re-planning, not laundering. The distinction is that the ledger is append-only:
/// widening a scope cannot erase a violation already recorded against the old one.
/// A later `verify` will pass, and the earlier denial stays visible in `audit`.
///
/// Deliberately not offered for acceptance measures. Those are frozen at dispatch —
/// amending what counts as done, after seeing what was produced, is how criteria
/// drift to fit the work.
pub(crate) fn task_scope(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let scope = scope_from(a).ok_or("give at least one --write or --read glob")?;

    let plan = store.load_plan()?;
    let mut task = the_task(&plan, require(a.cmd(2), "task id")?)?.clone();
    let id = task.id.clone();
    let was = task.scope.clone();
    task.scope = scope;

    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(task.project.to_string()), Some(id.to_string())),
        &Action::Define {
            kind: WorkKind::Task,
        },
        "changing a task's scope",
    )?;

    // The new scope faces the same checks the original did — a widened scope that now
    // collides with a sibling is a real conflict, not a formality.
    let mut probe = plan.clone();
    probe.update_task(task.clone())?;
    let gate = plan
        .project(&task.project)
        .map(|p| design_gate(&company, p))
        .unwrap_or_default();
    let mut defects = admission::check_task(&task, &probe, &gate);
    // The one command whose whole subject is the thing a project refuses, so the refusal
    // holds it back exactly as an overlap does. A scope that is widened into paths the
    // project said no to is the case the setting exists for: nothing else in wecode would
    // have asked again between the declaration and the diff.
    defects.extend(super::project::refuses(&company, &plan, &task));
    let blocking: Vec<_> = defects
        .iter()
        .filter(|d| {
            matches!(
                d,
                wecode_core::Defect::ScopeOverlaps { .. } | wecode_core::Defect::ScopeRefused { .. }
            )
        })
        .collect();
    if !blocking.is_empty() && !a.has("force") {
        let mut out = render::plan::admission(&render::plan::task_heading(&task), &defects, None);
        out.push_str("\n  not changed — narrow it, sequence the tasks, or pass --force\n");
        return Ok(out);
    }

    store.save_task(&task)?;
    let show = |s: &Scope| {
        if s.write.is_empty() {
            "nothing".to_string()
        } else {
            s.write.join(", ")
        }
    };
    Ok(format!(
        "  {id} writes\n    was  {}\n    now  {}\n\n  Earlier violations stay in the ledger — `wecode audit --denied --task {id}`\n",
        show(&was),
        show(&task.scope)
    ))
}

/// Changes what a task may spend, on the task that has already run.
///
/// The way out before this was `task rm` and `task add` again, and it stops working at
/// exactly the moment it is wanted: a task that has run is history and refuses to be
/// removed, and a budget is rarely known to be wrong until a run has proved it short.
/// So the extra room came from a new id, and everything recorded against the old one —
/// what it spent, what it was refused, the design signed off on it — stayed behind
/// under a task nobody was looking at.
///
/// The two figures are amended one at a time, unlike a scope, which is replaced whole.
/// An unstated wall is not a wall of zero: it is the agent template's, which is usually
/// far longer, so a `--tokens` raise that quietly dropped the wall would hand the task
/// hours nobody granted it.
///
/// Recorded as a `define`, exactly as [`task_scope`] is, and for the same reason: a
/// signature given to a task budgeted at 100k did not cover the same task at 400k, and
/// the dispatch gate reads the ledger to work that out.
pub(crate) fn task_budget(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let (tokens, wall) = (amount(a, "tokens")?, amount(a, "wall")?);
    if tokens.is_none() && wall.is_none() {
        return Err("give --tokens <n>, --wall <secs>, or both".into());
    }

    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(2), "task id")?)?.clone();
    let id = task.id.clone();
    let was = task.budget;
    // Whichever was not named is carried over rather than defaulted away.
    let now = Budget {
        tokens: tokens.or(was.tokens),
        wall_secs: wall.or(was.wall_secs),
    };

    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(task.project.to_string()), Some(id.to_string())),
        &Action::Define {
            kind: WorkKind::Task,
        },
        "changing a task's budget",
    )?;
    store.set_task_budget(&id, now)?;

    let mut out = format!(
        "  {id} may spend\n    was  {}\n    now  {}\n",
        budget_words(&was),
        budget_words(&now)
    );
    // A run is held to the figures it was dispatched with — they are read once, when
    // the process starts. Silence here would let a raise typed at the worst possible
    // moment read as a rescue of the run in flight.
    match task.status {
        TaskStatus::Running => out.push_str(&format!(
            "\n  {id} is running — a run keeps the figures it started with, so this reaches the next one\n"
        )),
        // The status a budget amendment most often follows, and nothing moves a failed
        // task on its own. Naming the command beats leaving a raised budget on a task
        // that will never be picked up.
        TaskStatus::Failed => out.push_str(&format!(
            "\n  {id} is failed — `wecode status {id} waiting` puts it back in the queue\n"
        )),
        _ => {}
    }
    out.push_str(&format!(
        "\n  What it has already spent stays in the ledger — `wecode audit --task {id}`\n"
    ));

    // Stating a budget is how the commonest defect of all is answered, so the verdict
    // is re-run and reported when anything is still outstanding. Left unsaid, a task
    // still sitting as a draft reads as the change not having taken.
    let mut amended = task;
    amended.budget = now;
    let mut probe = plan.clone();
    probe.update_task(amended.clone())?;
    let gate = plan
        .project(&amended.project)
        .map(|p| design_gate(&company, p))
        .unwrap_or_default();
    let mut defects = admission::check_task(&amended, &probe, &gate);
    // Reported, not blocking: a budget says nothing about paths, so a refusal here is one
    // the task already carried. Leaving it out of a verdict that lists everything else
    // would read as the refusal having been settled by a number.
    defects.extend(super::project::refuses(&company, &plan, &amended));
    if !defects.is_empty() {
        out.push('\n');
        out.push_str(&render::plan::admission(
            &render::plan::task_heading(&amended),
            &defects,
            None,
        ));
    }
    Ok(out)
}

/// Re-declares where a task sits: what it is part of, and what it must come after.
///
/// The two relations are the shape of the plan, and until now neither could be changed
/// once a task existed. The way out was `task rm` and `task add` again, which is refused
/// the moment a task has run — and a grouping is rarely known to be wrong until
/// something in it has run. So work that belonged in a sprint got a new id, and its
/// spend, its refusals and the design signed off on it stayed behind under a task nobody
/// was looking at. An ordering was worse: nothing has ever been able to add one after
/// the fact, so a dependency discovered late meant retyping both tasks.
///
/// Each relation is amended on its own, and an ordering is replaced whole — an unnamed
/// `--parent` leaves the group as it was rather than lifting the task out of it, which
/// is the same rule [`task_budget`] follows and for the same reason: silence is not a
/// value. `--top` and `--no-after` are how the clearing is said out loud.
///
/// Scope and budget have their own commands, and acceptance deliberately has none:
/// amending what counts as done, after seeing what was produced, is how criteria drift
/// to fit the work.
///
/// Recorded as a `define`, exactly as [`task_scope`] and [`task_budget`] are, and here
/// the reason is sharper than either. `parent` decides which worktree the work happens
/// in and which branch it lands on, so a signature given to a task that was going to
/// ship on its own did not cover the same task shipping inside a sprint.
///
/// That same fact is what one of the two refusals is about: a move is refused while it
/// would re-root a task that is running, whether that is the task named or anything
/// beneath it.
pub(crate) fn task_amend(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(2), "task id")?)?.clone();
    let id = task.id.clone();

    let (parent, top) = (a.get("parent"), a.has("top"));
    let (after, no_after) = (a.all("after"), a.has("no-after"));
    if parent.is_some() && top {
        return Err("--parent and --top say opposite things".into());
    }
    if !after.is_empty() && no_after {
        return Err("--after and --no-after say opposite things".into());
    }
    if parent.is_none() && !top && after.is_empty() && !no_after {
        return Err(
            "give --parent <task>, --top, --after <task> (repeatable), or --no-after".into(),
        );
    }

    let mut probe = plan.clone();
    let mut now = task.clone();
    if parent.is_some() || top {
        let to = match parent {
            Some(typed) => Some(the_task(&plan, typed)?.id.clone()),
            None => None,
        };
        now = probe.set_parent(&id, to)?;
    }
    if !after.is_empty() || no_after {
        let mut deps = Vec::with_capacity(after.len());
        for typed in &after {
            deps.push(the_task(&plan, typed)?.id.clone());
        }
        now = probe.set_predecessors(&id, deps)?;
    }

    // A worktree belongs to the root of a chain, so re-parenting a task re-roots
    // everything beneath it too — and a run in flight is never held to the path it was
    // started in: `verify` and teardown ask `work::owner` for the tree again, and a
    // task re-rooted under one nobody cut falls back to judging the project's own
    // checkout rather than the work.
    //
    // Asked as *whose owner changed*, rather than whether the named task is running.
    // A sprint is not itself running when the item inside it is, and the item is the one
    // standing in the checkout. Asking it this way is also the narrower refusal: a move
    // within a chain leaves the root alone, so the tree does not move and neither
    // relation needs to wait for the run.
    let owner_of = |p: &Plan, t: &TaskId| crate::work::owner(p, t).map(|o| o.id.clone());
    let uprooted: Vec<&str> = plan
        .tasks()
        .filter(|t| t.status == TaskStatus::Running)
        .filter(|t| owner_of(&plan, &t.id) != owner_of(&probe, &t.id))
        .map(|t| t.id.as_str())
        .collect();
    if !uprooted.is_empty() {
        return Err(format!(
            "moving {id} would take the worktree out from under a run: {}\n  \
             a run keeps the worktree it started in, and `parent` is what decides which one \
             that is\n{}",
            uprooted.join(", "),
            uprooted
                .iter()
                .map(|r| format!("  `wecode status {r} waiting` first, or wait for it"))
                .collect::<Vec<_>>()
                .join("\n")
        )
        .into());
    }

    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(task.project.to_string()), Some(id.to_string())),
        &Action::Define {
            kind: WorkKind::Task,
        },
        "moving a task in the plan",
    )?;

    // The ordering is part of what makes two overlapping scopes safe, so dropping one
    // can put a collision back that was settled when the tasks were written down. The
    // same check `task scope` re-runs, for the same reason.
    let gate = plan
        .project(&task.project)
        .map(|p| design_gate(&company, p))
        .unwrap_or_default();
    let mut defects = admission::check_task(&now, &probe, &gate);
    // Reported for the reason a budget amendment reports it: a move re-declares where a
    // task sits, not what it writes, so a refusal it draws is one it was already carrying.
    defects.extend(super::project::refuses(&company, &plan, &now));
    if defects
        .iter()
        .any(|d| matches!(d, wecode_core::Defect::ScopeOverlaps { .. }))
        && !a.has("force")
    {
        let mut out = render::plan::admission(&render::plan::task_heading(&now), &defects, None);
        out.push_str("\n  not moved — keep the ordering, narrow a scope, or pass --force\n");
        return Ok(out);
    }
    store.set_task_shape(&id, now.parent.as_ref(), &now.depends_on)?;

    let mut out = format!(
        "  {id} sits\n    was  {}\n    now  {}\n",
        place_words(task.parent.as_ref(), &task.depends_on),
        place_words(now.parent.as_ref(), &now.depends_on)
    );
    // One worktree per main task, subtasks sharing their parent's: a move that changes
    // the root of the chain therefore changes the branch the work lands on, and what
    // earlier attempts committed does not follow it.
    if let Some(to) = owner_of(&probe, &id)
        && owner_of(&plan, &id) != Some(to.clone())
    {
        out.push_str(&format!(
            "\n  {id} now works in {to}'s worktree — wecode/{to}\n"
        ));
        if !store.executions(&id)?.is_empty() {
            out.push_str("  what its earlier runs committed stays on the branch they landed on\n");
        }
    }
    for b in probe.blockers(&id) {
        out.push_str(&format!("  waiting: {}\n", blocker_note(&b)));
    }
    out.push_str(&format!(
        "\n  When it moved is in the ledger — `wecode audit --task {id}`\n"
    ));
    if !defects.is_empty() {
        out.push('\n');
        out.push_str(&render::plan::admission(
            &render::plan::task_heading(&now),
            &defects,
            None,
        ));
    }
    Ok(out)
}

/// `in sprint-2, after keys` — with the empty cases spelled out, because a plan reads
/// `top level` and `after nothing` as facts and a blank as a bug in the renderer.
fn place_words(parent: Option<&TaskId>, after: &[TaskId]) -> String {
    let names: Vec<&str> = after.iter().map(TaskId::as_str).collect();
    format!(
        "{}, after {}",
        parent.map_or_else(|| "top level".to_string(), |p| format!("in {p}")),
        if names.is_empty() {
            "nothing".to_string()
        } else {
            names.join(", ")
        }
    )
}

/// A figure a flag carries, or a refusal naming what was typed.
///
/// [`Args::num`] answers `None` both for a flag nobody passed and for one carrying
/// something that is not a number, and here the two must never read alike: `--tokens
/// 200k` would otherwise leave the budget exactly as it was, under a message saying it
/// had changed.
fn amount(a: &Args, flag: &str) -> Result<Option<u64>, String> {
    if !a.has(flag) {
        return Ok(None);
    }
    match a.get(flag) {
        None => Err(format!("--{flag} wants a number after it")),
        Some(raw) => raw
            .parse()
            .map(Some)
            .map_err(|_| format!("--{flag} wants a number, got `{raw}`")),
    }
}

/// `50000 tokens, 900s wall`, with `—` where nothing is stated — which is not zero: an
/// unstated wall is the agent template's, and an unstated token figure is no cap at all.
fn budget_words(b: &Budget) -> String {
    let stated =
        |v: Option<u64>, unit: &str| v.map_or_else(|| "—".to_string(), |n| format!("{n}{unit}"));
    format!(
        "{} tokens, {} wall",
        stated(b.tokens, ""),
        stated(b.wall_secs, "s")
    )
}
