//! The repository's own guidance: scaffolding it, reading it, planning against it,
//! and recording what it turned out not to say.

mod support;

use support::playbook::with_playbook;
use support::{Org, git_out, which};

// -------------------------------------------------------------- playbook ------

#[test]
fn playbook_init_writes_a_file_that_then_parses() {
    let org = Org::new("pb-init", "solo");
    let repo = org.repo_without_playbook();
    org.run(&[
        "project",
        "add",
        "p",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "1",
    ])
    .assert_ok("project");

    org.run(&["playbook", "init", "--language", "rust"])
        .assert_ok("playbook init")
        .assert_contains("playbook.toml")
        // Every decision the starter made on the project's behalf is reported, not
        // left in the file for whoever thinks to open it.
        .assert_contains("cargo test --workspace")
        .assert_contains("CARGO_TARGET_DIR = ~/.cache/wecode/repo/target");
    assert!(repo.join(".wecode/playbook.toml").is_file());

    // The starter must be valid, or adoption fails at the first step — and the
    // commands it wrote are the ones the project now runs.
    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("rust")
        .assert_contains("bug")
        .assert_contains("cargo test --workspace");

    // And it refuses to overwrite.
    let again = org.run(&["playbook", "init"]);
    assert!(!again.ok());
    again.assert_contains("already exists");
}

#[test]
fn playbook_init_reads_the_toolchain_off_the_repository() {
    // The flag that gets left off. A project scaffolded without `--language` used to
    // get `accept = []` and a TODO for every kind, and the first task paid for it.
    let org = Org::new("pb-init-detect", "solo");
    let repo = org.repo_without_playbook();
    std::fs::write(repo.join("Cargo.toml"), "[package]\nname = \"toy\"\n").unwrap();
    org.run(&[
        "project",
        "add",
        "p",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "1",
    ])
    .assert_ok("project");

    org.run(&["playbook", "init"])
        .assert_ok("playbook init")
        .assert_contains("read off Cargo.toml")
        .assert_contains("cargo clippy --all-targets -- -D warnings");

    let text = std::fs::read_to_string(repo.join(".wecode/playbook.toml")).unwrap();
    assert!(text.contains("language = \"rust\""), "{text}");
    assert!(text.contains("[project.build_cache]"), "{text}");
    // And the trap that cost a task: the file a build rewrites, said where a planner
    // reads it rather than left to be discovered by a scope violation.
    assert!(text.contains("Cargo.lock"), "{text}");
}

#[test]
fn playbook_init_says_when_this_machine_cannot_run_what_it_wrote() {
    // A starter names a real test command, so it can name one this machine does not
    // have — the mistake wemail made with `python -m pytest`. The file is still
    // written: it is right for the repository and wrong only here.
    let org = Org::new("pb-init-absent", "solo");
    org.repo_without_playbook();
    org.run(&[
        "project",
        "add",
        "p",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "1",
    ])
    .assert_ok("project");

    let out = org.run(&["playbook", "init", "--language", "python"]);
    out.assert_ok("playbook init");
    if which("uv").is_none() {
        out.assert_contains("not on this machine")
            .assert_contains("uv");
    }
}

#[test]
fn a_project_with_no_playbook_says_how_to_make_one() {
    let org = Org::new("pb-absent", "solo");
    org.repo_without_playbook();
    org.run(&[
        "project",
        "add",
        "p",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "1",
    ])
    .assert_ok("project");

    org.run(&["playbook"])
        .assert_ok("no playbook is not an error")
        .assert_contains("no playbook")
        .assert_contains("playbook init");
}

#[test]
fn playbook_shows_the_guidance_for_one_kind() {
    let (org, _) = with_playbook("pb-kind");
    org.run(&["playbook", "bug"])
        .assert_ok("playbook bug")
        .assert_contains("Reproduce first")
        .assert_contains("worktree  yes");

    org.run(&["playbook", "docs"])
        .assert_ok("playbook docs")
        .assert_contains("worktree  no");

    // A kind the project has said nothing about.
    org.run(&["playbook", "spike"])
        .assert_ok("playbook spike")
        .assert_contains("no [spike] section");
}

