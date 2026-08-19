//! `project add` — the objective, the repository, and what will judge the work.
//!
//! One command, and the only path that creates a project, which is why both gates sit
//! here rather than at dispatch: the authority check that says who may define work at
//! all, and the admission check that asks whether this definition can be answered. A
//! project that names no measure is printed back with the question it left open instead
//! of being saved, which is a cheaper conversation now than at merge.
//!
//! …and one thing every other module here asks of a project rather than of a task:
//! [`refuses`], the paths its playbook says no task of its own may write. It reads like a
//! task check and is a project's statement, made once, about work nobody has declared yet
//! — so it is answered beside the command that declares a project, and through one
//! function, the shape [`ctx::design_gate`] already has. A refusal each site resolved for
//! itself would be a refusal each site could resolve differently.
//!
//! [`ctx::design_gate`]: crate::commands::ctx::design_gate

use wecode_core::{Admission, Defect, Measure, Plan, Project, ProjectId, Task, admission};
use wecode_gov::{Action, WorkKind};
use wecode_org::Company;

use super::{budget_from, parse_metric};
use crate::args::Args;
use crate::commands::ctx::*;
use crate::render;

/// What a task's project refuses, as defects against the scope it declares.
///
/// A playbook that cannot be read refuses nothing, for the reason `design_gate` gates
/// nothing: an unregistered repo is already reported as its own defect, and a read-only
/// verdict must not fail on it. A task naming a project the plan does not hold refuses
/// nothing either: the guidance is a file in that project's repository, and until there is
/// a project there is nothing that names one.
pub(super) fn refuses(company: &Company, plan: &Plan, t: &Task) -> Vec<Defect> {
    let stated = plan
        .project(&t.project)
        .and_then(|p| playbook_of(company, p).ok().flatten())
        .map(|pb| pb.project.refuses)
        .unwrap_or_default();
    admission::check_refusals(t, &stated)
}

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
