//! The cockpit as an operator away from their desk gets it: `wecode board`, piped.
//!
//! board.rs unit-tests the cell against a hand-built `Plan`. What that cannot reach is
//! the plan a real workspace stores — where the tasks were added by the CLI, finished
//! by the CLI, and counted from what SQLite gave back — and whether the number this
//! board prints is the number the other views print for the same project.

mod support;

use support::Org;

/// A board snapshot, checked to have been produced at all.
fn board(org: &Org, args: &[&str]) -> String {
    let r = org.run(args);
    r.assert_ok("board");
    r.stdout
}

/// The project row of a board snapshot, so an assertion says which line it means.
fn project_row(out: &str) -> String {
    out.lines()
        .find(|l| l.contains("PROJECT caching"))
        .unwrap_or_else(|| panic!("no project row in:\n{out}"))
        .to_string()
}

#[test]
fn the_board_says_how_far_a_project_has_got() {
    // The gap this closes: `> active` is a fact about intent — the project is open for
    // work — and it reads the same on the day the project is opened and on the day its
    // last task lands. Somebody answering wecode from a phone is asking the other
    // question.
    let org = Org::new("board-standing", "software-company");
    org.seed();

    let before = project_row(&board(&org, &["board"]));
    assert!(before.contains("0/2"), "nothing done yet: {before}");

    org.run(&["status", "cache-tests", "done"]).assert_ok("done");
    let after = project_row(&board(&org, &["board"]));
    assert!(after.contains("1/2"), "one of two: {after}");
    // Beside the declared state, never instead of it. A project can be finished and
    // still open, or open and untouched, and the row has to be able to say which.
    assert!(after.contains("draft"), "the declared state stays: {after}");
}

#[test]
fn the_standing_is_on_the_focused_project_too() {
    // Descending is what an operator does after the portfolio row catches their eye,
    // and landing on a view that dropped the number they came for sends them back up.
    let org = Org::new("board-standing-focus", "software-company");
    org.seed();
    org.run(&["status", "cache-tests", "done"]).assert_ok("done");

    let out = board(&org, &["board", "caching"]);
    assert!(out.contains("L1 · caching"), "{out}");
    assert!(project_row(&out).contains("1/2"), "{out}");
}

#[test]
fn the_board_counts_what_the_other_views_count() {
    // One workspace, three surfaces, one answer. The board is the one people read
    // fastest, so it is the one that must not be the odd number out — a cockpit that
    // disagrees with `wecode show` about how much is left is a cockpit nobody believes
    // the second time.
    let org = Org::new("board-standing-agrees", "software-company");
    org.seed();
    org.run(&["status", "cache-tests", "done"]).assert_ok("done");

    org.run(&["show", "caching"])
        .assert_ok("show")
        .assert_contains("1 of 2 done");
    assert!(project_row(&board(&org, &["board"])).contains("1/2"));

    // And where the two could most easily part company: work nobody will do. Dropping
    // a task is a decision to record, not a way for a project to reach the end of
    // itself — so the denominator keeps it, here as everywhere else.
    org.run(&["status", "bench", "dropped"]).assert_ok("drop");
    org.run(&["show", "caching"])
        .assert_ok("show")
        .assert_contains("1 of 2 done");
    let row = project_row(&board(&org, &["board"]));
    assert!(row.contains("1/2"), "the dropped task is still counted: {row}");
}

#[test]
fn a_project_with_nothing_planned_yet_reports_no_standing() {
    // `0/0` is arithmetic about nothing. The needs-you cell already has the sentence.
    let org = Org::new("board-standing-bare", "software-company");
    org.run(&[
        "project",
        "add",
        "bare",
        "get the export endpoint under a second",
        "--repo",
        "app",
        "--measure-cmd",
        "cargo test",
        "--tokens",
        "1000",
        "--wall",
        "60",
    ])
    .assert_ok("add project");

    let out = board(&org, &["board"]);
    let row = out
        .lines()
        .find(|l| l.contains("PROJECT bare"))
        .unwrap_or_else(|| panic!("no project row in:\n{out}"));
    assert!(!row.contains("0/0"), "no fraction to print: {row}");
    assert!(row.contains("no tasks"), "the sentence instead: {row}");
}
