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

use wecode_core::TaskKind;

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
