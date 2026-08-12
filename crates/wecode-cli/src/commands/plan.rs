//! Commands that shape the plan: projects, tasks, their scopes and statuses.
//!
//! Nothing here executes work. These decide what the work *is*.

use wecode_core::{
    Admission, Budget, Cmp, Measure, Project, ProjectId, ProjectStatus, Scope, Task, TaskId,
    TaskKind, TaskStatus, admission,
};
use wecode_gov::{Action, WorkKind};

use crate::args::Args;
use crate::commands::ctx::*;
use crate::render;

pub(crate) fn parse_metric(spec: &str, flag: &str) -> Result<Measure, String> {
    let parts: Vec<&str> = spec.split(':').collect();
    if parts.len() != 3 {
        return Err(format!("{flag} wants <name>:<cmp>:<target>, got `{spec}`"));
    }
    let cmp = match parts[1] {
        "lt" => Cmp::Lt,
        "lte" => Cmp::Lte,
        "gt" => Cmp::Gt,
        "gte" => Cmp::Gte,
        "eq" => Cmp::Eq,
        other => return Err(format!("unknown comparison `{other}` (lt lte gt gte eq)")),
    };
    let target: f64 = parts[2]
        .parse()
        .map_err(|_| format!("target `{}` is not a number", parts[2]))?;
    Ok(Measure::Metric {
        name: parts[0].to_string(),
        target,
        cmp,
    })
}

pub(crate) fn budget_from(a: &Args) -> Option<Budget> {
    (a.has("tokens") || a.has("wall")).then(|| Budget {
        tokens: a.num("tokens"),
        wall_secs: a.num("wall"),
    })
}

