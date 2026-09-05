//! Commands that make work happen: prepare it, run it, judge it, schedule it.
//!
//! Split by reason-to-change: `prepare` cuts the tree and writes the envelope,
//! `queue` decides what may go and promotes, `dispatch` runs the agents, and `judge`
//! reads the diff. Listing and removing trees is `commands::trees` — an operator's
//! command aimed at a directory, not a step of a run. The small helpers
//! both sides share stay here, with the re-exports that keep every command's path.

mod dispatch;
mod judge;
mod prepare;
mod queue;
#[cfg(test)]
mod test_support;

pub(crate) use dispatch::{run_task, serve, start};
pub(crate) use judge::{commit_attempt, verify_task};
pub(crate) use queue::{tick, unsigned};
// Kept at `exec::prepare` for path stability: `prepare` has only in-tree callers today
// (each reaches it as `super::prepare::prepare`), so the re-export is otherwise unused.
#[allow(unused_imports)]
pub(crate) use prepare::{Prepared, prepare};

use wecode_gov::glob;
use wecode_org::Company;

pub(crate) fn indent(s: &str) -> String {
    s.lines()
        .map(|l| format!("    {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The `never_run` pattern a command line matches, if any.
///
/// Invariants outrank every grant, so this is checked even though the launch line is
/// operator-written: a grant that permits an invariant violation is itself the bug,
/// and so is a config that does.
pub(crate) fn forbidden_by_charter(company: &Company, line: &str) -> Option<String> {
    company.charter.invariants.iter().find_map(|inv| match inv {
        wecode_gov::Invariant::NeverRun(patterns) => patterns
            .iter()
            .find(|p| glob::matches(p, line))
            .map(ToString::to_string),
        _ => None,
    })
}
