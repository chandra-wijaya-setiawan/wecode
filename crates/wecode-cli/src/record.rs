//! Keeping a merge's report, and a story's, in the repository they describe.
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
//!
//! One reader was still being left out: **the person who has to sign the merge.** The
//! report is the document that says what a task did, and until [`proposed`] it was only
//! ever produced *after* the decision it exists to inform — filed where the operator
//! could read it once it no longer mattered, while the notification asking them to
//! approve carried a diff and a file list and nothing that added them up. So the same
//! body is rendered before the merge as well, from the same functions, minus every line
//! that is a fact a merge creates: no merge sha, no undo, no `how`. What the signer
//! reads is what the repository will say about what they signed.
//!
//! A story is filed the same way and from a different source. ADR-0006 makes its
//! completion report generated too, but a story never merges — it aggregates — so there
//! is no diff and no merge sha to build one out of. What there is instead is the ledger:
//! the obligations the story stated, the tasks that answered them, and what those runs
//! cost. [`report::story`] does that join and [`closing_file`] files it, at the same path
//! and behind the same fence, so `docs/wecode/<story>/` ends up holding the two documents
//! ADR-0006 leaves standing — one `design.md` somebody wrote, one report nobody could.
//!
//! **Not wired yet.** The close command is what calls that pair, and the change that adds
//! it deletes the two `allow(dead_code)` below. `wecode close <story>` renders
//! [`report::story`] once from `store.requirements(None, Some(&id))`, the loaded plan and
//! `store.audit(&AuditQuery::default())`; prints it and stops where [`report::closes`] is
//! false, since nothing landed and there is nothing to file; and otherwise commits
//! `closing_file(&story.id, &report)` through [`keep`], exactly as `merge_task` commits
//! [`report_file`]. The story's branch and the project's integration branch are the only
//! other arguments [`keep`] wants, and that command already holds both.

use std::path::Path;

use wecode_core::{Plan, Task, TaskId};

use crate::git;
use crate::install::{Installed, install_line};
use crate::render;
use crate::teardown::{Swept, teardown_line};

/// The story report's own renderer.
///
/// The file sits under `render/` because of the rule that module states: what it renders
/// is core's [`Plan`] and the store's `Requirement` rows, and a view of another crate's
/// concepts belongs there. It is declared from here rather than from `render.rs` because
/// `render.rs` was outside the scope of the change that wrote it; moving the line is one
/// edit — `pub(crate) mod report;` there, this attribute and this comment gone.
#[path = "render/report.rs"]
pub(crate) mod report;

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
// Eight parameters is one past clippy's threshold, and the honest fix is a
// struct of the merge's facts rather than a shorter signature that hides one.
// Deferred: this function is a renderer, its parameters are its inputs, and the
// aftermath (swept, installed) arrived here because a merge now does more.
#[allow(clippy::too_many_arguments)]
#[must_use]
pub(crate) fn merged(
    task: &Task,
    plan: &Plan,
    target: &str,
    branch: &str,
    m: &git::Merged,
    signed: bool,
    swept: &Swept,
    installed: &Installed,
) -> String {
    let short = |sha: &str| sha.chars().take(9).collect::<String>();

    let mut out = format!("MERGED  {} → {target}\n\nsummary\n", task.id);
    out.push_str(&tally(m.files.len(), m.insertions(), m.deletions()));
    out.push_str(&format!(
        "  how        {}\n",
        if signed { "signed off" } else { "automatic" }
    ));
    out.push_str(&unblocks(task, plan));
    out.push_str(&teardown_line(swept));
    // Beside the worktree line, because they are the two facts a merge creates about the
    // machine it ran on rather than about the branch. No ledger row: this file is
    // committed, generated, and already the document that says what a merge did, so a
    // second record of the same event would be a second thing to keep in agreement.
    out.push_str(&install_line(installed));
    out.push_str(&format!(
        "  undo       wecode rollback {}   (was {})\n",
        task.id,
        short(&m.was)
    ));

    // Every file, however many there are: a file in a repository has room for the
    // whole list, which is the one thing it has over the message that asked for the
    // signature. See [`proposed`] for the end of that bargain.
    out.push_str(&changes(
        &m.files,
        usize::MAX,
        "nothing — the branch held no changes against the target",
    ));
    // Ticked, because it landed: a merge is downstream of a passing verdict, so the
    // mark is a statement about what happened rather than a list of conditions.
    out.push_str(&acceptance(task, "✓"));

    out.push_str(&format!(
        "\nprovenance\n  branch     {branch}\n  merge      {}\n  target was {}\n",
        short(&m.sha),
        short(&m.was)
    ));
    out
}

