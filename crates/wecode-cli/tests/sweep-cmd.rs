//! `sweep` — one command over every task that is finished with.
//!
//! End to end because the claim is about three pieces agreeing: the candidate set the
//! command computes, the cascade the store performs, and the views that must stop
//! showing what was filed. The cascade and the guard are proven beside their own code;
//! what only the binary can prove is that a sweep hides exactly the rows `archive task`
//! would have hidden one at a time — no more, and no fewer.
//!
//! Not to be confused with `tests/sweep.rs`, which is the loop's sweep of runs whose
//! supervisor stopped answering. That one is deliberately not a command.

mod support;

use support::Org;
use wecode_core::TaskId;
use wecode_store::Store;

/// Whether the row is off the board, read out of the database the binary wrote.
fn filed(org: &Org, id: &str) -> bool {
    !Store::open(org.path("wecode.db"))
        .expect("the workspace database")
        .load_plan()
        .expect("the plan")
        .task(&TaskId::new(id))
        .expect("the task")
        .is_visible()
}

/// The seeded workspace with `keys` under `cache-tests`, so a sweep has a group to
/// cascade over rather than three unrelated rows.
///
/// `bench` comes with the seed and is left `waiting` throughout: every test here needs
/// one row that a sweep must not touch, and live work sitting beside finished work is
/// the whole situation the command is for.
fn org(name: &str) -> Org {
    let org = Org::new(name, "solo");
    org.seed();
    org.run(&[
        "task",
        "add",
        "keys",
        "design the cache key format",
        "--project",
        "caching",
        "--parent",
        "cache-tests",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/keys/**",
        "--tokens",
        "10",
    ])
    .assert_ok("a subtask under cache-tests");
    org
}

fn status(org: &Org, id: &str, want: &str) {
    org.run(&["status", id, want]).assert_ok(want);
}

#[test]
fn a_finished_group_is_filed_once_and_counted_in_full() {
    let org = org("sweep-group");
    status(&org, "cache-tests", "done");
    status(&org, "keys", "done");

    // Two rows, one group: the parent is named and the cascade reaches the child, so a
    // five-row feature is one line of report rather than five.
    org.run(&["sweep"])
        .assert_ok("sweep")
        .assert_contains("filed 2 tasks in 1 group")
        .assert_contains("cache-tests")
        .assert_lacks("keys");

    assert!(filed(&org, "cache-tests"));
    assert!(filed(&org, "keys"), "the cascade took the subtask");
    assert!(!filed(&org, "bench"), "waiting work is not finished work");

    // And the views agree, which is the point of filing at all. Asserted on the title
    // rather than the id: `bench` comes after cache-tests and says so on its own row.
    org.run(&["tree"])
        .assert_ok("tree")
        .assert_lacks("cover the cache layer")
        .assert_contains("benchmark the cache");
    org.run(&["tree", "--all"])
        .assert_ok("tree --all")
        .assert_contains("cover the cache layer");

    // Twice is not an error and not a second filing: there is nothing left on the board
    // that is finished with.
    org.run(&["sweep"])
        .assert_ok("sweep again")
        .assert_contains("nothing to file away");
}

#[test]
fn a_dry_run_reports_the_same_sweep_and_writes_nothing() {
    let org = org("sweep-dry");
    status(&org, "cache-tests", "done");
    status(&org, "keys", "dropped");

    org.run(&["sweep", "--dry-run"])
        .assert_ok("dry run")
        .assert_contains("would file 2 tasks in 1 group")
        .assert_contains("nothing was written");
    assert!(!filed(&org, "cache-tests"), "nothing was written");
    assert!(!filed(&org, "keys"), "nothing was written");

    // Nothing changed, so nothing needed signing: with the session closed the report
    // still comes out, and only the write is refused. This is what lets a sweep be
    // read from a script, a hook, or an acceptance command with no seat behind it.
    org.run(&["logout", "--all"]).assert_ok("logout");
    org.run(&["sweep", "--dry-run"])
        .assert_ok("dry run with nobody logged in")
        .assert_contains("would file");
    let r = org.run(&["sweep"]);
    assert!(!r.ok(), "a sweep that writes needs a seat");
    r.assert_contains("not logged in");
    assert!(!filed(&org, "cache-tests"));
}

#[test]
fn finished_work_covering_work_that_could_still_move_is_held_back_by_name() {
    // The load-bearing guard, inherited whole from `archive task`: filing a task does
    // not park it, so a hidden `ready` row would be dispatched with nothing on screen
    // saying so. A sweep may not be the way round that.
    let org = org("sweep-held");
    status(&org, "cache-tests", "done");
    status(&org, "keys", "ready");

    org.run(&["sweep"])
        .assert_ok("sweep")
        .assert_contains("nothing to file away")
        .assert_contains("held back")
        .assert_contains("keys is ready")
        .assert_contains("--force");
    assert!(!filed(&org, "cache-tests"), "the group was left alone");

    // Overridden on the same terms one task is overridden on.
    org.run(&["sweep", "--force"])
        .assert_ok("forced sweep")
        .assert_contains("filed 2 tasks in 1 group");
    assert!(filed(&org, "cache-tests"));
    assert!(filed(&org, "keys"));
}

#[test]
fn a_named_project_narrows_the_sweep_and_an_unknown_one_is_refused() {
    let org = org("sweep-project");
    // `--force`, because one repository holds one live project: two projects is the
    // situation being tested and sharing `app` is the only way to reach it here.
    org.run(&[
        "project",
        "add",
        "export",
        "cut the export endpoint's p99 below 500ms",
        "--repo",
        "app",
        "--measure-cmd",
        "cargo test",
        "--tokens",
        "200000",
        "--wall",
        "1800",
        "--force",
    ])
    .assert_ok("a second project")
    .assert_contains("saved project export");
    org.run(&[
        "task",
        "add",
        "export-probe",
        "measure where the export time goes",
        "--project",
        "export",
        "--accept-cmd",
        "cargo test",
        // Clear of `tests/**`, so the overlap check has nothing to say about a task
        // this test only needs in order to file it away.
        "--write",
        "src/export/**",
        "--tokens",
        "10",
    ])
    .assert_ok("its one task");
    status(&org, "cache-tests", "done");
    status(&org, "keys", "done");
    status(&org, "export-probe", "done");

    org.run(&["sweep", "export"])
        .assert_ok("sweep one project")
        .assert_contains("filed 1 task away")
        .assert_contains("export-probe");
    assert!(filed(&org, "export-probe"));
    assert!(
        !filed(&org, "cache-tests"),
        "the other project was not named"
    );

    let r = org.run(&["sweep", "nope"]);
    assert!(!r.ok(), "an unknown project is a typo, not an empty sweep");
    r.assert_contains("no such project");
}

#[test]
fn an_archived_project_keeps_its_rows_unless_it_is_named() {
    // Unarchiving should hand back the board that was parked, not an emptier one — so
    // the wide sweep leaves a parked project's rows where they are. Naming it reaches
    // them anyway: the operator said which.
    let org = org("sweep-parked");
    status(&org, "cache-tests", "done");
    status(&org, "keys", "done");
    status(&org, "bench", "dropped");
    org.run(&["archive", "caching"]).assert_ok("park it");

    org.run(&["sweep"])
        .assert_ok("wide sweep")
        .assert_contains("nothing to file away");
    assert!(!filed(&org, "cache-tests"), "a parked row is already hidden");

    org.run(&["sweep", "caching"])
        .assert_ok("sweep the named project")
        .assert_contains("filed 3 tasks in 2 groups");
    assert!(filed(&org, "cache-tests"));
    assert!(filed(&org, "bench"));
}
