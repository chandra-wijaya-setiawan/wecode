//! `archive` and `unarchive` — what stays on the board.
//!
//! Two levels, and the level is named in the command rather than inferred from the id,
//! because the two do not archive alike: [`set_archived`] *parks* a project — nothing in
//! it is promoted or dispatched — while [`set_task_archived`] only hides a task, along
//! with everything that is part of it.
//!
//! That difference is what the guards here are about. Filing a task away does not stop
//! the scheduler, so anything that could still move on its own is refused rather than
//! hidden: an archived `ready` row would be dispatched with nothing on screen to say so.

use std::collections::BTreeSet;

use wecode_core::{Plan, Task, TaskId, TaskStatus};
use wecode_gov::{Action, WorkKind};

use crate::args::Args;
use crate::commands::ctx::*;

/// Files a project away, or brings it back — and, spelled `archive task <id>`, a task
/// with its subtasks.
///
/// Deliberately not a status. Archiving says "stop showing me this", which is a
/// different claim from "this work is finished" — a done project can stay on the
/// board, and a parked active one can be hidden. Display only: nothing here changes
/// what is dispatchable.
///
/// The level is named rather than inferred from the id, because the two do not archive
/// alike: a project is *parked* — nothing in it is promoted or dispatched — while a task
/// is only hidden. An operator asking to file something away is entitled to know which
/// of those two they are asking for, and a polymorphic id would decide it for them.
pub(crate) fn set_archived(a: &Args, archived: bool) -> Res {
    // `!is_empty` rather than the word alone, so a project that happens to be called
    // `task` is still reachable as `archive task`.
    if a.cmd(1) == "task" && !a.cmd(2).is_empty() {
        return set_task_archived(a, archived);
    }
    let (store, company) = open(a)?;
    let verb = if archived { "archive" } else { "unarchive" };
    let named = require(a.cmd(1), "project id")?;
    let plan = store.load_plan()?;
    let p = plan.project_ref(named).ok_or_else(|| {
        // Named as a task where it is one: the bare form is the one an operator reaches
        // for first, and a refusal that only says no leaves them nowhere.
        let hint = if plan.task_ref(named).is_some() {
            format!(" — `wecode {verb} task {named}` files that task away with its subtasks")
        } else {
            String::new()
        };
        format!("no such project: {named} — a bare id names projects, not tasks{hint}")
    })?;
    let id = p.id.clone();

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

/// Files a task away with everything that is part of it, or brings the group back.
///
/// The cascade is the point. A feature expanded into four subtasks is one piece of work
/// and five rows; filing the parent alone would clear the heading and none of the
/// clutter, and filing five ids by hand is why nobody would file anything.
///
/// It reaches *down* the is-part-of chain and no further. A subtask can be put away on
/// its own, leaving the feature it belongs to on the board; a task that merely comes
/// after this one is not part of it and is left alone.
///
/// Hiding only, unlike a project. Archiving a project parks its work — the scheduler
/// skips it — and there is no equivalent here: an archived task is still promoted, still
/// dispatched, still merged. So this refuses to file away anything that could move on
/// its own, which is the whole of what keeps `archived` from meaning *running where
/// nobody is looking*.
fn set_task_archived(a: &Args, archived: bool) -> Res {
    let (store, company) = open(a)?;
    let verb = if archived { "archive" } else { "unarchive" };
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(2), "task id")?)?;
    let id = task.id.clone();
    let group = part_of(&plan, &id);
    let others = group.len() - 1;

    if archived {
        let live: Vec<&Task> = group.iter().copied().filter(|t| !is_settled(t)).collect();
        if !live.is_empty() && !a.has("force") {
            // The same words the project path uses for the same situation, one level up.
            let mut msg = format!("{id} covers work that would be hidden mid-flight:\n");
            for t in live.iter().take(10) {
                msg.push_str(&format!(
                    "    {} {:<24} {}\n",
                    t.status.mark(),
                    t.id,
                    t.status.as_str()
                ));
            }
            msg.push_str(
                "  filing a task away only hides it — the scheduler would still dispatch it,\n  \
                 where nothing on the board would say so\n  \
                 finish or drop them, or pass --force",
            );
            return Err(msg.into());
        }
    }

    // Changing the task record is defining, the same capability that created it — not
    // staffing, which is about who acts next. Nothing here moves work.
    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(task.project.to_string()), Some(id.to_string())),
        &Action::Define {
            kind: WorkKind::Task,
        },
        &format!("{verb} a task"),
    )?;

    // Empty means every row in the group already read that way. Saying so beats
    // reporting a filing that did nothing, and beats refusing: `archive` twice is not a
    // mistake worth an error.
    if store.set_task_archived(&id, archived)?.is_empty() {
        return Ok(format!(
            "  {id}{} already {}\n",
            with_subtasks(others),
            if archived { "archived" } else { "visible" }
        ));
    }

    Ok(if archived {
        format!(
            "  archived {id}{} — `wecode board --all` still shows them\n",
            with_subtasks(others)
        )
    } else {
        format!("  {id}{} visible again\n", with_subtasks(others))
    })
}