/// The same report, before the merge instead of after it — what a notification hands
/// the person whose signature the merge is waiting on.
///
/// Every line of it comes from the functions [`merged`] uses, and that is the whole
/// point: an operator approving from a phone and the repository they approved it into
/// are reading one document, not two accounts of one change. A second renderer here
/// would be free to drift, and the shape of that bug is a signature given against a
/// summary the record then contradicts.
///
/// What is missing is exactly what a merge creates and nothing else: no merge sha, no
/// `target was`, no `undo`, no `how`. Those are not omitted for brevity — they do not
/// exist yet, and inventing a line for them is how a proposal starts reading like a
/// receipt.
///
/// `most` bounds the file rows, because this one goes into an environment and out to a
/// channel with a ceiling — it is the operator's own `max_files`, applied to the same
/// list of paths for the same reason. The counts above the rows are never bounded, so a
/// report showing ten rows of forty still says forty.
#[must_use]
pub(crate) fn proposed(
    task: &Task,
    plan: &Plan,
    files: &[(String, u32, u32)],
    most: usize,
) -> String {
    let mut out = String::from("summary\n");
    out.push_str(&tally(
        files.len(),
        files.iter().map(|(_, a, _)| a).sum(),
        files.iter().map(|(_, _, d)| d).sum(),
    ));
    out.push_str(&unblocks(task, plan));
    out.push_str(&changes(
        files,
        most,
        "nothing yet — the attempt has written no files",
    ));
    // Listed, not ticked. This report goes out on every wait that has a tree behind it,
    // and one of those is `failed` — a `✓` beside the command that just refused the work
    // would be the report contradicting the reason it was sent.
    out.push_str(&acceptance(task, "·"));
    out
}

/// How much this is: files, and what they gained and lost between them.
///
/// Given the three numbers rather than the list, because a merge already has them from
/// git's own accounting of it and a proposal has to add them up — one line, told the
/// same way, from whichever side knows.
fn tally(count: usize, add: u32, del: u32) -> String {
    format!(
        "  {count} file{}, +{add} −{del}\n",
        if count == 1 { "" } else { "s" }
    )
}

/// What landing this lets start, and nothing at all when it lets nothing start.
///
/// The thing only wecode knows. git can say what a change touched; only the plan can
/// say that three tasks have been sitting behind it.
fn unblocks(task: &Task, plan: &Plan) -> String {
    let waiting: Vec<String> = plan
        .tasks()
        .filter(|t| t.depends_on.contains(&task.id) && !t.status.is_closed())
        .map(|t| t.id.to_string())
        .collect();
    if waiting.is_empty() {
        return String::new();
    }
    format!("  unblocks   {}\n", waiting.join(", "))
}

/// The change itself: every file with its line counts, and the areas they fall in.
///
/// `most` rows at the outside, and the overflow is *named as an overflow* rather than
/// dropped — the count in [`tally`] above is the true one, so a reader handed a cut list
/// has to be able to tell that it was cut.
fn changes(files: &[(String, u32, u32)], most: usize, empty: &str) -> String {
    let mut out = String::from("\nwhat changed\n");
    if files.is_empty() {
        out.push_str(&format!("  {empty}\n"));
    }
    for (path, add, del) in files.iter().take(most) {
        out.push_str(&format!(
            "  {:<52} +{add:<5} −{del}\n",
            render::truncate_cmd(path, 52)
        ));
    }
    if let Some(rest) = files.len().checked_sub(most).filter(|n| *n > 0) {
        out.push_str(&format!("  … and {rest} more\n"));
    }

    // Only when it actually groups. One line per file under a heading called "by
    // area" is the same list twice. It survives a bound the list did not, which is
    // most of why it is worth printing at all: a cut list of forty paths still says
    // which corners of the tree they were in.
    let areas = by_area(files);
    if areas.len() > 1 && areas.len() < files.len() {
        out.push_str("\nby area\n");
        for (area, n, add, del) in areas {
            out.push_str(&format!(
                "  {:<24} {n} file{}, +{add} −{del}\n",
                area,
                if n == 1 { "" } else { "s" }
            ));
        }
    }
    out
}

