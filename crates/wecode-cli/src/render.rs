//! Views of the concepts the crates below this one own.
//!
//! Rendering lives with the thing it renders. A worktree listing belongs beside the
//! code that knows where worktrees are, a run report beside the supervisor that watched
//! the run, a merge report beside the record it is committed as — and every one of
//! those things is defined in this crate, so every one of those renderers now sits in
//! the module that defines it. What is left here is the half `wecode-cli` cannot put
//! beside its subject: a [`wecode_core::Plan`] is core's, a `Playbook` and a `Company`
//! are org's, a `Grant` and a `Decision` are gov's, and none of those crates may know
//! that a terminal exists — `core` has no dependencies at all, which is the ordering
//! the whole design rests on. Their views live in the one crate that prints anything,
//! one module per concept.
//!
//! Pure string functions throughout, so the output is testable without a terminal.
//!
//! What stays in this file is what every view shares, and each of the three is shared
//! across modules that own different things: a task's tag is read on the board, in the
//! cockpit, in a run report and in a plan listing, and it has to be the same five
//! characters in all four.

pub(crate) mod gov;
pub(crate) mod org;
pub(crate) mod plan;
pub(crate) mod playbook;

use wecode_core::{Task, TaskKind, TaskStatus};

/// What a row that has stopped is asking of the person reading it.
///
/// Almost always the status itself, which is already the honest answer: `failed` and
/// `needs-input` say what they want. `needs-approval` is the one that comes apart. On an
/// agent's task it means *look at what I did*; on a manual task it means the opposite —
/// nothing has been done, and the doing is the reader's. One status, two requests, and a
/// board that printed the same word for both would send an operator to look for a diff
/// that was never going to exist.
#[must_use]
pub(crate) fn waiting_word(t: &Task) -> String {
    if t.is_done_by_a_person() && t.status == TaskStatus::NeedsApproval {
        "yours to do".to_string()
    } else {
        t.status.as_str().to_string()
    }
}

#[must_use]
pub(crate) fn kind_tag(kind: TaskKind) -> &'static str {
    match kind {
        TaskKind::Feature => "feat",
        TaskKind::Bug => "bug",
        // Five characters at most: the tag column is padded to 5, and `refactor`
        // would push every title out of alignment.
        TaskKind::Refactor => "refac",
        TaskKind::Chore => "chore",
        TaskKind::Spike => "spike",
        TaskKind::Design => "dsgn",
        TaskKind::Docs => "docs",
    }
}

/// An age in the largest unit that still says something.
fn ago(secs: u64) -> String {
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m", secs / 60),
        3600..=86_399 => format!("{}h", secs / 3600),
        _ => format!("{}d", secs / 86_400),
    }
}

/// `s`, cut to `max` characters and marked as cut.
///
/// Characters rather than bytes, because this one fits a column: what it shapes is a
/// path or a command line standing in a width the reader scans down.
pub(crate) fn truncate_cmd(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::task::Doer;

    fn stopped(doer: Doer, status: TaskStatus) -> String {
        let mut t = Task::new("t", "p", "x").done_by(doer);
        t.status = status;
        waiting_word(&t)
    }

    #[test]
    fn one_status_asks_two_different_things_of_the_reader() {
        assert_eq!(
            stopped(Doer::Agent, TaskStatus::NeedsApproval),
            "needs-approval",
            "an agent's finished work is waiting to be looked at"
        );
        assert_eq!(
            stopped(Doer::Person, TaskStatus::NeedsApproval),
            "yours to do",
            "nothing has been done — this is the job itself"
        );
    }

    #[test]
    fn every_other_stop_says_what_it_already_said() {
        // Only `needs-approval` is ambiguous. A manual task that failed its probes, or
        // that asked a question, wants exactly what those words already ask for.
        for s in [
            TaskStatus::Failed,
            TaskStatus::NeedsInput,
            TaskStatus::Running,
        ] {
            assert_eq!(stopped(Doer::Person, s), s.as_str(), "{s:?}");
            assert_eq!(stopped(Doer::Agent, s), s.as_str(), "{s:?}");
        }
    }
}
