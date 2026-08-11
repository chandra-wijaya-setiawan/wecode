//! Commands over the governance plane: authorising an action, signing one off, and
//! reading the ledger afterwards.

use wecode_gov::{Action, ActionKind, glob};
use wecode_store::AuditQuery;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::render;

pub(crate) fn parse_action(a: &Args) -> Result<Action, String> {
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

pub(crate) fn guard(a: &Args) -> Res {
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

/// A holder signs off on something the Broker gated.
pub(crate) fn approve(a: &Args) -> Res {
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

pub(crate) fn audit(a: &Args) -> Res {
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
