//! What a task is told before it starts — and who has to sign before it may.

mod support;

use std::process::Command;

use support::Org;
use support::agent::{a_task, a_task_in_src, signs_first, with_agent};
use support::playbook::with_playbook;

// --------------------------------------------------------------- handoff ------

#[test]
fn a_retry_is_told_what_it_tried_and_why_it_was_refused() {
    // The whole point of a retry envelope: without the previous diff and the failing
    // check, the second attempt is the first attempt again.
    let (org, _) = with_agent("handoff-retry", "echo wrong >> src/app.txt");
    a_task(&org, "t", "src/**", "grep -q right src/app.txt");

    org.run(&["run", "t"]).assert_contains("failed");
    org.run(&["status", "t", "waiting"]).assert_ok("reopen");

    let r = org.run(&["start", "t"]);
    r.assert_ok("start")
        .assert_contains("YOUR PREVIOUS ATTEMPTS")
        .assert_contains("attempt 1")
        // Why it was rejected, not how the process exited.
        .assert_contains("grep -q right src/app.txt")
        .assert_contains("exit 1, wanted 0")
        // And the diff it produced.
        .assert_contains("+wrong");
}

#[test]
fn a_first_attempt_has_no_previous_attempts_section() {
    // An empty heading would read as though something were missing.
    let (org, _) = with_agent("handoff-first", "true");
    a_task(&org, "t", "src/**", "true");
    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_lacks("YOUR PREVIOUS ATTEMPTS");
}

