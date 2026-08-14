//! Commands about the company itself: scaffolding it, connecting to it, and
//! orienting whoever just did.

use wecode_core::TaskKind;
use wecode_gov::{Action, WorkKind};
use wecode_org::{Company, Workspace, gap, playbook, workspace};

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{render, work};

pub(crate) fn init(a: &Args) -> Res {
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

/// Prints a project's guidance. This is what an orchestrator reads before it
/// decomposes a request into tasks.
pub(crate) fn playbook_show(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let project = which_project(a, &plan)?;
    let path = repo_path(&company, &project)?;
    let found = gaps_on(ws.root(), &project)?;

    let Some(pb) = playbook_of(&company, &project)? else {
        // The gaps still count here — "there is no playbook" is the largest gap a
        // project can have, and whatever was recorded against it is what the starter
        // should be filled in with.
        return Ok(format!(
            "project {} has no playbook\n  {}\n  wecode playbook init --project {}  writes a starter\n{}",
            project.id,
            path.join(playbook::PLAYBOOK_PATH).display(),
            project.id,
            render::gap_count(&found),
        ));
    };

    let now = wecode_store::now_secs();
    match a.cmd(1) {
        "" => Ok(render::playbook_all(&project, &pb, &found)),
        want => {
            let kind = parse_kind(want)?;
            Ok(render::playbook_kind(&project, &pb, kind, &found, now))
        }
    }
}

// ------------------------------------------------------------------ gaps ------

/// Records what a playbook did not say.
///
/// The gate is `define project`, not `write`. A gap is not a change to the
/// repository — the chief, which holds `define` and no write scope at all, is exactly
/// the seat that finds these, and the engineer that holds `crates/**` is exactly the
/// seat that must not be able to annotate the guidance it was handed. Asking the
/// Broker about a file write would have had it backwards on both counts.
pub(crate) fn playbook_gap(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;

    // Attribution first, because it decides the rest: a task names its own project and
    // its own kind, so `--task <id>` alone is usually the whole invocation.
    let task = match a.get("task") {
        Some(id) => Some(the_task(&plan, id)?.clone()),
        None => None,
    };
    let project = match (&task, a.get("project")) {
        // Both given and disagreeing is a mistake worth stopping on: the note would
        // be filed against guidance the task was never planned from, where the next
        // reader of the *right* playbook will never see it.
        (Some(t), Some(p)) if p != t.project.as_str() => {
            return Err(format!("{} is in project {}, not {p}", t.id, t.project).into());
        }
        (Some(t), _) => plan
            .project(&t.project)
            .cloned()
            .ok_or_else(|| format!("no such project: {}", t.project))?,
        (None, _) => which_project(a, &plan)?,
    };
    let kind = match a.get("kind") {
        Some(want) => Some(parse_kind(want)?),
        None => task.as_ref().map(|t| t.kind),
    };

    let note = require(a.cmd(2), "the gap — say what the guidance does not")?;
    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (
            Some(project.id.to_string()),
            task.as_ref().map(|t| t.id.to_string()),
        ),
        &Action::Define {
            kind: WorkKind::Project,
        },
        "recording a playbook gap",
    )?;

    let found = gap::Gap {
        project: project.id.to_string(),
        kind,
        task: task.map(|t| t.id.to_string()),
        by: who.post.clone(),
        at: wecode_store::now_secs(),
        note: note.to_string(),
    };
    let fresh = gap::record(ws.root(), &found)?;
    Ok(render::gap_recorded(
        &found,
        fresh,
        &playbook_file(&company, &project),
        &gap::path(ws.root()),
    ))
}

/// What has been found and not folded in.
pub(crate) fn playbook_gaps(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let project = which_project(a, &plan)?;
    Ok(render::gaps(
        &project,
        &gaps_on(ws.root(), &project)?,
        wecode_store::now_secs(),
        &playbook_file(&company, &project),
        &gap::path(ws.root()),
    ))
}

/// The file a gap is folded into, named in full so it can be opened without
/// looking anything up.
///
/// A project whose repo is not registered has no such path, and falls back to the
/// name of the file inside whatever repo it acquires. That defect is reported by
/// `check`; telling somebody where to write a note is not the place to raise it.
fn playbook_file(company: &Company, project: &wecode_core::Project) -> std::path::PathBuf {
    repo_path(company, project)
        .map(|r| r.join(playbook::PLAYBOOK_PATH))
        .unwrap_or_else(|_| std::path::PathBuf::from(playbook::PLAYBOOK_PATH))
}

/// One project's gaps, oldest first.
fn gaps_on(
    root: &std::path::Path,
    project: &wecode_core::Project,
) -> Result<Vec<gap::Gap>, Box<dyn std::error::Error>> {
    let mut all = gap::at(root)?;
    all.retain(|g| g.project == project.id.as_str());
    Ok(all)
}

fn parse_kind(want: &str) -> Result<TaskKind, String> {
    TaskKind::parse(want).ok_or_else(|| {
        format!(
            "unknown kind `{want}` — have: {}",
            TaskKind::all()
                .iter()
                .map(|k| k.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

/// Writes a starter playbook into the project's repo.
///
/// `--language` is optional and usually omitted: the repository's own manifest says
/// what it is, and a flag that must be remembered is a flag that gets left off — which
/// is how every new project used to start with `accept = []`.
///
/// What is written is then read back, because a starter now names a real test command
/// and can name one this machine does not have. That refusal is reported rather than
/// raised: the file is right for the repository and wrong only here, and it costs one
/// edit to a file that is already open.
pub(crate) fn playbook_init(a: &Args) -> Res {
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
    let written = playbook::init(&repo, a.get("language").unwrap_or(""))?;
    let refusal = playbook::Playbook::at(&repo).err().map(|e| e.to_string());
    Ok(render::playbook_written(
        &project,
        &written,
        refusal.as_deref(),
    ))
}

// ----------------------------------------------------------------- brief ------

/// Orients an agent: who it is, what it may do, and where the guidance lives.
///
/// Derived from the grant rather than stored as a prompt. A hand-written briefing
/// drifts from the roles the moment one is edited, and then tells an agent it has
/// authority the Broker will refuse.
pub(crate) fn brief(a: &Args) -> Res {
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

/// Remembers a workspace as the default, so later commands need no --org.
pub(crate) fn use_org(a: &Args) -> Res {
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

pub(crate) fn login(a: &Args) -> Res {
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

pub(crate) fn logout(a: &Args) -> Res {
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

pub(crate) fn who(a: &Args) -> Res {
    let (store, company) = open(a)?;
    Ok(render::who(
        &store.sessions_all()?,
        company.session_ttl,
        wecode_store::now_secs(),
    ))
}

pub(crate) fn whoami(a: &Args) -> Res {
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