/// Nothing, or ` and its 3 subtasks` — so every message above reads as a sentence
/// whether or not the group turned out to have anything under it.
fn with_subtasks(n: usize) -> String {
    match n {
        0 => String::new(),
        1 => " and its subtask".to_string(),
        n => format!(" and its {n} subtasks"),
    }
}

/// A task and everything that is part of it, breadth-first so a group reads parent
/// before child. The is-part-of chain, not the dependency graph.
///
/// `seen` is what makes a parent loop terminate rather than hang. `Plan` refuses to
/// build one, but anyone can open wecode.db with the sqlite3 CLI, and the same
/// reasoning is why [`wecode_core::Blocker::Missing`] exists.
fn part_of<'a>(plan: &'a Plan, root: &TaskId) -> Vec<&'a Task> {
    let mut out: Vec<&Task> = plan.task(root).into_iter().collect();
    let mut seen: BTreeSet<TaskId> = out.iter().map(|t| t.id.clone()).collect();
    let mut i = 0;
    while i < out.len() {
        let id = out[i].id.clone();
        let mut kids: Vec<&Task> = plan.subtasks(&id).collect();
        kids.sort_by(|x, y| x.id.cmp(&y.id));
        for k in kids {
            if seen.insert(k.id.clone()) {
                out.push(k);
            }
        }
        i += 1;
    }
    out
}

/// Whether nothing will move this task again unless a person does — the only kind that
/// is safe to hide, given that hiding does not park it.
///
/// A draft counts: nothing dispatches a draft, so a mis-scoped one can be put away
/// without first being dropped. `failed` does not — it is waiting on a decision, and a
/// decision nobody can see is one nobody makes.
fn is_settled(t: &Task) -> bool {
    t.status.is_closed() || t.status == TaskStatus::Draft
}

#[cfg(test)]
mod tests {
    use wecode_core::Project;
    use wecode_store::Store;

    use super::*;

    fn parse(s: &[&str]) -> Args {
        Args::parse(s.iter().map(|x| (*x).to_string()))
    }