#[test]
fn task_add_fills_the_defaults_the_playbook_supplies() {
    let (org, _) = with_playbook("pb-defaults");
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
    .assert_ok("task add")
    .assert_contains("(from playbook)")
    .assert_contains("admitted");

    org.run(&["show", "fix-it"])
        .assert_contains("impl")
        .assert_contains("`true` exits 0");
}

#[test]
fn an_explicit_flag_beats_the_playbook() {
    let (org, _) = with_playbook("pb-explicit");
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
        "--accept-cmd",
        "cargo test",
        "--to",
        "impl",
        "--tokens",
        "50",
        "--wall",
        "5",
    ])
    .assert_ok("task add")
    .assert_lacks("(from playbook)");

    org.run(&["show", "fix-it"]).assert_contains("cargo test");
}

#[test]
fn a_kind_the_playbook_omits_gets_no_defaults() {
    let (org, _) = with_playbook("pb-omitted");
    // `refactor` has no section, so nothing is filled and the task is bare.
    org.run(&[
        "task",
        "add",
        "tidy",
        "--project",
        "caching",
        "--kind",
        "refactor",
        "remove the deprecated export helper",
        "--write",
        "src/**",
    ])
    .assert_lacks("(from playbook)");
}

#[test]
fn a_playbook_naming_a_program_the_machine_lacks_is_refused() {
    // Verification would find this as exit 127, after the budget is spent. The
    // playbook is refused at load instead, so the mistake costs an edit, not a task.
    let org = Org::new("pb-no-such-program", "solo");
    let repo = org.repo();
    org.playbook(
        &repo,
        "[bug]\nworktree = true\nassign_to = \"impl\"\n\
         accept = [\"definitely-not-a-real-binary-xyz --check\"]\n\
         tokens = 1000\nwall_secs = 60\n",
    );
    org.run(&[
        "project",
        "add",
        "caching",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "1000",
        "--wall",
        "60",
    ])
    .assert_ok("add project");

    // Reading it refuses and names the program and the kind...
    let read = org.run(&["playbook", "bug"]);
    assert!(!read.ok(), "a broken playbook must not render");
    read.assert_contains("definitely-not-a-real-binary-xyz")
        .assert_contains("[bug]")
        .assert_contains("not on this machine");

    // ...and so does creating work against it — even with explicit acceptance,
    // because the file is wrong for this machine and the fix is one edit to it.
    let add = org.run(&[
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
        "--accept-cmd",
        "true",
        "--to",
        "impl",
        "--tokens",
        "50",
        "--wall",
        "5",
    ]);
    assert!(!add.ok(), "task add must refuse a broken playbook");
    add.assert_contains("definitely-not-a-real-binary-xyz");
}

// ----------------------------------------------------------------- gaps ------

/// A task to attribute a finding to, of the kind the guidance is short on.
fn a_bug_task(org: &Org) {
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
}

const FOUND: &str = "put the test file in the write scope, or the scope check refuses the diff";

#[test]
fn a_gap_found_while_planning_reaches_whoever_reads_that_guidance_next() {
    // The whole point of the feature in one test: the finding goes in through the
    // orchestrator, and comes out where the next planner already looks.
    let (org, _) = with_playbook("pb-gap");
    a_bug_task(&org);

    org.run(&["playbook", "gap", FOUND, "--task", "fix-it"])
        .assert_ok("playbook gap")
        .assert_contains("recorded a gap")
        // The kind is taken from the task, so `--task` alone is the whole invocation.
        .assert_contains("[bug]")
        .assert_contains("note, not a change");

    org.run(&["playbook", "bug"])
        .assert_ok("playbook bug")
        .assert_contains(FOUND)
        .assert_contains("found on fix-it")
        // Still the guidance's page, not a replacement for it.
        .assert_contains("Reproduce first");

    // Filed against `bug`, so it is not noise on every other kind's page.
    org.run(&["playbook", "docs"])
        .assert_ok("playbook docs")
        .assert_lacks(FOUND);

    // The index counts them, so a reader who starts at the top knows to look.
    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("1 gap recorded");

    org.run(&["playbook", "gaps"])
        .assert_ok("playbook gaps")
        .assert_contains(FOUND)
        .assert_contains("playbook.toml");
}

