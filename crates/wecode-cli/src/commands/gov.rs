//! Commands over the governance plane: authorising an action, signing one off, and
//! reading the ledger afterwards.

use wecode_core::TaskStatus;
use wecode_gov::{Action, ActionKind, glob};
use wecode_store::{AuditQuery, Store};

use crate::args::Args;
use crate::commands::ctx::*;
use crate::render;
use crate::{board, git, install, ledger, notify, record, teardown, telegram, work};

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
    Ok(render::gov::decision(
        &post.name,
        &post.agent,
        &action,
        &decision,
    ))
}

/// A holder signs off on something the Broker gated.
pub(crate) fn approve(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
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
        Some(id) => Some(the_task(&plan, id)?.clone()),
        None => None,
    };
    let who = actor(a, &store, &company)?;
    let on = attribution(a, &plan);

    let mut out = sign(
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
    )?;

    // The signature is given; the message that asked for it is still on a phone, still
    // carrying *Approve*. Answered here rather than inside `sign`, which the chat's own
    // path also calls: that path answers the tap it read, with the button's address on it,
    // and one function saying it under both would say it twice about a tap and with half
    // an address about this.
    //
    // Only for a signature about a task, because a notification is about one: a budget
    // approved for a whole project names no message anybody could be looking at.
    if let Some(t) = &task {
        let told = telegram::settled(&company, ws.root(), t, &out);
        out.push_str(&told);
    }
    Ok(out)
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
        why.push_str("  docs/reference/config/telegram.md has the getUpdates line to put there\n");
        return Err(why.into());
    }
    telegram::drain_channel(&ws, &store, &company, a.has("dry-run"))
}

/// Answers a question asked in the chat, out of the state the board already prints.
///
/// The other half of [`inbox`], and beside it for that reason: the channel is a view onto
/// the ledger rather than a second brain. Every answer here is composed from
/// [`crate::board`]'s own functions — the same four groups `wecode board` leads with, the
/// same needs-human cell, the same vitals — so a reply read on a phone and the board read
/// at a desk cannot come to different conclusions about what needs a person. A second
/// rendering of *what is happening* would be a second thing to keep true.
///
/// Nothing is stored and no record is written. A question is a read, and `wecode board`
/// writes none either; a channel that appended a row per poll would fill the ledger with
/// the answering rather than the work.
pub(crate) fn from_the_ledger(
    store: &Store,
    company: &wecode_org::Company,
    asked: telegram::Question,
    text: &str,
) -> Res {
    let plan = store.load_plan()?;
    let audit = store.audit(&AuditQuery::default())?;
    let l = board::ledger_index(&audit);
    let gates = design_gates(company, &plan);
    // The projects a board would show, filed-away work excluded: `--all` is a flag
    // somebody types at a desk while looking at the tree, and there is no tree here.
    let projects: Vec<&wecode_core::Project> = plan.projects().collect();
    let groups = board::attention_groups(&plan, &projects, &l, false);
    let asking = Asking {
        plan: &plan,
        audit: &audit,
        l: &l,
        gates: &gates,
        groups: &groups,
    };
    Ok(match asked {
        telegram::Question::Status => asking.summary(),
        telegram::Question::Board => {
            asking.rows(board::Group::NeedsYou, "nothing is waiting on you")
        }
        telegram::Question::Agents => asking.rows(board::Group::Moving, "nothing is running"),
        telegram::Question::Why => asking.why(text)?,
    })
}

/// What one question is answered out of: the plan, the ledger folded two ways, and the
/// grouping. Bundled because all four answers read most of it, and read the same copy —
/// two loads of the plan inside one reply could disagree with each other.
struct Asking<'a> {
    plan: &'a wecode_core::Plan,
    audit: &'a [wecode_store::AuditLine],
    l: &'a crate::board::Ledger,
    gates: &'a crate::board::DesignGates,
    groups: &'a [(board::Group, Vec<&'a wecode_core::Task>, usize)],
}

