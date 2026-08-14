//! Commands over the governance plane: authorising an action, signing one off, and
//! reading the ledger afterwards.

use wecode_core::{TaskId, TaskStatus};
use wecode_gov::{Action, ActionKind, glob};
use wecode_store::{AuditQuery, Store};

use crate::args::Args;
use crate::commands::ctx::*;
use crate::render;
use crate::{git, ledger, notify, record, teardown, telegram, work};

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
    let plan = store.load_plan()?;
    // A signature attributed to a task that does not exist signs nothing, and every
    // gate reading the ledger afterwards would go on refusing without saying why.
    // Checked before the Broker is asked, so a mistyped id costs a message rather than
    // a record that looks like authority.
    let task = match a.get("task") {
        Some(id) => Some(
            plan.task(&TaskId::new(id))
                .ok_or_else(|| format!("no such task: {id}"))?
                .clone(),
        ),
        None => None,
    };
    let who = actor(a, &store, &company)?;
    let on = attribution(a, &plan);

    sign(
        &store,
        &company,
        &plan,
        &who,
        &Signature {
            kind,
            task: task.as_ref(),
            note: a.cmd(2),
            on,
        },
    )
}

/// What is being signed: the kind, the task it is about, the note the signer left, and
/// what the record is attributed to.
///
/// Attribution travels beside the task rather than being derived from it, because the
/// two come apart: a budget increase can be signed for a project with no task named at
/// all, and the record still has to be findable.
pub(crate) struct Signature<'a> {
    pub(crate) kind: ActionKind,
    pub(crate) task: Option<&'a wecode_core::Task>,
    pub(crate) note: &'a str,
    pub(crate) on: (Option<String>, Option<String>),
}

/// One signature: past the Broker, onto the ledger, and whatever signing that kind
/// *is* beyond the record.
///
/// Extracted from [`approve`] so a signature given from a chat reply is the same act
/// as one typed at a terminal — the same Broker call, the same design transition, the
/// same words back. A second implementation of this is a second answer to "is this
/// signed", and the two would disagree the first time either changed.
///
/// `who` is resolved by the caller because that is exactly what differs between them:
/// a session or `--as` at a terminal, the account a message came from over a channel.
pub(crate) fn sign(
    store: &Store,
    company: &wecode_org::Company,
    plan: &wecode_core::Plan,
    who: &Actor,
    what: &Signature,
) -> Res {
    let Signature {
        kind,
        task,
        note,
        on,
    } = what;
    let (kind, task, note) = (*kind, *task, *note);
    require_allowed(
        store,
        company,
        who,
        on.clone(),
        &Action::Approve { kind },
        "approving",
    )?;
    let mut out = format!(
        "  {} approved {}{}\n",
        who.describe(),
        kind.as_str(),
        if note.is_empty() {
            String::new()
        } else {
            format!(": {note}")
        }
    );

    // Admission is the *dispatch* signature. Nothing changes status here, because
    // nothing about the task changed: it became dispatchable, which is a fact about the
    // ledger and is read at the door by `start` and `run`. Said out loud all the same —
    // the other thing an operator could take from silence is that nothing happened.
    if kind == ActionKind::Admission
        && let Some(t) = task
    {
        out.push_str(&format!("  {}  may be dispatched\n", t.id));
        let gated = plan
            .project(&t.project)
            .and_then(|p| playbook_of(company, p).ok().flatten())
            .is_some_and(|pb| pb.project.dispatch.needs_a_signature());
        if !gated {
            out.push_str(
                "  nothing was waiting on it — this project dispatches without a signature\n",
            );
        }
    }

    // A design approval is the transition, not a note about one. Merge approval is
    // read later by `merge`, which does its own work afterwards; a design has no
    // later step to read it, so signing is the last thing that happens to it.
    if kind == ActionKind::Design
        && let Some(task) = task
    {
        let id = &task.id;
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
        store.set_task_status(id, TaskStatus::Done)?;
        out.push_str(&format!("  {id}  needs-approval → done\n"));
    }
    Ok(out)
}

/// Reads the replies waiting in the chat channel, and signs what they approved.
///
/// The other end of the notify hook. `wecode loop` does this every pass on its own
/// when `[telegram] fetch` is set, so typing it is for reading the channel once by
/// hand — and for `--dry-run`, which says what the messages would sign while moving
/// neither a signature nor the cursor.
pub(crate) fn inbox(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    if company.telegram.fetch.is_none() {
        let mut why = String::from("no [telegram] fetch in company.toml — nothing reads replies\n");
        why.push_str("  docs/reference/config.md has the getUpdates line to put there\n");
        return Err(why.into());
    }
    telegram::drain_channel(&ws, &store, &company, a.has("dry-run"))
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
        // A limit larger than this machine can index is a limit of "everything".
        limit: a
            .num("limit")
            .map(|n| usize::try_from(n).unwrap_or(usize::MAX)),
    };
    let mut lines = store.audit(&q)?;
    if let Some(pattern) = a.get("path") {
        lines.retain(|l| {
            matches!(l.action.as_str(), "read" | "write") && glob::matches(pattern, &l.target)
        });
    }
    Ok(render::audit(&lines))
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

    // Cloned rather than held: the plan is reloaded after the merge lands, and a
    // borrow of the old one would outlive it.
    let owner = work::owner(&plan, &id)
        .ok_or("task is not in the plan")?
        .id
        .clone();
    let branch = work::branch_for(&owner);
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
    let signed = ledger::is_signed(&store, &id, ActionKind::Merge)?;
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

    let scratch = work::merge_scratch(&work::org_name(ws.root()));
    let merged = git::merge_into(
        &repo,
        &scratch,
        &target,
        &branch,
        &format!("{id}: {}\n\nmerged by wecode from {branch}", task.title),
    )?;

    store.set_task_status(&id, TaskStatus::Done)?;

    // Reloaded, because the tree may only come down once nothing still needs it — and
    // the task that just landed is the commonest occupant. The in-memory plan predates
    // the transition above and would report this very task as still working there.
    let plan = store.load_plan()?;
    let swept = teardown::after_landing(&store, &plan, &repo, &work::org_name(ws.root()), &owner)?;

    // The report is built first and committed second, because the file *is* the report:
    // rendering a second version for the repository would give the same merge two
    // accounts that could disagree. What the terminal shows is the committed text plus
    // one line saying where it went — the only fact that postdates the file.
    let report = render::merged(
        &task,
        &plan,
        &target,
        &branch,
        &merged,
        needs_signature,
        &swept,
    );
    let kept = record::keep(
        &repo,
        &scratch,
        &target,
        &id,
        &branch,
        &render::report_file(&id, &target, &report),
    );
    Ok(report + &render::record_line(&kept))
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

    let scratch = work::merge_scratch(&work::org_name(ws.root()));
    let revert = git::revert_merge(&repo, &scratch, &target, &merge)?;

    // Back to needs-approval, not failed: the work still passed its acceptance. What
    // was withdrawn is the decision to land it.
    store.set_task_status(&id, TaskStatus::NeedsApproval)?;
    // A rollback puts finished work back in front of a person, which is the same
    // wait as reaching `needs-approval` the first time and is announced as one.
    let announced = notify::on_status_change(
        &company,
        ws.root(),
        &task,
        task.status,
        TaskStatus::NeedsApproval,
    );
    Ok(format!(
        "{}{announced}",
        render::rolled_back(&task, &target, &merge, &revert)
    ))
}
