//! `wecode` — the single control driver.

mod args;
mod board;
mod git;
mod render;
mod tui;
mod verify;
mod work;

use std::process::ExitCode;

use std::path::PathBuf;

use args::Args;
use wecode_core::{
    Admission, Budget, Cmp, Measure, Plan, Project, ProjectId, ProjectStatus, Scope, Task, TaskId,
    TaskKind, TaskStatus, admission,
};
use wecode_gov::{Action, ActionKind, Broker, Effective, Grant, Session, WorkKind, glob};
use wecode_org::{Company, Playbook, Post, Workspace, playbook, workspace};
use wecode_store::{AuditQuery, Store};

const USAGE: &str = "\
wecode — run coding agents as staff

A company is a self-contained directory: company.toml by hand, wecode.db by
machine. It is not a code repository; the repos it works on are declared inside it
by path.

SESSION
  wecode orgs                          named orgs under ~/.wecode/workspaces
  wecode use <name|dir>                remember a default org (skips --org)
  wecode login <user> [--as <post>] [--agent <n>]   open a session
  wecode whoami                        this seat, and the commands it may call
  wecode who                           everything connected right now
  wecode logout [--session <id>] [--all]

SETUP
  wecode init <name|dir> [--template <t>] scaffold a company workspace
        a bare name lands in ~/.wecode/workspaces/<name>
  wecode templates                        list available templates
  wecode company show                     profile, posts, invariants

  Commands find the workspace by walking up from the working directory, or via
  --org <name|dir> / $WECODE_ORG / the default set by `wecode use`.

PLAN
  A project owns one repo and carries an objective. A task is the executable unit.

  wecode project add <id> --repo <name> \"<objective>\"
        --measure-cmd \"<cmd>\"   --measure-metric <name>:<lt|lte|gt|gte|eq>:<n>
        --tokens <n>  --wall <secs>
  wecode project list

  wecode task add <id> --project <p> \"<title>\"
        --kind <feature|bug|refactor|chore|spike|docs>   default: feature
        --parent <task>          is part of that task
        --after <task>           must come after it (repeatable)
        --accept-cmd \"<cmd>\"     executable acceptance (repeatable)
        --accept-metric <name>:<cmp>:<target>
        --write <glob>  --read <glob>   scope (repeatable)
        --tokens <n>  --wall <secs>     --to <post>
        --force                  save despite defects, recorded as waivers
  wecode task scope <id> --write <glob> [--read <glob>]
        replace a scope after the fact; recorded violations are not erased

  wecode playbook [<kind>]             this project's guidance for that kind
        --project <p>   init            `init` writes a starter into the repo
  wecode brief                         who you are and how to work — read this first
  wecode tree [--all]                  projects and their task trees
  wecode ready                         what is schedulable right now
  wecode show <id>                     one project or task in full
  wecode check <id>                    the admission verdict
  wecode status <project|task> <status>   set a status by hand
  wecode archive <project> | unarchive <project>
        hide a project from the cockpit, or bring it back (--force if work is live)

COCKPIT
  wecode up                            live dashboard: j/k move, enter descend, q quit
  wecode board [<id>] [--all]          the same view as a one-shot snapshot

WORK
  wecode assign <task> --to <post>     check the post may do it, then make it ready
  wecode start <task>                  worktree + envelope; marks it running
  wecode verify <task>                 judge it: diff against scope, then acceptance
  wecode worktree [remove <task>]      list them, or remove one (--force if dirty)
  wecode approve <merge|admission|budget|measure> [<what>] --as <post>
  wecode guard <post> <verb> <target>  authorise an action; records the decision
        verbs: read write run merge spend        --tokens <n> for spend
        --task <id> / --project <id> attributes the record
  wecode audit [--denied] [--alarms] [--path <glob>] [--project <p>] [--task <t>]
