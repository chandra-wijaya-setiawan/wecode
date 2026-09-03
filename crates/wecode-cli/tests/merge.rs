//! Landing the work: the policy, the record, the branch, and the tree it leaves.
//!
//! The steps of an expansion are here too, because what makes a step a step is that
//! it lands with its main task rather than on its own.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use support::merge::{landed_task, mergeable};
use support::{Org, git, git_out};

// ----------------------------------------------------------------- merge ------

#[test]
fn an_auto_project_merges_without_being_asked_and_reports_what_it_did() {
    let (org, repo) = mergeable("merge-auto", "auto");
    landed_task(&org, "t");

    let r = org.run(&["merge", "t"]);
    r.assert_ok("merge")
        .assert_contains("MERGED  t → dev")
        .assert_contains("how        automatic")
        // The way back leads, because auto-merge is only defensible if it is undoable.
        .assert_contains("undo       wecode rollback t")
        .assert_contains("src/app.txt");
    org.run(&["show", "t"]).assert_contains("status     done");

    let on_dev = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", "dev:src/app.txt"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&on_dev.stdout).contains("landed"));
}

#[test]
fn an_approved_project_waits_for_a_signature() {
    let (org, _) = mergeable("merge-approved", "approved");
    landed_task(&org, "t");

    let r = org.run(&["merge", "t"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("needs a signature")
        .assert_contains("wecode approve merge --task t");

    // A recorded signature, not a flag: the ledger is what the charter reads.
    org.run(&["approve", "merge", "--task", "t"])
        .assert_ok("sign");
    org.run(&["merge", "t"])
        .assert_ok("signed")
        .assert_contains("how        signed off");
}

#[test]
fn the_charter_outranks_an_auto_project() {
    // A project may be stricter than the company, never laxer. `merge = "auto"` on a
    // branch the charter protects changes nothing.
    let (org, _) = mergeable("merge-charter", "auto");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        text.replace("approval_to_merge = [", "approval_to_merge = [\"dev\", "),
    )
    .unwrap();

    landed_task(&org, "t");
    let r = org.run(&["merge", "t"]);
    assert!(!r.ok(), "the charter protects dev");
    r.assert_contains("charter protects that branch");

    // And a signature still lands it — the charter demands one, it does not forbid.
    org.run(&["approve", "merge", "--task", "t"])
        .assert_ok("sign");
    org.run(&["merge", "t"])
        .assert_ok("signed")
        .assert_contains("MERGED");
}

#[test]
fn only_verified_work_merges() {
    let (org, _) = mergeable("merge-unverified", "auto");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "chore",
        "append a marker comment to the source",
        "--write",
        "src/**",
        "--accept-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "5",
        "--to",
        "impl",
    ])
    .assert_ok("task add");
    let r = org.run(&["merge", "t"]);
    assert!(!r.ok());
    r.assert_contains("only verified work merges");
}

#[test]
fn a_merge_can_be_rolled_back_and_says_how_to_restore_it() {
    let (org, repo) = mergeable("merge-rollback", "auto");
    landed_task(&org, "t");
    org.run(&["merge", "t"]).assert_ok("merge");

    org.run(&["rollback", "t"])
        .assert_ok("rollback")
        .assert_contains("ROLLED BACK")
        // The trap, named before it is sprung.
        .assert_contains("will not")
        .assert_contains("git revert");
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");

    let on_dev = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", "dev:src/app.txt"])
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&on_dev.stdout).contains("landed"));
}

