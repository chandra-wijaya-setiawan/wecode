//! Commands that shape the plan: projects, tasks, their scopes and statuses.
//!
//! Nothing here executes work. These decide what the work *is*.
//!
//! One module per decision, which is the line the commands are already drawn on. What a
//! task *is* gets settled once, at `task add`; everything after that either re-declares
//! one field of it, moves it, hides it, or only reads it back — and those are different
//! enough that mixing them was how a scope amendment and an archive check came to sit
//! two hundred lines apart under the same heading.
//!
//! | | |
//! |---|---|
//! | `project` | `project add` — the objective, and what will judge it |
//! | `task` | `task add`, `task rm` — what a task is, what the playbook fills, what `--expand` produces |
//! | `amend` | `task scope`, `task budget`, `task add --amend` — re-declaring one field of an existing task |
//! | `staff` | `assign`, `status` — who acts next, and where the work stands |
//! | `filing` | `archive`, `unarchive`, `sweep` — what stays on the board |
//! | `inspect` | `show`, `check` — the two that decide nothing |
//!
//! What stays here is what belongs to no single command: the three readers that turn
//! flags into the pieces every declaration is assembled from. `--tokens` has to mean the
//! same thing to a project, to a task and to an amendment, and reading it in three
//! places is how it stops meaning the same thing.
//!
//! …and `--onto`, the one flag on a declaration that reaches past the store. Every other
//! field of a task is a row; where its branch starts is a git ref, and cutting it is a
//! side effect on the repository — so it is answered here, either side of the command
//! rather than inside it, for the same reason the verdict below is: what is checked has
//! to be checked before the row is written, and what is created has to be created after.
//!
//! …and the playbook's opinion, which belongs to two of them. The gate below decides
//! whether a task may be worked on; the project's guidance decides nothing, and is
//! read back out afterwards for the two commands where somebody is looking at a task
//! they could still change their mind about — `task add` and `check`. Both are wrapped
//! here rather than answered inside their own modules, because a second verdict that
//! two modules format two ways is two features.
//!
//! …and `--requirement`, which is `--onto` again in a different plane. Every other
//! field of a task is a column on its row; an obligation is a *ledger* row that
//! outlives the attempts at it (ADR-0005), so it is answered either side of the
//! command on exactly the rule `--onto` is: the handle is checked before the task is
//! written, and stated after. What a story owes and what a task serves are then read
//! back beside the playbook's opinion, for the same two commands and the same reason.

mod amend;
mod filing;
mod inspect;
mod project;
mod staff;
mod task;

pub(crate) use amend::{amount, task_budget, task_scope};
pub(crate) use filing::{set_archived, sweep};
pub(crate) use inspect::show;
pub(crate) use project::project_add;
pub(crate) use staff::{assign, set_status};
pub(crate) use task::task_rm;

use std::path::PathBuf;

use wecode_core::admission::{self, Divergence};
use wecode_core::requirement;
use wecode_core::{Budget, Cmp, Measure, Plan, Scope, Task, TaskId, TaskKind};
use wecode_gov::{Action, WorkKind};
use wecode_store::audit::{By, ReqKind, Requirement};
use wecode_store::{Store, StoreError};

use crate::args::Args;
use crate::commands::ctx::{
    Res, actor, open, playbook_of, repo_path, require, require_allowed, the_task, which_project,
};
use crate::{git, work};

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

// ----------------------------------------------------- the second verdict ------