/// What the work is held to, each line marked with `mark`.
///
/// The mark is the caller's because the same list means two things at two moments: a
/// tick is a claim that these passed, and only a report written after a verdict may
/// make it.
fn acceptance(task: &Task, mark: &str) -> String {
    let mut out = String::from("\nacceptance\n");
    if task.acceptance.is_empty() {
        out.push_str("  none declared\n");
    }
    for a in &task.acceptance {
        out.push_str(&format!("  {mark} {}\n", a.describe()));
    }
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
    filed(
        &format!("{task} → {target}"),
        "Written by wecode when the merge landed, from git and its own record of the\n\
         run. Generated, never authored: an agent's account of its own work is\n\
         inadmissible, and a file it could have written would be too.",
        report,
    )
}

/// A story's completion report as the file that gets committed.
///
/// No target branch in the heading, unlike [`report_file`]. A merge report is about a
/// change arriving somewhere and names where; a story's report is about the story, which
/// landed over as many merges as it had tasks. Naming one of those branches here would
/// pick a winner among them.
#[allow(
    dead_code,
    reason = "the call site is the close command, out of this task's scope"
)]
#[must_use]
pub(crate) fn closing_file(story: &TaskId, report: &str) -> String {
    filed(
        &format!("{story} closed"),
        "Written by wecode when the story closed, from the ledger and the plan.\n\
         Generated, never authored: it restates no obligation and quotes no agent, so\n\
         there is nothing in it that a second reading could have got wrong.",
        report,
    )
}

