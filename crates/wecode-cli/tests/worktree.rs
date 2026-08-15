//! The trees work happens in: cutting them, recording them, and taking them down.

mod support;

use std::path::PathBuf;
use std::process::Command;

use support::playbook::with_playbook;
use support::{Org, Run};

// ------------------------------------------------------------- worktrees ------

#[test]
fn start_creates_the_worktree_the_playbook_asks_for() {
    let (org, repo) = with_playbook("wt-bug");
    org.run(&[
        "task",
        "add",
        "fix-it",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");

    let r = org.run(&["start", "fix-it"]);
    r.assert_ok("start");
    r.assert_contains("worktree")
        .assert_contains("wecode/fix-it")
        .assert_contains("running")
        // The envelope, which was inert template text before anything rendered it.
        .assert_contains("YOUR TASK: the cache returns a stale entry")
        .assert_contains("You may modify only: src/**");

    let wt = org.path("config/run");
    assert!(
        wt.exists(),
        "worktree root should exist under the isolated config"
    );
    org.run(&["worktree"])
        .assert_ok("worktree list")
        .assert_contains("fix-it");

    // git agrees, and the branch is real.
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "--list", "wecode/fix-it"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("wecode/fix-it"),
        "branch should exist"
    );
}

#[test]
fn start_creates_no_worktree_when_the_playbook_says_not_to() {
    let (org, _) = with_playbook("wt-docs");
    org.run(&[
        "task",
        "add",
        "write-docs",
        "--project",
        "caching",
        "--kind",
        "docs",
        "document the eviction policy",
        "--write",
        "docs/**",
    ])
    .assert_ok("task add");

    org.run(&["start", "write-docs"])
        .assert_ok("start")
        .assert_contains("no worktree")
        .assert_contains("running");
    org.run(&["worktree"]).assert_contains("no worktrees");
}

#[test]
fn a_subtask_shares_its_main_tasks_worktree() {
    // The rule that makes `parent` and `depends_on` do separate jobs: hierarchy picks
    // the tree, dependencies pick the order.
    let (org, _) = with_playbook("wt-shared");
    org.run(&[
        "task",
        "add",
        "fix-it",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("main task");
    org.run(&[
        "task",
        "add",
        "fix-it-test",
        "--project",
        "caching",
        "--kind",
        "bug",
        "--parent",
        "fix-it",
        "no test covers eviction of a stale entry",
        "--write",
        "src/**",
    ])
    .assert_ok("subtask shares its parent's scope legally");

    org.run(&["start", "fix-it-test"])
        .assert_ok("start subtask")
        .assert_contains("shared with fix-it")
        .assert_contains("wecode/fix-it");

    // One tree, not two.
    let listed = org.run(&["worktree"]).assert_ok("worktree").stdout.clone();
    assert_eq!(
        listed.lines().filter(|l| l.contains("fix-it")).count(),
        1,
        "exactly one worktree:\n{listed}"
    );

    // And removing it must be done via the owner.
    let r = org.run(&["worktree", "remove", "fix-it-test"]);
    assert!(!r.ok());
    r.assert_contains("shares").assert_contains("fix-it");
}

/// A project and one bug task in it, ready to start.
fn with_bug(name: &str) -> (Org, PathBuf) {
    let (org, repo) = with_playbook(name);
    org.run(&[
        "task",
        "add",
        "fix-it",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    (org, repo)
}

/// The worktree path `start` printed, which is where the work really went.
fn started_at(r: &Run) -> String {
    r.stdout
        .lines()
        .find_map(|l| l.trim().strip_prefix("worktree "))
        .expect("start prints the worktree path")
        .trim()
        .trim_end_matches(" (reset)")
        .to_string()
}

#[test]
fn start_writes_down_the_worktree_it_made() {
    // `start` creates a tree and opens no execution row, so before this the only
    // record of it was the directory itself.
    let (org, _) = with_bug("wt-recorded");
    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));

    let all = org.recorded();
    assert_eq!(all.len(), 1, "{all:?}");
    let wt = &all[0];
    assert_eq!(wt.path, path);
    assert_eq!(wt.task, "fix-it");
    assert_eq!(wt.branch, "wecode/fix-it");
    assert_eq!(wt.repo, "app", "the repo it was cut from, not the project");
    assert!(wt.removed.is_none(), "it is standing");
}

#[test]
fn a_worktree_wecode_did_not_make_is_not_claimed_as_its_own() {
    // The fault that started this: another tool keeping worktrees in the same
    // repository was printed as one of ours that had lost its task.
    let (org, repo) = with_bug("wt-stranger");
    org.run(&["start", "fix-it"]).assert_ok("start");

    let theirs = org.path("not-ours");
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["worktree", "add", "-b", "theirs", theirs.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "a stranger's worktree should be addable"
    );

    let ours: Vec<String> = org.recorded().into_iter().map(|w| w.path).collect();
    assert_eq!(ours.len(), 1, "only wecode's own is recorded: {ours:?}");
    assert!(!ours[0].contains("not-ours"));

    // And the listing says which is which, rather than calling both an orphan.
    org.run(&["worktree"])
        .assert_ok("worktree")
        .assert_contains("— not ours")
        .assert_contains("1 in use")
        .assert_contains("1 not ours")
        .assert_lacks("orphan");
}

#[test]
fn a_tree_is_listed_once_however_many_projects_share_its_repo() {
    // The fault: `git worktree list` answers per repository, so asking once per project
    // printed every tree once per project sharing it. Four trees came out as 27 rows.
    let (org, _) = with_bug("wt-shared-repo");
    org.run(&[
        "project",
        "add",
        "exports",
        "cut the export endpoint's p99 latency in half",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "1000",
        "--wall",
        "60",
    ])
    .assert_ok("a second project on the same repo");

    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));
    let listed = org.run(&["worktree"]).assert_ok("worktree").stdout.clone();

    assert_eq!(
        listed.lines().filter(|l| l.contains(&path)).count(),
        1,
        "one tree, one row:\n{listed}"
    );
    // Grouped by repo, and the tally is what makes a repeat visible at a glance.
    assert!(
        listed.contains("1 tree in 1 repo"),
        "the tally counts trees, not project-tree pairs:\n{listed}"
    );
    // The project shown is the one whose task works here — not whichever shares the repo.
    assert!(
        listed.contains("caching") && !listed.contains("exports"),
        "attributed to the owning task's project:\n{listed}"
    );
}

#[test]
fn a_tree_whose_task_is_gone_is_ours_rather_than_a_stranger() {
    // `start` opens no execution row, so a started task can still be removed outright —
    // and the directory does not go with it. Before the registry this came back as an
    // orphan by accident; now it is one on the record, and names who it was for.
    let (org, _) = with_bug("wt-orphan");
    org.run(&["start", "fix-it"]).assert_ok("start");
    org.run(&["task", "rm", "fix-it"])
        .assert_ok("remove a task that only started");

    org.run(&["worktree"])
        .assert_ok("worktree")
        .assert_contains("— orphan (fix-it)")
        .assert_contains("1 ours to clean up");
}

#[test]
fn starting_the_same_task_again_records_the_tree_once() {
    // The retry path resets the directory rather than creating it. A row per attempt
    // would make the registry a run log, which `task_executions` already is.
    let (org, _) = with_bug("wt-again");
    org.run(&["start", "fix-it"]).assert_ok("first start");
    let first = org.recorded();
    org.run(&["start", "fix-it"])
        .assert_ok("second start")
        .assert_contains("(reset)");

    assert_eq!(org.recorded(), first, "nothing added, nothing restated");
}

#[test]
fn a_subtask_records_no_worktree_of_its_own() {
    // It shares its parent's tree, so it owns nothing to record.
    let (org, _) = with_bug("wt-sub-record");
    org.run(&[
        "task",
        "add",
        "fix-it-test",
        "--project",
        "caching",
        "--kind",
        "bug",
        "--parent",
        "fix-it",
        "no test covers eviction of a stale entry",
        "--write",
        "src/**",
    ])
    .assert_ok("subtask");

    org.run(&["start", "fix-it-test"])
        .assert_ok("start subtask");
    let all = org.recorded();
    assert_eq!(all.len(), 1, "one tree, one row: {all:?}");
    assert_eq!(all[0].task, "fix-it", "recorded against its owner");
}

#[test]
fn removing_a_worktree_records_that_it_is_gone_without_forgetting_it_existed() {
    let (org, _) = with_bug("wt-tombstone");
    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));
    org.run(&["worktree", "remove", "fix-it"])
        .assert_ok("remove");

    let all = org.recorded();
    assert_eq!(all.len(), 1, "the row stays: {all:?}");
    assert_eq!(all[0].path, path);
    assert!(
        all[0].removed.is_some(),
        "we made one here and tore it down — not: there was never one"
    );
}