/// `task add`, with `--onto` either side of it and the playbook's opinion appended.
///
/// After the command rather than inside it, and that ordering is the point: the gate
/// speaks first and decides, then the guidance speaks and decides nothing. A task
/// refused above is not in the plan, so it draws no advice — the blocking questions
/// are the ones to answer, and burying them under an opinion would be the wrong way
/// round.
///
/// `--onto` is the one thing here that straddles the command instead of following it,
/// for the same rule read twice: what it *checks* has to be checked before the row is
/// written, and what it *creates* has to be created after. See [`Cut`].
pub(crate) fn task_add(a: &Args) -> Res {
    // Checked before the declaration is written and cut after it: see [`Cut`].
    let cut = onto_asked(a)?;
    // Likewise, and for the reason spelled out on [`Stated`].
    let stated = requirement_asked(a)?;
    // `--onto` can be the whole of an amendment, and then it has to run without one.
    // `task_amend` requires one of its own flags and refuses a command naming none, so
    // it only runs when it has something to do — the same split `--steps` makes, one
    // module over, for the same reason. `--requirement` is the same case: stating an
    // obligation on a story already in the plan changes no field of its row.
    let alone = (cut.is_some() || stated.is_some())
        && a.has("amend")
        && !["parent", "top", "after", "no-after", "steps"]
            .iter()
            .any(|f| a.has(f));
    let mut out = if alone {
        String::new()
    } else {
        task::task_add(a)?
    };
    let had_cut = cut.is_some();
    if let Some(cut) = cut {
        out.push_str(&cut.apply(a, alone)?);
    }
    if let Some(stated) = stated {
        // Not twice for one command: the cut above already recorded the `define` when
        // it ran on the path where nothing else would have.
        out.push_str(&stated.apply(a, alone && !had_cut)?);
    }
    // The id names the task being declared, so it is read as a task and nothing else.
    out.push_str(&advice_on(a, a.cmd(2), false)?);
    out.push_str(&requirements_on(a, a.cmd(2), false)?);
    Ok(out)
}

/// `check <id>`, likewise — and reading the id the way `check` itself reads it.
///
/// Ids are unique per level rather than globally, so a project and a task may share
/// one. The verdict above resolves the project first and stops there; advising about
/// the task of that name would file an opinion under something else's heading.
pub(crate) fn check(a: &Args) -> Res {
    let mut out = inspect::check(a)?;
    out.push_str(&advice_on(a, a.cmd(1), true)?);
    out.push_str(&requirements_on(a, a.cmd(1), true)?);
    Ok(out)
}

/// The playbook's opinion of a task that is in the plan, or nothing.
///
/// Read back from the store rather than passed down from the command, so `--expand`
/// is judged on the steps it actually created. Silent at every point where the answer
/// would be a guess: no such task, no repository, no playbook, no section for the
/// kind. A playbook that cannot be read advises nothing for the reason `design_gate`
/// gates nothing — an unregistered repo is already reported as its own defect, and a
/// read-only verdict should not fail on it.
fn advice_on(a: &Args, typed: &str, project_first: bool) -> Res {
    if typed.is_empty() {
        return Ok(String::new());
    }
    let (store, company) = open(a)?;
    let plan = store.load_plan()?;
    if project_first && plan.project_ref(typed).is_some() {
        return Ok(String::new());
    }
    let Some(t) = plan.task_ref(typed) else {
        return Ok(String::new());
    };
    let expected = plan
        .project(&t.project)
        .and_then(|p| playbook_of(&company, p).ok().flatten())
        .and_then(|pb| pb.expected_of(t.kind));
    Ok(expected.map_or_else(String::new, |e| {
        advisory(t, &admission::advise(t, &plan, &e))
    }))
}

/// The block of notes, formatted so it cannot be mistaken for the verdict above it:
/// stated rather than numbered, and told outright that nothing was refused.
fn advisory(t: &Task, notes: &[Divergence]) -> String {
    if notes.is_empty() {
        return String::new();
    }
    let mut out = format!(
        "\n  ⚠ {} note{} — the playbook for [{}] would have written this differently\n\n",
        notes.len(),
        if notes.len() == 1 { "" } else { "s" },
        t.kind.as_str()
    );
    for n in notes {
        out.push_str(&format!("  ·  {}\n", n.note()));
    }
    out.push_str("\n  advisory — nothing is refused for these\n");
    out
}

// -------------------------------------------------------- the per-task base ------