";

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let a = Args::parse(argv);

    match run(&a) {
        Ok(out) => {
            print!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

type Res = Result<String, Box<dyn std::error::Error>>;

fn run(a: &Args) -> Res {
    match (a.cmd(0), a.cmd(1)) {
        ("init", _) => init(a),
        ("templates", _) => Ok(render::templates()),
        ("company", "show") | ("org", "show") => {
            let (_, company) = open(a)?;
            Ok(render::company(&company))
        }
        ("project", "add") => project_add(a),
        ("project", "list") | ("projects", _) => {
            let (store, _) = open(a)?;
            Ok(render::tree(&store.load_plan()?, a.has("all")))
        }
        ("task", "add") => task_add(a),
        ("task", "scope") => task_scope(a),
        ("tree", _) => {
            let (store, _) = open(a)?;
            Ok(render::tree(&store.load_plan()?, a.has("all")))
        }
        ("ready", _) => {
            let (store, _) = open(a)?;
            Ok(render::ready(&store.load_plan()?))
        }
        ("playbook", "init") => playbook_init(a),
        ("playbook", _) => playbook_show(a),
        ("brief", _) => brief(a),
        ("start", _) => start(a),
        ("verify", _) => verify_task(a),
        ("worktree", "remove") | ("worktree", "rm") => worktree_remove(a),
        ("worktree", _) => worktree_list(a),
        ("archive", _) => set_archived(a, true),
        ("unarchive", _) => set_archived(a, false),
        ("show", _) => show(a),
        ("check", _) => check(a),
        ("status", _) => set_status(a),
        ("board", _) => board(a),
        ("up", _) | ("cockpit", _) => cockpit(a),
        ("assign", _) => assign(a),
        ("use", _) => use_org(a),
        ("orgs", _) => Ok(render::orgs()),
        ("login", _) => login(a),
        ("logout", _) => logout(a),
        ("who", _) => who(a),
        ("whoami", _) => whoami(a),
        ("approve", _) => approve(a),
        ("guard", _) => guard(a),
        ("audit", _) => audit(a),
        ("", _) | ("help", _) | ("--help", _) => Ok(USAGE.to_string()),
        (cmd, sub) => Err(format!("unknown command `{cmd} {sub}`\n\n{USAGE}").into()),
    }
}

/// Resolves the workspace, then its store and validated profile.
fn open(a: &Args) -> Result<(Store, Company), Box<dyn std::error::Error>> {
    let (_, store, company) = open_full(a)?;
    Ok((store, company))
}

/// The same, keeping the workspace — needed by anything that resolves a repo path or
/// names the run directory.
fn open_full(a: &Args) -> Result<(Workspace, Store, Company), Box<dyn std::error::Error>> {
    let ws = workspace::resolve(a.get("org"))?;
    let company = ws.load()?;
    let store = Store::open(ws.db_path())?;
    Ok((ws, store, company))
}

/// Resolves which project is meant, the way sessions resolve: one is unambiguous,
/// several need naming.
fn which_project(
    a: &Args,
    plan: &Plan,
) -> Result<wecode_core::Project, Box<dyn std::error::Error>> {
    if let Some(id) = a.get("project") {
        return plan
            .project(&ProjectId::new(id))
            .cloned()
            .ok_or_else(|| format!("no such project: {id}").into());
    }
    let all: Vec<&wecode_core::Project> = plan.projects().collect();
    match all.len() {
        1 => Ok(all[0].clone()),
        0 => {
            Err("no projects yet — `wecode project add <id> --repo <name> \"<objective>\"`".into())
        }
        _ => {
            let names: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
            Err(format!(
                "several projects — name one with --project: {}",
                names.join(", ")
            )
            .into())
        }
    }
}

/// The absolute path of a project's repository.
fn repo_path(
    company: &Company,
    project: &wecode_core::Project,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let repo = company.repo(&project.repo).ok_or_else(|| {
        format!(
            "project `{}` names repo `{}`, which is not in [[repos]] — have: {}",
            project.id,
            project.repo,
            company.repo_names().join(", ")
        )
    })?;
    Ok(workspace::expand_home(&repo.path))
}

/// The project's playbook, if it has one. A project without one keeps working.
fn playbook_of(
    company: &Company,
    project: &wecode_core::Project,
) -> Result<Option<Playbook>, Box<dyn std::error::Error>> {
    Ok(Playbook::at(&repo_path(company, project)?)?)
}

fn require<'a>(value: &'a str, what: &str) -> Result<&'a str, String> {
    if value.is_empty() {
        Err(format!("missing {what}"))
    } else {
        Ok(value)
    }
}

