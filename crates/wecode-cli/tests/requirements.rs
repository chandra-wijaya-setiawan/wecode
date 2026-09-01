//! What a task is *for*: the obligation it serves, carried on the task's own row.
//!
//! The plan suite next door covers stating an obligation and answering one — the shape
//! of the feature. This covers the link itself, which is a different kind of bug: it is
//! written by one command and read by another days later, with every promotion, scope
//! amendment and re-aiming in between. None of that is visible from a single command's
//! output, and all of it is what a column has to survive.

mod support;

use support::Org;

/// A project with a story under it and one obligation stated, which is the smallest
/// workspace in which a task can serve anything.
fn a_story(name: &str) -> Org {
    let org = Org::new(name, "solo");
    org.seed();
    org.run(&["task", "add", "reply-story", "answer a task from a chat reply",
              "--project", "caching", "--kind", "story"])
        .assert_ok("add story");
    org.run(&["task", "add", "reply-story", "--amend", "--requirement",
              "a reply naming a task by number signs it"])
        .assert_ok("state FR-1")
        .assert_contains("reply-story/FR-1");
    org
}

/// A task under that story, serving whichever handle is named.
fn serving(org: &Org, id: &str, handle: &str) {
    org.run(&["task", "add", id, "parse a chat reply into a task id",
              "--project", "caching", "--parent", "reply-story",
              "--accept-cmd", "cargo test", "--write", "src/reply/**",
              "--tokens", "5000", "--requirement", handle])
        .assert_ok("serve it")
        .assert_contains(&format!("serves    {handle}"));
}

#[test]
fn what_a_task_serves_survives_everything_that_moves_it() {
    // The link is written once, at `task add`, and read every time afterwards. In
    // between the task is promoted, assigned and re-scoped — and a scope amendment is a
    // whole-row save built from a plan the command read a moment earlier, which is
    // exactly where a column not carried on the domain type disappears.
    let org = a_story("req-link-survives");
    serving(&org, "reply-parse", "reply-story/FR-1");

    org.run(&["task", "scope", "reply-parse", "--write", "src/reply/parse/**"])
        .assert_ok("narrow the scope");
    org.run(&["status", "reply-parse", "ready"]).assert_ok("promote it");
    org.run(&["task", "budget", "reply-parse", "--tokens", "9000"])
        .assert_ok("raise the budget");

    org.run(&["check", "reply-parse"])
        .assert_ok("what it answers to")
        .assert_contains("the obligations this task answers to")
        .assert_contains("reply-story/FR-1");
    org.run(&["check", "reply-story"])
        .assert_ok("what the story owes")
        .assert_contains("1 attempt: reply-parse");
}

#[test]
fn pointing_a_task_at_another_obligation_releases_the_first() {
    // The reason the join reads the task's row rather than the claims in the ledger. A
    // task re-aimed is no longer an attempt at what it used to serve, and reading the
    // claims would leave the old obligation counting an answer it never got.
    let org = a_story("req-link-moves");
    org.run(&["task", "add", "reply-story", "--amend", "--requirement",
              "a reply naming nothing is ignored"])
        .assert_ok("state FR-2")
        .assert_contains("reply-story/FR-2");
    serving(&org, "reply-parse", "reply-story/FR-1");
    org.run(&["status", "reply-parse", "done"]).assert_ok("finish it");
    org.run(&["check", "reply-story"])
        .assert_contains("reply-story/FR-1")
        .assert_contains("met");

    org.run(&["task", "add", "reply-parse", "--amend", "--requirement",
              "reply-story/FR-2"])
        .assert_ok("re-aim it")
        .assert_contains("serves    reply-story/FR-2");

    // FR-1 is answered by nothing now, so it is open again — and FR-2 is met, because
    // the task that serves it is done. One task, and it counts for exactly one.
    org.run(&["check", "reply-story"])
        .assert_ok("read both back")
        .assert_contains("reply-story/FR-1  open")
        .assert_contains("reply-story/FR-2  met")
        .assert_contains("1 attempt: reply-parse");
    org.run(&["check", "reply-parse"])
        .assert_contains("reply-story/FR-2")
        .assert_lacks("reply-story/FR-1");
}

#[test]
fn the_ledger_keeps_every_claim_the_task_row_no_longer_shows() {
    // The other half of the split, and the reason both are written. The column answers
    // *what is this task for*; it can only hold one answer, and moving it is a write.
    // What an obligation has been through is the thing a story cannot otherwise show,
    // so it stays in rows nothing rewrites.
    let org = a_story("req-link-ledger");
    org.run(&["task", "add", "reply-story", "--amend", "--requirement",
              "a reply naming nothing is ignored"])
        .assert_ok("state FR-2");
    serving(&org, "reply-parse", "reply-story/FR-1");
    org.run(&["task", "add", "reply-parse", "--amend", "--requirement",
              "reply-story/FR-2"])
        .assert_ok("re-aim it");

    org.run(&["audit", "--task", "reply-parse"])
        .assert_ok("the claims")
        .assert_contains("reply-story/FR-1")
        .assert_contains("reply-story/FR-2");
}

#[test]
fn a_task_that_answers_to_nothing_is_not_given_an_obligation() {
    // Most tasks serve nothing in particular, and `check` says nothing about it rather
    // than inventing a heading with an empty list under it.
    let org = a_story("req-link-absent");
    org.run(&["check", "cache-tests"])
        .assert_ok("check an ordinary task")
        .assert_lacks("the obligations this task answers to");
}