/// Where one task's branch starts, once `--onto` has named it and git has agreed.
///
/// Split from the cutting on purpose, and the ordering is the whole of it. Resolving the
/// base is a question — is that a revision this repository has? — and a question about a
/// declaration belongs *before* the row is written, or a typo costs the operator a saved
/// task whose branch is not where the command said. Cutting the ref is a side effect, and
/// belongs *after*: a declaration the gate refused is not a task, and a `wecode/<id>`
/// standing for one is a ref no teardown will ever come for.
///
/// What it produces is a branch and no worktree. That is not an optimisation — it is
/// where the flag gets its effect from. Preparation reuses a branch that is already
/// standing and ignores the base it computed, so a ref cut here *is* the base the
/// worktree lands on, and the project-wide `merge_to` goes on being the answer for every
/// task that named nothing. Nothing downstream had to learn a new field to honour it.
#[derive(Debug)]
struct Cut {
    repo: PathBuf,
    /// The task's own branch — `wecode/<id>` is the per-task ref this is all about.
    branch: String,
    /// The revision as the operator typed it, kept for what is printed back.
    onto: String,
    /// What it resolved to. Compared against a branch already standing, so `--onto`
    /// naming where the branch already is reads as nothing to do rather than as a
    /// refusal.
    base: String,
}

/// `--onto <branch>`: the base, resolved and checked, before anything is written.
///
/// `None` when the flag is absent, which is the ordinary case and the one that changes
/// nothing.
fn onto_asked(a: &Args) -> Result<Option<Cut>, Box<dyn std::error::Error>> {
    if !a.has("onto") {
        return Ok(None);
    }
    let onto = require(a.get("onto").unwrap_or(""), "--onto <branch>")?;
    let (store, company) = open(a)?;
    let plan = store.load_plan()?;
    let typed = require(a.cmd(2), "task id")?;
    // An amendment names work that exists, so a name that resolves to nothing is refused
    // here rather than passed on: this reader is the whole command in that case, and
    // would otherwise answer a mistyped id by doing nothing and saying so quietly.
    let existing = if a.has("amend") {
        Some(the_task(&plan, typed)?)
    } else {
        plan.task_ref(typed)
    };

    // A subtask has no branch of its own — it shares its parent's worktree, and
    // [`crate::verify`] reads the *absence* of a `wecode/<id>` as what says a commit came
    // from a step rather than from behind the task. Cutting one here would take that
    // reading away, for a ref nothing would ever check out.
    if a.has("parent") || existing.is_some_and(|t| t.parent.is_some() && !a.has("top")) {
        return Err(format!(
            "--onto: {typed} is part of another task and shares its worktree — a step has \
             no branch of its own to cut\n  \
             name the main task instead; the base it is given is the one every step works on"
        )
        .into());
    }

    let project = match existing {
        Some(t) => plan
            .project(&t.project)
            .cloned()
            .ok_or_else(|| format!("{typed} names project `{}`, which is not there", t.project))?,
        None => which_project(a, &plan)?,
    };
    let repo = repo_path(&company, &project)?;
    if !git::is_repo(&repo) {
        return Err(format!(
            "--onto {onto}: {} is not a git repository, so there is nothing to cut a branch in",
            repo.display()
        )
        .into());
    }
    // Resolved rather than taken on trust. A base is only useful if it exists *now* — the
    // ref is cut in a moment — and the common way to get this wrong is naming a branch
    // that only exists on the remote, which is worth saying rather than leaving to git.
    let base = git::commit_at(&repo, onto).ok_or_else(|| {
        format!(
            "--onto {onto}: no such branch or revision in {}\n  \
             a branch that is only on the remote is named `origin/{onto}` until it is fetched",
            repo.display()
        )
    })?;

    let id = existing.map_or_else(|| TaskId::new(typed), |t| t.id.clone());
    let branch = work::branch_for(&id);
    if let Some(tip) = git::commit_at(&repo, &format!("refs/heads/{branch}"))
        && tip != base
    {
        return Err(format!(
            "--onto {onto}: `{branch}` is already cut, and not there\n  \
             its commits are {id}'s work, and moving the branch would leave them behind\n  \
             moving it anyway is git's, not planning's: `wecode worktree remove {id}` frees \
             the branch, then `git branch -f {branch} {onto}`"
        )
        .into());
    }
    Ok(Some(Cut {
        repo,
        branch,
        onto: onto.to_string(),
        base,
    }))
}

