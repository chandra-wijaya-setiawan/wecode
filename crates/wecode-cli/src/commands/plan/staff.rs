//! `assign` and `status` — the two that move work rather than define it.
//!
//! Neither changes what a task is. `assign` decides who is expected to act on it next,
//! `status` decides where it stands, and both are recorded as `staff` for that reason.
//! The authority checked is that of whoever typed the command, never that of the post
//! the work lands on: assigning is the chief's job, so it is the chief who must hold
//! `staff`.
//!
//! A project's status is the exception on both counts. It is a judgement about the
//! project record rather than about who acts, so it is recorded as a `define` — the same
//! capability that created the project — and it is not a rollup: `done` with two tasks
//! unfinished is a legitimate thing to say, so nothing here consults progress.

use wecode_core::{ProjectStatus, TaskStatus, admission};
use wecode_gov::{Action, WorkKind};

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{notify, render};

/// Moves a project or a task by hand. The scheduler will own most task transitions;
/// this exists so a human can correct it, and so the seed can mark history.
///
/// Resolves either level, the way `show` and `check` do. A project's status is a
/// judgement, not a rollup: `done` with two tasks unfinished is a legitimate thing to
/// say, so nothing here consults progress.
pub(crate) fn set_status(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let id = require(a.cmd(1), "project or task id")?;
    let want = require(a.cmd(2), "status")?;
    let plan = store.load_plan()?;

    if let Some(p) = plan.project_ref(id) {
        // From here on the id is the project's own, not what was typed: a number in the
        // ledger, in the message, or in the count below would name nothing later.
        let id = p.id.clone();
        let status = ProjectStatus::parse(want).ok_or_else(|| {
            format!(
                "unknown project status `{want}` — have: {}",
                ProjectStatus::all()
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
        // Changing the project record is defining, the same capability that created
        // it — not staffing, which is about who acts next.
        let who = actor(a, &store, &company)?;
        require_allowed(
            &store,
            &company,
            &who,
            (Some(id.to_string()), None),
            &Action::Define {
                kind: WorkKind::Project,
            },
            "setting a project's status",
        )?;
        let was = p.status;
        store.set_project_status(&id, status)?;
        let mut out = format!("  {id}  {} → {}\n", was.as_str(), status.as_str());
        if status.is_closed() {
            let open = plan
                .tasks_of(&id)
                .filter(|t| !t.status.is_closed())
                .count();
            if open > 0 {
                // Said plainly rather than refused: closing with work outstanding is a
                // judgement the operator is entitled to make.
                out.push_str(&format!(
                    "  {open} task{} still open — they remain dispatchable\n",
                    if open == 1 { "" } else { "s" }
                ));
            }
        }
        return Ok(out);
    }

    let status = TaskStatus::parse(want).ok_or_else(|| {
        format!(
            "unknown status `{want}` — have: {}",
            TaskStatus::all()
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;

    let t = plan
        .task_ref(id)
        .ok_or_else(|| format!("no project or task `{id}` — `wecode tree` lists both"))?;
    let id = t.id.clone();

    // Moving work is staffing, not defining: it changes who is expected to act.
    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(t.project.to_string()), Some(id.to_string())),
        &Action::Staff,
        "moving a task",
    )?;

    let was = t.status;
    store.set_task_status(&id, status)?;
    let mut out = format!("  {id}  {} → {}\n", was.as_str(), status.as_str());
    // By hand and still announced. Whoever moved it is at a terminal and knows; the
    // hook is how everyone else finds out, and a wait wecode only announces when it
    // discovered the wait itself is a hook that cannot be relied on.
    out.push_str(&notify::on_status_change(
        &company,
        ws.root(),
        t,
        was,
        status,
    ));
    // The moment of the act is when the operator can still reconsider. A failed or
    // dropped task will never finish on its own, so every open dependent behind it
    // is stranded right now — said here, rather than left for the board to notice.
    if status.is_dead_end() {
        let stranded: Vec<&str> = plan
            .dependents(&id)
            .filter(|d| !d.status.is_closed())
            .map(|d| d.id.as_str())
            .collect();
        if !stranded.is_empty() {
            out.push_str(&format!(
                "  now stuck behind it: {} — reopen {id}, or re-point them with \
                 `wecode task add <id> --amend --after <other>`\n",
                stranded.join(", ")
            ));
        }
    }
    Ok(out)
}

/// Assigns an admitted task to a post — the chief's job.
///
/// The load-bearing check is the scope one: a post whose grant does not cover the
/// task's write scope cannot legally do the work, so assigning it guarantees a
/// rejection later. Catching that here is deterministic and cheap.
pub(crate) fn assign(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let named = require(a.cmd(1), "task id")?;
    let post_name = require(a.get("to").unwrap_or(""), "--to <post>")?;
    let post = find_post(&company, post_name)?;

    let plan = store.load_plan()?;
    let task = the_task(&plan, named)?;
    let id = task.id.clone();

    let gate = plan
        .project(&task.project)
        .map(|p| design_gate(&company, p))
        .unwrap_or_default();
    let defects = admission::check_task(task, &plan, &gate);
    if !defects.is_empty() {
        let mut out = render::plan::admission(&render::plan::task_heading(task), &defects, None);
        out.push_str("\n  not assigned — a draft cannot be dispatched\n");
        return Ok(out);
    }

    covers_the_work(&company, &post, task)?;

    // Assigning is the chief's job, so the chief's authority is what gets checked
    // — not the assignee's. Staffing requires the `staff` capability.
    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(task.project.to_string()), Some(id.to_string())),
        &Action::Staff,
        "assigning work",
    )?;

    let mut assigned = task.clone();
    assigned.assignee = Some(post.name.clone());
    // Waiting, not Ready: whether the prerequisites are met is the scheduler's
    // finding, not the assigner's opinion.
    if assigned.status == TaskStatus::Draft {
        assigned.status = TaskStatus::Waiting;
    }
    store.save_task(&assigned)?;

    let mut out = format!(
        "  {} assigned {id} to {post_name} ({}, run by {})\n",
        who.describe(),
        post.role,
        post.agent
    );
    let blockers = plan.blockers(&id);
    if blockers.is_empty() {
        out.push_str("  status: waiting → ready on the next scan\n");
    } else {
        out.push_str("  status: waiting\n");
        for b in &blockers {
            out.push_str(&format!("    on {}\n", blocker_note(b)));
        }
    }
    Ok(out)
}
