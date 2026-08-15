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

mod amend;
mod filing;
mod inspect;
mod project;
mod staff;
mod task;

pub(crate) use amend::{task_budget, task_scope};
pub(crate) use filing::set_archived;
pub(crate) use inspect::{check, show};
pub(crate) use project::project_add;
pub(crate) use staff::{assign, set_status};
pub(crate) use task::{task_add, task_rm};

use wecode_core::{Budget, Cmp, Measure, Scope};

use crate::args::Args;

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