impl Cut {
    /// Cuts the branch, now that the task it belongs to is in the plan.
    ///
    /// `authorise` is for the amendment that is only this: re-declaring where a task's
    /// branch starts is a `define` like every other amendment, and on the path where
    /// `task_amend` was skipped there is nothing else to have recorded one.
    fn apply(&self, a: &Args, authorise: bool) -> Res {
        let (store, company) = open(a)?;
        let plan = store.load_plan()?;
        // Read back out of the plan rather than trusted from the flags, which is what
        // makes a refused declaration cut nothing: the gate above already printed why,
        // and there is no task here to own a ref.
        let Some(t) = plan.task_ref(a.cmd(2)) else {
            return Ok(String::new());
        };
        if authorise {
            let who = actor(a, &store, &company)?;
            require_allowed(
                &store,
                &company,
                &who,
                (Some(t.project.to_string()), Some(t.id.to_string())),
                &Action::Define {
                    kind: WorkKind::Task,
                },
                "re-declaring where a task's branch starts",
            )?;
        }
        if git::branch_exists(&self.repo, &self.branch) {
            return Ok(format!(
                "  onto      {} — `{}` is already there, so nothing was cut\n",
                self.onto, self.branch
            ));
        }
        git::branch_at(&self.repo, &self.branch, &self.base)?;
        let mut out = format!(
            "  onto      {} ({})\n  \
             branch    {} cut there — `wecode start {}` opens its worktree on it, not on \
             the project's integration branch\n",
            self.onto,
            self.base.get(..7).unwrap_or(&self.base),
            self.branch,
            t.id
        );
        // Named back, like every other substitution this module makes. A dependent task
        // is otherwise cut from its predecessor's branch so that it *has* the work it
        // comes after; a base declared here wins over that, and an operator who did not
        // mean to say so should hear it now rather than read it off a conflict.
        if !t.depends_on.is_empty() {
            out.push_str(&format!(
                "  note      it comes after {} — this base wins over their branches, so \
                 their work is here only if {} already carries it\n",
                t.depends_on
                    .iter()
                    .map(TaskId::as_str)
                    .collect::<Vec<_>>()
                    .join(", "),
                self.onto
            ));
        }
        Ok(out)
    }
}

// ------------------------------------------------- the stated obligation ------

/// What `--requirement` names, once the plan has been asked about it.
///
/// Two things, because a requirement has two ends and the task's own kind says which
/// end this is. A **story** states one: the wording is the contract, and the handle it
/// answers to is minted rather than typed. Anything else *serves* one: the task is an
/// attempt at an obligation somebody already wrote down, and naming it is what puts
/// that obligation back on the board until this task is done (ADR-0005).
///
/// The kind decides it rather than the shape of the string, so a wording that happens
/// to look like a handle is still a wording, and a handle typed on a story is still a
/// story restating what it owes.
#[derive(Debug)]
enum Stated {
    Declared {
        project: wecode_core::ProjectId,
        kind: ReqKind,
        wording: String,
    },
    Served {
        project: wecode_core::ProjectId,
        id: String,
    },
}

