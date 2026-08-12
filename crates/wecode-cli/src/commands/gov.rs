//! Commands over the governance plane: authorising an action, signing one off, and
//! reading the ledger afterwards.

use wecode_core::{TaskId, TaskStatus};
use wecode_gov::{Action, ActionKind, glob};
use wecode_store::{AuditQuery, Store};

use crate::args::Args;
use crate::commands::ctx::*;
use crate::render;
use crate::{git, work};

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
    let mut out = format!(
        "  {} approved {}{}\n",
        who.describe(),
        kind.as_str(),
        if a.cmd(2).is_empty() {
            String::new()
        } else {
            format!(": {}", a.cmd(2))
        }
    );

    // A design approval is the transition, not a note about one. Merge approval is
    // read later by `merge`, which does its own work afterwards; a design has no
    // later step to read it, so signing is the last thing that happens to it.
    if kind == ActionKind::Design
        && let Some(id) = a.get("task")
    {
        let id = TaskId::new(id);
        let plan = store.load_plan()?;
        let task = plan
            .task(&id)
            .ok_or_else(|| format!("no such task: {id}"))?;
        if !task.kind.needs_a_signature() {
            return Err(format!(
                "{id} is a {} task — only a design is signed off this way",
                task.kind.as_str()
            )
            .into());
        }
        if task.status != TaskStatus::NeedsApproval {
            return Err(format!(
                "{id} is {} — a design is signed once it has passed, not before",
                task.status.as_str()
            )
            .into());
        }
        store.set_task_status(&id, TaskStatus::Done)?;
        out.push_str(&format!("  {id}  needs-approval → done\n"));
    }
    Ok(out)
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

/// Whether a merge approval is on the record for this task.
///
/// Read from the ledger rather than taken as a flag: a signature that a command-line
/// switch could stand in for is not a signature. `wecode approve` writes it, and it is
/// attributable to the post that gave it.
fn signed_off(store: &Store, task: &TaskId) -> Result<bool, Box<dyn std::error::Error>> {
    let lines = store.audit(&AuditQuery {
        task: Some(task.to_string()),
        ..Default::default()
    })?;
    Ok(lines
        .iter()
        .any(|l| l.action == "approve" && l.target == "Merge" && l.outcome == "allow"))
}

/// Lands a verified task on its project's integration branch.
///
/// Two gates, and they are not the same thing. The charter's `approval_to_merge` is a
/// company invariant and outranks everything; the playbook's `merge` is a project
/// preference. A project may therefore be stricter than the company, never laxer —
/// choosing `auto` for a branch the charter protects changes nothing.
///
/// Auto-merging is defensible only because it is reversible: every merge is one
/// `--no-ff` commit, and the report says what undoes it.
pub(crate) fn merge_task(a: &Args) -> Res {
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

    if task.status != TaskStatus::NeedsApproval {
        return Err(format!(
            "{id} is {} — only verified work merges. `wecode verify {id}` first",
            task.status.as_str()
        )
        .into());
    }

    let repo = repo_path(&company, project)?;
    let pb = playbook_of(&company, project)?;
    let target = pb
        .as_ref()
        .and_then(|p| p.project.merge_to.clone())
        .ok_or_else(|| {
            format!(
                "project `{}` has no integration branch — set `merge_to` in its playbook",
                project.id
            )
        })?;

    let owner = work::owner(&plan, &id).ok_or("task is not in the plan")?;
    let branch = work::branch_for(&owner.id);
    if !git::branch_exists(&repo, &branch) {
        return Err(format!("no branch `{branch}` — this task produced nothing to merge").into());
    }

    // The charter first. An invariant that a project preference could switch off would
    // not be an invariant.
    let protected = company.charter.invariants.iter().any(|inv| {
        matches!(inv, wecode_gov::Invariant::ApprovalToMerge(globs)
            if glob::any_matches(globs, &target))
    });
    let policy = pb.as_ref().map(|p| p.project.merge).unwrap_or_default();
    let needs_signature = protected || policy == wecode_org::MergePolicy::Approved;

    let who = actor(a, &store, &company)?;
    let signed = signed_off(&store, &id)?;
    if needs_signature && !signed {
        let mut msg = format!("{id} → {target} needs a signature");
        if protected {
            msg.push_str(" — the charter protects that branch");
        }
        msg.push_str(&format!(
            "\n  a holder signs it: wecode approve merge --task {id} --as <post>\n"
        ));
        msg.push_str(&format!("  then: wecode merge {id}\n"));
        msg.push_str(&format!(
            "  charter: {} · playbook: {}",
            if protected { "protects it" } else { "silent" },
            policy.as_str()
        ));
        return Err(msg.into());
    }

    // The Broker still decides. `RequireApproval` is not a refusal when the signature
    // it asks for is already on the record — that is what the record is for.
    let decision = record(
        &store,
        &company,
        &who,
        (Some(task.project.to_string()), Some(id.to_string())),
        &Action::Merge {
            branch: target.clone(),
        },
    )?;
    match decision {
        wecode_gov::Decision::Allow => {}
        wecode_gov::Decision::RequireApproval { .. } if signed => {}
        wecode_gov::Decision::RequireApproval { .. } => {
            return Err(format!("{id} → {target} needs a signature").into());
        }
        wecode_gov::Decision::Deny { reason, .. } => {
            return Err(format!("merging refused for `{}`: {reason}", who.post).into());
        }
    }

    let scratch = work::run_root()
        .join(work::org_name(ws.root()))
        .join(".merge");
    let merged = git::merge_into(
        &repo,
        &scratch,
        &target,
        &branch,
        &format!("{id}: {}\n\nmerged by wecode from {branch}", task.title),
    )?;

    store.set_task_status(&id, TaskStatus::Done)?;
    Ok(render::merged(
        &task,
        &plan,
        &target,
        &branch,
        &merged,
        needs_signature,
    ))
}

/// Undoes a merge that should not have happened.
///
/// By reverting, not resetting: a revert is a new commit rather than a rewrite, so it
/// is safe whether or not the branch has been shared. The merge stays in history,
/// which is the honest record — it did happen.
pub(crate) fn rollback_task(a: &Args) -> Res {
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

    let repo = repo_path(&company, project)?;
    let target = playbook_of(&company, project)?
        .and_then(|p| p.project.merge_to.clone())
        .ok_or_else(|| format!("project `{}` has no integration branch", project.id))?;

    let merge = git::merge_commit_for(&repo, &target, id.as_str())
        .ok_or_else(|| format!("no merge of {id} found on `{target}` — nothing to roll back"))?;

    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(task.project.to_string()), Some(id.to_string())),
        &Action::Merge {
            branch: target.clone(),
        },
        "rolling back a merge",
    )?;

    let scratch = work::run_root()
        .join(work::org_name(ws.root()))
        .join(".merge");
    let revert = git::revert_merge(&repo, &scratch, &target, &merge)?;

    // Back to needs-approval, not failed: the work still passed its acceptance. What
    // was withdrawn is the decision to land it.
    store.set_task_status(&id, TaskStatus::NeedsApproval)?;
    Ok(render::rolled_back(&task, &target, &merge, &revert))
}
