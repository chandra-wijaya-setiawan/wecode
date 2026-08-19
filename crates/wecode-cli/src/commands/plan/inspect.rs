//! `show` and `check` — the two commands here that decide nothing.
//!
//! Both take either level, because an operator holding an id rarely stops to think which
//! kind of thing it names: a project is looked up first and a task second, and a short
//! number is unique across both, so at most one of the two ever answers to one.
//!
//! Neither writes. `show` reports what was declared and what it has spent; `check` re-runs
//! the admission verdict without the save that `add` would attempt, which is what makes
//! the gate something to consult rather than only to be refused by.

use wecode_core::admission;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{render, usage};

/// `show <id>` accepts either level. Ids are unique per level, not globally, so a
/// project is looked up first and a task second — and a short number is unique across
/// both, so at most one of the two ever answers to one.
pub(crate) fn show(a: &Args) -> Res {
    let (store, _) = open(a)?;
    let id = require(a.cmd(1), "project or task id")?;
    let plan = store.load_plan()?;

    if let Some(p) = plan.project_ref(id) {
        let pid = p.id.clone();
        return Ok(render::plan::project_detail(&plan, &pid));
    }
    if let Some(t) = plan.task_ref(id) {
        let tid = t.id.clone();
        let runs = store.executions(&tid)?;
        return Ok(format!(
            "{}{}",
            render::plan::task_detail(&plan, &tid),
            usage::executions(&runs)
        ));
    }
    Err(format!("no project or task `{id}` — `wecode tree` lists both").into())
}

pub(crate) fn check(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let id = require(a.cmd(1), "project or task id")?;
    let plan = store.load_plan()?;

    if let Some(p) = plan.project_ref(id) {
        let defects = admission::check_project(p, &plan, &repo_names(&company));
        return Ok(render::plan::admission(
            &render::plan::project_heading(p),
            &defects,
            None,
        ));
    }
    if let Some(t) = plan.task_ref(id) {
        let gate = plan
            .project(&t.project)
            .map(|p| design_gate(&company, p))
            .unwrap_or_default();
        let mut defects = admission::check_task(t, &plan, &gate);
        // The command an operator reaches for when something was refused and they want to
        // know what is still outstanding, which is exactly when a project's own refusal has
        // to be in the list. A verdict here that was quieter than the one `task add` printed
        // would read as the refusal having gone away.
        defects.extend(super::project::refuses(&company, &plan, t));
        return Ok(render::plan::admission(&render::plan::task_heading(t), &defects, None));
    }
    Err(format!("no project or task `{id}`").into())
}
