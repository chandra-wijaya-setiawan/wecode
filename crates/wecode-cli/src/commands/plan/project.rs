//! `project add` — the objective, the repository, and what will judge the work.
//!
//! One command, and the only path that creates a project, which is why both gates sit
//! here rather than at dispatch: the authority check that says who may define work at
//! all, and the admission check that asks whether this definition can be answered. A
//! project that names no measure is printed back with the question it left open instead
//! of being saved, which is a cheaper conversation now than at merge.

use wecode_core::{Admission, Measure, Project, ProjectId, admission};
use wecode_gov::{Action, WorkKind};

use super::{budget_from, parse_metric};
use crate::args::Args;
use crate::commands::ctx::*;
use crate::render;

pub(crate) fn project_add(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let id = require(a.cmd(2), "project id")?;
    let repo = require(a.get("repo").unwrap_or(""), "--repo <name>")?;
    let objective = require(a.cmd(3), "objective")?;

    let mut p = Project::new(ProjectId::new(id), objective, repo);
    for cmd in a.all("measure-cmd") {
        p = p.measured(Measure::Command {
            cmd: cmd.to_string(),
            expect_status: 0,
        });
    }
    for spec in a.all("measure-metric") {
        p = p.measured(parse_metric(spec, "--measure-metric")?);
    }
    if let Some(b) = budget_from(a) {
        p = p.budgeted(b);
    }

    // A post may never define the work it will be judged by. This is the only path
    // that creates a project, so the check belongs here.
    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(p.id.to_string()), None),
        &Action::Define {
            kind: WorkKind::Project,
        },
        "defining a project",
    )?;

    let plan = store.load_plan()?;
    let defects = admission::check_project(&p, &plan, &repo_names(&company));
    let verdict = Admission::decide(defects.clone(), "operator", Vec::new());
    let mut out = render::plan::admission(&render::plan::project_heading(&p), &defects, Some(&verdict));

    if defects.is_empty() || a.has("force") {
        let mut probe = plan;
        probe.add_project(p.clone())?;
        store.save_project(&p)?;
        if a.has("force") && !defects.is_empty() {
            out.push_str("\n  forced — defects recorded as waivers\n");
        }
        out.push_str(&format!(
            "\n  saved project {}\n  next: wecode task add <id> --project {} \"<title>\"\n",
            p.id, p.id
        ));
    } else {
        out.push_str("\n  not saved — answer the above, or pass --force\n");
    }
    Ok(out)
}
