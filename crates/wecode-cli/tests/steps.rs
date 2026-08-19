//! What a person's task is told to do, written down at the moment it is declared.
//!
//! The other end of this is [`notify`](../notify.rs): these tests are about the steps
//! existing and being recorded, the ones there are about them reaching a phone. Kept
//! apart because the failure modes are different — a briefing nobody wrote and a briefing
//! nobody delivered — and because each is the whole of one command's behaviour.

mod support;

use support::Org;

/// A file in the workspace holding `body`, and the path to hand `--steps`.
fn steps_file(org: &Org, name: &str, body: &str) -> String {
    let path = org.path(name);
    std::fs::write(&path, body).unwrap();
    path.to_str().expect("a utf-8 temp path").to_string()
}

/// The steps the workspace recorded for a task.
///
/// Read out of the database the binary wrote, because no command prints them yet: the
/// notification is the reader this task built, and `wecode show` is one file outside its
/// write scope. Until that lands, opening the file is the only way to prove the write.
fn stored(org: &Org, id: &str) -> Option<String> {
    wecode_store::Store::open(org.path("wecode.db"))
        .expect("the workspace database")
        .task_steps(&wecode_core::TaskId::new(id))
        .expect("the steps column")
}

#[test]
fn a_persons_task_is_declared_with_the_steps_it_carries() {
    // The owner held ticket #238 and asked what to do. A task carries a title, which is
    // right for an agent — the envelope describes the work at dispatch — and a person's
    // task has no dispatch to be described at, so the words have to be written here or
    // they do not exist.
    let org = Org::new("steps-declared", "solo");
    org.seed();
    let file = steps_file(
        &org,
        "mint.md",
        "1. open the Travelpayouts console\n2. create a token\n3. paste it into the vault\n",
    );

    org.run(&[
        "task", "add", "mint", "mint the fares token", "--project", "caching", "--by",
        "person", "--steps", &file,
    ])
    .assert_ok("a person's task with its briefing")
    .assert_contains("saved task mint")
    .assert_contains("3 lines from")
    .assert_lacks("no steps");

    // Stored as text, not as a path: the notification goes out days later, from a loop
    // on a machine where that file may have moved or been merged away.
    let steps = stored(&org, "mint").expect("the steps were recorded");
    assert!(steps.contains("Travelpayouts console"), "{steps}");
    assert!(steps.contains("3. paste it into the vault"), "{steps}");
    std::fs::remove_file(&file).unwrap();
    assert_eq!(
        stored(&org, "mint").as_deref(),
        Some(steps.as_str()),
        "the briefing depended on the file it was read from"
    );
}

#[test]
fn a_persons_task_with_no_steps_is_told_what_is_missing() {
    // The advisory, and the complaint it answers word for word: a manual task with
    // nothing written on it reaches a phone as a title and a number, which is an operator
    // being woken up and asked to guess. Nothing is refused for it — a step whose whole
    // instruction is its title is a real task — and the remedy is named, since the flag
    // is not in `wecode help`.
    let org = Org::new("steps-advisory", "solo");
    org.seed();

    org.run(&[
        "task", "add", "mint", "mint the fares token", "--project", "caching", "--by",
        "person",
    ])
    .assert_ok("still admitted")
    .assert_contains("saved task mint")
    .assert_contains("no steps")
    .assert_contains("--amend --steps");
    assert_eq!(stored(&org, "mint"), None);

    // The control: an agent's task is briefed at dispatch, so there is nothing to say
    // about it having no steps of its own.
    org.run(&[
        "task", "add", "warm", "warm the cache on deploy", "--project", "caching",
        "--write", "src/warm/**", "--accept-cmd", "cargo test", "--tokens", "1000",
    ])
    .assert_ok("an agent's task")
    .assert_lacks("no steps");
}

