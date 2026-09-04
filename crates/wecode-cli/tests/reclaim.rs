//! The drill: a supervisor killed mid-run, and what is left of the workspace.
//!
//! Every test here kills a real process. That is the point — the failure being closed
//! is `kill -9`, the OOM killer and a closed laptop lid, and none of those can be
//! simulated by returning an error from a function. So the supervisor is the real
//! binary, the agent is a real `sleep`, and the assertions are about what is on disk
//! and in the process table afterwards.
//!
//! Linux only, like the identity proof itself: without `/proc` there is no start time
//! to read, every owner is [unproven](../src/identity.rs), and `reclaim` correctly
//! declines to do anything. These tests skip rather than fail there.

mod support;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use support::Org;
use support::agent::{a_task_in_src, with_agent};
use support::git_out;

/// How long to wait for the agent to be up before giving up on the test.
const PATIENCE: Duration = Duration::from_secs(20);

/// What the agent writes, and what the task is judged by.
const WORK: &str = "echo done >> src/app.txt";
const ACCEPT: &str = "grep -q done src/app.txt";

/// Whether this machine can answer the question the whole feature rests on.
fn provable() -> bool {
    Path::new("/proc/self/stat").is_file()
}

/// A workspace whose agent sits there long enough to be interrupted.
///
/// It writes a file first, so the attempt has something to commit and AC-3 has
/// something to look for. `sleep 120` is far longer than the drill needs — the run is
/// killed within a second — and short enough that a leaked process is not permanent.
///
/// `a_task_in_src` rather than `a_task`, and that is load-bearing rather than
/// incidental: its scope is inside the engineer's own grant, so the task is admitted
/// and reaches `ready`. That is the status this drill has to see handed back, and it is
/// what makes the queue able to offer the task again afterwards.
fn mid_run(name: &str) -> Org {
    let (org, _) = with_agent(name, &format!("{WORK}; sleep 120"));
    a_task_in_src(&org, "t", "src/**", ACCEPT);
    org
}

