//! Exercising what a task will depend on, before a task depends on it.
//!
//! Two halves, in the order they are needed. [`machine`] asks whether this computer can
//! do the work at all — a `git`, somewhere to cut worktrees, a repository to cut them
//! from, a coding CLI to run inside them, and the environment that CLI is launched with.
//! [`hooks`] asks whether the operator can be reached once it stops, and can answer.
//!
//! Both halves are configuration nothing else checks. `company.toml` is hand-edited by
//! design — a role's write scope is exactly the thing you want to review in a diff — and
//! the price of that is a file full of paths, command names and variable names that are
//! true on the machine they were written on and are believed everywhere else until
//! something depends on them.
//!
//! What the two halves cost when they are wrong is different, and worth stating.
//!
//! - A broken **hook** is silent. A hook that never ran and a queue with nothing in it
//!   look identical from where the operator is standing, so nothing anywhere says the
//!   message did not arrive.
//! - A broken **machine** is loud in the wrong place. The dispatch fails, so the task
//!   fails — after admission, after scheduling, with a worktree cut, a run recorded and
//!   an attempt against its name. Read back later it is a task that could not be done,
//!   and it is nothing of the kind: `claude` is not installed, or `[[repos]] app` still
//!   points at the example path the template shipped with. Under `wecode loop` that
//!   repeats once per promotion, and every one of those records is a lie about the work.
//!
//! So the answer is one command that runs before either has anything riding on it, and
//! whose exit status is the verdict: `wecode doctor && wecode loop` starts a day's
//! unattended work only on a machine that can do it and a channel that can say so.
//!
//! **What is not set is not a failure.** Nothing in either half is compulsory, and an
//! operator who watches a terminal is configured for a terminal rather than
//! misconfigured. Three marks and not two, because *nothing is set* and *what is set
//! does not work* are the two answers an operator has to act on differently, and a
//! single `✗` for both sends them to the wrong file.

mod hooks;
mod machine;

use std::path::Path;

use wecode_org::{Company, workspace};

use crate::args::Args;
use crate::commands::ctx::Res;

/// What came of trying one thing.
#[derive(Debug)]
enum Outcome {
    /// It ran, or is set and could be read this far.
    Sound(String),
    /// Nothing is configured. An absence, not a fault — see the module note.
    Absent(String),
    /// It is configured, and it does not work.
    Broken(String),
}

impl Outcome {
    /// The mark in the left column — see the module note on why there are three.
    fn mark(&self) -> char {
        match self {
            Self::Sound(_) => '✓',
            Self::Absent(_) => '·',
            Self::Broken(_) => '✗',
        }
    }

    fn note(&self) -> &str {
        match self {
            Self::Sound(n) | Self::Absent(n) | Self::Broken(n) => n,
        }
    }

    fn is_broken(&self) -> bool {
        matches!(self, Self::Broken(_))
    }

    fn is_absent(&self) -> bool {
        matches!(self, Self::Absent(_))
    }
}

/// One thing the drill tried, named where it is written down.
///
/// `at` is owned rather than a `&'static str` because half the report is now named
/// after things the operator invented: `[[repos]] app` and `[agents.claude-code]
/// command` are the headings that can be grepped for in the file that caused them, and
/// a fixed set of names could only have said `repositories` and `agents`.
#[derive(Debug)]
struct Check {
    at: String,
    outcome: Outcome,
}

impl Check {
    fn new(at: impl Into<String>, outcome: Outcome) -> Self {
        Self {
            at: at.into(),
            outcome,
        }
    }

    fn is(&self, at: &str) -> bool {
        self.at == at
    }
}

/// One half of the report: its heading, its rows, and what the rows cannot say for
/// themselves.
#[derive(Debug)]
struct Section {
    title: &'static str,
    checks: Vec<Check>,
    /// Printed under the rows, empty when there is nothing to add. It belongs to the
    /// half rather than to the report, because what a half has left to say depends on
    /// what it found — see [`hooks`], whose last line is the only question wecode is
    /// not entitled to answer.
    note: String,
}