#[test]
fn steps_are_written_after_the_fact_by_amending_the_task() {
    // What the advisory points at, which therefore has to work. A manual task is usually
    // created while planning and its runbook written afterwards, and `task rm` is not
    // available for that: a task that has been signed for is history.
    let org = Org::new("steps-amend", "solo");
    org.seed();
    org.run(&[
        "task", "add", "mint", "mint the fares token", "--project", "caching", "--by",
        "person",
    ])
    .assert_ok("bare to begin with");

    let file = steps_file(&org, "mint.md", "1. open the console\n2. create a token\n");
    org.run(&["task", "add", "mint", "--amend", "--steps", &file])
        .assert_ok("brief it")
        .assert_contains("was  nothing")
        .assert_contains("now  2 lines from");
    assert!(stored(&org, "mint").unwrap().contains("1. open the console"));

    // Replaced rather than added to, and the count of what it replaced is printed: a
    // briefing that grew a step nobody asked for would be worse than one nobody wrote.
    let longer = steps_file(&org, "mint2.md", "1. open the console\n2. mint\n3. paste\n");
    org.run(&["task", "add", "mint", "--amend", "--steps", &longer])
        .assert_ok("re-brief it")
        .assert_contains("was  2 lines")
        .assert_contains("now  3 lines");
    let steps = stored(&org, "mint").unwrap();
    assert!(steps.contains("3. paste"), "{steps}");
    assert!(!steps.contains("create a token"), "both versions kept: {steps}");

    // Beside a move, since `--amend` is what reshapes the plan: the two are read in one
    // command and neither swallows the other.
    org.run(&[
        "task", "add", "mint", "--amend", "--after", "cache-tests", "--steps", &file,
    ])
    .assert_ok("move it and re-brief it")
    .assert_contains("after cache-tests")
    .assert_contains("now  2 lines from");
}

#[test]
fn a_briefing_that_cannot_be_read_is_refused_before_the_task_is_saved() {
    // A path with a typo in it must cost the operator the same command again, not a task
    // that claims a briefing it has not got — which is the exact failure the flag exists
    // to end, arriving through the flag itself.
    let org = Org::new("steps-unreadable", "solo");
    org.seed();

    let missing = org.path("nowhere.md").to_str().unwrap().to_string();
    let r = org.run(&[
        "task", "add", "mint", "mint the fares token", "--project", "caching", "--by",
        "person", "--steps", &missing,
    ]);
    assert!(!r.ok(), "a briefing that is not there was accepted");
    r.assert_contains("--steps").assert_contains("nowhere.md");
    org.run(&["tree"]).assert_lacks("mint");

    // An empty document is the same refusal for the same reason: it reaches a phone as a
    // bare title, which is what was being complained about.
    let empty = steps_file(&org, "empty.md", "  \n\n");
    let r = org.run(&[
        "task", "add", "mint", "mint the fares token", "--project", "caching", "--by",
        "person", "--steps", &empty,
    ]);
    assert!(!r.ok(), "an empty briefing was accepted");
    r.assert_contains("nothing in it");
    org.run(&["tree"]).assert_lacks("mint");
}

#[test]
fn an_agents_task_is_refused_a_briefing_nothing_would_read() {
    // An agent is told what to do at dispatch, assembled from the plan, the playbook and
    // the repository. Storing a file here anyway would leave the operator holding a
    // receipt for instructions that were never going to be delivered to anybody, which is
    // worse than the refusal and the same shape of failure as a bare manual task.
    let org = Org::new("steps-agents", "solo");
    org.seed();
    let file = steps_file(&org, "warm.md", "1. open the console\n");

    let r = org.run(&[
        "task", "add", "warm", "warm the cache on deploy", "--project", "caching",
        "--write", "src/warm/**", "--accept-cmd", "cargo test", "--tokens", "1000",
        "--steps", &file,
    ]);
    assert!(!r.ok(), "an agent's task took a briefing");
    r.assert_contains("--by person");
    org.run(&["tree"]).assert_lacks("warm");

    // And on the way back in: the same refusal from the amend door, so the flag cannot be
    // smuggled onto a task that was declared an agent's.
    org.run(&[
        "task", "add", "warm", "warm the cache on deploy", "--project", "caching",
        "--write", "src/warm/**", "--accept-cmd", "cargo test", "--tokens", "1000",
    ])
    .assert_ok("an agent's task");
    let r = org.run(&["task", "add", "warm", "--amend", "--steps", &file]);
    assert!(!r.ok(), "an agent's task was briefed by amendment");
    assert_eq!(stored(&org, "warm"), None);
}
