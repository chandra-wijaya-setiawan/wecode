//! Commands that shape the plan: projects, tasks, their scopes and statuses.
//!
//! Nothing here executes work. These decide what the work *is*.

use std::collections::BTreeSet;

use wecode_core::{
    Admission, Budget, Cmp, Measure, Plan, Project, ProjectId, ProjectStatus, Scope, Task, TaskId,
    TaskKind, TaskStatus, admission,
};
use wecode_gov::{Action, WorkKind};
use wecode_org::{Company, Playbook, Subtask};
use wecode_store::Store;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{notify, render};

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

/// Assembles a task from the flags.
///
/// The plan is here for one reason: `--project`, `--parent` and `--after` name work that
/// already exists, so they take a short number like everything else. The task's *own*
/// id never does — `wecode task add 4 ...` names a new task `4`, which is what it says.
///
/// A reference that resolves to nothing is passed through as typed rather than refused
/// here. The caller and `Plan::add_task` both have a better message for it than this
/// does, and each names what the operator wrote.
pub(crate) fn build_task(a: &Args, plan: &Plan) -> Result<Task, Box<dyn std::error::Error>> {
    let id = require(a.cmd(2), "task id")?;
    let project = require(a.get("project").unwrap_or(""), "--project <id>")?;
    let title = require(a.cmd(3), "title")?;
    let named_task = |typed: &str| {
        plan.task_ref(typed)
            .map_or_else(|| TaskId::new(typed), |t| t.id.clone())
    };

    let project = plan
        .project_ref(project)
        .map_or_else(|| ProjectId::new(project), |p| p.id.clone());
    let mut t = Task::new(TaskId::new(id), project, title);

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
        t = t.under(named_task(parent));
    }
    for after in a.all("after") {
        t = t.after(named_task(after));
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

/// Fills what a task did not state from the project's guidance for its kind.
///
/// An explicit flag always wins, and every substitution is named back to the caller —
/// a default that arrives silently is one nobody checks. Shared with `--expand`, so a
/// generated subtask acquires its defaults down exactly the path a hand-written task
/// of that kind does.
fn with_playbook_defaults(mut t: Task, pb: &Playbook) -> (Task, Vec<String>) {
    let mut filled = Vec::new();
    let Some(k) = pb.for_kind(t.kind) else {
        return (t, filled);
    };
    if t.acceptance.is_empty() && !k.accept.is_empty() {
        for cmd in &k.accept {
            t = t.accepting(Measure::Command {
                cmd: cmd.clone(),
                expect_status: 0,
            });
        }
        filled.push(format!("accept    {}", k.accept.join(", ")));
    }
    if t.assignee.is_none()
        && let Some(post) = &k.assign_to
    {
        t = t.assigned_to(post.clone());
        filled.push(format!("assignee  {post}"));
    }
    if !t.budget.is_set() && (k.tokens.is_some() || k.wall_secs.is_some()) {
        t = t.budgeted(Budget {
            tokens: k.tokens,
            wall_secs: k.wall_secs,
        });
        filled.push(format!(
            "budget    {} tokens, {}s",
            k.tokens.map_or_else(|| "—".to_string(), |n| n.to_string()),
            k.wall_secs
                .map_or_else(|| "—".to_string(), |n| n.to_string())
        ));
    }
    (t, filled)
}

/// Moves a task with an assignee out of `draft`, once the post can reach its scope.
///
/// Naming a post means assigning to it. Leaving the task `draft` with an assignee is a
/// half-state: `ready` would not list it, the loop would not dispatch it, and nothing
/// on screen would say why. The playbook fills `assign_to` on most tasks, so this was
/// the common case, not a corner.
///
/// The task is kept when the post cannot cover it. Losing it would mean retyping the
/// whole declaration over a post that can be changed with one flag.
fn assign_if_named(
    store: &Store,
    company: &Company,
    t: &Task,
) -> Result<Assignment, Box<dyn std::error::Error>> {
    let Some(name) = t.assignee.clone() else {
        return Ok(Assignment::Unnamed);
    };
    let post = find_post(company, &name)?;
    match covers_the_work(company, &post, t) {
        Ok(()) => {
            let mut assigned = t.clone();
            assigned.status = TaskStatus::Waiting;
            store.save_task(&assigned)?;
            Ok(Assignment::Landed(name))
        }
        Err(why) => Ok(Assignment::Refused(why)),
    }
}

/// What became of a task that named a post.
enum Assignment {
    /// No post named, so nothing was offered.
    Unnamed,
    /// Moved draft → waiting, on the named post.
    Landed(String),
    /// Kept as a draft, with the reason it could not be handed over.
    Refused(String),
}

pub(crate) fn task_add(a: &Args) -> Res {
    let (store, company) = open(a)?;
    // Loaded before the task is assembled, because `--project`, `--parent` and `--after`
    // are resolved against it.
    let plan = store.load_plan()?;
    let mut t = build_task(a, &plan)?;
    let mut from_playbook = Vec::new();

    if !store.project_exists(&t.project)? {
        return Err(format!(
            "no such project `{}` — `wecode project add {} --repo <name> \"<objective>\"` first",
            t.project, t.project
        )
        .into());
    }
    let pb = match plan.project(&t.project) {
        Some(project) => playbook_of(&company, project)?,
        None => None,
    };
    if let Some(pb) = &pb {
        let (filled, notes) = with_playbook_defaults(t, pb);
        (t, from_playbook) = (filled, notes);
    }

    // Refused before anything is created rather than after. A main task saved beside
    // an expansion that turned out to be empty is worse than a command that did
    // nothing, because only one of the two is obvious from the output.
    let steps = if a.has("expand") {
        let declared = pb
            .as_ref()
            .and_then(|p| p.for_kind(t.kind))
            .map(|k| k.expand(t.kind, t.id.as_str(), &t.title))
            .unwrap_or_default();
        if declared.is_empty() {
            return Err(format!(
                "--expand: this project's playbook declares no subtasks for `{kind}`\n  \
                 `wecode playbook {kind}` shows what it does declare\n  \
                 add `subtasks` to [{kind}], or drop the flag",
                kind = t.kind.as_str()
            )
            .into());
        }
        declared
    } else {
        Vec::new()
    };

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
    let gate = pb
        .as_ref()
        .map(Playbook::design_required_kinds)
        .unwrap_or_default();
    let mut defects = admission::check_task(&t, &plan, &gate);
    // The main task of an expansion carries its design as a subtask, and at this
    // moment the subtask exists only as a declared step. Judging the main task
    // without crediting the design about to be created would refuse the one flow
    // the gate is meant to steer people into. Every later check finds the child
    // in the plan.
    if steps.iter().any(|s| s.kind == TaskKind::Design) {
        defects.retain(|d| *d != wecode_core::Defect::DesignMissing);
    }
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
        match assign_if_named(&store, &company, &t)? {
            Assignment::Unnamed => {}
            Assignment::Landed(name) => {
                out.push_str(&format!("  assigned to {name} — draft → waiting\n"));
            }
            Assignment::Refused(why) => out.push_str(&format!("\n  not assigned — {why}\n")),
        }

        if !probe.is_ready(&t.id) {
            for b in probe.blockers(&t.id) {
                out.push_str(&format!("  waiting: {}\n", blocker_note(&b)));
            }
        }

        if !steps.is_empty() {
            out.push_str(&expand(
                a,
                &store,
                &company,
                pb.as_ref(),
                &t,
                &steps,
                &mut probe,
            )?);
        }
    } else {
        out.push_str("\n  not saved — answer the above, or pass --force\n");
        if !steps.is_empty() {
            out.push_str("  nothing was expanded either\n");
        }
    }
    Ok(out)
}