/// `--requirement <wording|handle>`, resolved and checked, before anything is written.
///
/// The refusal here is [`Defect::RequirementUnknown`] asked as a question rather than
/// filed as a defect, and that is deliberate: a handle nothing ever stated is a typo in
/// the command, not a gap in the plan. Answering it with a saved task pointing at
/// nothing would leave the operator a row to find and unpick.
fn requirement_asked(a: &Args) -> Result<Option<Stated>, Box<dyn std::error::Error>> {
    if !a.has("requirement") {
        return Ok(None);
    }
    let said = require(
        a.get("requirement").unwrap_or(""),
        "--requirement \"<wording>\" on a story, or <handle> on a task",
    )?;
    let (store, _) = open(a)?;
    let plan = store.load_plan()?;
    let typed = require(a.cmd(2), "task id")?;
    // An amendment names work that exists, on `onto_asked`'s rule and for its reason.
    let existing = if a.has("amend") {
        Some(the_task(&plan, typed)?)
    } else {
        plan.task_ref(typed)
    };
    let kind = match existing {
        Some(t) => t.kind,
        None => a.get("kind").and_then(TaskKind::parse).unwrap_or_default(),
    };
    let project = match existing {
        Some(t) => t.project.clone(),
        None => which_project(a, &plan)?.id,
    };

    if kind == TaskKind::Story {
        return Ok(Some(Stated::Declared {
            project,
            kind: if a.has("nfr") {
                ReqKind::NonFunctional
            } else {
                ReqKind::Functional
            },
            wording: said.to_string(),
        }));
    }

    // The task as it will be, so the check reads the same before the row exists as
    // after it: a fresh declaration is a draft, which is what `Task::new` gives, and an
    // amendment is the task already in the plan carrying the handle it is about to
    // claim. Set on the probe rather than passed beside it, so what is checked is the
    // object that gets written.
    let probe = match existing {
        Some(t) => t.clone(),
        None => Task::new(typed, project.clone(), "").of_kind(kind),
    }
    .serving(said);
    let known = handles(&store, &project)?;
    if let Some(d) = requirement::check_requirement(&probe, &known).first() {
        return Err(d.question().into());
    }
    Ok(Some(Stated::Served {
        project,
        id: said.to_string(),
    }))
}

impl Stated {
    /// Writes the ledger row, now that the task it belongs to is in the plan.
    ///
    /// `authorise` on [`Cut::apply`]'s terms and for its reason: stating an obligation
    /// on a story already in the plan can be the whole of an amendment, and on that
    /// path nothing else has recorded a `define`.
    fn apply(&self, a: &Args, authorise: bool) -> Res {
        let (store, company) = open(a)?;
        let plan = store.load_plan()?;
        // Read back out of the plan, which is what makes a refused declaration state
        // nothing: an obligation nobody can name is worse than one nobody wrote.
        let Some(t) = plan.task_ref(a.cmd(2)) else {
            return Ok(String::new());
        };
        let who = actor(a, &store, &company)?;
        if authorise {
            require_allowed(
                &store,
                &company,
                &who,
                (Some(t.project.to_string()), Some(t.id.to_string())),
                &Action::Define {
                    kind: WorkKind::Task,
                },
                "stating what a story owes",
            )?;
        }
        let by = By {
            session: &who.session,
            post: &who.post,
            agent: &who.agent,
            human: who.human.as_deref().unwrap_or_default(),
        };
        match self {
            Self::Declared {
                project,
                kind,
                wording,
            } => {
                let r = store.declare_requirement(by, project, &t.id, *kind, wording)?;
                Ok(format!(
                    "  requires  {} — {}\n",
                    r.id, r.wording
                ))
            }
            Self::Served { project, id } => {
                store.serve_requirement(by, project, &t.id, id)?;
                // The column after the row, on `set_task_steps`'s rule and for its
                // reason: the task has to exist before anything on it can be written.
                // Both halves, because they are different facts — the ledger keeps that
                // this task claimed the handle just now, the column keeps that it is
                // what the task answers to until somebody says otherwise.
                store.set_task_requirement(&t.id, id)?;
                Ok(format!(
                    "  serves    {id} — open again until this task is done\n"
                ))
            }
        }
    }
}

/// Every requirement handle a project holds.
fn handles(store: &Store, project: &wecode_core::ProjectId) -> Result<Vec<String>, StoreError> {
    Ok(store
        .requirements(Some(project), None)?
        .into_iter()
        .map(|r| r.id)
        .collect())
}