impl Asking<'_> {
    /// How many rows a group holds, the ones it stood down to a count included.
    fn count(&self, want: board::Group) -> usize {
        self.groups
            .iter()
            .find(|(g, _, _)| *g == want)
            .map_or(0, |(_, shown, hidden)| shown.len() + hidden)
    }

    /// The summary sentence, and — when nothing is moving — the row that says why.
    ///
    /// Four counts alone describe a workspace that has finished everything and one whose
    /// operator forgot to start `wecode loop` identically, which is the whole reason this
    /// line names a cause. The cause is a row rather than a diagnosis: the first thing
    /// waiting on a person, else the first thing queued, each in the words its own group
    /// already uses.
    fn summary(&self) -> String {
        let moving = self.count(board::Group::Moving);
        // The group titles, in the order the board leads with them, so the counts and the
        // rows a follow-up question returns are named the same thing.
        let mut out = format!(
            "    needs you {} · moving {moving} · next {} · landed {}\n",
            self.count(board::Group::NeedsYou),
            self.count(board::Group::Next),
            self.count(board::Group::Landed),
        );
        if moving > 0 {
            return out;
        }
        let cause = [board::Group::NeedsYou, board::Group::Next]
            .iter()
            .find_map(|want| self.first(*want));
        out.push_str(&match cause {
            Some(line) => format!("      nothing is moving: {line}\n"),
            None if self.plan.is_empty() => "      no projects yet\n".to_string(),
            None => "      nothing is moving: all work is done\n".to_string(),
        });
        out
    }

    /// The leading row of a group, as that group describes it.
    fn first(&self, want: board::Group) -> Option<String> {
        let (_, shown, _) = self.groups.iter().find(|(g, _, _)| *g == want)?;
        shown.first().map(|t| self.row(want, t))
    }

    /// A group as a phone reads it: the rows it leads with, the sentence that group asks
    /// of each, and the tail it stood down to a count. `empty` is what an empty group says
    /// — a heading over nothing would make the reader work out which nothing it was.
    fn rows(&self, want: board::Group, empty: &str) -> String {
        let group = self.groups.iter().find(|(g, _, _)| *g == want);
        let Some((_, shown, hidden)) = group.filter(|(_, rows, _)| !rows.is_empty()) else {
            return format!("    {empty}\n");
        };
        let mut out = format!("    {} ({})\n", want.title(), shown.len() + hidden);
        for t in shown {
            out.push_str(&format!("      {}\n", self.row(want, t)));
        }
        if *hidden > 0 {
            out.push_str(&format!("      … and {hidden} more\n"));
        }
        out
    }

    /// One row: which task, what its group has to say about it, and its beat.
    fn row(&self, want: board::Group, t: &wecode_core::Task) -> String {
        let v = board::task_vitals(self.plan, t, self.l, self.gates);
        format!(
            "{}/{}  {}{}",
            t.project,
            t.id,
            want.line(self.plan, t, self.l, &v),
            self.beat(t)
        )
    }

    /// How long since the ledger last said anything about a task, and nothing at all for
    /// one it has never named.
    ///
    /// The age is what makes a run readable on a phone. `write src/lib.rs` is the same row
    /// whether the agent wrote that four seconds or four hours ago, and the difference
    /// between those two is the whole of whether somebody has to go and look.
    fn beat(&self, t: &wecode_core::Task) -> String {
        board::newest(self.audit, "", t.id.as_str(), 1)
            .first()
            .map_or_else(String::new, |l| {
                let since = wecode_store::now_secs().saturating_sub(l.at);
                format!("  {}", board::ago(since))
            })
    }

    /// Why one task is where it is: the row's own words, and what it stands behind.
    ///
    /// Two halves, because the question has two answers. [`crate::board::task_vitals`]
    /// carries the first — the same cell the board colours — and the blockers carry the
    /// second, with [`blocker_note`]'s distinction between a prerequisite that is merely
    /// unfinished and one no tick will ever release. That distinction is the question
    /// actually asked from a phone: *will this clear on its own, or is it mine?*
    fn why(&self, text: &str) -> Result<String, String> {
        let named = telegram::tasks_named(text, self.plan);
        let [id] = named.as_slice() else {
            return Err(match named.len() {
                0 => "why needs a task: `why cache-tests`, or `why #4` by number".to_string(),
                n => format!("that names {n} tasks — ask about one"),
            });
        };
        // Named by the same reader that resolved it, so this cannot fail.
        let t = self.plan.task(id).ok_or("no such task")?;
        let v = board::task_vitals(self.plan, t, self.l, self.gates);
        // The status in full, unlike the board's own column: a chat message has room, and
        // `needs-approval` is the word the operator will type back.
        let mut out = format!("    {id}  {} {}\n", t.status.mark(), t.status.as_str());
        for b in self.plan.blockers(id) {
            out.push_str(&format!("      waits on {}\n", blocker_note(&b)));
        }
        if !v.needs.is_empty() {
            out.push_str(&format!("      {}\n", v.needs.join(" · ")));
        }
        Ok(out)
    }
}