#[test]
fn the_merge_report_is_committed_where_the_task_record_lives() {
    // The gap: `merge` built the one document that says what a task did — files, line
    // counts, acceptance, provenance, what became of the tree — and printed it to a
    // terminal that scrolls. A week on, the only surviving trace of a landed task was a
    // merge commit.
    let (org, repo) = mergeable("merge-record", "auto");
    landed_task(&org, "t");

    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("record     docs/wecode/t/report.md @");

    // Beside the design the gate looks for, so one task's record is one directory.
    let file = git_out(&repo, &["show", "dev:docs/wecode/t/report.md"]);
    assert!(file.starts_with("# t → dev"), "{file}");
    assert!(file.contains("Generated, never authored"), "{file}");
    // The file *is* the report, not a second telling of it: re-rendering would give one
    // merge two accounts that could disagree.
    assert!(file.contains("MERGED  t → dev"), "{file}");
    assert!(file.contains("src/app.txt"), "{file}");
    assert!(file.contains("undo       wecode rollback t"), "{file}");
    assert!(file.contains("worktree   removed"), "{file}");
    // The one line it cannot carry is the one saying where it went. Nothing records its
    // own landing.
    assert!(!file.contains("record     docs"), "{file}");

    // A commit of its own, on top of the merge, because the report names the merge sha
    // and no commit can contain its own name. Not a merge commit either — `rollback`
    // finds the merge by grepping `--merges`, and a second match would break it.
    let log = git_out(&repo, &["log", "dev", "--format=%s", "-n", "2"]);
    let mut lines = log.lines();
    assert_eq!(lines.next(), Some("t: merge record"), "{log}");
    assert!(
        lines.next().expect("the merge").contains("t: append"),
        "{log}"
    );
    // `rollback` finds the merge by grepping `--merges`, so a record that was itself a
    // merge commit would be a second match sitting in front of the real one.
    let parents = git_out(&repo, &["rev-list", "--parents", "-n", "1", "dev"]);
    assert_eq!(
        parents.split_whitespace().count(),
        2,
        "one parent: {parents}"
    );
}

#[test]
fn rolling_back_a_merge_leaves_its_record_standing() {
    // A revert is a new commit rather than a rewrite, and the record is honest for the
    // same reason: the merge did happen. Deleting the report would leave the branch
    // carrying a merge and a revert that nothing accounts for.
    let (org, repo) = mergeable("merge-record-rollback", "auto");
    landed_task(&org, "t");
    org.run(&["merge", "t"]).assert_ok("merge");

    org.run(&["rollback", "t"])
        .assert_ok("rollback")
        .assert_contains("Its record stays too, at docs/wecode/t/report.md");

    let file = git_out(&repo, &["show", "dev:docs/wecode/t/report.md"]);
    assert!(file.contains("MERGED  t → dev"), "{file}");
    // And the work itself is gone, which is what a rollback is.
    let dev = git_out(&repo, &["ls-tree", "-r", "--name-only", "dev"]);
    assert!(dev.contains("docs/wecode/t/report.md"), "{dev}");
}

/// Whether the repo has a branch by that name.
fn has_branch(repo: &Path, branch: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .output()
        .expect("git runs")
        .status
        .success()
}

/// The one worktree the workspace has standing, by path.
fn standing(org: &Org) -> PathBuf {
    let live: Vec<PathBuf> = org
        .recorded()
        .into_iter()
        .filter(|w| w.removed.is_none())
        .map(|w| PathBuf::from(w.path))
        .collect();
    assert_eq!(
        live.len(),
        1,
        "expected exactly one standing tree: {live:?}"
    );
    live.into_iter().next().unwrap()
}

#[test]
fn landing_the_work_takes_its_worktree_down_and_keeps_the_branch() {
    // The gap: a tree was created and never removed. Once the merge lands, every commit
    // in it is reachable from the integration branch, so the directory is a copy rather
    // than the only copy — and four of them were still standing on the workspace that
    // found this.
    let (org, repo) = mergeable("merge-teardown", "auto");
    landed_task(&org, "t");
    let wt = standing(&org);
    assert!(wt.is_dir(), "the run left a tree at {wt:?}");

    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("worktree   removed");

    assert!(!wt.exists(), "{wt:?} should be gone");
    assert!(
        org.recorded()[0].removed.is_some(),
        "and the registry should say so rather than going on claiming it"
    );
    // The branch stays. Its commits are already on `dev`, so it is redundant — but
    // keeping it is what makes `wecode start` able to cut the tree again.
    assert!(has_branch(&repo, "wecode/t"), "the branch was deleted");
    org.run(&["worktree"]).assert_contains("no worktrees");
}