fn init(a: &Args) -> Res {
    let dir = require(a.cmd(1), "org name or directory")?;
    let template = a.get("template").unwrap_or("software-company");
    // A bare name lands in ~/.wecode/workspaces; a path is taken as given.
    let root = workspace::locate(dir);

    let written = workspace::init(&root, template)?;
    let company = Workspace::at(&root).load()?;

    let mut out = format!("created {} from template `{template}`\n\n", root.display());
    for p in &written {
        out.push_str(&format!("  {}\n", p.display()));
    }
    out.push_str(&format!(
        "\n{} — {} posts, {} roles\n\nnext:\n  cd {}\n  wecode company show\n  edit company.toml, then point [[repos]] at your code\n",
        company.name,
        company.posts.len(),
        company.roles.len(),
        root.display()
    ));
    Ok(out)
}

fn parse_metric(spec: &str, flag: &str) -> Result<Measure, String> {
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

fn budget_from(a: &Args) -> Option<Budget> {
    (a.has("tokens") || a.has("wall")).then(|| Budget {
        tokens: a.num("tokens"),
        wall_secs: a.num("wall"),
    })
}

fn scope_from(a: &Args) -> Option<Scope> {
    let read: Vec<&str> = a.all("read");
    let write: Vec<&str> = a.all("write");
    (!read.is_empty() || !write.is_empty()).then(|| Scope {
        read: read.iter().map(|s| (*s).to_string()).collect(),
        write: write.iter().map(|s| (*s).to_string()).collect(),
    })
}

fn project_add(a: &Args) -> Res {
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

fn build_task(a: &Args) -> Result<Task, Box<dyn std::error::Error>> {
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

fn task_add(a: &Args) -> Res {
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

fn blocker_note(b: &wecode_core::Blocker) -> String {
    match b {
        wecode_core::Blocker::Waiting(id) => format!("{id} is not done"),
        wecode_core::Blocker::Missing(id) => format!("{id} does not exist"),
    }
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
fn task_scope(a: &Args) -> Res {
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
fn show(a: &Args) -> Res {
    let (store, _) = open(a)?;
    let id = require(a.cmd(1), "project or task id")?;
    let plan = store.load_plan()?;

    if plan.project(&ProjectId::new(id)).is_some() {
        return Ok(render::project_detail(&plan, &ProjectId::new(id)));
    }
    if plan.task(&TaskId::new(id)).is_some() {
        return Ok(render::task_detail(&plan, &TaskId::new(id)));
    }
    Err(format!("no project or task `{id}` — `wecode tree` lists both").into())
}

fn check(a: &Args) -> Res {
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
fn set_status(a: &Args) -> Res {
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
fn set_archived(a: &Args, archived: bool) -> Res {
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
fn assign(a: &Args) -> Res {
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

    let grant = company
        .grant_of(&post)
        .ok_or_else(|| format!("post `{post_name}` has no role grant"))?;
    let uncovered: Vec<&str> = task
        .scope
        .write
        .iter()
        .filter(|w| !grant.write.iter().any(|g| glob::covers(g, w)))
        .map(String::as_str)
        .collect();

    if !uncovered.is_empty() {
        return Err(format!(
            "post `{post_name}` (role {}) may not write {} — it writes only: {}\n\
             \x20 assign a post whose scope covers the work, or widen the role",
            post.role,
            uncovered.join(", "),
            if grant.write.is_empty() {
                "nothing".to_string()
            } else {
                grant.write.join(", ")
            }
        )
        .into());
    }

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

/// The repos a project may name. Empty means "unchecked", so this must come from
/// the profile rather than being defaulted at each call site.
fn repo_names(company: &Company) -> Vec<String> {
    company.repos.iter().map(|r| r.name.clone()).collect()
}

// -------------------------------------------------------------- playbook ------

/// Prints a project's guidance. This is what an orchestrator reads before it
/// decomposes a request into tasks.
fn playbook_show(a: &Args) -> Res {
    let (_, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let project = which_project(a, &plan)?;
    let path = repo_path(&company, &project)?;

    let Some(pb) = playbook_of(&company, &project)? else {
        return Ok(format!(
            "project {} has no playbook\n  {}\n  wecode playbook init --project {}  writes a starter\n",
            project.id,
            path.join(playbook::PLAYBOOK_PATH).display(),
            project.id
        ));
    };

    match a.cmd(1) {
        "" => Ok(render::playbook_all(&project, &pb)),
        want => {
            let kind = TaskKind::parse(want).ok_or_else(|| {
                format!(
                    "unknown kind `{want}` — have: {}",
                    TaskKind::all()
                        .iter()
                        .map(|k| k.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;
            Ok(render::playbook_kind(&project, &pb, kind))
        }
    }
}

/// Writes a starter playbook into the project's repo.
fn playbook_init(a: &Args) -> Res {
    let (_, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let project = which_project(a, &plan)?;
    let repo = repo_path(&company, &project)?;

    if !repo.is_dir() {
        return Err(format!(
            "repo `{}` is not a directory: {}",
            project.repo,
            repo.display()
        )
        .into());
    }
    let language = a.get("language").unwrap_or("");
    let path = playbook::init(&repo, language)?;
    Ok(format!(
        "  wrote {}\n\n  Fill in the guidance for each kind, then:\n    wecode playbook bug --project {}\n\n  Commit it — it describes this code, so it belongs with it.\n  Add {}/ to .gitignore; it is the worker-writable area.\n",
        path.display(),
        project.id,
        playbook::RUN_DIR
    ))
}

// ----------------------------------------------------------------- brief ------

/// Orients an agent: who it is, what it may do, and where the guidance lives.
///
/// Derived from the grant rather than stored as a prompt. A hand-written briefing
/// drifts from the roles the moment one is edited, and then tells an agent it has
/// authority the Broker will refuse.
fn brief(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let live = store.sessions(company.session_ttl)?;
    let Some(s) = live.first() else {
        return Ok(format!("{}\n", no_session_error(&company)));
    };
    let post = find_post(&company, &s.post)?;
    let grant = company.grant_of(&post);
    let plan = store.load_plan()?;

    let mut playbooks = Vec::new();
    for p in plan.projects() {
        let kinds = playbook_of(&company, p)
            .ok()
            .flatten()
            .map(|pb| {
                pb.kinds()
                    .iter()
                    .map(|(k, _)| k.as_str())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        playbooks.push((p.clone(), kinds));
    }

    Ok(render::brief(
        &company,
        s,
        &post,
        grant,
        &plan,
        &playbooks,
        work::org_name(ws.root()),
    ))
}

// ------------------------------------------------------------------ work ------

/// Begins work on a task: prepares the worktree its playbook asks for, marks it
/// running, and prints the envelope for whoever does the work.
fn start(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let id = TaskId::new(require(a.cmd(1), "task id")?);
    let plan = store.load_plan()?;
    let task = plan
        .task(&id)
        .ok_or_else(|| format!("no such task: {id}"))?
        .clone();

    if task.status.is_closed() {
        return Err(format!(
            "{id} is {} — reopen it with `wecode status {id} waiting` first",
            task.status.as_str()
        )
        .into());
    }
    let defects = admission::check_task(&task, &plan);
    if !defects.is_empty() {
        let mut out = render::admission(&render::task_heading(&task), &defects, None);
        out.push_str("\n  not started — a draft cannot be worked on\n");
        return Ok(out);
    }
    let blockers = plan.blockers(&id);
    if !blockers.is_empty() {
        let mut out = format!("  {id} is not ready\n");
        for b in &blockers {
            out.push_str(&format!("    waiting on {}\n", blocker_note(b)));
        }
        return Ok(out);
    }

    let project = plan
        .project(&task.project)
        .ok_or_else(|| format!("no such project: {}", task.project))?;
    let pb = playbook_of(&company, project)?;

    // The worktree belongs to the main task, so a subtask joins its parent's tree
    // rather than opening a second checkout of the same work.
    let owner = work::owner(&plan, &id).expect("task is in the plan");
    let kind_pb = pb.as_ref().and_then(|p| p.for_kind(owner.kind));
    let wants_worktree = kind_pb.is_some_and(|k| k.worktree);

    let mut out = String::new();
    let mut cwd = repo_path(&company, project)?;

    if wants_worktree {
        let branch = work::branch_for(&owner.id);
        let path = work::worktree_for(&work::org_name(ws.root()), &owner.id);
        let repo = repo_path(&company, project)?;
        if !git::is_repo(&repo) {
            return Err(format!("{} is not a git repository", repo.display()).into());
        }
        // The playbook's integration branch when it names one, else wherever the
        // repo is standing. Guessing a name like "dev" would fail on repos that
        // have no such branch.
        let base = match pb.as_ref().and_then(|p| p.project.merge_to.clone()) {
            Some(b) => Some(b),
            None => git::current_branch(&repo)?,
        };

        if path.is_dir() {
            git::reset_hard(&path)?;
            out.push_str(&format!("  worktree {} (reset)\n", path.display()));
        } else {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            git::worktree_add(&repo, &path, &branch, base.as_deref())?;
            out.push_str(&format!("  worktree {}\n", path.display()));
        }
        out.push_str(&format!("  branch   {branch}\n"));
        if owner.id != id {
            out.push_str(&format!("  shared with {} (its main task)\n", owner.id));
        }
        cwd = path;
    } else {
        out.push_str(&format!(
            "  no worktree — the {} playbook does not ask for one\n  work in {}\n",
            owner.kind.as_str(),
            cwd.display()
        ));
    }

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
    out.push_str(&format!("  status   {} → running\n", task.status.as_str()));

    out.push('\n');
    out.push_str(&render::envelope(
        &company.templates.task_envelope,
        &task,
        project,
        &plan,
        &cwd,
    ));
    Ok(out)
}

/// Judges a finished task from its diff and its acceptance commands.
///
/// Nothing here asks the agent how it went. The diff is ground truth, the exit codes
/// are ours, and both reach the ledger as `Source::Supervisor` — observed, not
/// self-reported, and therefore admissible.
fn verify_task(a: &Args) -> Res {
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

    let mut v = verify::run_acceptance(&dir, &task.acceptance);
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
    for c in &v.checks {
        broker.observe(
            &session,
            Action::Run {
                argv: vec![c.cmd.clone()],
            },
            if c.passed() {
                wecode_gov::Decision::Allow
            } else {
                wecode_gov::Decision::Deny {
                    reason: wecode_gov::DenyReason::CommandNotPermitted {
                        argv: format!("{} — {}", c.cmd, c.describe()),
                    },
                    mode: wecode_gov::ControlMode::Sanctioned,
                    alarm: false,
                }
            },
            wecode_gov::Source::Supervisor,
        );
    }
    store.append_records(broker.ledger())?;

    let next = if v.passed() {
        // Passing acceptance is not the same as landed. A task with a worktree has a
        // branch nobody has merged, and merging is a signature wecode does not yet
        // collect — so it waits for a person rather than claiming to be done.
        if dir.starts_with(work::run_root()) {
            TaskStatus::NeedsApproval
        } else {
            TaskStatus::Done
        }
    } else {
        TaskStatus::Failed
    };
    store.set_task_status(&id, next)?;

    Ok(render::verdict(&task, &dir, &v, next))
}

fn worktree_list(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let org = work::org_name(ws.root());

    let mut rows = Vec::new();
    // `all_projects`: archiving must not make a checkout unreachable. A worktree you
    // cannot see is one you cannot clean up.
    for p in plan.all_projects() {
        let repo = repo_path(&company, p)?;
        if !git::is_repo(&repo) {
            continue;
        }
        for path in git::worktree_list(&repo)? {
            let owned = plan
                .tasks_of(&p.id)
                .find(|t| work::worktree_for(&org, &t.id).to_string_lossy() == path)
                .map(|t| (t.id.to_string(), t.status));
            rows.push((path, p.id.to_string(), owned));
        }
    }
    Ok(render::worktrees(&rows))
}

fn worktree_remove(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let id = TaskId::new(require(a.cmd(2), "task id")?);
    let plan = store.load_plan()?;
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
    let path = work::worktree_for(&work::org_name(ws.root()), &id);
    if !path.exists() {
        return Ok(format!("  no worktree at {}\n", path.display()));
    }
    let repo = repo_path(&company, project)?;

    // Uncommitted work in a worktree is unrecoverable once the tree is gone, and
    // nothing has committed it yet — wecode does that, after checks pass.
    let dirty = git::changed_files(&path).unwrap_or_default();
    if !dirty.is_empty() && !a.has("force") {
        let mut msg = format!(
            "{id} has {} uncommitted change{} — removing the worktree would lose them:\n",
            dirty.len(),
            if dirty.len() == 1 { "" } else { "s" }
        );
        for f in dirty.iter().take(10) {
            msg.push_str(&format!("    {f}\n"));
        }
        msg.push_str("  pass --force to discard them");
        return Err(msg.into());
    }

    git::worktree_remove(&repo, &path)?;
    let mut out = format!("  removed {}\n", path.display());
    if !dirty.is_empty() {
        out.push_str(&format!(
            "  discarded {} uncommitted change(s)\n",
            dirty.len()
        ));
    }
    out.push_str(&format!(
        "  branch {} kept — delete it once merged\n",
        work::branch_for(&id)
    ));
    Ok(out)
}

fn find_post(company: &Company, name: &str) -> Result<Post, String> {
    company.post(name).cloned().ok_or_else(|| {
        format!(
            "no such post `{name}` — have: {}",
            company
                .posts
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

/// Whoever an action is performed by: a seat, the agent typing for it, and the
/// human in it when there is one.
struct Actor {
    post: String,
    agent: String,
    human: Option<String>,
    session: String,
    effective: Effective,
}

impl Actor {
    /// The root grant. Reachable only by typing `--as operator` — never by
    /// omitting a flag, which is how authority used to leak.
    fn operator() -> Self {
        Self {
            post: "operator".into(),
            agent: "cli".into(),
            human: None,
            session: "operator".into(),
            effective: Effective::of(vec![Grant::root()]),
        }
    }

    fn of(company: &Company, post: &Post, session: &str, human: Option<String>) -> Self {
        Self {
            post: post.name.clone(),
            agent: std::env::var("WECODE_AGENT").unwrap_or_else(|_| post.agent.clone()),
            human,
            session: session.to_string(),
            effective: company.effective(post),
        }
    }

    fn describe(&self) -> String {
        match &self.human {
            Some(h) => format!("{} ({h} via {})", self.post, self.agent),
            None => format!("{} ({})", self.post, self.agent),
        }
    }
}

/// Resolves who is acting, in one order, for every state-changing command:
///
/// 1. `--session <id>`
/// 2. `$WECODE_SESSION`
/// 3. exactly one active session — the solo case
/// 4. `--as <post>` — a deliberate override
/// 5. refuse
///
/// Step 5 is the point. Nothing reaches the root grant by omission.
fn actor(a: &Args, store: &Store, company: &Company) -> Result<Actor, Box<dyn std::error::Error>> {
    if let Some(name) = a.get("as") {
        if name == "operator" {
            return Ok(Actor::operator());
        }
        let post = find_post(company, name)?;
        let human = company.users_of(&post.name).first().map(|u| u.name.clone());
        return Ok(Actor::of(company, &post, "adhoc", human));
    }

    let live = store.sessions(company.session_ttl)?;
    let wanted = a
        .get("session")
        .map(str::to_string)
        .or_else(|| std::env::var("WECODE_SESSION").ok());

    let chosen = match wanted {
        Some(id) => live.iter().find(|s| s.id == id).cloned().ok_or_else(|| {
            format!("session `{id}` is not active — `wecode who` lists live ones")
        })?,
        None => match live.len() {
            1 => live[0].clone(),
            0 => {
                return Err(no_session_error(company).into());
            }
            _ => {
                let mut msg =
                    String::from("several sessions are active — name one with --session:\n");
                for s in &live {
                    msg.push_str(&format!("  {}  {}  {}\n", s.id, s.post, s.who()));
                }
                return Err(msg.into());
            }
        },
    };

    store.touch(&chosen.id)?;
    let post = find_post(company, &chosen.post)?;
    Ok(Actor::of(company, &post, &chosen.id, chosen.human.clone()))
}

fn no_session_error(company: &Company) -> String {
    let mut msg = String::from("not logged in — `wecode login <user>`\n");
    if company.users.is_empty() {
        msg.push_str("  no users declared; add a [[users]] block to company.toml\n");
    } else {
        msg.push_str("  users: ");
        msg.push_str(
            &company
                .users
                .iter()
                .map(|u| format!("{} ({})", u.name, u.post))
                .collect::<Vec<_>>()
                .join(", "),
        );
        msg.push('\n');
    }
    msg.push_str("  or act explicitly with --as <post>");
    msg
}

/// Runs one action past the Broker under an actor's authority, and records it.
///
/// `on` is the attribution: the project and task the action is for. An audit
/// record with neither cannot be correlated with anything, which is why both are
/// threaded through rather than defaulted.
fn record(
    store: &Store,
    company: &Company,
    actor: &Actor,
    on: (Option<String>, Option<String>),
    action: &Action,
) -> Result<wecode_gov::Decision, Box<dyn std::error::Error>> {
    let mut broker = Broker::new(company.charter.clone());
    let session = Session::new(
        actor.session.clone(),
        actor.post.clone(),
        actor.agent.clone(),
        actor.effective.clone(),
    )
    .on(on.0, on.1)
    .with_human(actor.human.clone());
    let decision = broker.authorize(&session, action);
    store.append_records(broker.ledger())?;
    Ok(decision)
}

/// Records an action and fails unless it was allowed.
///
/// `record` alone returns the verdict; earlier code discarded it, which meant a
/// denial was logged and then ignored. Nothing that changes state may do that.
fn require_allowed(
    store: &Store,
    company: &Company,
    actor: &Actor,
    on: (Option<String>, Option<String>),
    action: &Action,
    what: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    match record(store, company, actor, on, action)? {
        wecode_gov::Decision::Allow => Ok(()),
        wecode_gov::Decision::RequireApproval { by } => Err(format!(
            "{what} needs approval: {}\n  a holder must sign: wecode approve {} --as <post>",
            by.as_str(),
            by.as_str()
        )
        .into()),
        wecode_gov::Decision::Deny { reason, alarm, .. } => Err(format!(
            "{what} refused for `{}`: {reason}{}",
            actor.post,
            if alarm {
                "\n  ⚡ charter invariant — recorded as an alarm"
            } else {
                ""
            }
        )
        .into()),
    }
}

fn parse_action(a: &Args) -> Result<Action, String> {
    let verb = a.cmd(2);
    let target = a.cmd(3);
    Ok(match verb {
        "read" => Action::Read {
            path: require(target, "path")?.to_string(),
        },
        "write" => Action::Write {
            path: require(target, "path")?.to_string(),
        },
        "run" => Action::Run {
            argv: require(target, "command")?
                .split_whitespace()
                .map(str::to_string)
                .collect(),
        },
        "merge" => Action::Merge {
            branch: require(target, "branch")?.to_string(),
        },
        "spend" => Action::Spend {
            tokens: a.num("tokens").unwrap_or(0),
            wall_secs: a.num("wall").unwrap_or(0),
        },
        other => {
            return Err(format!(
                "unknown verb `{other}` (read write run merge spend)"
            ));
        }
    })
}

/// What a record is attributed to. A task implies its project, so naming the task
/// alone is enough — the project is looked up rather than typed twice.
fn attribution(a: &Args, plan: &Plan) -> (Option<String>, Option<String>) {
    let task = a.get("task").map(str::to_string);
    let project = a.get("project").map(str::to_string).or_else(|| {
        task.as_ref()
            .and_then(|t| plan.task(&TaskId::new(t)))
            .map(|t| t.project.to_string())
    });
    (project, task)
}

fn guard(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let post = find_post(&company, require(a.cmd(1), "post")?)?;
    let action = parse_action(a)?;
    let on = attribution(a, &store.load_plan()?);
    let human = company.users_of(&post.name).first().map(|u| u.name.clone());
    let who = Actor::of(&company, &post, "guard", human);
    let decision = record(&store, &company, &who, on, &action)?;
    Ok(render::decision(
        &post.name,
        &post.agent,
        &action,
        &decision,
    ))
}

/// The live cockpit: full-screen, navigable, reloads as state changes.
fn cockpit(a: &Args) -> Res {
    let (store, company) = open(a)?;
    if !tui::is_tty() {
        return Err("wecode up needs a terminal — try `wecode board` for a snapshot".into());
    }
    tui::run(store, company)?;
    Ok(String::new())
}

/// A snapshot of the same view, for pipes and logs.
fn board(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let known_repos = repo_names(&company);
    let plan = store.load_plan()?;
    let audit = store.audit(&AuditQuery::default())?;
    match a.cmd(1) {
        "" => Ok(board::portfolio(&plan, &audit, &known_repos, a.has("all"))),
        id => Ok(board::focus(&plan, &audit, id, &known_repos)),
    }
}

/// Remembers a workspace as the default, so later commands need no --org.
fn use_org(a: &Args) -> Res {
    let dir = require(a.cmd(1), "workspace directory")?;
    let ws = Workspace::at(workspace::locate(dir));
    if !ws.exists() {
        return Err(format!("{} is not a company workspace", ws.root().display()).into());
    }
    let company = ws.load()?;
    workspace::set_default(&ws)?;
    Ok(format!(
        "  default org is now {} ({})\n",
        company.name,
        ws.root().display()
    ))
}

fn login(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let name = require(a.cmd(1), "user name")?;

    let user = company
        .user(name)
        .ok_or_else(|| no_session_error(&company))?
        .clone();
    let post_name = a.get("as").unwrap_or(&user.post).to_string();
    let post = find_post(&company, &post_name)?;
    let agent = a
        .get("agent")
        .map(str::to_string)
        .unwrap_or_else(|| post.agent.clone());

    let s = store.login(&post.name, &agent, Some(user.name.as_str()))?;
    let grant = company.grant_of(&post);

    let mut out = format!("  session {}  ({})\n\n", s.id, s.who());
    out.push_str(&render::whoami(&company, &s, &post, grant));
    Ok(out)
}

fn logout(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let live = store.sessions(company.session_ttl)?;

    // An autonomous session ends with its task, not with a human leaving.
    let mut closed = Vec::new();
    if a.has("all") {
        for s in live.iter().filter(|s| !s.is_autonomous()) {
            store.logout(&s.id)?;
            closed.push(s.id.clone());
        }
    } else if let Some(id) = a.get("session") {
        store.logout(id)?;
        closed.push(id.to_string());
    } else {
        match live.iter().filter(|s| !s.is_autonomous()).count() {
            1 => {
                let s = live
                    .iter()
                    .find(|s| !s.is_autonomous())
                    .expect("counted one");
                store.logout(&s.id)?;
                closed.push(s.id.clone());
            }
            0 => return Ok("  no interactive session to close\n".into()),
            _ => return Err("several sessions — name one with --session, or --all".into()),
        }
    }
    Ok(format!("  closed {}\n", closed.join(", ")))
}

fn who(a: &Args) -> Res {
    let (store, company) = open(a)?;
    Ok(render::who(
        &store.sessions_all()?,
        company.session_ttl,
        wecode_store::now_secs(),
    ))
}

fn whoami(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let live = store.sessions(company.session_ttl)?;
    let Some(s) = live.first() else {
        return Ok(format!("{}\n", no_session_error(&company)));
    };
    let s = a
        .get("session")
        .and_then(|id| live.iter().find(|x| x.id == id))
        .unwrap_or(s);
    let post = find_post(&company, &s.post)?;
    Ok(render::whoami(&company, s, &post, company.grant_of(&post)))
}

/// A holder signs off on something the Broker gated.
fn approve(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let want = require(a.cmd(1), "what to approve")?;
    let kind = ActionKind::parse(want).ok_or_else(|| {
        format!(
            "unknown approval `{want}` — have: {}",
            ActionKind::all()
                .iter()
                .map(|k| k.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    let who = actor(a, &store, &company)?;
    let on = attribution(a, &store.load_plan()?);

    require_allowed(
        &store,
        &company,
        &who,
        on,
        &Action::Approve { kind },
        "approving",
    )?;
    Ok(format!(
        "  {} approved {}{}\n",
        who.describe(),
        kind.as_str(),
        if a.cmd(2).is_empty() {
            String::new()
        } else {
            format!(": {}", a.cmd(2))
        }
    ))
}

fn audit(a: &Args) -> Res {
    let (store, _) = open(a)?;
    // Filtering happens in SQL where the index is; only the glob, which SQLite
    // cannot express, is applied afterwards.
    let q = AuditQuery {
        denied_only: a.has("denied"),
        alarms_only: a.has("alarms"),
        project: a.get("project").map(str::to_string),
        task: a.get("task").map(str::to_string),
        limit: a.num("limit").map(|n| n as usize),
    };
    let mut lines = store.audit(&q)?;
    if let Some(pattern) = a.get("path") {
        lines.retain(|l| {
            matches!(l.action.as_str(), "read" | "write") && glob::matches(pattern, &l.target)
        });
    }
    Ok(render::audit(&lines))
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
    fn a_task_id_attributes_its_project_without_being_told() {
        // Attribution is what makes the ledger queryable, and asking for the
        // project twice is how it silently goes missing.
        let mut plan = Plan::new();
        plan.add_project(Project::new("export", "an objective sentence", "api"))
            .unwrap();
        plan.add_task(Task::new("cache", "export", "add a cache"))
            .unwrap();

        let (p, t) = attribution(&parse(&["--task", "cache"]), &plan);
        assert_eq!(p.as_deref(), Some("export"));
        assert_eq!(t.as_deref(), Some("cache"));
    }

    #[test]
    fn an_unknown_task_attributes_nothing_rather_than_guessing() {
        let (p, t) = attribution(&parse(&["--task", "ghost"]), &Plan::new());
        assert_eq!(p, None);
        assert_eq!(t.as_deref(), Some("ghost"));
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
