//! Commands about the company itself: scaffolding it, connecting to it, and
//! orienting whoever just did.

use wecode_core::TaskKind;
use wecode_org::{Workspace, playbook, workspace};

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