/// Swaps the agent's script on a workspace whose template has already been replaced.
///
/// [`Org::agent`] matches `command = "claude"` and refuses a second call, deliberately:
/// it is the guard that stops a shipped template quietly ceasing to be replaced. This is
/// the case that guard does not cover — one workspace, two attempts, two scripts.
fn rescript(org: &Org, script: &str) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).expect("company.toml");
    let args = format!("args = [\"-c\", \"{}\"]", script.replace('"', "\\\""));
    let replaced: String = text
        .lines()
        .map(|l| {
            if l.starts_with("args = [\"-c\"") {
                args.clone()
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert_ne!(replaced, text, "the agent script was not replaced");
    std::fs::write(&conf, replaced).expect("company.toml");
}

/// `wecode run t`, started and not waited for.
fn dispatch(org: &Org) -> Child {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wecode"));
    cmd.arg("--org").arg(&org.dir).args(["run", "t"]);
    cmd.env_remove("WECODE_ORG");
    cmd.env("WECODE_CONFIG", org.dir.join("config"));
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().expect("the binary runs")
}

fn db(org: &Org) -> PathBuf {
    org.dir.join("wecode.db")
}

fn store(org: &Org) -> wecode_store::Store {
    wecode_store::Store::open(db(org)).expect("the workspace database")
}

/// Waits until the journal knows the agent's pid, and answers with it.
///
/// Polled rather than slept on, because the thing being waited for is precisely the
/// write this feature adds: a sleep long enough to be safe would be a test that passes
/// slowly, and one short enough to be quick would be a test that fails on a loaded
/// machine.
fn agent_pid(org: &Org) -> i64 {
    let until = Instant::now() + PATIENCE;
    while Instant::now() < until {
        if let Some(pid) = store(org)
            .unsettled()
            .expect("the journal")
            .iter()
            .find_map(|d| d.child.as_ref())
            .map(|c| c.pid)
        {
            return pid;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("the agent's pid never reached the journal");
}

fn alive(pid: i64) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Kills the supervisor the way the OOM killer would, and collects it.
///
/// Reaped deliberately: a zombie is not running, and the shell or service manager that
/// started the real thing would collect it in the same breath. Leaving one here would
/// test the zombie path rather than the crash.
fn crash(mut supervisor: Child) {
    let _ = supervisor.kill();
    let _ = supervisor.wait();
}

/// A crashed run: the workspace, and the agent it left behind.
fn crashed(name: &str) -> (Org, i64) {
    let org = mid_run(name);
    let supervisor = dispatch(&org);
    let agent = agent_pid(&org);
    crash(supervisor);
    (org, agent)
}

fn worktree(org: &Org) -> PathBuf {
    org.dir
        .join("config/run")
        .join(org.dir.file_name().expect("a workspace directory"))
        .join("t")
}

#[test]
fn a_crashed_run_is_settled_and_its_task_handed_back() {
    // AC-1 and AC-2 together, because they are one event: before this, the row stayed
    // `working` for ever, `scheduler::contended` refused every further dispatch of the
    // task and `free_slots` counted the seat as taken — and the agent carried on
    // writing into the worktree with nothing supervising it.
    if !provable() {
        return;
    }
    let (org, agent) = crashed("reclaim-crash");
    assert!(alive(agent), "the agent should outlive its supervisor");

    // `waiting` and not `ready`: this dispatch was typed at a task the tick had not
    // promoted yet, and that is exactly the status the claim took. Handing back
    // anything else would be reclaim deciding something, which is the one thing it may
    // not do — the tick promotes it a moment later, on the graph, as it always did.
    org.run(&["reclaim"])
        .assert_ok("reclaim")
        .assert_contains("supervisor pid")
        .assert_contains("running → waiting");

    // AC-2. Polled: the signal is delivered asynchronously, and `stop` does not wait on
    // a process it is not the parent of.
    let until = Instant::now() + PATIENCE;
    while alive(agent) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(agent), "the orphaned agent is still running");

    // AC-1: back where the dispatch found it, with the run closed as stopped from
    // outside rather than as work that failed.
    org.run(&["show", "t"]).assert_contains("status     waiting");
    let runs = store(&org)
        .executions(&wecode_core::TaskId::new("t"))
        .expect("the runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, wecode_core::ExecutionStatus::Canceled);
    assert!(runs[0].detail.contains("supervisor"), "{:?}", runs[0].detail);
}

#[test]
fn the_worktree_stands_and_the_attempt_is_committed() {
    // AC-3. The branch and the tree are the surviving copy of the work, so reclaiming
    // is non-destructive: it settles the run and leaves what the run produced.
    if !provable() {
        return;
    }
    let (org, _) = crashed("reclaim-keeps-work");
    org.run(&["reclaim"]).assert_ok("reclaim");

    let wt = worktree(&org);
    assert!(wt.is_dir(), "{} was taken down", wt.display());
    let log = git_out(&wt, &["log", "--oneline", "-1"]);
    assert!(log.contains("t: attempt 1"), "{log}");
    // What the agent actually wrote, committed rather than left in the working tree
    // where the next attempt's `reset --hard` would destroy it.
    let committed = git_out(&wt, &["show", "--name-only", "--format=", "HEAD"]);
    assert!(committed.contains("src/app.txt"), "{committed}");
}

#[test]
fn reclaiming_twice_changes_nothing_the_second_time() {
    // AC-4, and the property the whole design rests on: every step of a reclaim is
    // repeat-safe, so an interrupted one is finished by the next and a redundant one
    // is not a second opinion about a settled run.
    if !provable() {
        return;
    }
    let (org, _) = crashed("reclaim-twice");
    org.run(&["reclaim"]).assert_ok("first reclaim");

    let before = std::fs::read(db(&org)).expect("the database");
    org.run(&["reclaim"])
        .assert_ok("second reclaim")
        .assert_contains("nothing to reclaim");
    // The task keeps the status the first pass gave it, rather than being handed back
    // a second time from wherever it has got to since.
    org.run(&["show", "t"]).assert_contains("status     waiting");
    assert_eq!(
        before.len(),
        std::fs::read(db(&org)).expect("the database").len(),
        "the second reclaim wrote to the store"
    );
}

#[test]
fn a_run_whose_supervisor_is_alive_is_left_alone() {
    // AC-5, and the failure that would be worse than the one being fixed. A hand-run
    // `wecode run t` beside a running `wecode serve` is ordinary, and a reclaim that
    // assumed every open row was its own would kill a live sibling's agent.
    if !provable() {
        return;
    }
    let org = mid_run("reclaim-live");
    let supervisor = dispatch(&org);
    let agent = agent_pid(&org);

    org.run(&["reclaim"])
        .assert_ok("reclaim")
        .assert_contains("nothing to reclaim");
    assert!(alive(agent), "a live supervisor's agent was stopped");
    org.run(&["show", "t"]).assert_contains("status     running");

    crash(supervisor);
    org.run(&["reclaim"]).assert_ok("cleanup");
}

#[test]
fn an_orphan_whose_pid_was_never_recorded_is_found_by_its_token() {
    // AC-6. The window this covers is real: the kernel creates the process, and only
    // then does wecode get to write the number down. A crash in between used to leave
    // an agent nothing could name — and `env_clear` means the token in its environment
    // is one wecode put there and nothing else can be carrying.
    if !provable() {
        return;
    }
    let (org, agent) = crashed("reclaim-orphan");
    assert!(alive(agent));

    // The state no API can reach, which is why this test opens the file directly: a
    // spawn that died before `note_child` ran.
    rusqlite::Connection::open(db(&org))
        .expect("the database")
        .execute("UPDATE run_journal SET child_pid = NULL, child_start = NULL", [])
        .expect("forget the child");
    assert!(
        store(&org)
            .unsettled()
            .expect("the journal")
            .iter()
            .all(|d| d.child.is_none()),
        "the pid is still recorded, so this proves nothing about the token"
    );

    org.run(&["reclaim"]).assert_ok("reclaim");
    let until = Instant::now() + PATIENCE;
    while alive(agent) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(agent), "the token did not find the orphan");
}

#[test]
fn doctor_reports_the_same_run_and_touches_nothing() {
    // AC-7, and the split `teardown` already draws: an operator naming a thing has
    // decided, and a drill that runs before anything has been decided must be able to
    // report and decline.
    if !provable() {
        return;
    }
    let (org, agent) = crashed("reclaim-doctor");

    let r = org.run(&["doctor"]);
    r.assert_contains("runs").assert_contains("to reclaim");
    assert!(alive(agent), "doctor stopped a process");
    org.run(&["show", "t"]).assert_contains("status     running");

    org.run(&["reclaim"]).assert_ok("cleanup");
}

#[test]
fn a_workspace_with_nothing_in_doubt_says_so_in_the_drill() {
    // The other half of AC-7: the line has to be readable when it is good news, or an
    // operator learns to skip it.
    let (org, _) = with_agent("reclaim-doctor-quiet", "true");
    org.run(&["doctor"]).assert_contains("no run is in doubt");
}

#[test]
fn the_loop_dispatches_the_task_again_after_a_crash() {
    // AC-9, and the whole point of settling at startup: before this the task was
    // `running` with a run in flight for ever, so the queue never offered it again and
    // the seat it held was gone with it. Nobody was going to type `wecode reclaim`.
    if !provable() {
        return;
    }
    let (org, agent) = crashed("reclaim-serve");

    // A quick agent for the second attempt, so `serve --once` returns promptly.
    rescript(&org, WORK);
    let r = org.run(&["loop", "--once"]);
    r.assert_ok("loop --once").assert_contains("supervisor pid");

    let until = Instant::now() + PATIENCE;
    while alive(agent) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(agent), "the first attempt's agent survived");

    let runs = store(&org)
        .executions(&wecode_core::TaskId::new("t"))
        .expect("the runs");
    assert_eq!(runs.len(), 2, "the crashed run was not retried: {runs:?}");
    assert_eq!(runs[0].status, wecode_core::ExecutionStatus::Canceled);
    assert!(runs[1].ended.is_some(), "the second attempt did not finish");
}

#[test]
fn a_finished_run_leaves_nothing_in_doubt() {
    // The other side of every test above, and the one that would catch a settlement
    // that stopped happening: an ordinary run must close its own rows, or the next
    // restart would find work to reclaim that nobody lost.
    let (org, _) = with_agent("reclaim-clean", WORK);
    a_task_in_src(&org, "t", "src/**", ACCEPT);
    org.run(&["run", "t"]).assert_ok("run");

    assert!(
        store(&org).unsettled().expect("the journal").is_empty(),
        "a completed run left steps in doubt"
    );
    org.run(&["reclaim"]).assert_contains("nothing to reclaim");
}

#[test]
fn starting_a_task_by_hand_leaves_nothing_for_a_restart_to_take_back() {
    // A person is not a process whose liveness anything can prove. `wecode start` hands
    // the tree to an operator and settles its row on the way out, so a `reclaim` run
    // later — by them, or by `loop` — does not hand their task back mid-edit.
    let (org, _) = with_agent("reclaim-by-hand", "true");
    a_task_in_src(&org, "t", "src/**", ACCEPT);
    org.run(&["start", "t"]).assert_ok("start");

    assert!(store(&org).unsettled().expect("the journal").is_empty());
    org.run(&["reclaim"]).assert_contains("nothing to reclaim");
    org.run(&["show", "t"]).assert_contains("status     running");
}