/// What a story owes, or what a task is an attempt at.
///
/// Read out of the ledger rather than passed down from the command, on `advice_on`'s
/// rule: `--requirement` states one obligation and a story usually carries several, so
/// printing back only what was just typed would be the least useful of the two.
fn requirements_on(a: &Args, typed: &str, project_first: bool) -> Res {
    if typed.is_empty() {
        return Ok(String::new());
    }
    let (store, _) = open(a)?;
    let plan = store.load_plan()?;
    if project_first && plan.project_ref(typed).is_some() {
        return Ok(String::new());
    }
    let Some(t) = plan.task_ref(typed) else {
        return Ok(String::new());
    };
    let all = store.requirements(Some(&t.project), None)?;
    if t.kind == TaskKind::Story {
        let mine: Vec<&Requirement> = all.iter().filter(|r| r.story == t.id).collect();
        return Ok(owed(t, &mine, &plan));
    }
    // Asked of the task rather than searched for among the requirements: the task's own
    // row says what it serves, and there is at most one.
    let served: Vec<&Requirement> = all
        .iter()
        .filter(|r| t.requirement.as_deref() == Some(r.id.as_str()))
        .collect();
    Ok(listed("serves — the obligations this task answers to", &served, |_| {
        String::new()
    }))
}

/// The obligations of one story, each with whether anything still owes it.
fn owed(t: &Task, mine: &[&Requirement], plan: &Plan) -> String {
    let names: Vec<String> = mine.iter().map(|r| r.id.clone()).collect();
    if mine.is_empty() {
        // The one thing a story with no obligations gets told, and it is a question:
        // nothing here can settle whether such a story is finished.
        return requirement::check_requirement(t, &names)
            .first()
            .map_or_else(String::new, |d| format!("\n  ⚠ {}\n", d.question()));
    }
    listed("requirements — what this story owes", mine, |r| {
        let met = requirement::requirement_is_met(&r.served_by, plan);
        format!("{:<5}  ", if met { "met" } else { "open" })
    })
}

/// One block, formatted so a handle lines up under a handle.
fn listed(heading: &str, rows: &[&Requirement], state: impl Fn(&Requirement) -> String) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let mut out = format!("\n  {heading}\n\n");
    let wide = rows.iter().map(|r| r.id.len()).max().unwrap_or(0);
    for r in rows {
        out.push_str(&format!(
            "  ·  {:<wide$}  {}{}\n",
            r.id,
            state(r),
            r.wording
        ));
        if !r.served_by.is_empty() {
            out.push_str(&format!(
                "     {:<wide$}  {} attempt{}: {}\n",
                "",
                r.served_by.len(),
                if r.served_by.len() == 1 { "" } else { "s" },
                r.served_by
                    .iter()
                    .map(TaskId::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    out
}

pub(crate) fn scope_from(a: &Args) -> Option<Scope> {
    let read: Vec<&str> = a.all("read");
    let write: Vec<&str> = a.all("write");
    (!read.is_empty() || !write.is_empty()).then(|| Scope {
        read: read.iter().map(|s| (*s).to_string()).collect(),
        write: write.iter().map(|s| (*s).to_string()).collect(),
    })
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

    #[test]
    fn a_declaration_without_onto_opens_nothing() {
        // The absent case answers before the workspace is touched, which is what keeps
        // `task add` a store write and nothing else for every task that named no base.
        assert!(
            onto_asked(&parse(&["task", "add", "t1", "a title"]))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn onto_without_a_branch_is_refused_by_name() {
        // `--onto` followed by another flag parses as a boolean, and a base of "" would
        // otherwise reach git as `HEAD`-ish nonsense.
        let e = onto_asked(&parse(&[
            "task", "add", "t1", "a title", "--onto", "--force",
        ]))
        .unwrap_err()
        .to_string();
        assert!(e.contains("--onto <branch>"), "{e}");
    }
}
