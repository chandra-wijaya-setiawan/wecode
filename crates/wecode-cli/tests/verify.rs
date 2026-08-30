//! A verdict on work wecode did not dispatch: its acceptance, and nothing else.
//!
//! The other verdict tests are about the diff — [`project`](../project.rs) has the scope
//! half, [`run`](../run.rs) the one an agent earns. These are about the half that is left
//! when a person did the work: no tree was cut, no agent was launched, and what `wecode
//! verify` can still do is run the probes the task carries and write down what they said.
//!
//! Why that is worth a suite of its own: a manual task's probe — `test -n
//! "$TRAVELPAYOUTS_TOKEN"`, a bucket-exists check — is the cheap thing an operator wants
//! to run *before* the work as well as after, and a verdict is only safe to run early if
//! it cannot report anything about the work by itself. So every assertion here is about
//! what the acceptance said and what reached the ledger, and none is about the task
//! moving: a signature is what reports a person's task done.

mod support;

use support::Org;
use support::playbook::{with_playbook, with_playbook_body};

/// Guidance whose chore kind is held to nothing.
///
/// Stated here rather than shared: every other test wants a kind with acceptance in it,
/// and this one wants the case a manual task is admitted in most often — a probe nobody
/// has written yet, because the deliverable is a fact in the world rather than a diff.
const NOTHING_ASKED: &str = r#"
[project]
language = "rust"

[chore]
worktree = true
assign_to = "impl"
accept = []
tokens = 1000
wall_secs = 60
guidance = "A kind whose acceptance this project has not written."
"#;

/// A task somebody will do by hand, with the probe it is judged by — or none.
///
/// No write scope and no budget, which is not an omission: the gate stops asking for
/// all three at once, since a manual task cuts no tree, spends no tokens and has no
/// harness to run anything over the result.
fn by_hand(org: &Org, id: &str, probe: Option<&str>) {
    let mut argv = vec![
        "task",
        "add",
        id,
        "mint the fares token",
        "--project",
        "caching",
        "--kind",
        "chore",
        "--by",
        "person",
    ];
    if let Some(p) = probe {
        argv.push("--accept-cmd");
        argv.push(p);
    }
    org.run(&argv).assert_ok("a person's task");
}

// ------------------------------------------------------ the probes it has ------

#[test]
fn a_persons_task_is_judged_on_the_probes_it_carries() {
    // The half of verification that still applies. The command runs here, in wecode's
    // process, under the operator's own environment — which is the one place the
    // credential a real probe needs has ever been.
    let (org, _) = with_playbook("verify-person-green");
    by_hand(&org, "probe", Some("test -f README.md"));

    org.run(&["verify", "probe"])
        .assert_ok("verify a person's task")
        .assert_contains("test -f README.md")
        .assert_contains("exit 0")
        // Not `✓ passed`. The probes agreeing about the world is not the same claim as
        // the work having been delivered, and only one of them is what a merge follows.
        .assert_contains("✓ its checks pass")
        .assert_contains("a signature does")
        .assert_lacks("✓ passed");

    // The durable half, and the reason a probe is worth writing down even though it
    // cannot finish the task: one allow per command, with its exit code on the line,
    // attributed to the supervisor because running it was the supervisor's own act.
    org.run(&["audit", "--task", "probe"])
        .assert_contains("supervisor")
        .assert_contains("test -f README.md — exit 0");
}

#[test]
fn a_probe_that_failed_is_a_finding_and_nothing_is_denied_for_it() {
    // A red check is a red check whoever is holding the keyboard, and the exit code goes
    // on the record so a reader knows what it was. What must *not* happen is the finding
    // arriving in the governance channel: a denial is authority refusing an action, and
    // nothing here was refused.
    let (org, _) = with_playbook("verify-person-red");
    by_hand(&org, "probe", Some("test -f minted.txt"));

    org.run(&["verify", "probe"])
        .assert_ok("verify runs")
        .assert_contains("✗ test -f minted.txt")
        .assert_contains("exit 1, wanted 0")
        .assert_contains("acceptance check(s) failed");

    org.run(&["audit", "--task", "probe"])
        .assert_contains("test -f minted.txt — exit 1, wanted 0");
    org.run(&["audit", "--denied", "--task", "probe"])
        .assert_lacks("minted.txt");
}

#[test]
fn a_task_nobody_asked_anything_of_is_not_thereby_failed() {
    // The third outcome, and the whole of why there are three. A manual task is admitted
    // with no acceptance at all, so the ordinary case is an empty check list — and on a
    // dispatched task that is a real finding, because an agent ran and nothing can say
    // whether it worked. Here nobody ran and nothing was owed: the verdict has no content
    // in it, which is a different sentence from the work being wrong.
    let (org, _) = with_playbook_body("verify-person-bare", NOTHING_ASKED);
    by_hand(&org, "sign", None);

    org.run(&["verify", "sign"])
        .assert_ok("verify runs")
        .assert_contains("· nothing asked")
        .assert_contains("a signature is what reports this one done")
        // The failure this used to land as, which read as a fault on work nobody had
        // been asked about yet.
        .assert_lacks("nothing to judge by");
}