#[test]
fn a_tree_a_subtask_still_works_in_survives_the_merge() {
    // The branch belongs to the *main* task, so merging lands the whole tree's work
    // while its subtasks still have somewhere to be. Removing it here would take the
    // directory out from under them.
    let (org, _) = mergeable("merge-teardown-busy", "auto");
    landed_task(&org, "t");
    let wt = standing(&org);
    org.run(&[
        "task",
        "add",
        "t-doc",
        "--project",
        "caching",
        "--kind",
        "chore",
        "--parent",
        "t",
        "write down what the marker means",
        "--write",
        "docs/**",
        "--accept-cmd",
        "true",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("subtask");

    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("worktree   kept")
        .assert_contains("t-doc still working");
    assert!(wt.is_dir(), "{wt:?} should still be there");

    // And once the subtask closes, the next thing that lands takes the tree with it.
    org.run(&["status", "t-doc", "dropped"]).assert_ok("close");
    org.run(&["worktree", "remove", "t"])
        .assert_ok("remove")
        .assert_contains("removed");
    assert!(!wt.exists());
}

// ------------------------------------------------------------ the steps ---------

/// One main task and two ordered steps beneath it — the shape `--expand` emits.
///
/// Every one of them writes `src/**`, which the admission gate allows here for two
/// separate reasons: a subtask is nested in its parent, and the second step is
/// declared after the first, so the two can never run at once.
fn with_steps(org: &Org, main: &str) {
    let add = |id: &str, extra: &[&str]| {
        let mut argv = vec![
            "task",
            "add",
            id,
            "--project",
            "caching",
            "--kind",
            "chore",
            "append a marker comment to the source",
            "--write",
            "src/**",
            "--accept-cmd",
            "grep -q landed src/app.txt",
            "--tokens",
            "100",
            "--wall",
            "30",
            "--to",
            "impl",
        ];
        argv.extend_from_slice(extra);
        org.run(&argv)
    };
    add(main, &[]).assert_ok("main task");
    add(&format!("{main}-one"), &["--parent", main]).assert_ok("first step");
    add(
        &format!("{main}-two"),
        &["--parent", main, "--after", &format!("{main}-one")],
    )
    .assert_ok("second step");
}

#[test]
fn a_step_that_passes_finishes_instead_of_parking_at_approval() {
    // The gap this closes. A subtask that passed went to `needs-approval` and waited
    // for a landing decision that could not be taken about it: its commits are on the
    // main task's branch, so merging it would have put every step of the expansion on
    // the integration branch, including the ones that had not run. Nothing could
    // correctly grant that approval — and while it stood there the sibling declared
    // after it stayed `waiting`, because readiness follows `done`, and the loop stops
    // dispatching entirely while anything needs a human. One passing step held up the
    // rest of its own plan.
    let (org, _) = mergeable("step-lands", "auto");
    with_steps(&org, "t");

    org.run(&["run", "t-one"])
        .assert_ok("first step")
        .assert_contains("passed")
        // And it says where the work went, because the status word cannot: `done`
        // here does not mean landed, it means there is nothing left of this task to
        // land separately.
        .assert_contains("its commits are on t's branch");
    org.run(&["show", "t-one"])
        .assert_contains("status     done");

    // Which is the whole point: the next step is startable now, with no signature in
    // between.
    org.run(&["tick"]).assert_ok("tick");
    org.run(&["show", "t-two"])
        .assert_contains("status     ready");
}

#[test]
fn a_step_cannot_be_merged_on_its_own_and_the_main_task_lands_them_all() {
    // The other half. `merge` on a step used to land the whole shared branch and mark
    // one task done; now it is refused and says which task does land it.
    let (org, repo) = mergeable("step-merge", "auto");
    with_steps(&org, "t");
    org.run(&["run", "t-one"]).assert_ok("first step");

    let r = org.run(&["merge", "t-one"]);
    assert!(!r.ok(), "a step lands nothing on its own");
    r.assert_contains("t-one is part of t")
        .assert_contains("wecode merge t");

    // The main task owns the tree and the branch, so it is what lands. Its own run
    // commits on top of the step's, and the merge takes both.
    org.run(&["run", "t"]).assert_ok("main task");
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");
    org.run(&["merge", "t"])
        .assert_ok("the main task lands")
        .assert_contains("MERGED  t → dev")
        // t-two never ran, so the directory is still somebody's.
        .assert_contains("t-two still working");

    let on_dev = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", "dev:src/app.txt"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&on_dev.stdout)
            .matches("landed")
            .count(),
        2,
        "the step's commit and the main task's both landed"
    );
}

#[test]
fn uncommitted_work_keeps_the_tree_standing_through_a_merge() {
    // Teardown nobody asked for does not get to decide that uncommitted work was
    // worthless. The merge took what was committed; anything else stays where it is.
    let (org, _) = mergeable("merge-teardown-dirty", "auto");
    landed_task(&org, "t");
    let wt = standing(&org);
    std::fs::write(wt.join("scratch.txt"), "half an idea\n").unwrap();

    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("worktree   kept")
        .assert_contains("uncommitted");
    assert!(wt.join("scratch.txt").exists(), "the work is still there");

    // The operator still decides, and has to say so.
    let r = org.run(&["worktree", "remove", "t"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("scratch.txt");
    org.run(&["worktree", "remove", "t", "--force"])
        .assert_ok("forced")
        .assert_contains("discarded");
}

#[test]
fn a_rolled_back_merge_can_have_its_tree_cut_again() {
    // What makes teardown safe: the branch is kept, so reopening the work is one
    // command and it comes back at the tip the merge landed.
    let (org, _) = mergeable("merge-teardown-redo", "auto");
    landed_task(&org, "t");
    let wt = standing(&org);
    org.run(&["merge", "t"]).assert_ok("merge");
    assert!(!wt.exists());

    org.run(&["rollback", "t"]).assert_ok("rollback");
    org.run(&["start", "t"]).assert_ok("start again");
    assert!(wt.is_dir(), "the tree is back at {wt:?}");
    assert!(
        wt.join("src/app.txt").exists(),
        "and it holds the work, not an empty checkout"
    );
}

#[test]
fn merging_twice_is_refused_rather_than_silently_doing_nothing() {
    let (org, _) = mergeable("merge-twice", "auto");
    landed_task(&org, "t");
    org.run(&["merge", "t"]).assert_ok("merge");
    org.run(&["status", "t", "needs-approval"])
        .assert_ok("reopen");

    let r = org.run(&["merge", "t"]);
    assert!(!r.ok(), "a no-op merge must not read as success");
    r.assert_contains("already merged");
}

// ------------------------------------------- the executable it produced ---------

// The merge-side half of installing. What each refusal *says* is unit-tested inside
// `src/install.rs`; that a landed merge builds and installs, that a decline is a line
// in a report the merge still commits, and that `wecode install` is the same step
// typed, are `tests/install.rs`. What is here is what only a merge can be asked: where
// the install lands among the merge's other facts, whose build cache it used, that a
// binary the operator is running gets replaced rather than written through, and that
// the repository being merged has no say in where its own executable goes.

/// Names where the `app` repo's executable installs, in the one file that may say so.
///
/// Edited the way an operator edits it, because no command does it on purpose: the
/// destination is an authority to write outside every repository, and only a
/// hand-edited file can carry one.
fn installs_to(org: &Org, dest: &Path) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let replaced = text.replace(
        "name = \"app\"\n",
        &format!("name = \"app\"\ninstalls = \"{}\"\n", dest.display()),
    );
    assert_ne!(replaced, text, "the app repo block was not found");
    std::fs::write(&conf, replaced).unwrap();
}

/// A mergeable workspace whose repo really is a crate producing `app`, and a
/// destination that really exists. `dev` carries the crate, because `dev` is what
/// gets built.
///
/// The same fixture `tests/install.rs` stands up. It is a candidate for
/// `support::merge` now that a second area wants it — a move outside this task's
/// scope, and the reason this copy exists rather than a shared one.
fn installable(name: &str, main_rs: &str) -> (Org, PathBuf, PathBuf) {
    let (org, repo) = mergeable(name, "auto");
    std::fs::write(
        repo.join("Cargo.toml"),
        "[package]\nname = \"app\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[workspace]\n",
    )
    .unwrap();
    std::fs::write(repo.join("src/main.rs"), main_rs).unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "the repo produces an executable"]);
    git(&repo, &["branch", "-f", "dev"]);

    std::fs::create_dir_all(org.path("bin")).unwrap();
    let dest = org.path("bin/app");
    installs_to(&org, &dest);
    (org, repo, dest)
}