/// Emits the subtasks a kind's template declares, as ordinary tasks.
///
/// This is the whole of what a template does. It runs once, here, at planning time,
/// and produces tasks that face the same admission gate as hand-written ones and can
/// be edited, dropped or added to before anything is dispatched. Nothing consults the
/// template again — a scaffold that produces tasks is not a pipeline that runs them.
///
/// All or nothing, on purpose. A half-built expansion leaves later steps depending on
/// tasks that were never created, and the operator has to work out which of four ids
/// to retype; refusing the set costs one edit to the playbook instead.
fn expand(
    a: &Args,
    store: &Store,
    company: &Company,
    pb: Option<&Playbook>,
    main: &Task,
    steps: &[Subtask],
    probe: &mut Plan,
) -> Res {
    let mut tasks = Vec::with_capacity(steps.len());
    for s in steps {
        let mut t = Task::new(TaskId::new(&s.id), main.project.clone(), s.title.clone())
            .of_kind(s.kind)
            // Part of the main task, not blocked by it: the two relations are separate,
            // and the ordering between steps is `after` alone.
            .under(main.id.clone());
        for dep in &s.after {
            t = t.after(TaskId::new(dep));
        }
        for cmd in &s.accept {
            t = t.accepting(Measure::Command {
                cmd: cmd.clone(),
                expect_status: 0,
            });
        }
        if !s.write.is_empty() || !s.read.is_empty() {
            t = t.scoped(Scope {
                read: s.read.clone(),
                write: s.write.clone(),
            });
        }
        if s.tokens.is_some() || s.wall_secs.is_some() {
            t = t.budgeted(Budget {
                tokens: s.tokens,
                wall_secs: s.wall_secs,
            });
        }
        if let Some(post) = &s.assign_to {
            t = t.assigned_to(post.clone());
        }
        if let Some(pb) = pb {
            (t, _) = with_playbook_defaults(t, pb);
        }
        tasks.push(t);
    }

    // Each is a task being defined, so each is authorised as one. Four Define records
    // for four tasks is what the ledger should say; one would understate it.
    let who = actor(a, store, company)?;
    for t in &tasks {
        require_allowed(
            store,
            company,
            &who,
            (Some(t.project.to_string()), Some(t.id.to_string())),
            &Action::Define {
                kind: WorkKind::Task,
            },
            &format!("defining subtask {}", t.id),
        )?;
    }

    // A generated id that is already taken — most often an expansion re-run after only
    // the main task was removed. Reported rather than raised, so the main task's own
    // verdict above survives, and so every collision is named instead of the first.
    let taken: Vec<&str> = tasks
        .iter()
        .filter(|t| probe.task(&t.id).is_some())
        .map(|t| t.id.as_str())
        .collect();
    if !taken.is_empty() {
        return Ok(format!(
            "\n  not expanded — {} already exist{}\n  \
             `wecode task rm <id>` erases a task that never ran\n",
            taken.join(", "),
            if taken.len() == 1 { "s" } else { "" }
        ));
    }

    // Into the scratch plan in declared order, so each step is checked against the
    // siblings that precede it: the overlap check needs them present to see that the
    // ordering makes two scopes safe.
    for t in &tasks {
        probe.add_task(t.clone())?;
    }
    // The design gate holds for generated steps as for hand-written tasks — a
    // template that skips the design step its own gate demands should be refused
    // here, not discovered at dispatch.
    let gate = pb.map(Playbook::design_required_kinds).unwrap_or_default();
    let defects: Vec<(&Task, Vec<wecode_core::Defect>)> = tasks
        .iter()
        .map(|t| (t, admission::check_task(t, probe, &gate)))
        .filter(|(_, d)| !d.is_empty())
        .collect();

    if !defects.is_empty() && !a.has("force") {
        let mut out = format!(
            "\n  not expanded — {} of {} subtask{} would be refused\n  \
             a half-built expansion leaves the rest waiting on tasks that do not exist\n\n",
            defects.len(),
            tasks.len(),
            if tasks.len() == 1 { "" } else { "s" }
        );
        for (t, d) in &defects {
            out.push_str(&render::admission(&render::task_heading(t), d, None));
        }

        // A step of a kind the project has written nothing about gets no budget and
        // no acceptance, which is most of the ways an expansion is refused. Saying so
        // beats leaving the reader to infer it from two unrelated-looking questions.
        let mut unwritten: Vec<&str> = defects
            .iter()
            .map(|(t, _)| t.kind)
            .filter(|k| pb.is_none_or(|p| p.for_kind(*k).is_none()))
            .map(TaskKind::as_str)
            .collect();
        unwritten.sort_unstable();
        unwritten.dedup();
        for kind in unwritten {
            out.push_str(&format!(
                "\n  [{kind}] has no section in this project's playbook, so nothing \
                 filled that step's budget or acceptance\n"
            ));
        }
        out.push_str(&format!(
            "\n  fix the [{}.<step>] blocks in the playbook, or pass --force\n",
            main.kind.as_str()
        ));
        return Ok(out);
    }

    for t in &tasks {
        store.save_task(t)?;
    }
    // Assigned before the table is drawn, so its assignee column reports what
    // happened rather than what was asked for.
    let mut refused = String::new();
    for t in &tasks {
        match assign_if_named(store, company, t)? {
            Assignment::Unnamed | Assignment::Landed(_) => {}
            Assignment::Refused(why) => {
                refused.push_str(&format!("\n  {} not assigned — {why}\n", t.id));
            }
        }
    }
    let plan_now = store.load_plan()?;
    let saved: Vec<Task> = tasks
        .iter()
        .filter_map(|t| plan_now.task(&t.id).cloned())
        .collect();

    let mut out = render::expansion(main, &saved);
    if !defects.is_empty() {
        out.push_str("  forced — defects recorded as waivers\n");
    }
    out.push_str(&refused);
    Ok(out)
}

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
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(2), "task id")?)?.clone();
    let id = task.id.clone();

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
    let defects = admission::check_task(&task, &probe, &gate);
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
    let defects = admission::check_task(&amended, &probe, &gate);
    if !defects.is_empty() {
        out.push('\n');
        out.push_str(&render::admission(
            &render::task_heading(&amended),
            &defects,
            None,
        ));
    }
    Ok(out)
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

