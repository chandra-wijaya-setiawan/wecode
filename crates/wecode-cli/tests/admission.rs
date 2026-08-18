//! What a task is held to before anyone works on it.
//!
//! The gate itself is decided in core and tested there, a case per defect. What this
//! file covers is the part core structurally cannot: that a verdict reaches the person
//! typing the command, through the real binary, against a real workspace and a real
//! playbook — and that the advisory half of it still refuses nothing on the way.

mod support;

use support::Org;
use support::playbook::with_playbook;

/// `caching` is budgeted 1000 tokens and 60 seconds of wall time, and every kind in
/// the shared playbook is written for exactly those figures. So a task that states
/// them is at its project's ceiling and not over it, which is what makes the one that
/// steps over it unambiguous.
fn a_chore(org: &Org, id: &str, title: &str, scope: &str, tokens: &str) -> support::Run {
    org.run(&[
        "task", "add", id, title, "--project", "caching", "--kind", "chore", "--write", scope,
        "--tokens", tokens, "--wall", "60",
    ])
}

#[test]
fn a_task_worth_more_than_its_whole_project_is_told_so_and_still_admitted() {
    // The one advisory note that is not read off a playbook. A kind's default budget
    // is written once, in a repository, and applied in every project on it — so the
    // figure a task ends up carrying can exceed what its project was given without
    // anyone having compared the two. Nothing did compare them until now: the project
    // budget was read on the board, against spend, which is after it has been paid.
    let (org, _) = with_playbook("admission-over-project");
    a_chore(&org, "over", "bump the serde dependency", "src/**", "400000")
        .assert_ok("a task may ask for more than its project has")
        .assert_contains("saved task over")
        .assert_contains("⚠ 1 note")
        .assert_contains("400000 tokens")
        .assert_contains("project `caching` was given 1000 for all of its work")
        .assert_contains("advisory — nothing is refused");

    // The half that makes it advice rather than a gate: it is still admitted, and
    // `check` — which is where an operator goes to find out — says both things.
    org.run(&["check", "over"])
        .assert_ok("check")
        .assert_contains("✓ admitted")
        .assert_contains("was given 1000 for all of its work");
}

#[test]
fn a_task_inside_what_its_project_was_given_is_said_nothing_about() {
    // The control. A note on every task would be a note nobody reads, and the ceiling
    // is a ceiling rather than a target: at it is not over it.
    let (org, _) = with_playbook("admission-within-project");
    a_chore(&org, "within", "bump the serde dependency", "src/**", "1000")
        .assert_ok("a task at its project's ceiling")
        .assert_contains("saved task within")
        .assert_lacks("would have written this differently");
}
