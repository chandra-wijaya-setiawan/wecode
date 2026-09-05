//! Whether landing work stops on a person, and what decides that it does not.
//!
//! `tests/merge.rs` covers the merge itself — the branch, the report, the tree it leaves.
//! This is the door in front of it: the charter's `approval_to_merge` demands a holder's
//! signature per merge, and `[[invariants.auto_merge]]` is the operator answering some of
//! those merges once, in advance, by condition.
//!
//! Driven through `wecode guard`, which is the command that asks the Broker what it would
//! decide and records the verdict — so what is asserted here is the real decision on the
//! real ledger, taken from a hand-edited `company.toml`, and not a unit test's idea of
//! one. What `wecode merge` then does with that verdict is `tests/merge.rs`'s subject; see
//! the note at the foot of this file for the wire that is still missing between them.

mod support;

use support::Org;
use support::playbook::with_playbook;

/// Appends standing orders to the workspace's own `company.toml`.
///
/// Edited the way an operator edits it, because no command writes one and none should:
/// pre-authorising a merge changes what the charter demands, and the only thing entitled
/// to do that is a person editing a file that arrives in a diff.
fn pre_authorises(org: &Org, orders: &str) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).expect("the workspace has a company.toml");
    assert!(
        text.contains("approval_to_merge = [\"main\", \"master\"]"),
        "these tests are about carving out of that protection:\n{text}"
    );
    // At the foot of the file, which is where a fully-qualified `[[invariants.auto_merge]]`
    // header may sit however far it is from `[invariants]`.
    std::fs::write(&conf, format!("{text}\n{orders}")).expect("writable");
}

/// What the Broker decided about `post` landing on `branch` for `project`.
fn asks(org: &Org, post: &str, branch: &str, project: &str) -> support::Run {
    org.run(&["guard", post, "merge", branch, "--project", project])
}

#[test]
fn a_protected_branch_stops_on_a_person_when_nothing_pre_authorised_it() {
    // The baseline the feature is a carve-out of, asserted here so a later change that
    // pre-authorises everything cannot pass by making the whole file vacuous.
    let (org, _repo) = with_playbook("merge-policy-bare");
    asks(&org, "chief", "master", "caching")
        .assert_ok("guard")
        .assert_contains("⏸ needs approval: merge")
        .assert_contains("nothing happens until a holder signs");
}

#[test]
fn a_standing_order_lands_the_merge_the_operator_already_decided_about() {
    let (org, _repo) = with_playbook("merge-policy-standing");
    pre_authorises(
        &org,
        "[[invariants.auto_merge]]\nto = \"master\"\nprojects = [\"caching\"]\n",
    );

    asks(&org, "chief", "master", "caching")
        .assert_ok("guard")
        .assert_contains("✓ allowed")
        .assert_lacks("needs approval");

    // The record says it was allowed, and there is no signature anywhere on the ledger —
    // which is the claim: nothing was signed, and the merge was authorised anyway.
    org.run(&["audit"])
        .assert_ok("audit")
        .assert_contains("✓ allow   broker      merge   master")
        .assert_lacks("approve");

    // And the protection is still standing. `main` is in the same `approval_to_merge`
    // list and no order names it, so it stops exactly as it did before.
    asks(&org, "chief", "main", "caching")
        .assert_ok("guard")
        .assert_contains("⏸ needs approval: merge");
    org.run(&["audit"])
        .assert_ok("audit")
        .assert_contains("⏸ approve broker      merge   main");
}

#[test]
fn a_standing_order_reaches_no_further_than_the_condition_it_names() {
    let (org, _repo) = with_playbook("merge-policy-condition");
    pre_authorises(
        &org,
        "[[invariants.auto_merge]]\nto = \"master\"\nprojects = [\"caching\"]\n",
    );

    // Another project's work, onto the branch the order names.
    asks(&org, "chief", "master", "payments")
        .assert_ok("guard")
        .assert_contains("⏸ needs approval: merge");

    // And a merge that named no project at all: the condition cannot be evaluated, so it
    // is not met. Without this an unattributed merge would be the way past every order.
    org.run(&["guard", "chief", "merge", "master"])
        .assert_ok("guard")
        .assert_contains("⏸ needs approval: merge");
}

