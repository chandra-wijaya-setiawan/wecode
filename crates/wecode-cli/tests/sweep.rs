//! A run whose supervisor stopped answering: what the loop may close, and what
//! nothing else may ever touch.
//!
//! The close itself — a stale row confirmed and swept — turns on a real minute of one
//! process's life, which is not a thing a suite of fast tests waits out; the decision,
//! its confirmation memory and the writes are pure or store-level and proven in unit
//! tests beside their code. What is end-to-end here is the boundary the design draws
//! around the mechanism: a one-shot pass never closes anything, a first reading only
//! remembers, and work nobody claimed to be watching is never touched at all.

mod support;

use support::Org;
use support::agent::{a_task, with_agent};
use wecode_core::{TaskId, TaskStatus};
use wecode_store::Store;

/// The workspace database, as the binary left it.
fn store(org: &Org) -> Store {
    Store::open(org.path("wecode.db")).expect("the workspace database")
}

/// What the plan says the task is, read back the way the binary would.
fn status(org: &Org, id: &str) -> TaskStatus {
    store(org)
        .load_plan()
        .unwrap()
        .task(&TaskId::new(id))
        .unwrap()
        .status
}

/// A task `running` with an open execution row whose beat is an hour past the
/// threshold — the state a killed supervisor leaves behind.
fn with_dead_run(name: &str) -> Org {
    let (org, _) = with_agent(name, "true");
    a_task(&org, "t", "a.txt", "true");
    let s = store(&org);
    let id = TaskId::new("t");
    s.set_task_status(&id, TaskStatus::Running).unwrap();
    let exec = s
        .start_execution(&id, "s-dead", Some("/wt/t"), None)
        .unwrap();
    let ago = wecode_store::now_secs().saturating_sub(3600);
    s.backdate_run(exec, ago, Some(ago)).unwrap();
    org
}

#[test]
fn a_single_tick_over_a_stale_row_changes_nothing() {
    // Only the loop sweeps. A one-shot process has one pass and was not there to hear
    // the silence, so it may not judge it.
    let org = with_dead_run("sweep-tick");
    org.run(&["tick"]).assert_ok("tick").assert_lacks("silent");
    assert_eq!(store(&org).open_runs().unwrap().len(), 1, "the row stands");
    assert_eq!(status(&org, "t"), TaskStatus::Running);
}

#[test]
fn one_pass_of_the_loop_suspects_and_closes_nothing() {
    // The first stale reading is remembered, never acted on: suspend freezes the
    // beating thread while the wall clock runs on, and a single reading cannot tell
    // frozen from dead. `--once` is a single pass by construction.
    let org = with_dead_run("sweep-once");
    org.run(&["loop", "--once"])
        .assert_ok("loop --once")
        .assert_lacks("silent");
    assert_eq!(store(&org).open_runs().unwrap().len(), 1, "the row stands");
    assert_eq!(status(&org, "t"), TaskStatus::Running);
}

#[test]
fn work_nobody_claimed_to_be_watching_is_never_touched() {
    // `wecode start` writes `running` and opens no attempt at all: the operator has
    // it, and typing `start` before going to lunch must not lose it — there is no
    // supervisor here whose silence a sweep could be reading.
    let (org, _) = with_agent("sweep-manual", "true");
    a_task(&org, "t", "a.txt", "true");
    org.run(&["start", "t"]).assert_ok("start");
    for _ in 0..3 {
        org.run(&["loop", "--once"]).assert_ok("loop --once");
    }
    assert!(store(&org).open_runs().unwrap().is_empty(), "no attempt row");
    assert_eq!(status(&org, "t"), TaskStatus::Running);
}

#[test]
fn a_finished_run_leaves_nothing_for_the_sweep_to_suspect() {
    // The whole lifecycle under the beat guard: dispatched, supervised, judged. The
    // verdict closes the row, so the loop afterwards has nothing open to read.
    let (org, _) = with_agent("sweep-finished", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    org.run(&["run", "t"]).assert_ok("run");
    assert!(
        store(&org).open_runs().unwrap().is_empty(),
        "the verdict closed the row"
    );
    org.run(&["loop", "--once"])
        .assert_ok("loop --once")
        .assert_lacks("silent");
}
