//! The loop's width: how many agents it has working at once, and what bounds it.
//!
//! The unit tests beside `scheduler.rs` prove what the queue *offers* — capped by the
//! slots given, never a task somebody already holds. What only an end-to-end test can
//! show is that the offer is taken up at the same time: two agents in two worktrees,
//! each one's process alive while the other's is. That is the whole claim, and it is
//! made below by having the two agents refuse to finish until they can see each other.

mod support;

use std::time::Duration;

use support::Org;
use support::agent::a_task_in_src;
use support::playbook::with_playbook;
use wecode_core::{TaskId, TaskStatus};
use wecode_store::Store;

/// What the plan says the task is, read back the way the binary would.
fn status(org: &Org, id: &str) -> TaskStatus {
    Store::open(org.path("wecode.db"))
        .expect("the workspace database")
        .load_plan()
        .unwrap()
        .task(&TaskId::new(id))
        .unwrap()
        .status
}

/// An agent that will not finish until `wanted` of them are running at once.
///
/// It touches a file named after its own worktree — which is named after its task — in
/// a directory both agents can see, then waits for the directory to fill up. Finishing
/// is what proves the overlap, so a run that timed out writes nothing and fails its
/// acceptance: the assertion is on the verdict, not on a log line.
///
/// `sh` and nothing else, on the twelve seconds the task's own 30s wall leaves room
/// for. Every marker is under the workspace, so two tests never see each other's.
fn agents_that_must_meet(org: &Org, wanted: usize) {
    let gate = org.path("gate");
    std::fs::create_dir_all(&gate).expect("the meeting place");
    org.agent(&format!(
        "mine=$(basename $PWD); mkdir -p src/$mine; touch {gate}/$mine; i=0; \
         while [ $i -lt 60 ]; do \
           if [ $(ls {gate} | wc -l) -ge {wanted} ]; then echo done >> src/$mine/m.txt; exit 0; fi; \
           sleep 0.2; i=$((i+1)); \
         done; exit 1",
        gate = gate.display()
    ));
}

/// Whether this machine has the cores for the width a test needs.
///
/// `parallelism` narrows the attention budget by `cores - 2`, so on a two-core box
/// serial dispatch is the *correct* answer and a test asserting overlap would be
/// asserting against the design. Skipped rather than weakened: the decision itself is
/// covered by a unit test that needs no cores at all.
fn cores_for(width: usize) -> bool {
    std::thread::available_parallelism().map_or(1, std::num::NonZero::get) >= width + 2
}

#[test]
fn two_ready_tasks_run_at_the_same_time() {
    // The point of the whole task. Serially these two cannot both pass: whichever went
    // first would wait out its twelve seconds alone, write nothing, and fail acceptance
    // — which is exactly what the queue used to do with a five in `max_open_items`.
    if !cores_for(2) {
        return;
    }
    let (org, _) = with_playbook("loop-pair");
    agents_that_must_meet(&org, 2);
    a_task_in_src(&org, "a", "src/a/**", "grep -q done src/a/m.txt");
    a_task_in_src(&org, "b", "src/b/**", "grep -q done src/b/m.txt");

    let r = org.run(&["loop", "--once"]);
    r.assert_ok("one pass").assert_contains("▶ a");
    r.assert_contains("▶ b");
    // Both dispatched, both reported: `◀` is the supervisor coming back, and a pass
    // that returned before its own runs had verdicts would print neither.
    r.assert_contains("◀ a").assert_contains("◀ b");

    // Passed, and stopped for the signature that lands a branch — the verdict a run
    // that met its neighbour earns. Failed would mean it waited alone.
    for id in ["a", "b"] {
        assert_eq!(status(&org, id), TaskStatus::NeedsApproval, "{id}");
    }
}

#[test]
fn the_attention_budget_is_what_bounds_the_width() {
    // `max_open_items` finally means what it says. One agent at a time here, so the
    // rendezvous above cannot happen — and the second task waits for a pass of its own
    // rather than being dropped.
    let (org, _) = with_playbook("loop-width");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, text.replace("max_open_items = 5", "max_open_items = 1")).unwrap();
    // Two of them wanted, one slot given: the first agent times out and fails, which is
    // what says nothing else was running beside it.
    agents_that_must_meet(&org, 2);
    a_task_in_src(&org, "a", "src/a/**", "grep -q done src/a/m.txt");
    a_task_in_src(&org, "b", "src/b/**", "grep -q done src/b/m.txt");

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("1 at a time")
        .assert_contains("▶ a")
        .assert_lacks("▶ b");
    assert_eq!(status(&org, "a"), TaskStatus::Failed, "it waited alone");
    assert_eq!(status(&org, "b"), TaskStatus::Ready, "still queued");

    // And the slot the first run gave back is the one the second takes.
    org.run(&["loop", "--once"])
        .assert_ok("second pass")
        .assert_contains("▶ b");
}

#[test]
fn each_concurrent_run_gets_its_own_verdict() {
    // Two supervisors judging two tasks in the same second, against one database. The
    // failure mode this covers is a shared verdict: one run's status, spend or
    // execution row landing on the other's task.
    if !cores_for(2) {
        return;
    }
    let (org, _) = with_playbook("loop-verdicts");
    // Only `a` writes anything, so `b` fails acceptance while `a` passes.
    org.agent("if [ $(basename $PWD) = a ]; then mkdir -p src/a; echo done >> src/a/m.txt; fi");
    a_task_in_src(&org, "a", "src/a/**", "grep -q done src/a/m.txt");
    a_task_in_src(&org, "b", "src/b/**", "grep -q done src/b/m.txt");

    org.run(&["loop", "--once"]).assert_ok("one pass");
    assert_eq!(status(&org, "a"), TaskStatus::NeedsApproval);
    assert_eq!(status(&org, "b"), TaskStatus::Failed);

    // One attempt each, closed, and each on its own task: the row is the record the
    // thread is not, so this is what a `board` in another terminal would have read.
    let store = Store::open(org.path("wecode.db")).unwrap();
    for id in ["a", "b"] {
        let runs = store.executions(&TaskId::new(id)).unwrap();
        assert_eq!(runs.len(), 1, "{id} ran once");
        assert!(runs[0].ended.is_some(), "{id}'s row is closed");
    }
    assert!(store.open_runs().unwrap().is_empty(), "nothing left open");
}

#[test]
fn a_pass_with_nothing_ready_dispatches_nothing_and_returns() {
    // The degenerate width, and what a scope makes easy to get wrong: an exit that now
    // goes through a join must not wait on a list nothing was ever put into — a loop
    // that hung here would fail by timing out the suite rather than by asserting.
    let org = Org::new("loop-idle", "solo");
    org.seed();
    let started = std::time::Instant::now();
    let r = org.run(&["loop", "--once"]);
    r.assert_ok("one pass").assert_lacks("▶");
    // Well inside `scheduler::INTERVAL`, which is the sleep a pass takes only when it
    // is going round again.
    assert!(started.elapsed() < Duration::from_secs(5), "returned at once");
    // Nothing was claimed, so nothing needs giving back.
    assert_eq!(status(&org, "cache-tests"), TaskStatus::Draft);
}
