//! `wecode` — the single control driver.

mod args;
mod board;
mod render;
mod tui;

use std::process::ExitCode;

use args::Args;
use wecode_core::{
    Admission, Budget, Cmp, Measure, Plan, Project, ProjectId, Scope, Task, TaskId, TaskKind,
    TaskStatus, admission,
};
use wecode_gov::{Action, ActionKind, Broker, Effective, Grant, Session, WorkKind, glob};
use wecode_org::{Company, Post, Workspace, workspace};
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
        --kind <feature|bug|chore|spike|docs>     default: feature
        --parent <task>          is part of that task
        --after <task>           must come after it (repeatable)
        --accept-cmd \"<cmd>\"     executable acceptance (repeatable)
        --accept-metric <name>:<cmp>:<target>
        --write <glob>  --read <glob>   scope (repeatable)
        --tokens <n>  --wall <secs>     --to <post>
        --force                  save despite defects, recorded as waivers

  wecode tree                          projects and their task trees
  wecode ready                         what is schedulable right now
  wecode show <id>                     one project or task in full
  wecode check <id>                    the admission verdict
  wecode status <task> <status>        move a task by hand

COCKPIT
  wecode up                            live dashboard: j/k move, enter descend, q quit
  wecode board [<id>]                  the same view as a one-shot snapshot

WORK
  wecode assign <task> --to <post>     check the post may do it, then make it ready
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
            Ok(render::tree(&store.load_plan()?))
        }
        ("task", "add") => task_add(a),
        ("tree", _) => {
            let (store, _) = open(a)?;
            Ok(render::tree(&store.load_plan()?))
        }
        ("ready", _) => {
            let (store, _) = open(a)?;
            Ok(render::ready(&store.load_plan()?))
        }
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
    let ws = workspace::resolve(a.get("org"))?;
    let company = ws.load()?;
    let store = Store::open(ws.db_path())?;
    Ok((store, company))
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
    let t = build_task(a)?;

    if !store.project_exists(&t.project)? {
        return Err(format!(
            "no such project `{}` — `wecode project add {} --repo <name> \"<objective>\"` first",
            t.project, t.project
        )
        .into());
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

    let plan = store.load_plan()?;
    let defects = admission::check_task(&t, &plan);
    let verdict = Admission::decide(defects.clone(), "operator", Vec::new());
    let mut out = render::admission(&render::task_heading(&t), &defects, Some(&verdict));

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

/// Moves a task by hand. The scheduler will own most transitions; this exists so a
/// human can correct it, and so the seed can mark history.
fn set_status(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let id = TaskId::new(require(a.cmd(1), "task id")?);
    let want = require(a.cmd(2), "status")?;
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

    let plan = store.load_plan()?;
    let t = plan
        .task(&id)
        .ok_or_else(|| format!("no such task: {id}"))?;

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
        "" => Ok(board::portfolio(&plan, &audit, &known_repos)),
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