#[test]
fn a_worktree_deleted_by_hand_stops_being_reported_as_standing() {
    // A row claiming a directory that is provably absent is worse than no row.
    let (org, _) = with_bug("wt-handdel");
    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));
    std::fs::remove_dir_all(&path).unwrap();

    org.run(&["worktree", "remove", "fix-it"])
        .assert_ok("remove a tree that is already gone")
        .assert_contains("recorded as gone");
    assert!(org.recorded()[0].removed.is_some());
}

#[test]
fn a_worktree_whose_task_is_gone_can_be_removed_by_its_path() {
    // The gap `worktree-view` left: an orphan is named by the listing and unreachable by
    // a command that takes a task id, because *having no task* is what makes it an
    // orphan. Seeing a tree you cannot remove is worse than not seeing it.
    let (org, _) = with_bug("wt-rm-path");
    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));
    org.run(&["task", "rm", "fix-it"]).assert_ok("remove task");
    org.run(&["worktree"]).assert_contains("— orphan (fix-it)");

    org.run(&["worktree", "remove", &path])
        .assert_ok("remove by path")
        .assert_contains("removed")
        // The branch comes from the registry, since a path does not imply one.
        .assert_contains("branch wecode/fix-it kept");
    org.run(&["worktree"]).assert_contains("no worktrees");
    assert!(
        org.recorded()[0].removed.is_some(),
        "the row is closed, not deleted"
    );
}