pub(crate) fn audit(a: &Args) -> Res {
    let (store, _) = open(a)?;
    // The ledger is keyed on ids, so a number has to become one before it reaches the
    // query. Resolved here rather than through `attribution`, which would also fill the
    // project in from the task and silently narrow a filter nobody asked to narrow.
    //
    // Left as typed when nothing in the plan answers to it: a removed task's records
    // outlive the task, and naming it by id is how they stay reachable.
    let plan = store.load_plan()?;
    let by_id = |flag: &str, found: fn(&wecode_core::Plan, &str) -> Option<String>| {
        a.get(flag)
            .map(|typed| found(&plan, typed).unwrap_or_else(|| typed.to_string()))
    };
    // Filtering happens in SQL where the index is; only the glob, which SQLite
    // cannot express, is applied afterwards.
    let q = AuditQuery {
        denied_only: a.has("denied"),
        alarms_only: a.has("alarms"),
        project: by_id("project", |p, t| {
            p.project_ref(t).map(|x| x.id.to_string())
        }),
        task: by_id("task", |p, t| p.task_ref(t).map(|x| x.id.to_string())),
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
    Ok(render::gov::audit(&lines))
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
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(1), "task id")?)?.clone();
    let id = task.id.clone();
    let project = plan
        .project(&task.project)
        .ok_or_else(|| format!("no such project: {}", task.project))?;

    // Cloned rather than held: the plan is reloaded after the merge lands, and a
    // borrow of the old one would outlive it.
    let owner = work::owner(&plan, &id)
        .ok_or("task is not in the plan")?
        .id
        .clone();

    // Asked before the status, because it decides whether this is the right task to be
    // asking about at all. A subtask has no branch of its own — `owner` is the main
    // task — so merging here would put that task's whole branch on the integration
    // branch, every step of it including the ones that have not run, and then mark
    // only this one done. Telling the operator to verify it first would send them the
    // wrong way: no state this task can reach makes it mergeable.
    if owner != id {
        return Err(format!(
            "{id} is part of {owner} and shares its branch — a step lands nothing on its own\n  \
             its commits are already on `{}`; the main task is what puts them on the\n  \
             integration branch: wecode merge {owner}",
            work::branch_for(&owner)
        )
        .into());
    }

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

    // The first thing that ever compiles the merge result, and — if this repo named a
    // destination — the moment the operator's `wecode` stops being whatever their
    // checkout was on. Unable to fail the merge, which has already landed: everything it
    // refuses is a line in the report. See [`crate::install`].
    let installed = install::after_landing(
        &repo,
        &scratch,
        &target,
        company
            .repo(&project.repo)
            .and_then(|r| r.installs.as_deref()),
        &merged.sha,
    );

    // The report is built first and committed second, because the file *is* the report:
    // rendering a second version for the repository would give the same merge two
    // accounts that could disagree. What the terminal shows is the committed text plus
    // one line saying where it went — the only fact that postdates the file.
    let report = record::merged(
        &task,
        &plan,
        &target,
        &branch,
        &merged,
        needs_signature,
        &swept,
        &installed,
    );
    let kept = record::keep(
        &repo,
        &scratch,
        &target,
        &id,
        &branch,
        &record::report_file(&id, &target, &report),
    );

    // And the chat, for the same reason the signature tells it: a task that reached
    // `needs-approval` was announced with a button on it, and an `auto` project lands the
    // work without any signature to carry that news — so the offer would outlive the merge
    // by however long it took somebody to look at a terminal.
    //
    // One sentence rather than the report. What is being turned from an offer into a record
    // has a caption's worth of room, and what it has to say is that this is done.
    let told = telegram::settled(
        &company,
        ws.root(),
        &task,
        &format!("merged {id} → {target}"),
    );
    Ok(report + &record::record_line(&kept) + &told)
}

/// Undoes a merge that should not have happened.
///
/// By reverting, not resetting: a revert is a new commit rather than a rewrite, so it
/// is safe whether or not the branch has been shared. The merge stays in history,
/// which is the honest record — it did happen.
pub(crate) fn rollback_task(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(1), "task id")?)?.clone();
    let id = task.id.clone();
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
        record::rolled_back(&task, &target, &merge, &revert)
    ))
}