/// `show <id>` accepts either level. Ids are unique per level, not globally, so a
/// project is looked up first and a task second — and a short number is unique across
/// both, so at most one of the two ever answers to one.
pub(crate) fn show(a: &Args) -> Res {
    let (store, _) = open(a)?;
    let id = require(a.cmd(1), "project or task id")?;
    let plan = store.load_plan()?;

    if let Some(p) = plan.project_ref(id) {
        let pid = p.id.clone();
        return Ok(render::project_detail(&plan, &pid));
    }
    if let Some(t) = plan.task_ref(id) {
        let tid = t.id.clone();
        let runs = store.executions(&tid)?;
        return Ok(format!(
            "{}{}",
            render::task_detail(&plan, &tid),
            render::executions(&runs)
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
        return Ok(render::admission(
            &render::project_heading(p),
            &defects,
            None,
        ));
    }
    if let Some(t) = plan.task_ref(id) {
        let gate = plan
            .project(&t.project)
            .map(|p| design_gate(&company, p))
            .unwrap_or_default();
        let defects = admission::check_task(t, &plan, &gate);
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
            .tasks()
            .filter(|d| !d.status.is_closed() && d.depends_on.contains(&id))
            .map(|d| d.id.as_str())
            .collect();
        if !stranded.is_empty() {
            out.push_str(&format!(
                "  now stuck behind it: {} — reopen {id}, or re-point them\n",
                stranded.join(", ")
            ));
        }
    }
    Ok(out)
}

/// Files a project away, or brings it back — and, spelled `archive task <id>`, a task
/// with its subtasks.
///
/// Deliberately not a status. Archiving says "stop showing me this", which is a
/// different claim from "this work is finished" — a done project can stay on the
/// board, and a parked active one can be hidden. Display only: nothing here changes
/// what is dispatchable.
///
/// The level is named rather than inferred from the id, because the two do not archive
/// alike: a project is *parked* — nothing in it is promoted or dispatched — while a task
/// is only hidden. An operator asking to file something away is entitled to know which
/// of those two they are asking for, and a polymorphic id would decide it for them.
pub(crate) fn set_archived(a: &Args, archived: bool) -> Res {
    // `!is_empty` rather than the word alone, so a project that happens to be called
    // `task` is still reachable as `archive task`.
    if a.cmd(1) == "task" && !a.cmd(2).is_empty() {
        return set_task_archived(a, archived);
    }
    let (store, company) = open(a)?;
    let verb = if archived { "archive" } else { "unarchive" };
    let named = require(a.cmd(1), "project id")?;
    let plan = store.load_plan()?;
    let p = plan.project_ref(named).ok_or_else(|| {
        // Named as a task where it is one: the bare form is the one an operator reaches
        // for first, and a refusal that only says no leaves them nowhere.
        let hint = if plan.task_ref(named).is_some() {
            format!(" — `wecode {verb} task {named}` files that task away with its subtasks")
        } else {
            String::new()
        };
        format!("no such project: {named} — a bare id names projects, not tasks{hint}")
    })?;
    let id = p.id.clone();

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

/// Files a task away with everything that is part of it, or brings the group back.
///
/// The cascade is the point. A feature expanded into four subtasks is one piece of work
/// and five rows; filing the parent alone would clear the heading and none of the
/// clutter, and filing five ids by hand is why nobody would file anything.
///
/// It reaches *down* the is-part-of chain and no further. A subtask can be put away on
/// its own, leaving the feature it belongs to on the board; a task that merely comes
/// after this one is not part of it and is left alone.
///
/// Hiding only, unlike a project. Archiving a project parks its work — the scheduler
/// skips it — and there is no equivalent here: an archived task is still promoted, still
/// dispatched, still merged. So this refuses to file away anything that could move on
/// its own, which is the whole of what keeps `archived` from meaning *running where
/// nobody is looking*.
fn set_task_archived(a: &Args, archived: bool) -> Res {
    let (store, company) = open(a)?;
    let verb = if archived { "archive" } else { "unarchive" };
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(2), "task id")?)?;
    let id = task.id.clone();
    let group = part_of(&plan, &id);
    let others = group.len() - 1;

    if archived {
        let live: Vec<&Task> = group.iter().copied().filter(|t| !is_settled(t)).collect();
        if !live.is_empty() && !a.has("force") {
            // The same words the project path uses for the same situation, one level up.
            let mut msg = format!("{id} covers work that would be hidden mid-flight:\n");
            for t in live.iter().take(10) {
                msg.push_str(&format!(
                    "    {} {:<24} {}\n",
                    t.status.mark(),
                    t.id,
                    t.status.as_str()
                ));
            }
            msg.push_str(
                "  filing a task away only hides it — the scheduler would still dispatch it,\n  \
                 where nothing on the board would say so\n  \
                 finish or drop them, or pass --force",
            );
            return Err(msg.into());
        }
    }

    // Changing the task record is defining, the same capability that created it — not
    // staffing, which is about who acts next. Nothing here moves work.
    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(task.project.to_string()), Some(id.to_string())),
        &Action::Define {
            kind: WorkKind::Task,
        },
        &format!("{verb} a task"),
    )?;

    // Empty means every row in the group already read that way. Saying so beats
    // reporting a filing that did nothing, and beats refusing: `archive` twice is not a
    // mistake worth an error.
    if store.set_task_archived(&id, archived)?.is_empty() {
        return Ok(format!(
            "  {id}{} already {}\n",
            with_subtasks(others),
            if archived { "archived" } else { "visible" }
        ));
    }

    Ok(if archived {
        format!(
            "  archived {id}{} — `wecode board --all` still shows them\n",
            with_subtasks(others)
        )
    } else {
        format!("  {id}{} visible again\n", with_subtasks(others))
    })
}