/// A report as a committed file: a heading, who wrote it and why it may be believed, and
/// then the report itself inside a fence.
///
/// One writer for both, because the fence is the promise. What differs between a merge's
/// record and a story's is the sentence above it — the two were written at different
/// moments out of different evidence — and everything a reader has to trust about the
/// shape is the same either way.
fn filed(heading: &str, provenance: &str, report: &str) -> String {
    format!(
        "# {heading}\n\n{provenance}\n\n```text\n{}\n```\n",
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
    use wecode_core::{Measure, Project};

    /// A task with two acceptance commands, and a plan with one task still queued
    /// behind it.
    fn work() -> (Task, Plan) {
        let mut plan = Plan::new();
        plan.add_project(Project::new("proj", "an objective sentence", "repo"))
            .unwrap();
        let task = Task::new("notify-report", "proj", "put the report in front")
            .accepting(Measure::Command {
                cmd: "cargo test --workspace".into(),
                expect_status: 0,
            })
            .accepting(Measure::Command {
                cmd: "bash scripts/max-lines.sh".into(),
                expect_status: 0,
            });
        plan.add_task(task.clone()).unwrap();
        plan.add_task(Task::new("next", "proj", "waiting on it").after("notify-report"))
            .unwrap();
        (task, plan)
    }

    /// Four files over three directories, so `by area` has something to group.
    fn changed() -> Vec<(String, u32, u32)> {
        vec![
            ("crates/wecode-cli/src/notify.rs".to_string(), 120, 4),
            ("crates/wecode-cli/src/record.rs".to_string(), 80, 6),
            ("crates/wecode-cli/tests/notify.rs".to_string(), 40, 0),
            ("docs/reference/config/notify.md".to_string(), 12, 3),
        ]
    }

    #[test]
    fn the_report_a_signature_is_asked_against_is_the_one_the_record_will_keep() {
        // The whole point of rendering it here. An operator approving from a phone and
        // the repository they approved it into have to be reading one document: a second
        // renderer would be free to drift, and the shape of that bug is a signature
        // given against a summary the record then contradicts.
        let (task, plan) = work();
        let before = proposed(&task, &plan, &changed(), usize::MAX);
        let after = merged(
            &task,
            &plan,
            "master",
            "wecode/notify-report",
            &git::Merged {
                was: "c010c2bdb1".into(),
                sha: "7fee207901".into(),
                files: changed(),
            },
            true,
            &Swept::Nothing,
            &Installed::Unasked,
        );
        for shared in [
            "  4 files, +252 −13\n",
            "  unblocks   next\n",
            "crates/wecode-cli/src/notify.rs",
            "\nby area\n",
            "2 files, +200 −10\n",
            "cargo test --workspace",
        ] {
            assert!(before.contains(shared), "missing from the proposal: {before}");
            assert!(after.contains(shared), "missing from the record: {after}");
        }
    }

    #[test]
    fn a_proposal_carries_nothing_a_merge_has_not_done_yet() {
        // Not brevity: those lines do not exist. A merge sha, the commit the target was
        // on, the undo that reverses it and whether it was signed off are all facts a
        // merge creates, and a proposal that printed a shape for them would read like a
        // receipt for something nobody has decided.
        let (task, plan) = work();
        let before = proposed(&task, &plan, &changed(), usize::MAX);
        for absent in ["MERGED", "undo", "provenance", "how  ", "target was"] {
            assert!(!before.contains(absent), "{absent} is not a fact yet: {before}");
        }
    }

    #[test]
    fn what_a_proposal_must_satisfy_is_listed_and_not_ticked() {
        // The report goes out on every wait with a tree behind it, and one of those is
        // `failed`. A `✓` beside the command that just refused the work would have the
        // report contradicting the reason it was sent — so the tick belongs to the
        // record, which is written downstream of a verdict that passed.
        let (task, plan) = work();
        let before = proposed(&task, &plan, &changed(), usize::MAX);
        assert!(before.contains("  · `cargo test --workspace` exits 0"), "{before}");
        assert!(!before.contains('✓'), "a proposal has passed nothing yet: {before}");
    }

    #[test]
    fn a_file_list_cut_to_fit_a_message_says_that_it_was_cut() {
        // The same honesty the count beside the names has, and the same reason: a reader
        // handed part of a list must be able to tell it is a part. The tally above is the
        // true number either way, and `by area` survives the bound — which is most of why
        // it is worth printing, since a cut list of paths still says where they fell.
        let (task, plan) = work();
        let cut = proposed(&task, &plan, &changed(), 1);
        assert!(cut.contains("  4 files, +252 −13\n"), "{cut}");
        assert!(cut.contains("crates/wecode-cli/src/notify.rs"), "{cut}");
        assert!(cut.contains("  … and 3 more\n"), "{cut}");
        assert!(!cut.contains("docs/reference/config/notify.md"), "{cut}");
        assert!(cut.contains("\nby area\n"), "{cut}");
        assert!(cut.contains("2 files, +200 −10\n"), "where they fell: {cut}");

        // `max_files = 0` is legal and means the count alone. The rows go; nothing
        // claims there were none.
        let none = proposed(&task, &plan, &changed(), 0);
        assert!(none.contains("  4 files, +252 −13\n"), "{none}");
        assert!(none.contains("  … and 4 more\n"), "{none}");
        assert!(!none.contains("crates/wecode-cli/src/notify.rs"), "{none}");
    }

    #[test]
    fn a_tree_nothing_has_been_written_in_yet_says_so_in_words() {
        // Distinct from *has not started*, which is the notification sending no report
        // at all. This is an attempt that ran and produced nothing, which is a thing a
        // person is genuinely being woken up to decide about.
        let (task, plan) = work();
        let empty = proposed(&task, &plan, &[], usize::MAX);
        assert!(empty.contains("  0 files, +0 −0\n"), "{empty}");
        assert!(empty.contains("the attempt has written no files"), "{empty}");
        assert!(!empty.contains("… and"), "nothing was held back: {empty}");
    }

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
    fn a_story_is_filed_behind_the_same_fence_and_a_different_sentence() {
        // The fence is what both documents promise: verbatim text, so what a reader saw
        // and what landed stay comparable word for word. What differs is who wrote it and
        // out of what — a merge's record from a diff, a story's from the ledger — and that
        // is the question a reader of a committed file asks before believing any of it.
        let report = "CLOSED  one-tap-checkout — buy a basket in one step\n";
        let file = closing_file(&TaskId::new("one-tap-checkout"), report);
        assert!(file.starts_with("# one-tap-checkout closed\n"), "{file}");
        assert!(file.contains("when the story closed, from the ledger"), "{file}");
        assert!(file.contains("Generated, never authored"), "{file}");
        assert!(file.contains(report.trim_end()), "{file}");
        assert!(file.ends_with("```\n"), "{file}");
        // And no branch in the heading. A story landed over as many merges as it had
        // tasks, so naming one of them would be picking a winner among them.
        assert!(!file.contains(" → "), "{file}");
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