/// `wecode doctor`.
///
/// The store is never opened here, and that is the guarantee rather than an economy:
/// the drill has no handle on anything it could write. What state it does reach it
/// reaches through the hook — a `[notify] command` that calls `wecode` back is the
/// operator's own line doing the operator's own thing, and the charter is what bounds
/// that, exactly as when the loop fires it.
///
/// It follows that the drill reads `company.toml` and nothing else. That is a bound on
/// what it can check as well as on what it can break: the toolchain a *particular* task
/// declares as its acceptance lives in the plan, so what is checked here is what every
/// task needs rather than what any one of them asked for.
pub(crate) fn run(a: &Args) -> Res {
    let ws = workspace::resolve(a.get("org"))?;
    let company = ws.load()?;
    let sections = drill(&company, ws.root());
    let report = render(&sections);

    let broken = sections
        .iter()
        .flat_map(|s| &s.checks)
        .filter(|c| c.outcome.is_broken())
        .count();
    if broken == 0 {
        return Ok(report);
    }
    // A non-zero exit, because the answer to *may I trust this* is what the command is
    // for and a report nobody reads is the state it was written to end. The detail goes
    // with it rather than to stdout: one stream, so the reason cannot be separated from
    // the verdict by a redirect.
    Err(format!(
        "{} — what is configured does not work\n{report}",
        plural(broken, "failed check")
    )
    .into())
}

/// Both halves, in the order a task meets them: the machine it runs on, then the person
/// it stops for.
fn drill(company: &Company, org: &Path) -> Vec<Section> {
    vec![machine::section(company, org), hooks::section(company, org)]
}

/// `1 update`, `2 updates` — a report a person reads should not say `1 updates`.
fn plural(n: usize, thing: &str) -> String {
    match n {
        1 => format!("1 {thing}"),
        n => format!("{n} {thing}s"),
    }
}

fn render(sections: &[Section]) -> String {
    // One column across the whole report, measured rather than fixed: the widest
    // heading is `[agents.<whatever the operator called it>] env_allowlist`, and a
    // hardcoded pad would either wrap it or space every other row out to fit it.
    let width = sections
        .iter()
        .flat_map(|s| &s.checks)
        .map(|c| c.at.chars().count())
        .max()
        .unwrap_or_default();

    let mut out = String::new();
    for section in sections {
        out.push_str(&format!("\n{}\n", section.title));
        for c in &section.checks {
            out.push_str(&format!(
                "  {} {:<width$}  {}\n",
                c.outcome.mark(),
                c.at,
                c.outcome.note()
            ));
        }
        out.push_str(&section.note);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_count_a_person_reads_agrees_with_itself() {
        assert_eq!(plural(0, "update"), "0 updates");
        assert_eq!(plural(1, "update"), "1 update");
        assert_eq!(plural(2, "update"), "2 updates");
    }

    #[test]
    fn one_column_is_wide_enough_for_the_longest_heading_in_the_whole_report() {
        // Both halves are read down the same left edge. A section that measured only
        // its own rows would step in and out where the heading changed, which is the
        // one thing a column of marks is for.
        let out = render(&[
            Section {
                title: "machine",
                checks: vec![Check::new(
                    "[agents.claude-code] env_allowlist",
                    Outcome::Sound("all set".into()),
                )],
                note: String::new(),
            },
            Section {
                title: "hooks",
                checks: vec![Check::new("git", Outcome::Absent("nothing".into()))],
                note: String::new(),
            },
        ]);
        // Counted in characters and not in bytes: `✓` is three bytes and `·` is two, so
        // a byte offset says these two rows disagree on a report that lines up.
        let column = |line: &str, note: &str| {
            line.find(note)
                .map(|byte| line[..byte].chars().count())
                .unwrap_or_else(|| panic!("no {note} in {line}"))
        };
        let rows: Vec<&str> = out.lines().filter(|l| l.starts_with("  ")).collect();
        assert_eq!(rows.len(), 2, "{out}");
        assert_eq!(
            column(rows[0], "all set"),
            column(rows[1], "nothing"),
            "the notes do not start in the same column:\n{out}"
        );
    }
}
