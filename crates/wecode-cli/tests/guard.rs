//! What a seat may do, and the record of it having done so.

mod support;

use support::Org;

// ---------------------------------------------------------------- guard --------

#[test]
fn an_in_scope_write_is_allowed() {
    let org = Org::new("guard-allow", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "impl",
        "write",
        "crates/export/cache.rs",
        "--task",
        "cache-tests",
    ])
    .assert_ok("guard")
    .assert_contains("allowed");
}

#[test]
fn the_tester_cannot_edit_the_implementation() {
    let org = Org::new("guard-tester", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "test",
        "write",
        "crates/export/cache.rs",
        "--task",
        "cache-tests",
    ])
    .assert_ok("guard")
    .assert_contains("denied")
    // Recoverable, so the attempt is a signal about the scope, not misconduct.
    .assert_contains("sanctioned");
}

#[test]
fn an_invariant_violation_alarms_even_for_a_permitted_post() {
    let org = Org::new("guard-alarm", "software-company");
    org.seed();
    // The engineer may write src/**, but no grant outranks a charter invariant.
    org.run(&[
        "guard",
        "impl",
        "write",
        "src/keys/prod.pem",
        "--task",
        "cache-tests",
    ])
    .assert_contains("ALARM")
    .assert_contains("never_touch");

    org.run(&[
        "guard",
        "impl",
        "run",
        "git push --force",
        "--task",
        "cache-tests",
    ])
    .assert_contains("ALARM")
    .assert_contains("never_run");
}

#[test]
fn merging_a_protected_branch_needs_approval() {
    let org = Org::new("guard-merge", "software-company");
    org.seed();
    org.run(&["guard", "review", "merge", "main", "--task", "cache-tests"])
        .assert_contains("needs approval");
}

#[test]
fn overspending_is_refused() {
    let org = Org::new("guard-spend", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "impl",
        "spend",
        "x",
        "--tokens",
        "500000",
        "--task",
        "cache-tests",
    ])
    .assert_contains("budget");
}

// ---------------------------------------------------------------- audit --------

#[test]
fn the_audit_sequence_is_monotonic_across_processes() {
    // Regression: each invocation used to restart the Broker's counter at 1.
    let org = Org::new("audit-seq", "software-company");
    org.seed();
    for path in [
        "crates/export/a.rs",
        "crates/export/b.rs",
        "crates/export/c.rs",
    ] {
        org.run(&["guard", "impl", "write", path, "--task", "cache-tests"]);
    }
    let out = org.run(&["audit"]).assert_ok("audit").stdout.clone();
    let seqs: Vec<u64> = out
        .lines()
        .filter_map(|l| l.split_whitespace().next()?.parse().ok())
        .collect();
    // Contiguous from 1, not a fixed count: seeding also records `define`
    // actions now, so pinning the length would just be brittle.
    let expected: Vec<u64> = (1..=seqs.len() as u64).collect();
    assert_eq!(seqs, expected, "one ledger, one sequence:\n{out}");
    assert!(seqs.len() > 3, "the three writes must be in there:\n{out}");
}

#[test]
fn audit_filters_select_alarms_denials_and_paths() {
    let org = Org::new("audit-filter", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "impl",
        "write",
        "crates/export/ok.rs",
        "--task",
        "cache-tests",
    ]);
    org.run(&[
        "guard",
        "test",
        "write",
        "crates/export/no.rs",
        "--task",
        "cache-tests",
    ]);
    org.run(&[
        "guard",
        "impl",
        "write",
        "src/x.pem",
        "--task",
        "cache-tests",
    ]);

    org.run(&["audit", "--alarms"])
        .assert_contains("x.pem")
        .assert_lacks("ok.rs");

    org.run(&["audit", "--denied"]).assert_contains("no.rs");

    // The cross-harness question: who touched this, whichever agent it was.
    let touched = org.run(&["audit", "--path", "crates/export/**"]);
    touched
        .assert_contains("claude-code")
        .assert_contains("codex");
    touched.assert_lacks("x.pem");
}

#[test]
fn guard_records_are_attributed_to_their_task() {
    // Regression: the attribution was hardcoded, so every record was uncorrelated.
    let org = Org::new("audit-attrib", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "impl",
        "write",
        "src/x.pem",
        "--task",
        "cache-tests",
    ]);

    // Assert on the needs-you cell and the incident row, NOT on the word "alarm":
    // the footer hints mention "--alarms", so a looser assertion passes even when
    // attribution is broken. This test was vacuous until that was noticed.
    org.run(&["board", "caching"])
        .assert_ok("board caching")
        .assert_contains("1 alarm")
        .assert_contains("x.pem");

    // And it must roll up: the alarm is on the project, the portfolio shows goals.
    org.run(&["board"])
        .assert_ok("board")
        .assert_contains("1 alarm");
}

#[test]
fn an_unattributed_record_does_not_reach_the_board() {
    // The other half of attribution: a record naming nothing must not be silently
    // credited to some task.
    let org = Org::new("audit-unattrib", "software-company");
    org.seed();
    org.run(&["guard", "impl", "write", "src/x.pem"]);

    org.run(&["audit", "--alarms"]).assert_contains("x.pem");
    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_lacks("1 alarm");
}