#[test]
fn a_successor_is_shown_what_its_predecessor_produced() {
    // The handoff travels along depends_on, and is read out of git rather than taken
    // from the agent that produced it.
    let (org, _) = with_agent("handoff-chain", "echo groundwork >> src/app.txt");
    a_task(&org, "first", "src/**", "grep -q groundwork src/app.txt");
    org.run(&[
        "task",
        "add",
        "second",
        "--project",
        "caching",
        "--kind",
        "chore",
        "build on what the first task laid down",
        "--after",
        "first",
        "--write",
        "src/**",
        "--accept-cmd",
        "true",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("second");

    org.run(&["run", "first"]).assert_contains("passed");
    org.run(&["status", "first", "done"]).assert_ok("close it");

    let r = org.run(&["start", "second"]);
    r.assert_ok("start")
        .assert_contains("first — append a marker comment to the source")
        .assert_contains("+groundwork");
}

/// A design and the task built on it, with the design signed and closed.
///
/// The design asks for no worktree — no playbook here gives it one — so its document is
/// written into the repository itself and never committed by wecode, which is exactly
/// the arrangement the handoff has to cope with.
fn a_signed_design(org: &Org, doc: &str) {
    org.run(&[
        "task",
        "add",
        "d",
        "decide the cache key format",
        "--project",
        "caching",
        "--kind",
        "design",
        "--write",
        doc,
        "--accept-cmd",
        &format!("test -f {doc}"),
        "--tokens",
        "1000",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("add design");
    org.run(&["run", "d"]).assert_contains("passed");
    org.run(&["approve", "design", "--task", "d"])
        .assert_ok("sign the design");

    org.run(&[
        "task",
        "add",
        "build",
        "--project",
        "caching",
        "--kind",
        "chore",
        "build what the design decided",
        "--after",
        "d",
        "--write",
        "src/**",
        "--accept-cmd",
        "true",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("add build");
}

#[test]
fn a_design_predecessor_is_handed_over_as_its_document() {
    // The one kind whose output is not code. Its deliverable is a file, wecode never
    // commits it — a design asks for no worktree — and the successor's branch is cut
    // from a base that may not have it either. Read out of the repository instead, or
    // the kind the design gate exists to protect is the one kind whose handoff is empty.
    let (org, _) = with_agent(
        "handoff-design",
        "mkdir -p docs/wecode/d && printf 'The key is the url and the vary header.\\n' \
         > docs/wecode/d/design.md",
    );
    a_signed_design(&org, "docs/wecode/d/design.md");

    org.run(&["start", "build"])
        .assert_ok("start")
        .assert_contains("docs/wecode/d/design.md")
        .assert_contains("The key is the url and the vary header.")
        // The decision itself, not a diff of it.
        .assert_lacks("+The key is the url");
}

#[test]
fn a_design_document_is_found_wherever_the_task_declared_it() {
    // The convention is `docs/wecode/<task>/design.md`, but a playbook that templates
    // its steps names its own path. The write scope is where the task says which.
    let (org, _) = with_agent(
        "handoff-design-path",
        "mkdir -p src/design && printf 'Hash the url, not the body.\\n' > src/design/keys.md",
    );
    a_signed_design(&org, "src/design/keys.md");

    org.run(&["start", "build"])
        .assert_ok("start")
        .assert_contains("src/design/keys.md")
        .assert_contains("Hash the url, not the body.");
}

#[test]
fn a_design_whose_document_cannot_be_found_says_where_it_looked() {
    // "(no commits)" would read as a signed design that produced nothing, which is a
    // far more alarming fact than one this process could not locate.
    let (org, _) = with_agent(
        "handoff-design-gone",
        "mkdir -p docs/wecode/d && printf 'decided\\n' > docs/wecode/d/design.md",
    );
    a_signed_design(&org, "docs/wecode/d/design.md");
    std::fs::remove_file(org.dir.join("repo/docs/wecode/d/design.md")).unwrap();

    org.run(&["start", "build"])
        .assert_ok("start")
        .assert_contains("no design document at docs/wecode/d/design.md");
}

#[test]
fn the_instruction_is_also_available_as_a2a_json() {
    // Why adopting the protocol is worth anything: a caller that can parse gets the
    // acceptance and the scope as data, rather than scraping them back out of prose.
    let (org, _) = with_agent("a2a-json", "true");
    a_task(&org, "t", "src/**", "grep -q right src/app.txt");

    let r = org.run(&["start", "t", "--json"]);
    r.assert_ok("start --json");
    let v: serde_json::Value =
        serde_json::from_str(&r.stdout).expect("start --json must emit valid JSON");

    // A2A's Task is one wecode *execution*, and nothing has been spawned yet.
    assert_eq!(v["id"], "t-attempt-1");
    assert_eq!(v["contextId"], "t");
    assert_eq!(v["status"]["state"], "submitted");
    assert_eq!(v["history"][0]["role"], "user");

    let parts = v["history"][0]["parts"].as_array().expect("parts");
    let data = &parts
        .iter()
        .find(|p| p["kind"] == "data")
        .expect("a data part")["data"];
    assert!(
        data["acceptance"][0]
            .as_str()
            .unwrap()
            .contains("grep -q right src/app.txt"),
        "{data}"
    );
    // The declared scope, plus the worker area every task may write to.
    let scope = data["writeScope"].as_array().expect("writeScope");
    assert!(scope.iter().any(|g| g == "src/**"), "{data}");
    assert!(scope.iter().any(|g| g == ".wecode/run/**"), "{data}");
    assert_eq!(data["attempt"], 1);

    // ...and that structured half never reaches the text a coding CLI is handed,
    // where it would read as noise inside the instruction.
    let text = parts
        .iter()
        .find(|p| p["kind"] == "text")
        .expect("a text part")["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!text.contains("writeScope"), "{text}");
    assert!(
        text.contains("You may modify only: .wecode/run/**, src/**"),
        "{text}"
    );
}

#[test]
fn a_worker_is_told_the_shape_of_the_tree_it_lands_in() {
    // Otherwise the first thing every agent does in a repository it has never seen is
    // run `find` and `wc -l` — against a budget the task is held to, for an answer
    // wecode is standing in when it writes the envelope.
    let (org, _) = with_agent("handoff-map", "true");
    a_task(&org, "t", "src/**", "true");

    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_contains("REPO MAP")
        // The directory this task may write to, opened up file by file.
        .assert_contains("src ✍")
        .assert_contains("✍ app.txt")
        // One it may not, as a count and in its own words — the mark is not on it, and
        // the description is the README's own heading rather than one wecode invented.
        .assert_contains("toy — the repository the tests drive")
        .assert_lacks("✍ README.md");
}

#[test]
fn the_map_reaches_a_remote_agent_as_an_artifact() {
    // The prompt and the JSON are two renderings of one record, and a map that existed
    // only in the prose would be the first thing to prove otherwise.
    let (org, _) = with_agent("handoff-map-json", "true");
    a_task(&org, "t", "src/**", "true");

    let r = org.run(&["start", "t", "--json"]);
    r.assert_ok("start --json");
    let v: serde_json::Value = serde_json::from_str(&r.stdout).expect("valid JSON");
    let map = v["artifacts"]
        .as_array()
        .expect("artifacts")
        .iter()
        .find(|a| a["artifactId"] == "repo-map")
        .expect("the repo map is an artifact of the instruction");
    let text = map["parts"][0]["text"].as_str().expect("a text part");
    assert!(text.contains("app.txt"), "{text}");
}

#[test]
fn a_worker_is_pointed_at_the_guidance_its_own_playbook_wrote() {
    // The one thing the project decided about *how* work like this is done here, and
    // the envelope was the one place it never appeared: objective, title, acceptance
    // and scope say what the work is, and none of them says how this repository wants
    // it done. The file is committed in the tree the worker lands in, so what was
    // missing was never the guidance — it was any reason to know it was there.
    let (org, _) = with_agent("handoff-guidance", "true");
    a_task(&org, "t", "src/**", "true");

    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_contains("GUIDANCE")
        .assert_contains(".wecode/playbook.toml")
        // Handed over to be read, not to be rewritten: a worker that could edit the
        // guidance it was given is not governed by it.
        .assert_contains("Do not edit it");

    // And it is actually there to be read. A pointer into a tree that does not hold
    // the file would be worse than saying nothing — the worker spends a budget
    // looking, finds nothing, and concludes the project wrote no guidance at all.
    let guidance = org
        .path("config/run")
        .join("wecode-e2e-handoff-guidance")
        .join("t")
        .join(".wecode/playbook.toml");
    let text = std::fs::read_to_string(&guidance)
        .unwrap_or_else(|e| panic!("{}: {e}", guidance.display()));
    assert!(
        text.contains("Uses a worktree, like most work here."),
        "the chore guidance is what this task's worker would read:\n{text}"
    );
}

#[test]
fn a_task_with_no_predecessors_says_so_plainly() {
    let (org, _) = with_agent("handoff-none", "true");
    a_task(&org, "t", "src/**", "true");
    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_contains("nothing came before this task");
}

#[test]
fn a_dependent_task_starts_from_its_predecessors_work() {
    // Being *told* what came before is not the same as *having* it. Cut from the base,
    // a chain touching the same file conflicts the moment it merges.
    let (org, _) = with_agent("chain-base", "echo groundwork >> src/app.txt");
    a_task(&org, "first", "src/**", "grep -q groundwork src/app.txt");
    org.run(&[
        "task",
        "add",
        "second",
        "--project",
        "caching",
        "--kind",
        "chore",
        "build on what the first task laid down",
        "--after",
        "first",
        "--write",
        "src/**",
        "--accept-cmd",
        "grep -q groundwork src/app.txt",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("second");

    org.run(&["run", "first"]).assert_contains("passed");
    org.run(&["status", "first", "done"]).assert_ok("close it");

    // `second`'s acceptance greps for what `first` wrote. It can only pass if the
    // worktree actually contains it.
    org.run(&["run", "second"])
        .assert_ok("run")
        .assert_contains("passed");
}

#[test]
fn an_independent_task_still_starts_from_the_base() {
    // Only a dependency moves the branch point; two unrelated tasks must not inherit
    // each other's changes.
    let (org, _) = with_agent("chain-indep", "echo mine >> src/app.txt");
    // Disjoint scopes: `src/**` would swallow the other and the gate would refuse it.
    a_task(&org, "one", "src/app.txt", "grep -q mine src/app.txt");
    a_task(&org, "two", "src/other.txt", "test -f src/app.txt");

    org.run(&["run", "one"]).assert_contains("passed");
    org.run(&["status", "one", "done"]).assert_ok("close");

    org.run(&["run", "two"]).assert_ok("run");

    // Asserted on history, not on file content: the stand-in agent writes the same
    // line for every task, so content proves nothing. What matters is whether one's
    // *commit* is an ancestor of two's branch.
    let wt = org
        .path("config/run")
        .join("wecode-e2e-chain-indep")
        .join("two");
    let out = Command::new("git")
        .arg("-C")
        .arg(&wt)
        .args(["log", "--oneline"])
        .output()
        .unwrap();
    let log = String::from_utf8_lossy(&out.stdout);
    assert!(
        !log.contains("one: attempt"),
        "an unrelated task inherited a predecessor's commit:\n{log}"
    );
}

// ------------------------------------------------------ dispatch signature ----

#[test]
fn a_task_nobody_signed_for_is_not_dispatched() {
    let org = signs_first("dispatch-unsigned", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");

    // Both, because they are one door. A gate `start` walks around is not a gate — and
    // `start` is how a person takes the work themselves, which is still dispatch.
    for cmd in [["start", "t"], ["run", "t"]] {
        let r = org.run(&cmd);
        assert!(!r.ok(), "{cmd:?} should refuse");
        r.assert_contains("has not been signed for")
            .assert_contains("wecode approve admission --task t");
    }
    // Refused before anything was prepared: no worktree cut, and the task did not move.
    assert!(
        org.recorded().is_empty(),
        "a tree was cut for work nobody signed for"
    );
    org.run(&["show", "t"])
        .assert_contains("status     waiting");

    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign")
        .assert_contains("may be dispatched");
    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
}

#[test]
fn changing_a_task_after_it_was_signed_retracts_the_signature() {
    // The hole a present/absent check would leave: sign something small, then widen it.
    // The ledger is ordered, so "signed before the last change" is a fact about it.
    let org = signs_first("dispatch-restated", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign");

    org.run(&[
        "task", "scope", "t", "--write", "src/**", "--write", "tests/**",
    ])
    .assert_ok("widen the scope");
    let r = org.run(&["run", "t"]);
    assert!(!r.ok(), "the signature was for the narrower task");
    r.assert_contains("was changed after it was signed")
        .assert_contains("wecode approve admission --task t");

    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign what it is now");
    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
}

#[test]
fn the_post_doing_the_work_cannot_sign_for_it() {
    let org = signs_first("dispatch-self", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");

    let r = org.run(&["approve", "admission", "--task", "t", "--as", "impl"]);
    assert!(!r.ok(), "an engineer holds no approvals");
    r.assert_contains("approving refused for `impl`");
    // The attempt is on the record and is not a signature: the gate reads allowed
    // decisions, not the fact that someone tried.
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_contains("approve");
    org.run(&["run", "t"])
        .assert_contains("has not been signed for");
}

#[test]
fn a_signature_cannot_be_attributed_to_a_task_that_does_not_exist() {
    // A typo would otherwise record as authority, and the gate would go on refusing
    // the real task while the operator held what looked like a signature for it.
    let (org, _) = with_playbook("dispatch-ghost");
    let r = org.run(&["approve", "admission", "--task", "ghost"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("no such task: ghost");
    org.run(&["audit", "--task", "ghost"])
        .assert_lacks("approve");
}

#[test]
fn signing_a_task_whose_project_asks_for_no_signature_says_so() {
    // Recorded either way — a holder may sign whatever they like — but silence would
    // let it be read as a gate that is now satisfied.
    let (org, _) = with_playbook("dispatch-ungated");
    a_task_in_src(&org, "t", "src/**", "true");
    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign")
        .assert_contains("nothing was waiting on it");
    org.run(&["start", "t"]).assert_ok("dispatches as before");
}

#[test]
fn the_loop_pauses_on_an_unsigned_task_rather_than_failing_it() {
    let org = signs_first("dispatch-loop", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");

    let r = org.run(&["loop", "--once"]);
    r.assert_ok("one pass")
        // Promoted, then held: the task is startable and waiting on a person, which are
        // two different facts and both true.
        .assert_contains("waiting → ready")
        .assert_contains("⏸ t needs your signature")
        .assert_lacks("▶ t");
    org.run(&["show", "t"]).assert_contains("status     ready");

    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign");
    org.run(&["loop", "--once"])
        .assert_ok("second pass")
        .assert_contains("▶ t")
        .assert_contains("passed");
}

#[test]
fn an_unsigned_task_does_not_hold_the_slot_behind_it() {
    // The queue is taken in id order, so `aaa` is offered first. If the gate were
    // applied after the concurrency cap, one unsigned task at the head would stall
    // everything behind it for as long as nobody signed.
    let org = signs_first(
        "dispatch-slot",
        "mkdir -p src/bbb && echo done >> src/bbb/x.txt",
    );
    a_task_in_src(&org, "aaa", "src/aaa/**", "true");
    a_task_in_src(&org, "bbb", "src/bbb/**", "grep -q done src/bbb/x.txt");
    org.run(&["approve", "admission", "--task", "bbb"])
        .assert_ok("sign the second one only");

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("⏸ aaa needs your signature")
        .assert_contains("▶ bbb");
}
