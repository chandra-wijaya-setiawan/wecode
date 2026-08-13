//! What every command needs before it can do anything: the workspace, who is
//! acting, and the two helpers that put a decision past the Broker.
//!
//! Split out so a command module never reaches into another one.

use std::path::PathBuf;

use wecode_core::{Plan, ProjectId, Task, TaskId, TaskKind};
use wecode_gov::{Action, Broker, Effective, Grant, Session, glob};
use wecode_org::{Company, Playbook, Post, Workspace, workspace};
use wecode_store::Store;

use crate::args::Args;

pub(crate) type Res = Result<String, Box<dyn std::error::Error>>;

/// Resolves the workspace, then its store and validated profile.
pub(crate) fn open(a: &Args) -> Result<(Store, Company), Box<dyn std::error::Error>> {
    let (_, store, company) = open_full(a)?;
    Ok((store, company))
}

/// The same, keeping the workspace — needed by anything that resolves a repo path or
/// names the run directory.
pub(crate) fn open_full(
    a: &Args,
) -> Result<(Workspace, Store, Company), Box<dyn std::error::Error>> {
    let ws = workspace::resolve(a.get("org"))?;
    let company = ws.load()?;
    let store = Store::open(ws.db_path())?;
    Ok((ws, store, company))
}

/// Resolves which project is meant, the way sessions resolve: one is unambiguous,
/// several need naming.
pub(crate) fn which_project(
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
pub(crate) fn repo_path(
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
pub(crate) fn playbook_of(
    company: &Company,
    project: &wecode_core::Project,
) -> Result<Option<Playbook>, Box<dyn std::error::Error>> {
    Ok(Playbook::at(&repo_path(company, project)?)?)
}

/// The kinds a project's playbook refuses without a design — what `check_task`
/// takes. Resolved through one function so every admission site gates the same way.
///
/// A project whose playbook cannot be read gates nothing rather than failing: an
/// unregistered repo is already reported as its own defect, and a playbook that does
/// not parse fails loudly on every path that creates tasks. Neither should take the
/// board or a read-only verdict down with it.
pub(crate) fn design_gate(company: &Company, project: &wecode_core::Project) -> Vec<TaskKind> {
    playbook_of(company, project)
        .ok()
        .flatten()
        .map(|pb| pb.design_required_kinds())
        .unwrap_or_default()
}

/// The gate for every project at once — what the board and the cockpit consult per
/// row. Archived projects included: their rows are still drawn on request.
pub(crate) fn design_gates(company: &Company, plan: &Plan) -> crate::board::DesignGates {
    plan.all_projects()
        .map(|p| (p.id.clone(), design_gate(company, p)))
        .filter(|(_, kinds)| !kinds.is_empty())
        .collect()
}

pub(crate) fn require<'a>(value: &'a str, what: &str) -> Result<&'a str, String> {
    if value.is_empty() {
        Err(format!("missing {what}"))
    } else {
        Ok(value)
    }
}

pub(crate) fn blocker_note(b: &wecode_core::Blocker) -> String {
    match b {
        wecode_core::Blocker::Waiting(id) => format!("{id} is not done"),
        wecode_core::Blocker::Missing(id) => format!("{id} does not exist"),
    }
}

/// The repos a project may name. Empty means "unchecked", so this must come from
/// the profile rather than being defaulted at each call site.
pub(crate) fn repo_names(company: &Company) -> Vec<String> {
    company.repos.iter().map(|r| r.name.clone()).collect()
}

// -------------------------------------------------------------- playbook ------

/// Builds the arguments for a subcommand the loop invokes on the operator's behalf.
///
/// Carries the flags that say *who and where*, and nothing else — a stray `--force`
/// or `--all` inherited from the loop's own invocation would change what the
/// subcommand does.
pub(crate) fn forward(a: &Args, cmd: &str, target: &str) -> Args {
    let mut argv = vec![cmd.to_string(), target.to_string()];
    for flag in ["org", "session", "as"] {
        if let Some(v) = a.get(flag) {
            argv.push(format!("--{flag}"));
            argv.push(v.to_string());
        }
    }
    Args::parse(argv)
}

/// Refuses a post whose grant cannot reach the task's write scope.
///
/// Checked when the post is named rather than when the agent runs: a post that cannot
/// legally do the work will be refused at the boundary later anyway, and finding that
/// out after dispatch wastes an agent's whole run.
pub(crate) fn covers_the_work(company: &Company, post: &Post, task: &Task) -> Result<(), String> {
    let grant = company
        .grant_of(post)
        .ok_or_else(|| format!("post `{}` has no role grant", post.name))?;
    let uncovered: Vec<&str> = task
        .scope
        .write
        .iter()
        // The worker area is exempt here for the same reason it is exempt in
        // `verify`: the envelope instructs the agent to write its result there, so
        // no role needs a grant for it and declaring it must not break assignment.
        // The two checks have to agree or a natural declaration fails one of them.
        .filter(|w| !w.starts_with(wecode_core::WORKER_DIR))
        .filter(|w| !grant.write.iter().any(|g| glob::covers(g, w)))
        .map(String::as_str)
        .collect();
    if uncovered.is_empty() {
        return Ok(());
    }
    Err(format!(
        "post `{}` (role {}) may not write {} — it writes only: {}\n\
         \x20 assign a post whose scope covers the work, or widen the role",
        post.name,
        post.role,
        uncovered.join(", "),
        if grant.write.is_empty() {
            "nothing".to_string()
        } else {
            grant.write.join(", ")
        }
    ))
}

pub(crate) fn find_post(company: &Company, name: &str) -> Result<Post, String> {
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
pub(crate) struct Actor {
    pub(crate) post: String,
    pub(crate) agent: String,
    pub(crate) human: Option<String>,
    pub(crate) session: String,
    pub(crate) effective: Effective,
}

impl Actor {
    /// The root grant. Reachable only by typing `--as operator` — never by
    /// omitting a flag, which is how authority used to leak.
    pub(crate) fn operator() -> Self {
        Self {
            post: "operator".into(),
            agent: "cli".into(),
            human: None,
            session: "operator".into(),
            effective: Effective::of(vec![Grant::root()]),
        }
    }

    pub(crate) fn of(company: &Company, post: &Post, session: &str, human: Option<String>) -> Self {
        Self {
            post: post.name.clone(),
            agent: std::env::var("WECODE_AGENT").unwrap_or_else(|_| post.agent.clone()),
            human,
            session: session.to_string(),
            effective: company.effective(post),
        }
    }

    pub(crate) fn describe(&self) -> String {
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
pub(crate) fn actor(
    a: &Args,
    store: &Store,
    company: &Company,
) -> Result<Actor, Box<dyn std::error::Error>> {
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

pub(crate) fn no_session_error(company: &Company) -> String {
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
pub(crate) fn record(
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
pub(crate) fn require_allowed(
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

/// What a record is attributed to. A task implies its project, so naming the task
/// alone is enough — the project is looked up rather than typed twice.
pub(crate) fn attribution(a: &Args, plan: &Plan) -> (Option<String>, Option<String>) {
    let task = a.get("task").map(str::to_string);
    let project = a.get("project").map(str::to_string).or_else(|| {
        task.as_ref()
            .and_then(|t| plan.task(&TaskId::new(t)))
            .map(|t| t.project.to_string())
    });
    (project, task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Project, Task};

    fn parse(s: &[&str]) -> Args {
        Args::parse(s.iter().map(|x| (*x).to_string()))
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
}