#[test]
fn an_order_open_to_every_project_says_so_by_naming_none() {
    let (org, _repo) = with_playbook("merge-policy-open");
    pre_authorises(&org, "[[invariants.auto_merge]]\nto = \"master\"\n");

    for project in ["caching", "payments"] {
        asks(&org, "chief", "master", project)
            .assert_ok("guard")
            .assert_contains("✓ allowed");
    }
    // A merge naming no project is covered too, and only because nothing narrowed it.
    org.run(&["guard", "chief", "merge", "master"])
        .assert_ok("guard")
        .assert_contains("✓ allowed");
}

#[test]
fn a_standing_order_is_not_a_grant() {
    // Two locks, and this opens one of them. `impl` holds no `merge_to` at all, so a
    // pre-authorised branch is refused for the reason it always was — and refused as a
    // denial rather than as a request for a signature, because no signature would help.
    let (org, _repo) = with_playbook("merge-policy-grant");
    pre_authorises(&org, "[[invariants.auto_merge]]\nto = \"master\"\n");

    let r = asks(&org, "impl", "master", "caching");
    r.assert_ok("guard")
        .assert_contains("✗ denied — merge not permitted: master")
        .assert_lacks("needs approval");
}

#[test]
fn an_order_over_a_branch_nothing_protects_grants_nothing_and_breaks_nothing() {
    // Inert rather than wrong: those merges never needed a signature, so the order adds
    // no authority. Worth a test because the tempting alternative is to refuse it at
    // load, which would make withdrawing a protection a two-line edit and leave an
    // operator's file rejected for a key that had stopped mattering.
    let (org, _repo) = with_playbook("merge-policy-inert");
    pre_authorises(&org, "[[invariants.auto_merge]]\nto = \"dev\"\n");

    asks(&org, "chief", "dev", "caching")
        .assert_ok("guard")
        .assert_contains("✓ allowed");
    asks(&org, "chief", "master", "caching")
        .assert_ok("guard")
        .assert_contains("⏸ needs approval: merge");
}

// -------------------------------------------------------------- what is missing ------
//
// `wecode merge <task>` does not honour a standing order yet, and the reason is one line:
// `commands::gov::merge_task` re-derives `protected` from `charter.invariants` itself
// instead of asking `Charter::demands_signature_to_merge`, which is now the single answer
// to that question. Until that line changes, `guard` and `merge` can disagree about the
// same merge — so there is no test here claiming otherwise.
//
// Located, so the fix is not re-derived a third time. In `commands::gov::merge_task`:
//
//     let protected = company.charter.invariants.iter().any(|inv| { .. });
//     let needs_signature = protected || policy == wecode_org::MergePolicy::Approved;
//
// becomes `charter.demands_signature_to_merge(Some(project.id.as_str()), &target)` in
// place of `protected` — and `protected` stays as its own binding, because the refusal
// it prints says `charter: protects it | silent` and a pre-authorised protected branch
// is neither. `merge` asks about the *playbook's* `merge_to`, not a branch anyone typed,
// which is the one thing `guard` cannot reach and the reason this file stops here.
//
// The test that then belongs here needs `support::merge::mergeable(_, "auto")`:
// `merge = "approved"` keeps the signature by design — a project may be stricter than
// the charter, never laxer — so an order over one would read as inert and prove nothing.
// Widen `approval_to_merge` to cover that fixture's `dev` the way `tests/merge.rs` does,
// pre-authorise `to = "dev"`, land a task, and assert `wecode merge` needs no signature.
//
// One thing to decide with it, in `record::merged`: it is handed `needs_signature` and
// prints `how  signed off | automatic`. A pre-authorised merge is neither — the operator
// authorised it, in `company.toml`, before it existed.