#[test]
fn the_same_finding_recorded_twice_is_held_once() {
    // Something records these in a loop. A duplicate must cost a sentence rather
    // than an error or a second copy of the same paragraph.
    let (org, _) = with_playbook("pb-gap-twice");
    a_bug_task(&org);
    org.run(&["playbook", "gap", FOUND, "--task", "fix-it"])
        .assert_ok("first");
    org.run(&["playbook", "gap", FOUND, "--task", "fix-it"])
        .assert_ok("second")
        .assert_contains("already recorded");

    org.run(&["playbook", "gaps"])
        .assert_ok("gaps")
        .assert_contains("1 gap against");
}

#[test]
fn a_finding_about_no_kind_in_particular_is_shown_against_all_of_them() {
    let (org, _) = with_playbook("pb-gap-project");
    org.run(&[
        "playbook",
        "gap",
        "nothing here says which branch work merges into",
    ])
    .assert_ok("playbook gap")
    .assert_contains("every kind");

    for kind in ["bug", "docs"] {
        org.run(&["playbook", kind])
            .assert_ok("playbook kind")
            .assert_contains("which branch work merges into");
    }

    // Including a kind the playbook says nothing about, which is the strongest
    // reason for a gap to have been recorded in the first place.
    org.run(&["playbook", "spike"])
        .assert_ok("playbook spike")
        .assert_contains("no [spike] section")
        .assert_contains("which branch work merges into");
}

#[test]
fn a_gap_is_recorded_in_the_workspace_and_never_in_the_repository() {
    // The repository is what verification diffs, and a kind whose playbook asks for
    // no worktree is judged in the main checkout — a file dropped there would be
    // reported as somebody else's scope violation.
    let (org, repo) = with_playbook("pb-gap-where");
    org.run(&["playbook", "gap", "the docs guidance says nothing at all"])
        .assert_ok("playbook gap");

    assert!(org.path("gaps.toml").is_file(), "recorded in the workspace");
    assert!(!repo.join(".wecode/gaps.toml").exists());
    assert!(
        git_out(&repo, &["status", "--porcelain"]).is_empty(),
        "the repository is untouched"
    );
}

#[test]
fn only_a_seat_that_may_define_work_may_annotate_the_guidance() {
    // The gate is `define project`, not a write scope: the chief writes no code and
    // must be able to record one, the engineer writes the code and must not — it
    // would be annotating the guidance it was handed.
    let (org, _) = with_playbook("pb-gap-seat");
    let refused = org.run(&[
        "playbook",
        "gap",
        "the bug guidance should say where tests live",
        "--as",
        "impl",
    ]);
    assert!(!refused.ok(), "an engineer may not record one");
    refused
        .assert_contains("recording a playbook gap refused")
        .assert_contains("define");
    assert!(!org.path("gaps.toml").exists(), "nothing was written");

    // And the refusal is on the ledger, like every other decision.
    org.run(&["audit"]).assert_contains("define");
}

#[test]
fn a_planner_is_told_it_may_record_one_before_it_needs_to() {
    // A place to put a finding that nobody knows about is a place nothing is put.
    // Both surfaces are derived from the same capability that gates the command, so
    // neither can promise what the Broker would refuse.
    let (org, _) = with_playbook("pb-gap-brief");
    org.run(&["brief"])
        .assert_ok("brief")
        .assert_contains("playbook gap");
    org.run(&["whoami"])
        .assert_ok("whoami")
        .assert_contains("playbook gap");
}

#[test]
fn a_gap_needs_a_note_and_a_task_that_exists() {
    let (org, _) = with_playbook("pb-gap-refusals");

    let empty = org.run(&["playbook", "gap"]);
    assert!(!empty.ok());
    empty.assert_contains("say what the guidance does not");

    let ghost = org.run(&["playbook", "gap", FOUND, "--task", "ghost"]);
    assert!(!ghost.ok(), "a finding attributed to nothing is a lie");
    ghost.assert_contains("no such task: ghost");

    let kind = org.run(&["playbook", "gap", FOUND, "--kind", "buld"]);
    assert!(!kind.ok());
    kind.assert_contains("unknown kind `buld`");

    // A task and a project that disagree would file the note against guidance the
    // task was never planned from.
    a_bug_task(&org);
    let elsewhere = org.run(&[
        "playbook",
        "gap",
        FOUND,
        "--task",
        "fix-it",
        "--project",
        "nowhere",
    ]);
    assert!(!elsewhere.ok());
    elsewhere.assert_contains("fix-it is in project caching");
}