#[test]
fn what_a_merge_installed_is_recorded_beside_what_it_did_to_the_machine() {
    let (org, repo, dest) = installable(
        "merge-install-record",
        "fn main() { println!(\"made by the merge\"); }\n",
    );
    landed_task(&org, "t");

    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains(&format!("install    {} ← ", dest.display()));

    // In the summary, between the worktree line and the undo line: those two and this
    // are the facts a merge creates about the machine it ran on rather than about the
    // branch, and the way back stays last because it is what anyone acts on.
    let file = git_out(&repo, &["show", "dev:docs/wecode/t/report.md"]);
    let at = |needle: &str| {
        file.find(needle)
            .unwrap_or_else(|| panic!("no {needle:?} in:\n{file}"))
    };
    assert!(at("worktree   ") < at("install    "), "{file}");
    assert!(at("install    ") < at("undo       "), "{file}");

    // And it was built in the repository's own cache, not a cache of the scratch tree's
    // own. That tree is cut fresh for every merge and comes down after, so a build with
    // a target directory of its own would cost the merge path a full compile every
    // time — the shared cache is what makes this affordable enough to be automatic.
    assert!(
        repo.join("target/debug/app").is_file(),
        "the artefact should be in the repo's target/, not the merge tree's"
    );
}

#[test]
fn a_merge_replaces_the_binary_the_operator_is_running_without_disturbing_it() {
    // Writing the destination in place gives ETXTBSY exactly when the operator has a
    // `wecode board` open, which is the moment a merge is most likely to happen. The
    // rename swaps a directory entry and leaves the running process on its old inode —
    // so the proof is two facts at once: a new inode at the destination, and a child
    // that never noticed.
    use std::os::unix::fs::MetadataExt;

    let (org, _repo, dest) = installable(
        "merge-install-running",
        "fn main() { std::thread::sleep(std::time::Duration::from_secs(20)); }\n",
    );
    // The first install is the typed one — bootstrapping reach out of a merge you must
    // already be at a terminal to run is circular.
    org.run(&["install"]).assert_ok("the first install");
    let before = std::fs::metadata(&dest).unwrap().ino();

    let mut running = Command::new(&dest)
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("the installed binary runs");

    landed_task(&org, "t");
    let r = org.run(&["merge", "t"]);
    let after = std::fs::metadata(&dest).unwrap().ino();
    let alive = running
        .try_wait()
        .expect("the child can be asked")
        .is_none();
    // Killed before the assertions, so a failure here does not leave it sleeping.
    let _ = running.kill();
    let _ = running.wait();

    r.assert_ok("a busy destination is not a reason to fail a merge")
        .assert_contains(&format!("install    {} ← ", dest.display()));
    assert_ne!(before, after, "the destination should be a new inode");
    assert!(alive, "the running process should not have been disturbed");
}

#[test]
fn no_repository_can_name_where_its_own_executable_installs() {
    // The load-bearing half of putting the destination in `company.toml`: a playbook is
    // committed *inside* the repository being merged, so a playbook field would let any
    // repo acquire the right to write to the operator's machine by committing a line to
    // itself. `deny_unknown_fields` on `[project]` is what keeps that unsayable, and it
    // is refused before the merge rather than ignored after it.
    let (org, repo) = mergeable("merge-install-playbook", "auto");
    landed_task(&org, "t");
    let dest = org.path("bin/app");
    org.playbook(
        &repo,
        &format!(
            "[project]\nlanguage = \"text\"\nmerge_to = \"dev\"\nmerge = \"auto\"\n\
             installs = \"{}\"\n\n[chore]\nworktree = true\nassign_to = \"impl\"\n\
             accept = [\"true\"]\ntokens = 100\nwall_secs = 30\nguidance = \"x\"\n",
            dest.display()
        ),
    );

    let r = org.run(&["merge", "t"]);
    assert!(!r.ok(), "an unreadable playbook is not a merge");
    r.assert_contains(".wecode/playbook.toml")
        .assert_contains("unknown field `installs`");
    assert!(!dest.exists(), "and nothing was written where it asked");
}
