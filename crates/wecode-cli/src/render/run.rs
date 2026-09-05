//! What running an agent did, as the operator reads it.
//!
//! Beside the other views rather than inside [`crate::spawn`], on the split the parent
//! module draws: supervising a process and describing one are different jobs, and the
//! supervisor is the file that has to stay readable while the clock, the meter and the
//! signal handling all live in it. Facts only — the verdict comes from `verify`.

use wecode_core::Task;
use wecode_org::Post;

use crate::render::{kind_tag, truncate_cmd};
use crate::spawn::{Limits, Outcome};

/// The cached context a run re-read, said beside what it spent.
///
/// Not added to it: those tokens are counted when they are written, and a long
/// conversation replays them once per turn — the figure runs to millions where the
/// spend runs to thousands, which is why a budget is not written in it. Saying it
/// here is what keeps that decision from hiding real money, since cache reads are
/// billed, at a tenth of the rate. Silent when there were none, so a short run's
/// line stays a short line.
fn replay(o: &Outcome) -> String {
    match o.replayed {
        Some(n) if n > 0 => format!(" (+{n} re-read from cache, not budgeted)"),
        _ => String::new(),
    }
}

/// The clock the run was held to, and whose clock it was.
///
/// Beside `took`, because the two numbers only mean anything together: a run that ended
/// at 60s under a 60s wall was killed, and one that ended at 60s under half an hour
/// finished. Without the second figure "killed — wall limit" sends the operator to
/// `company.toml` to find out which limit, and half the time the answer is the task's own
/// budget rather than anything in that file.
///
/// So the source is named, not just the number. A task's wall and a harness's wall are
/// two declarations in two files with two owners, and "give it longer" means editing a
/// different one depending on which of them bit. Silent when the run was held to nothing
/// at all, which is what an unlimited configuration deserves to look like.
///
/// The token cap is named on the same line and for the same reason. It reads beside the
/// spend two lines down, so "killed — token budget" can be checked against the figure
/// that killed it without opening the plan.
fn held_to(task: &Task, post: &Post, l: Limits) -> String {
    let mut parts = Vec::new();
    if let Some(wall) = l.wall {
        // The task's when it declared this figure — including when the template happens
        // to name the same one, since then it is both, and the task is the declaration
        // the operator has in front of them.
        let whose = if task.budget.wall_secs == Some(wall.as_secs()) {
            "this task's budget".to_string()
        } else {
            format!("the {} template", post.agent)
        };
        parts.push(format!("wall {}s ({whose})", wall.as_secs()));
    }
    if let Some(idle) = l.idle {
        parts.push(format!("idle {}s", idle.as_secs()));
    }
    // No source named: a token cap has only one, the task, since no template declares
    // one to be confused with.
    if let Some(tokens) = l.tokens {
        parts.push(format!("{tokens} tokens (this task's budget)"));
    }
    if parts.is_empty() {
        return String::new();
    }
    format!("  limit    {}\n", parts.join(", "))
}