    /// A scaffolded workspace holding `layer` → `keys` → `salt`, so the filing commands
    /// can be run for real rather than reasoned about.
    ///
    /// Each test gets its own directory: they run in parallel, and a shared database
    /// file means one test wipes another's state mid-write. The plan is seeded through
    /// the store rather than through `task add`, which would want a repository on disk
    /// and a playbook to read out of it.
    fn org(name: &str) -> (String, Store) {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
        let dir = std::path::Path::new(&base).join(format!("wecode-filing-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        wecode_org::workspace::init(&dir, "solo").expect("scaffold");

        let store = Store::open(dir.join("wecode.db")).expect("store");
        let project = Project::new("caching", "cut export p99 below 500ms", "app");
        store.save_project(&project).unwrap();
        store
            .save_task(&Task::new("layer", "caching", "write the cache layer"))
            .unwrap();
        store
            .save_task(&Task::new("keys", "caching", "design the cache keys").under("layer"))
            .unwrap();
        store
            .save_task(&Task::new("salt", "caching", "pick the salt").under("keys"))
            .unwrap();
        // A task that waits on the group without being part of it.
        store
            .save_task(&Task::new("bench", "caching", "benchmark the cache").after("layer"))
            .unwrap();
        (dir.to_string_lossy().into_owned(), store)
    }

    /// `wecode archive|unarchive task <id>` against that workspace, as the operator.
    fn filing(dir: &str, verb: &str, id: &str, force: bool) -> Res {
        let mut argv = vec![verb, "task", id, "--org", dir, "--as", "operator"];
        if force {
            argv.push("--force");
        }
        set_archived(&parse(&argv), verb == "archive")
    }

    #[test]
    fn filing_a_task_away_takes_its_subtasks_and_counts_them() {
        let (dir, store) = org("cascade");
        let out = filing(&dir, "archive", "layer", false).unwrap();
        assert!(out.contains("archived layer and its 2 subtasks"), "{out}");

        let plan = store.load_plan().unwrap();
        for id in ["layer", "keys", "salt"] {
            assert!(!plan.task(&id.into()).unwrap().is_visible(), "{id}");
        }
        assert!(
            plan.task(&"bench".into()).unwrap().is_visible(),
            "waiting on the group is not being part of it"
        );
    }

    #[test]
    fn filing_the_same_group_twice_is_not_an_error() {
        let (dir, _store) = org("twice");
        filing(&dir, "archive", "layer", false).unwrap();
        let out = filing(&dir, "archive", "layer", false).unwrap();
        assert!(
            out.contains("already archived"),
            "the second time says so rather than reporting work it did not do:\n{out}"
        );
    }

    #[test]
    fn unfiling_brings_the_whole_group_back() {
        let (dir, store) = org("back");
        filing(&dir, "archive", "layer", false).unwrap();
        let out = filing(&dir, "unarchive", "layer", false).unwrap();
        assert!(out.contains("2 subtasks visible again"), "{out}");
        let plan = store.load_plan().unwrap();
        for id in ["layer", "keys", "salt"] {
            assert!(plan.task(&id.into()).unwrap().is_visible(), "{id}");
        }
    }

    #[test]
    fn a_subtask_can_be_filed_away_on_its_own() {
        let (dir, store) = org("subtask");
        let out = filing(&dir, "archive", "keys", false).unwrap();
        assert!(out.contains("archived keys and its subtask"), "{out}");
        let plan = store.load_plan().unwrap();
        assert!(
            plan.task(&"layer".into()).unwrap().is_visible(),
            "filing reaches down, never up"
        );
        assert!(!plan.task(&"salt".into()).unwrap().is_visible());
    }

    #[test]
    fn work_that_could_still_move_is_not_filed_away_by_accident() {
        // The load-bearing guard. Filing does not park a task the way archiving parks a
        // project, so a hidden `ready` row would be dispatched with nothing on screen
        // saying so.
        let (dir, store) = org("live");
        store
            .set_task_status(&"keys".into(), TaskStatus::Ready)
            .unwrap();

        let err = filing(&dir, "archive", "layer", false)
            .expect_err("should refuse")
            .to_string();
        assert!(err.contains("keys"), "it names the row: {err}");
        assert!(err.contains("--force"), "{err}");
        let plan = store.load_plan().unwrap();
        let keys = plan.task(&"keys".into()).unwrap();
        assert!(keys.is_visible(), "nothing was written");

        let out = filing(&dir, "archive", "layer", true).unwrap();
        assert!(out.contains("archived layer"), "{out}");
    }

    #[test]
    fn a_bare_id_that_names_a_task_says_which_form_to_type() {
        // The bare form is the one an operator reaches for first, so its refusal is
        // where the task form is discovered.
        let (dir, _store) = org("bare");
        let bare = ["archive", "layer", "--org", &dir, "--as", "operator"];
        let err = set_archived(&parse(&bare), true)
            .expect_err("a task is not a project")
            .to_string();
        assert!(err.contains("projects, not tasks"), "{err}");
        assert!(err.contains("archive task layer"), "{err}");
    }
}