/// Nothing, or ` and its 3 subtasks` — so every message above reads as a sentence
/// whether or not the group turned out to have anything under it.
fn with_subtasks(n: usize) -> String {
    match n {
        0 => String::new(),
        1 => " and its subtask".to_string(),
        n => format!(" and its {n} subtasks"),
    }
}

/// A task and everything that is part of it, breadth-first so a group reads parent
/// before child. The is-part-of chain, not the dependency graph.
///
/// `seen` is what makes a parent loop terminate rather than hang. `Plan` refuses to
/// build one, but anyone can open wecode.db with the sqlite3 CLI, and the same
/// reasoning is why [`wecode_core::Blocker::Missing`] exists.
fn part_of<'a>(plan: &'a Plan, root: &TaskId) -> Vec<&'a Task> {
    let mut out: Vec<&Task> = plan.task(root).into_iter().collect();
    let mut seen: BTreeSet<TaskId> = out.iter().map(|t| t.id.clone()).collect();
    let mut i = 0;
    while i < out.len() {
        let id = out[i].id.clone();
        let mut kids: Vec<&Task> = plan.subtasks(&id).collect();
        kids.sort_by(|x, y| x.id.cmp(&y.id));
        for k in kids {
            if seen.insert(k.id.clone()) {
                out.push(k);
            }
        }
        i += 1;
    }
    out
}

