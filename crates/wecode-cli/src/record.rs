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
//!
//! The report is written here as well as filed here, and for the same reason the file
//! is a fence around verbatim text: one generator is what keeps the terminal and the
//! repository from disagreeing about a single merge. [`merged`] builds it, [`keep`]
//! commits it, [`record_line`] says where it went — and [`rolled_back`] is the other
//! half of the same promise, since a report that could not be undone would be a claim
//! rather than a record.

use std::path::Path;

use wecode_core::{Plan, Task, TaskId};

use crate::git;
use crate::render;
use crate::teardown::{Swept, teardown_line};

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

/// What a merge did: a summary anyone can act on, then the detail behind it.
///
/// The summary leads with what undoes it. Auto-merging is only defensible because it
/// is reversible, so the way back is the first thing worth knowing, not a footnote.
#[must_use]
pub(crate) fn merged(
    task: &Task,
    plan: &Plan,
    target: &str,
    branch: &str,
    m: &git::Merged,
    signed: bool,
    swept: &Swept,
) -> String {
    let short = |sha: &str| sha.chars().take(9).collect::<String>();
    let unblocked: Vec<&Task> = plan
        .tasks()
        .filter(|t| t.depends_on.contains(&task.id) && !t.status.is_closed())
        .collect();

    let mut out = format!("MERGED  {} → {target}\n\nsummary\n", task.id);
    out.push_str(&format!(
        "  {} file{}, +{} −{}\n",
        m.files.len(),
        if m.files.len() == 1 { "" } else { "s" },
        m.insertions(),
        m.deletions()
    ));
    out.push_str(&format!(
        "  how        {}\n",
        if signed { "signed off" } else { "automatic" }
    ));
    if !unblocked.is_empty() {
        // The thing only wecode knows: what this merge lets start.
        out.push_str(&format!(
            "  unblocks   {}\n",
            unblocked
                .iter()
                .map(|t| t.id.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    out.push_str(&teardown_line(swept));
    out.push_str(&format!(
        "  undo       wecode rollback {}   (was {})\n",
        task.id,
        short(&m.was)
    ));

    out.push_str("\nwhat changed\n");
    if m.files.is_empty() {
        out.push_str("  nothing — the branch held no changes against the target\n");
    }
    for (path, add, del) in &m.files {
        out.push_str(&format!(
            "  {:<52} +{add:<5} −{del}\n",
            render::truncate_cmd(path, 52)
        ));
    }

    // Only when it actually groups. One line per file under a heading called "by
    // area" is the same list twice.
    let areas = by_area(&m.files);
    if areas.len() > 1 && areas.len() < m.files.len() {
        out.push_str("\nby area\n");
        for (area, files, add, del) in areas {
            out.push_str(&format!(
                "  {:<24} {files} file{}, +{add} −{del}\n",
                area,
                if files == 1 { "" } else { "s" }
            ));
        }
    }

    out.push_str("\nacceptance\n");
    if task.acceptance.is_empty() {
        out.push_str("  none declared\n");
    }
    for a in &task.acceptance {
        out.push_str(&format!("  ✓ {}\n", a.describe()));
    }

    out.push_str(&format!(
        "\nprovenance\n  branch     {branch}\n  merge      {}\n  target was {}\n",
        short(&m.sha),
        short(&m.was)
    ));
    out
}

/// Files grouped by their first two path segments, largest first.
///
/// Two segments because one is usually `crates` or `src` and tells you nothing.
fn by_area(files: &[(String, u32, u32)]) -> Vec<(String, usize, u32, u32)> {
    let mut acc: std::collections::BTreeMap<String, (usize, u32, u32)> = Default::default();
    for (path, add, del) in files {
        // The directory it sits in. Splitting on a fixed depth made a top-level file
        // its own "area", which is the file list again with a different heading.
        let area = match path.rfind('/') {
            Some(i) => path[..i].to_string(),
            None => ".".to_string(),
        };
        let e = acc.entry(area).or_default();
        e.0 += 1;
        e.1 += add;
        e.2 += del;
    }
    let mut v: Vec<(String, usize, u32, u32)> =
        acc.into_iter().map(|(k, (n, a, d))| (k, n, a, d)).collect();
    v.sort_by_key(|x| std::cmp::Reverse(x.2 + x.3));
    v
}

/// The merge report as the file that gets committed.
///
/// The report goes in verbatim, inside a fence. It is deliberately *not* re-rendered
/// into markdown sections: this file is evidence, and evidence is the thing that was
/// produced, not a second telling of it. One generator means the file and the terminal
/// can never drift, and an operator comparing what they saw against what landed is
/// comparing identical text.
///
/// The heading and the two sentences above the fence are all that is added, and they
/// exist to answer the question a reader of a committed file asks first: who wrote this,
/// and may I believe it?
#[must_use]
pub(crate) fn report_file(task: &TaskId, target: &str, report: &str) -> String {
    format!(
        "# {task} → {target}\n\n\
         Written by wecode when the merge landed, from git and its own record of the\n\
         run. Generated, never authored: an agent's account of its own work is\n\
         inadmissible, and a file it could have written would be too.\n\n\
         ```text\n{}\n```\n",
        report.trim_end()
    )
}

/// The one line a merge says about where its own record went.
///
/// In `provenance` and last, because it is the only fact in the report that postdates
/// the report — it cannot be anywhere but the end. That is also why the committed file
/// does not contain this line: nothing can record its own landing.
#[must_use]
pub(crate) fn record_line(r: &Recorded) -> String {
    match r {
        Recorded::Kept { path, sha } => format!("  record     {path} @ {sha}\n"),
        // Named rather than swallowed. The merge is fine; the note about it is missing,
        // and only this line will ever say so.
        Recorded::Lost { path, why } => {
            format!("  record     not written to {path}\n             {why}\n")
        }
    }
}

/// What a rollback undid.
#[must_use]
pub(crate) fn rolled_back(task: &Task, target: &str, merge: &str, revert: &str) -> String {
    let mut out = format!("ROLLED BACK  {} from {target}\n\n", task.id);
    out.push_str(&format!(
        "  reverted   {}\n",
        merge.chars().take(9).collect::<String>()
    ));
    out.push_str(&format!("  revert     {revert}\n"));
    out.push_str("  status     needs-approval — verified, no longer landed\n\n");
    // Said plainly, because "rolled back" could be read as "erased".
    out.push_str("  The merge stays in history: a revert is a new commit, not a rewrite,\n");
    out.push_str("  so this is safe whether or not the branch has been shared.\n");
    // And so does its record, for the same reason. A rollback that deleted the report
    // would leave the branch carrying a merge and a revert that nothing accounts for.
    out.push_str(&format!(
        "  Its record stays too, at {} — the merge did happen.\n\n",
        path_for(&task.id)
    ));
    // The trap, said before it is sprung.
    out.push_str("  git still counts the branch as merged, so `wecode merge` will not\n");
    out.push_str(&format!(
        "  bring it back. To restore it: git revert {revert}\n"
    ));
    out
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

    #[test]
    fn the_committed_report_is_the_printed_one_word_for_word() {
        // The reason for a fence instead of markdown sections: the file is evidence, so
        // it has to be the text that was produced rather than a second telling of it.
        // A re-rendered version could differ from what the operator saw, and then the
        // repository and the terminal disagree about one merge.
        let report = "MERGED  t → dev\n\nsummary\n  1 file, +2 −0\n";
        let file = report_file(&TaskId::new("t"), "dev", report);
        assert!(file.starts_with("# t → dev\n"), "{file}");
        assert!(file.contains(report.trim_end()), "{file}");
        assert!(file.contains("Generated, never authored"), "{file}");
        assert!(file.ends_with("```\n"), "{file}");
    }

    #[test]
    fn a_record_that_did_not_land_says_so_rather_than_nothing() {
        // The merge succeeded either way, so this line is the only thing that will ever
        // tell an operator the note about it is missing.
        let kept = record_line(&Recorded::Kept {
            path: "docs/wecode/t/report.md".into(),
            sha: "abc1234".into(),
        });
        assert_eq!(kept, "  record     docs/wecode/t/report.md @ abc1234\n");

        let lost = record_line(&Recorded::Lost {
            path: "docs/wecode/t/report.md".into(),
            why: "git worktree add failed: no space left on device".into(),
        });
        assert!(
            lost.contains("not written to docs/wecode/t/report.md"),
            "{lost}"
        );
        assert!(lost.contains("no space left on device"), "{lost}");
    }
}
