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
//! | `filing` | `archive`, `unarchive` — what stays on the board |
//! | `inspect` | `show`, `check` — the two that decide nothing |
//!
//! What stays here is what belongs to no single command: the three readers that turn
//! flags into the pieces every declaration is assembled from. `--tokens` has to mean the
//! same thing to a project, to a task and to an amendment, and reading it in three
//! places is how it stops meaning the same thing.
//!
//! …and the playbook's opinion, which belongs to two of them. The gate below decides
//! whether a task may be worked on; the project's guidance decides nothing, and is
//! read back out afterwards for the two commands where somebody is looking at a task
//! they could still change their mind about — `task add` and `check`. Both are wrapped
//! here rather than answered inside their own modules, because a second verdict that
//! two modules format two ways is two features.

mod amend;
mod filing;
mod inspect;
mod project;
mod staff;
mod task;

pub(crate) use amend::{task_budget, task_scope};
pub(crate) use filing::set_archived;
pub(crate) use inspect::show;
pub(crate) use project::project_add;
pub(crate) use staff::{assign, set_status};
pub(crate) use task::task_rm;

use wecode_core::admission::{self, Divergence};
use wecode_core::{Budget, Cmp, Measure, Scope, Task};

use crate::args::Args;
use crate::commands::ctx::{Res, open, playbook_of};

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

/// `task add`, with what the playbook would have written appended.
///
/// After the command rather than inside it, and that ordering is the point: the gate
/// speaks first and decides, then the guidance speaks and decides nothing. A task
/// refused above is not in the plan, so it draws no advice — the blocking questions
/// are the ones to answer, and burying them under an opinion would be the wrong way
/// round.
pub(crate) fn task_add(a: &Args) -> Res {
    // The id names the task being declared, so it is read as a task and nothing else.
    let mut out = task::task_add(a)?;
    out.push_str(&advice_on(a, a.cmd(2), false)?);
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
}
