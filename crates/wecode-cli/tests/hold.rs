//! `hold` — parked on the board, walked past by the tick.
//!
//! A hold is the pause between `waiting` and the queue. It is deliberately not an
//! archive: filing a project away *hides* it, while a hold leaves every row on the
//! board and stops the scheduler from moving any of them — the state you reach for
//! when the work is still wanted but now is not the moment, and the thing you want
//! back is everything exactly where it stood.
//!
//! These run the real binary against a real workspace because the claim is about
//! three pieces agreeing: the `status` command that sets it, the tick that must skip
//! it, and the board that must still show it. A unit test can prove any one of them;
//! only the whole pipeline can prove they are holding the same opinion.

mod support;

use support::Org;
#[test]
fn a_held_task_stays_on_the_board_while_the_tick_walks_past_it() {
    let org = Org::new("hold-task", "software-company");
    org.seed();
    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign");

    // Held straight out of waiting: nothing has run, so nothing is in flight to
    // strand, and the round trip back to the queue is the whole point of the test.
    org.run(&["status", "cache-tests", "hold"])
        .assert_ok("hold")
        .assert_contains("waiting → hold");

    org.run(&["tick"]).assert_ok("tick");

    // Not promoted, not offered to a dispatcher...
    org.run(&["ready"])
        .assert_ok("ready")
        .assert_lacks("cache-tests");
    // ...and still on the board, saying why nothing will pick it up.
    org.run(&["board"])
        .assert_ok("board")
        .assert_contains("cache-tests")
        .assert_contains("held");

    // Releasing it is the same door it went in by, and the tick takes it from there:
    // a hold that could not be taken off again would be a drop with extra steps.
    org.run(&["status", "cache-tests", "waiting"])
        .assert_ok("release")
        .assert_contains("hold → waiting");
    org.run(&["tick"]).assert_ok("tick after release");
    org.run(&["ready"])
        .assert_ok("ready again")
        .assert_contains("cache-tests");
}

#[test]
fn a_held_project_pauses_every_task_in_it_without_hiding_any() {
    let org = Org::new("hold-project", "software-company");
    org.seed();
    // An operator holds a project that is running, not one that never started.
    org.run(&["status", "caching", "active"])
        .assert_ok("activate")
        .assert_contains("draft → active");
    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign");
    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign the dependent");

    org.run(&["status", "caching", "hold"])
        .assert_ok("hold the project")
        .assert_contains("active → hold");

    // cache-tests is waiting and unblocked: on a live project the tick would have
    // made it ready here. Held, it stays waiting — the project parks the queue, not
    // the display.
    org.run(&["tick"]).assert_ok("tick");
    org.run(&["show", "cache-tests"])
        .assert_ok("show")
        .assert_contains("status     waiting");
    // The board keeps both rows and names the project's hold as why they stand.
    org.run(&["board"])
        .assert_ok("board")
        .assert_contains("cache-tests")
        .assert_contains("project held");

    // Releasing the project is what resumes the tick, and the dependent behind the
    // held project's own task is still sequenced after it, as it always was.
    org.run(&["status", "caching", "active"])
        .assert_ok("release the project")
        .assert_contains("hold → active");
    org.run(&["tick"]).assert_ok("tick after release");
    org.run(&["show", "cache-tests"])
        .assert_ok("show promoted")
        .assert_contains("status     ready");
}

#[test]
fn a_held_task_is_no_competition_for_a_new_one() {
    // The admission side of the same pause: a held row cannot be running while a new
    // one is, so a task that would overlap it admits while it stands held — and the
    // overlap is back the moment it is released, the way unarchiving brings a
    // project's conflict back. `task add` refuses an overlap at the door, so the add
    // itself is the assertion; `check` re-runs the same verdict on the stored task.
    let org = Org::new("hold-overlap", "software-company");
    org.seed();
    org.run(&["status", "cache-tests", "hold"])
        .assert_ok("hold the holder");

    // Under tests/ but beside bench's tests/bench/** — overlapping cache-tests'
    // tests/** and nobody else, so the one relation this test is about is the only
    // one in play.
    org.run(&[
        "task",
        "add",
        "cache-unit",
        "cover the cache slow path with tests",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/unit/**",
        "--tokens",
        "50000",
    ])
    .assert_ok("a held task blocks nothing");

    org.run(&["status", "cache-tests", "waiting"])
        .assert_ok("release");
    org.run(&["check", "cache-unit"])
        .assert_ok("check")
        .assert_contains("overlaps task `cache-tests`");
}
