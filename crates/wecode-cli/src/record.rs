//! Keeping the merge report in the repository it describes.
//!
//! `wecode merge` already built the one document that says what a task did — files,
//! line counts, acceptance, provenance, what the merge unblocked, what became of the
//! worktree — and then printed it to a terminal that scrolls. A week later the only
//! surviving trace of a landed task is a merge commit and whatever the plan still says.
//! The report was evidence and it was thrown away.
//!
//! So it is committed, on the integration branch, at a path the repository already uses:
//! `docs/wecode/<task>/report.md`, beside the `design.md` the design gate looks for. Two
//! files, and the split between them is the whole point of writing this one down:
//!
//! | file | author | admissible as |
//! |---|---|---|
//! | `design.md` | the design subtask, signed by a person | a proposal someone approved |
//! | `report.md` | wecode, from git and its own record | evidence |
//!
//! Generated, never authored. An agent's account of its own work is inadmissible
//! everywhere else in wecode, and a file it could have written would be inadmissible
//! here too.
//!
//! There is no way to switch this off, and that is deliberate. A merge that leaves no
//! record is the gap this closes; a flag for turning the record off is a flag for
//! turning the audit off. What a project *can* decline is merging through wecode at all,
//! which is what leaving `merge_to` unset already means.

use std::path::Path;

use wecode_core::TaskId;

use crate::git;

/// Where a task's work record lives, relative to the repository root.
///
/// One fixed convention rather than a playbook field, because the design gate already
/// depends on this directory — `test -f docs/wecode/{{task}}/design.md` is a real
/// acceptance command precisely because nobody has to configure the path. A second,
/// configurable location for the sibling file could disagree with it, and then the two
/// halves of one task's record sit in different places.
#[must_use]
pub(crate) fn path_for(task: &TaskId) -> String {
    format!("docs/wecode/{task}/report.md")
}

/// What became of the attempt to keep the report.
///
/// Both outcomes carry the path. A record that failed to land is worth naming *by
/// destination*: the operator's next move is to look there, find nothing, and know why.
pub(crate) enum Recorded {
    /// Committed on the integration branch.
    Kept { path: String, sha: String },
    /// The merge landed and the record did not. Never fatal — see [`keep`].
    Lost { path: String, why: String },
}

/// Writes the report onto `target` as its own commit.
///
/// Never returns an error, because there is no error left to return. The merge has
/// already landed by the time this runs, and failing the command afterwards would tell
/// an operator their merge failed when it did not. A missing record is a line in the
/// report instead — which is the honest shape of it: the merge happened, the note about
/// it did not.
pub(crate) fn keep(
    repo: &Path,
    scratch: &Path,
    target: &str,
    task: &TaskId,
    branch: &str,
    report: &str,
) -> Recorded {
    let path = path_for(task);
    let message =
        format!("{task}: merge record\n\nwritten by wecode when {branch} landed on {target}");
    match git::commit_file(repo, scratch, target, &path, report, &message) {
        Ok(Some(sha)) => Recorded::Kept { path, sha },
        // Only reachable if a byte-identical report is already committed there, which
        // takes a merge sha repeating itself. Reported rather than passed off as kept:
        // the sha this run would have written is not on the branch.
        Ok(None) => Recorded::Lost {
            path,
            why: "git found nothing to commit — the file already said exactly this".into(),
        },
        Err(e) => Recorded::Lost {
            path,
            why: e.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_sits_beside_the_design_the_gate_looks_for() {
        // The gate's acceptance command is `test -f docs/wecode/<task>/design.md`, and
        // the two halves of one task's record are only one thing if they share a
        // directory.
        assert_eq!(
            path_for(&TaskId::new("merge-record")),
            "docs/wecode/merge-record/report.md"
        );
    }
}