/// What running the agent did. Facts only — the verdict comes from `verify`.
///
/// `model` is what the seat's level resolved to. Named on the line rather than left to
/// be inferred: it is the most expensive variable in a run, and a spend figure beside a
/// model nobody wrote down is a number with no unit.
///
/// `limits` is what the run was actually stopped by, passed in rather than read back off
/// the task or the template: it is composed from both, and a report that recomputed it
/// could disagree with the clock the process was held to.
#[must_use]
pub(crate) fn ran(
    task: &Task,
    post: &Post,
    model: Option<&str>,
    cwd: &std::path::Path,
    limits: Limits,
    o: &Outcome,
) -> String {
    let mut out = format!(
        "{} {}  {}\n  post     {} ({})\n  in       {}\n  took     {:.0}s\n{}  spent    {}\n  {}\n",
        kind_tag(task.kind),
        task.id,
        task.title,
        post.name,
        match (model, post.intelligence) {
            (Some(m), Some(i)) => format!("{}, {m} at {i}", post.agent),
            // A harness left to its own default. Said as such, because "claude" alone
            // reads as a complete answer to the question of what ran.
            _ => format!("{}, its own default model", post.agent),
        },
        cwd.display(),
        o.took.as_secs_f64(),
        held_to(task, post, limits),
        match o.spent {
            Some(n) => format!("{n} tokens, as the agent reported them{}", replay(o)),
            // Not "0": the agent's protocol says nothing wecode can read a count
            // out of, and a budget cannot be checked against a number nobody has.
            None => "unmetered — this agent reports no token usage".to_string(),
        },
        if o.ended.ok() {
            format!("✓ {}", o.ended.describe())
        } else {
            format!("✗ {}", o.ended.describe())
        }
    );
    if o.truncated {
        out.push_str("  output was capped\n");
    }
    // The tail, not the whole log: enough to see how it ended without burying the
    // verdict that follows.
    let tail: Vec<&str> = o.output.lines().rev().take(12).collect();
    if !tail.is_empty() {
        out.push_str("\nlast output\n");
        for line in tail.into_iter().rev() {
            out.push_str(&format!("  {}\n", truncate_cmd(line, 100)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spawn::Ended;
    use wecode_core::Budget;

    /// A finished run, so a test can vary the clock it was held to and nothing else.
    fn outcome() -> Outcome {
        Outcome {
            ended: Ended::Exited(0),
            output: String::new(),
            took: std::time::Duration::from_secs(12),
            truncated: false,
            spent: Some(90),
            replayed: None,
        }
    }

    fn seat() -> Post {
        Post {
            name: "impl".into(),
            role: "engineer".into(),
            agent: "claude-code".into(),
            intelligence: None,
        }
    }

    fn ran_under(wall: Option<u64>, idle: Option<u64>) -> String {
        held(wall, idle, None)
    }

    fn held(wall: Option<u64>, idle: Option<u64>, tokens: Option<u64>) -> String {
        // `cache` as the plan holds it: budgeted at 600s and 9000 tokens, which is what
        // the report has to name a source for.
        let task = Task::new("cache", "export", "add a response cache").budgeted(Budget {
            tokens: Some(9000),
            wall_secs: Some(600),
        });
        ran(
            &task,
            &seat(),
            None,
            std::path::Path::new("/run/cws/cache"),
            Limits {
                wall: wall.map(std::time::Duration::from_secs),
                idle: idle.map(std::time::Duration::from_secs),
                tokens,
            },
            &outcome(),
        )
    }

    #[test]
    fn a_run_says_which_clock_it_was_held_to_and_whose_it_was() {
        // `cache` is budgeted at 600s. Held to that figure, the report names the task —
        // because "killed — wall limit" otherwise sends the operator to company.toml to
        // find a limit that is not written there.
        let out = ran_under(Some(600), Some(300));
        assert!(
            out.contains("limit    wall 600s (this task's budget), idle 300s"),
            "{out}"
        );

        // Held to the harness's own instead: a different file, a different owner, and
        // the thing to edit if this run wants longer.
        let out = ran_under(Some(1800), Some(300));
        assert!(
            out.contains("limit    wall 1800s (the claude-code template)"),
            "{out}"
        );
    }

    #[test]
    fn the_token_cap_a_run_was_stopped_by_is_on_the_same_line() {
        // `cache` is budgeted at 9000 tokens, and that figure now ends runs rather than
        // only colouring rows afterwards. Printed beside the spend, so "killed — token
        // budget" can be read against the number that did it.
        let out = held(Some(600), Some(300), Some(9000));
        assert!(
            out.contains("limit    wall 600s (this task's budget), idle 300s, 9000 tokens"),
            "{out}"
        );

        // A cap and nothing else still prints, without a stray separator.
        let out = held(None, None, Some(9000));
        assert!(
            out.contains("limit    9000 tokens (this task's budget)\n"),
            "{out}"
        );
    }

    #[test]
    fn a_run_under_no_clock_at_all_says_nothing_about_one() {
        // An unlimited configuration should look unlimited, not like a limit nobody
        // filled in.
        let out = ran_under(None, None);
        assert!(!out.contains("limit"), "{out}");
        assert!(out.contains("took     12s"), "{out}");

        // And one half alone still prints, without a stray separator.
        let out = ran_under(None, Some(300));
        assert!(out.contains("limit    idle 300s\n"), "{out}");
    }
}