// ------------------------------------------------------- the second tier ------

/// A probe against real infrastructure, standing in for the bucket-exists check an
/// operator actually writes. `touch` on a path outside the repository, so *did it run*
/// is answered by the filesystem rather than by the verdict describing itself.
fn live_probe(org: &Org, id: &str) -> std::path::PathBuf {
    let mark = org.path("reached-the-infrastructure");
    by_hand(org, id, Some(&format!("live: touch {}", mark.display())));
    mark
}

#[test]
fn a_live_probe_is_not_started_unless_this_invocation_asks_for_it() {
    // A manual task's probes are the ones most likely to be `live:` — that is what makes
    // them worth having at all — so the deferred block matters more here than anywhere.
    // The assertion that carries it is the mark's absence: not that the check was
    // reported as skipped, but that nothing reached the infrastructure it names.
    let (org, _) = with_playbook("verify-person-deferred");
    let mark = live_probe(&org, "cloud");

    org.run(&["verify", "cloud"])
        .assert_ok("verify runs")
        .assert_contains("live — 1 check not run")
        // The way to the answer, in the invocation that would get it.
        .assert_contains("WECODE_LIVE=1 wecode verify cloud");
    assert!(!mark.exists(), "the live probe was started");

    // Nor is it in the ledger. A check nobody ran is not a check that passed and not one
    // that failed, and a record of it either way would be wecode's word about a command
    // it never started.
    org.run(&["audit", "--task", "cloud"])
        .assert_lacks("reached-the-infrastructure");
}

#[test]
fn asking_for_the_tier_runs_it_here_where_the_credential_is() {
    // The other half, or the tier would be a way of writing acceptance that never runs —
    // indistinguishable from not writing it. Asked for per invocation and through the
    // environment, because a tier written into the plan would be a standing instruction:
    // every judgement the board made from then on would reach for real infrastructure,
    // days after the person who wrote it stopped watching.
    let (org, _) = with_playbook("verify-person-live");
    let mark = live_probe(&org, "cloud");

    org.run_env(&[("WECODE_LIVE", "1")], &["verify", "cloud"])
        .assert_ok("verify runs")
        .assert_contains("   live")
        .assert_contains("✓ its checks pass")
        .assert_lacks("not run");
    assert!(mark.exists(), "the live probe was not started");
}

// -------------------------------------------------- the diff it has not got ------

#[test]
#[ignore = "wecode judges the diff of work it dispatched and of nothing else: the rule is \
            in verify.rs and not yet in commands/exec.rs, where judge still reads the \
            operator's checkout, files its dirty files against the task, and writes a \
            status onto work nobody dispatched"]
fn a_verdict_on_a_persons_task_reads_no_diff_and_moves_nothing() {
    // The three faults that come out of one line. `judge` judges wherever the work
    // happened, and where a task has no worktree that is the operator's own checkout: its
    // uncommitted files become this task's diff, an empty write scope refuses every one of
    // them into the governance channel, and the verdict that follows writes `failed` onto
    // a task whose only claim was that a person would do it later.
    //
    // Each half is asserted separately because each is a different kind of wrong: the
    // first invents a diff, the second invents a denial, the third takes the row out of
    // `yours to do` — where it is the operator's whole reminder — and puts it where
    // nothing will ask them again.
    let (org, repo) = with_playbook_body("verify-person-diff", NOTHING_ASKED);
    by_hand(&org, "sign", None);

    // Whatever the operator had in flight this afternoon.
    std::fs::write(repo.join("elsewhere.rs"), "fn x() {}\n").unwrap();

    org.run(&["verify", "sign"])
        .assert_ok("verify runs")
        // Never `0 files` either: that beside a green check is the precise misreading the
        // empty-diff finding exists to prevent. This says *no diff is this task's own*.
        .assert_contains("diff — not judged")
        .assert_contains("nothing was dispatched for this task")
        .assert_lacks("elsewhere.rs")
        .assert_lacks("outside scope")
        // The status the task already had, and said to be unmoved. A probe that fails
        // before the person has done the work is the expected state, not a fault.
        .assert_contains("waiting   unchanged");

    // A scope question nobody put is not a clean scope report, and the difference is
    // whether anything was written down: no refusal reaches the ledger at all.
    org.run(&["audit", "--denied", "--task", "sign"])
        .assert_lacks("elsewhere.rs");
    org.run(&["tree"]).assert_contains("⋯ chore sign");
}