#[test]
fn a_path_no_repository_claims_is_not_removed_by_wecode() {
    // `git worktree remove` is a command against a repository. A directory none of the
    // plan's repos lists as a worktree has no repository to run it against, and guessing
    // one would run a removal against the wrong repo.
    let (org, _) = with_bug("wt-rm-stray");
    let stray = org.path("just-a-directory");
    std::fs::create_dir_all(&stray).unwrap();

    let r = org.run(&["worktree", "remove", stray.to_str().unwrap()]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("no repository this workspace knows");
    assert!(stray.is_dir(), "and it is still there");
}

#[test]
fn a_mistyped_path_is_not_slugified_into_a_task_id() {
    // A task id is a kebab-case slug, so a `/` cannot occur in one. Before the two were
    // told apart by shape, `/tmp/nope` became the task `tmp-nope` and the refusal named
    // the wrong problem.
    let (org, _) = with_bug("wt-rm-typo");
    let r = org.run(&["worktree", "remove", "/tmp/no-such-tree"]);
    r.assert_ok("an absent path is a report, not an error")
        .assert_contains("no worktree at /tmp/no-such-tree")
        .assert_lacks("no such task");
}

#[test]
fn removing_a_worktree_refuses_to_discard_uncommitted_work() {
    let (org, _) = with_playbook("wt-dirty");
    org.run(&[
        "task",
        "add",
        "fix-it",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");

    // Nothing has committed this work — wecode does that, after checks pass — so
    // removing the tree would lose it outright.
    //
    // The path is read from `start` rather than guessed: the run directory is keyed on
    // the workspace directory name, not the test name.
    let started = org.run(&["start", "fix-it"]);
    let wt = PathBuf::from(
        started
            .stdout
            .lines()
            .find_map(|l| l.trim().strip_prefix("worktree "))
            .expect("start prints the worktree path")
            .trim()
            .trim_end_matches(" (reset)"),
    );
    assert!(wt.is_dir(), "{wt:?} should exist");
    std::fs::write(wt.join("new.rs"), "fn x() {}\n").unwrap();

    let r = org.run(&["worktree", "remove", "fix-it"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("uncommitted").assert_contains("new.rs");

    org.run(&["worktree", "remove", "fix-it", "--force"])
        .assert_ok("forced")
        .assert_contains("discarded");
    org.run(&["worktree"]).assert_contains("no worktrees");
}

#[test]
fn start_refuses_a_task_that_is_not_ready() {
    let (org, _) = with_playbook("wt-blocked");
    for (id, title) in [
        ("first", "the cache returns a stale entry after eviction"),
        ("second", "record the cache hit rate"),
    ] {
        let mut args = vec![
            "task",
            "add",
            id,
            "--project",
            "caching",
            "--kind",
            "bug",
            title,
            "--write",
        ];
        args.push(if id == "first" {
            "src/a/**"
        } else {
            "src/b/**"
        });
        if id == "second" {
            args.extend(["--after", "first"]);
        }
        org.run(&args).assert_ok(id);
    }
    let r = org.run(&["start", "second"]);
    r.assert_contains("not ready").assert_contains("first");
}