pub(crate) fn scope_from(a: &Args) -> Option<Scope> {
    let read: Vec<&str> = a.all("read");
    let write: Vec<&str> = a.all("write");
    (!read.is_empty() || !write.is_empty()).then(|| Scope {
        read: read.iter().map(|s| (*s).to_string()).collect(),
        write: write.iter().map(|s| (*s).to_string()).collect(),
    })
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
    let mut out = render::admission(&render::project_heading(&p), &defects, Some(&verdict));

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

pub(crate) fn build_task(a: &Args) -> Result<Task, Box<dyn std::error::Error>> {
    let id = require(a.cmd(2), "task id")?;
    let project = require(a.get("project").unwrap_or(""), "--project <id>")?;
    let title = require(a.cmd(3), "title")?;

    let mut t = Task::new(TaskId::new(id), ProjectId::new(project), title);

    if let Some(k) = a.get("kind") {
        t = t.of_kind(TaskKind::parse(k).ok_or_else(|| {
            format!(
                "unknown kind `{k}` — have: {}",
                TaskKind::all()
                    .iter()
                    .map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?);
    }
    if let Some(parent) = a.get("parent") {
        t = t.under(TaskId::new(parent));
    }
    for after in a.all("after") {
        t = t.after(TaskId::new(after));
    }
    for cmd in a.all("accept-cmd") {
        t = t.accepting(Measure::Command {
            cmd: cmd.to_string(),
            expect_status: 0,
        });
    }
    for spec in a.all("accept-metric") {
        t = t.accepting(parse_metric(spec, "--accept-metric")?);
    }
    if let Some(s) = scope_from(a) {
        t = t.scoped(s);
    }
    if let Some(b) = budget_from(a) {
        t = t.budgeted(b);
    }
    if let Some(post) = a.get("to") {
        t = t.assigned_to(post);
    }
    Ok(t)
}

pub(crate) fn task_add(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let mut t = build_task(a)?;
    let mut from_playbook = Vec::new();

    if !store.project_exists(&t.project)? {
        return Err(format!(
            "no such project `{}` — `wecode project add {} --repo <name> \"<objective>\"` first",
            t.project, t.project
        )
        .into());
    }
    let plan = store.load_plan()?;

    // Defaults the project's playbook supplies. An explicit flag always wins, and
    // whatever is filled in is named in the output — never a silent substitution.
    if let Some(project) = plan.project(&t.project)
        && let Some(pb) = playbook_of(&company, project)?
        && let Some(k) = pb.for_kind(t.kind)
    {
        if t.acceptance.is_empty() && !k.accept.is_empty() {
            for cmd in &k.accept {
                t = t.accepting(Measure::Command {
                    cmd: cmd.clone(),
                    expect_status: 0,
                });
            }
            from_playbook.push(format!("accept    {}", k.accept.join(", ")));
        }
        if t.assignee.is_none()
            && let Some(post) = &k.assign_to
        {
            t = t.assigned_to(post.clone());
            from_playbook.push(format!("assignee  {post}"));
        }
        if !t.budget.is_set() && (k.tokens.is_some() || k.wall_secs.is_some()) {
            t = t.budgeted(Budget {
                tokens: k.tokens,
                wall_secs: k.wall_secs,
            });
            from_playbook.push(format!(
                "budget    {} tokens, {}s",
                k.tokens.map_or_else(|| "—".to_string(), |n| n.to_string()),
                k.wall_secs
                    .map_or_else(|| "—".to_string(), |n| n.to_string())
            ));
        }
    }

    if let Some(post) = &t.assignee {
        find_post(&company, post)?;
    }

    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(t.project.to_string()), Some(t.id.to_string())),
        &Action::Define {
            kind: WorkKind::Task,
        },
        "defining a task",
    )?;
    let defects = admission::check_task(&t, &plan);
    let verdict = Admission::decide(defects.clone(), "operator", Vec::new());
    let mut out = render::admission(&render::task_heading(&t), &defects, Some(&verdict));
    for line in &from_playbook {
        out.push_str(&format!("  {line}  (from playbook)\n"));
    }

    if defects.is_empty() || a.has("force") {
        // Probe a scratch plan first. A cycle must be caught before anything is
        // written, because the store has no transaction spanning this decision.
        let mut probe = plan;
        probe.add_task(t.clone())?;
        store.save_task(&t)?;

        if a.has("force") && !defects.is_empty() {
            out.push_str("\n  forced — defects recorded as waivers\n");
        }
        out.push_str(&format!("\n  saved task {}\n", t.id));

        // Naming a post means assigning to it. Leaving the task `draft` with an
        // assignee is a half-state: `ready` would not list it, the loop would not
        // dispatch it, and nothing on screen would say why. The playbook fills
        // `assign_to` on most tasks, so this was the common case, not a corner.
        if let Some(name) = t.assignee.clone() {
            let post = find_post(&company, &name)?;
            match covers_the_work(&company, &post, &t) {
                Ok(()) => {
                    let mut assigned = t.clone();
                    assigned.status = TaskStatus::Waiting;
                    store.save_task(&assigned)?;
                    out.push_str(&format!("  assigned to {name} — draft → waiting\n"));
                }
                // The task is kept. Losing it would mean retyping the whole
                // declaration over a post that can be changed with one flag.
                Err(why) => {
                    out.push_str(&format!("\n  not assigned — {why}\n"));
                }
            }
        }

        if !probe.is_ready(&t.id) {
            for b in probe.blockers(&t.id) {
                out.push_str(&format!("  waiting: {}\n", blocker_note(&b)));
            }
        }
    } else {
        out.push_str("\n  not saved — answer the above, or pass --force\n");
    }
    Ok(out)
}

/// Replaces a task's write and read scope.
///
/// Re-planning, not laundering. The distinction is that the ledger is append-only:
/// widening a scope cannot erase a violation already recorded against the old one.
/// A later `verify` will pass, and the earlier denial stays visible in `audit`.
///
/// Deliberately not offered for acceptance measures. Those are frozen at dispatch —
/// amending what counts as done, after seeing what was produced, is how criteria
/// drift to fit the work.
/// Erases a task that never ran.
///
/// Distinct from `status <id> dropped`, and both are needed. Dropping records a
/// judgement — this was considered and abandoned — and belongs on the board where the
/// reasoning stays visible. Removing says the task should never have existed: a typo,
/// a mis-scoped draft, a breakdown replaced wholesale. Keeping those as `dropped`
/// makes the board a graveyard of corrections.
///
/// Refused once anything real has happened to it. The line is executions rather than
/// status, because an execution is the point at which a diff, a commit or a spend
/// exists to be orphaned.
pub(crate) fn task_rm(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let id = TaskId::new(require(a.cmd(2), "task id")?);
    let plan = store.load_plan()?;
    let task = plan
        .task(&id)
        .ok_or_else(|| format!("no such task: {id}"))?
        .clone();

    let runs = store.executions(&id)?;
    if !runs.is_empty() {
        return Err(format!(
            "{id} has {} execution{} — it ran, so it is history. \
             `wecode status {id} dropped` records that it was abandoned.",
            runs.len(),
            if runs.len() == 1 { "" } else { "s" }
        )
        .into());
    }

    // A dangling prerequisite would leave dependents permanently unschedulable, and
    // silently rewriting someone else's dependencies to fix that is worse than
    // refusing. Naming them lets the operator decide the order.
    let dependents: Vec<&str> = plan
        .tasks()
        .filter(|t| t.depends_on.contains(&id))
        .map(|t| t.id.as_str())
        .collect();
    if !dependents.is_empty() {
        return Err(format!(
            "{id} is waited on by {} — remove those first, or re-point them.",
            dependents.join(", ")
        )
        .into());
    }
    let children: Vec<&str> = plan
        .tasks()
        .filter(|t| t.parent.as_ref() == Some(&id))
        .map(|t| t.id.as_str())
        .collect();
    if !children.is_empty() {
        return Err(format!(
            "{id} is the parent of {} — remove those first.",
            children.join(", ")
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
        "removing a task",
    )?;

    store.delete_task(&id)?;
    Ok(format!(
        "  removed {id} — {}\n  the ledger still records that it existed: `wecode audit --task {id}`\n",
        task.title
    ))
}

pub(crate) fn task_scope(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let id = TaskId::new(require(a.cmd(2), "task id")?);
    let scope = scope_from(a).ok_or("give at least one --write or --read glob")?;

    let plan = store.load_plan()?;
    let mut task = plan
        .task(&id)
        .ok_or_else(|| format!("no such task: {id}"))?
        .clone();
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
    let defects = admission::check_task(&task, &probe);
    let blocking: Vec<_> = defects
        .iter()
        .filter(|d| matches!(d, wecode_core::Defect::ScopeOverlaps { .. }))
        .collect();
    if !blocking.is_empty() && !a.has("force") {
        let mut out = render::admission(&render::task_heading(&task), &defects, None);
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

/// `show <id>` accepts either level. Ids are unique per level, not globally, so a
/// project is looked up first and a task second.
pub(crate) fn show(a: &Args) -> Res {
    let (store, _) = open(a)?;
    let id = require(a.cmd(1), "project or task id")?;
    let plan = store.load_plan()?;

    if plan.project(&ProjectId::new(id)).is_some() {
        return Ok(render::project_detail(&plan, &ProjectId::new(id)));
    }
    if plan.task(&TaskId::new(id)).is_some() {
        let runs = store.executions(&TaskId::new(id))?;
        return Ok(format!(
            "{}{}",
            render::task_detail(&plan, &TaskId::new(id)),
            render::executions(&runs)
        ));
    }
    Err(format!("no project or task `{id}` — `wecode tree` lists both").into())
}

pub(crate) fn check(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let id = require(a.cmd(1), "project or task id")?;
    let plan = store.load_plan()?;

    if let Some(p) = plan.project(&ProjectId::new(id)) {
        let defects = admission::check_project(p, &plan, &repo_names(&company));
        return Ok(render::admission(
            &render::project_heading(p),
            &defects,
            None,
        ));
    }
    if let Some(t) = plan.task(&TaskId::new(id)) {
        let defects = admission::check_task(t, &plan);
        return Ok(render::admission(&render::task_heading(t), &defects, None));
    }
    Err(format!("no project or task `{id}`").into())
}

/// Moves a project or a task by hand. The scheduler will own most task transitions;
/// this exists so a human can correct it, and so the seed can mark history.
///
/// Resolves either level, the way `show` and `check` do. A project's status is a
/// judgement, not a rollup: `done` with two tasks unfinished is a legitimate thing to
/// say, so nothing here consults progress.
pub(crate) fn set_status(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let id = require(a.cmd(1), "project or task id")?;
    let want = require(a.cmd(2), "status")?;
    let plan = store.load_plan()?;

    if let Some(p) = plan.project(&ProjectId::new(id)) {
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
        store.set_project_status(&ProjectId::new(id), status)?;
        let mut out = format!("  {id}  {} → {}\n", was.as_str(), status.as_str());
        if status.is_closed() {
            let open = plan
                .tasks_of(&ProjectId::new(id))
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

    let id = TaskId::new(id);
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
        .task(&id)
        .ok_or_else(|| format!("no project or task `{id}` — `wecode tree` lists both"))?;

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
    Ok(format!("  {id}  {} → {}\n", was.as_str(), status.as_str()))
}

/// Files a project away, or brings it back.
///
/// Deliberately not a status. Archiving says "stop showing me this", which is a
/// different claim from "this work is finished" — a done project can stay on the
/// board, and a parked active one can be hidden. Display only: nothing here changes
/// what is dispatchable.
pub(crate) fn set_archived(a: &Args, archived: bool) -> Res {
    let (store, company) = open(a)?;
    let verb = if archived { "archive" } else { "unarchive" };
    let id = ProjectId::new(require(a.cmd(1), "project id")?);
    let plan = store.load_plan()?;
    let p = plan.project(&id).ok_or_else(|| {
        format!("no such project: {id} — archiving applies to projects, not tasks")
    })?;

    if p.archived == archived {
        return Ok(format!(
            "  {id} is already {}\n",
            if archived { "archived" } else { "visible" }
        ));
    }

    // Hiding work that is mid-flight or waiting on a person is how it gets forgotten.
    // Finished and draft tasks are fine to file away.
    if archived {
        let live: Vec<&Task> = plan
            .tasks_of(&id)
            .filter(|t| t.status == TaskStatus::Running || t.status.needs_a_human())
            .collect();
        if !live.is_empty() && !a.has("force") {
            let mut msg = format!("{id} has work that would be hidden mid-flight:\n");
            for t in live.iter().take(10) {
                msg.push_str(&format!("    {} {}  {}\n", t.status.mark(), t.id, t.title));
            }
            msg.push_str("  finish or drop them, or pass --force");
            return Err(msg.into());
        }
    }

    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(id.to_string()), None),
        &Action::Define {
            kind: WorkKind::Project,
        },
        &format!("{verb} a project"),
    )?;
    store.set_project_archived(&id, archived)?;

    Ok(if archived {
        format!("  archived {id} — `wecode tree --all` still shows it\n")
    } else {
        format!("  {id} is visible again\n")
    })
}

/// Assigns an admitted task to a post — the chief's job.
///
/// The load-bearing check is the scope one: a post whose grant does not cover the
/// task's write scope cannot legally do the work, so assigning it guarantees a
/// rejection later. Catching that here is deterministic and cheap.
pub(crate) fn assign(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let id = TaskId::new(require(a.cmd(1), "task id")?);
    let post_name = require(a.get("to").unwrap_or(""), "--to <post>")?;
    let post = find_post(&company, post_name)?;

    let plan = store.load_plan()?;
    let task = plan
        .task(&id)
        .ok_or_else(|| format!("no such task: {id}"))?;

    let defects = admission::check_task(task, &plan);
    if !defects.is_empty() {
        let mut out = render::admission(&render::task_heading(task), &defects, None);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &[&str]) -> Args {
        Args::parse(s.iter().map(|x| (*x).to_string()))
    }

    #[test]
    fn a_metric_needs_all_three_parts() {
        assert!(parse_metric("p99:lt:500", "--m").is_ok());
        assert!(
            parse_metric("p99:500", "--m")
                .unwrap_err()
                .contains("wants")
        );
        assert!(
            parse_metric("p99:under:500", "--m")
                .unwrap_err()
                .contains("unknown comparison")
        );
        assert!(
            parse_metric("p99:lt:fast", "--m")
                .unwrap_err()
                .contains("not a number")
        );
    }

    #[test]
    fn scope_and_budget_are_absent_unless_asked_for() {
        assert!(scope_from(&parse(&[])).is_none());
        assert!(budget_from(&parse(&[])).is_none());
        let s = scope_from(&parse(&["--write", "src/**", "--write", "tests/**"])).unwrap();
        assert_eq!(s.write.len(), 2);
        assert!(s.read.is_empty());
    }
}