/// Whether nothing will move this task again unless a person does — the only kind that
/// is safe to hide, given that hiding does not park it.
///
/// A draft counts: nothing dispatches a draft, so a mis-scoped one can be put away
/// without first being dropped. `failed` does not — it is waiting on a decision, and a
/// decision nobody can see is one nobody makes.
fn is_settled(t: &Task) -> bool {
    t.status.is_closed() || t.status == TaskStatus::Draft
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

    /// A scaffolded workspace holding `layer` → `keys` → `salt`, so the filing commands
    /// can be run for real rather than reasoned about.
    ///
    /// Each test gets its own directory: they run in parallel, and a shared database
    /// file means one test wipes another's state mid-write. The plan is seeded through
    /// the store rather than through `task add`, which would want a repository on disk
    /// and a playbook to read out of it.
    fn org(name: &str) -> (String, Store) {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
        let dir = std::path::Path::new(&base).join(format!("wecode-filing-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        wecode_org::workspace::init(&dir, "solo").expect("scaffold");

        let store = Store::open(dir.join("wecode.db")).expect("store");
        let project = Project::new("caching", "cut export p99 below 500ms", "app");
        store.save_project(&project).unwrap();
        store
            .save_task(&Task::new("layer", "caching", "write the cache layer"))
            .unwrap();
        store
            .save_task(&Task::new("keys", "caching", "design the cache keys").under("layer"))
            .unwrap();
        store
            .save_task(&Task::new("salt", "caching", "pick the salt").under("keys"))
            .unwrap();
        // A task that waits on the group without being part of it.
        store
            .save_task(&Task::new("bench", "caching", "benchmark the cache").after("layer"))
            .unwrap();
        (dir.to_string_lossy().into_owned(), store)
    }

    /// `wecode archive|unarchive task <id>` against that workspace, as the operator.
    fn filing(dir: &str, verb: &str, id: &str, force: bool) -> Res {
        let mut argv = vec![verb, "task", id, "--org", dir, "--as", "operator"];
        if force {
            argv.push("--force");
        }
        set_archived(&parse(&argv), verb == "archive")
    }

    #[test]
    fn filing_a_task_away_takes_its_subtasks_and_counts_them() {
        let (dir, store) = org("cascade");
        let out = filing(&dir, "archive", "layer", false).unwrap();
        assert!(out.contains("archived layer and its 2 subtasks"), "{out}");

        let plan = store.load_plan().unwrap();
        for id in ["layer", "keys", "salt"] {
            assert!(!plan.task(&id.into()).unwrap().is_visible(), "{id}");
        }
        assert!(
            plan.task(&"bench".into()).unwrap().is_visible(),
            "waiting on the group is not being part of it"
        );
    }

    #[test]
    fn filing_the_same_group_twice_is_not_an_error() {
        let (dir, _store) = org("twice");
        filing(&dir, "archive", "layer", false).unwrap();
        let out = filing(&dir, "archive", "layer", false).unwrap();
        assert!(
            out.contains("already archived"),
            "the second time says so rather than reporting work it did not do:\n{out}"
        );
    }

    #[test]
    fn unfiling_brings_the_whole_group_back() {
        let (dir, store) = org("back");
        filing(&dir, "archive", "layer", false).unwrap();
        let out = filing(&dir, "unarchive", "layer", false).unwrap();
        assert!(out.contains("2 subtasks visible again"), "{out}");
        let plan = store.load_plan().unwrap();
        for id in ["layer", "keys", "salt"] {
            assert!(plan.task(&id.into()).unwrap().is_visible(), "{id}");
        }
    }

    #[test]
    fn a_subtask_can_be_filed_away_on_its_own() {
        let (dir, store) = org("subtask");
        let out = filing(&dir, "archive", "keys", false).unwrap();
        assert!(out.contains("archived keys and its subtask"), "{out}");
        let plan = store.load_plan().unwrap();
        assert!(
            plan.task(&"layer".into()).unwrap().is_visible(),
            "filing reaches down, never up"
        );
        assert!(!plan.task(&"salt".into()).unwrap().is_visible());
    }

    #[test]
    fn work_that_could_still_move_is_not_filed_away_by_accident() {
        // The load-bearing guard. Filing does not park a task the way archiving parks a
        // project, so a hidden `ready` row would be dispatched with nothing on screen
        // saying so.
        let (dir, store) = org("live");
        store
            .set_task_status(&"keys".into(), TaskStatus::Ready)
            .unwrap();

        let err = filing(&dir, "archive", "layer", false)
            .expect_err("should refuse")
            .to_string();
        assert!(err.contains("keys"), "it names the row: {err}");
        assert!(err.contains("--force"), "{err}");
        let plan = store.load_plan().unwrap();
        let keys = plan.task(&"keys".into()).unwrap();
        assert!(keys.is_visible(), "nothing was written");

        let out = filing(&dir, "archive", "layer", true).unwrap();
        assert!(out.contains("archived layer"), "{out}");
    }

    #[test]
    fn a_bare_id_that_names_a_task_says_which_form_to_type() {
        // The bare form is the one an operator reaches for first, so its refusal is
        // where the task form is discovered.
        let (dir, _store) = org("bare");
        let bare = ["archive", "layer", "--org", &dir, "--as", "operator"];
        let err = set_archived(&parse(&bare), true)
            .expect_err("a task is not a project")
            .to_string();
        assert!(err.contains("projects, not tasks"), "{err}");
        assert!(err.contains("archive task layer"), "{err}");
    }
}
