//! A project's own state: its status, its archive, and amending its tasks' scopes.

mod support;

use support::playbook::with_playbook;

// -------------------------------------------------------- project status ------

#[test]
fn a_project_status_can_be_set_by_hand() {
    // The point of a declared status: `done` is a judgement, not a rollup, so it must
    // be settable with work outstanding.
    let (org, _) = with_playbook("proj-status");
    org.run(&[
        "task",
        "add",
        "unfinished",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");

    let r = org.run(&["status", "caching", "done"]);
    r.assert_ok("set project status")
        .assert_contains("draft → done")
        .assert_contains("1 task still open");

    org.run(&["show", "caching"])
        .assert_contains("status     done");
}

#[test]
fn an_unknown_project_status_lists_the_real_ones() {
    let (org, _) = with_playbook("proj-status-bad");
    let r = org.run(&["status", "caching", "finished"]);
    assert!(!r.ok());
    r.assert_contains("unknown project status")
        .assert_contains("dropped");
}

#[test]
fn status_still_resolves_tasks_and_says_so_when_neither_matches() {
    let (org, _) = with_playbook("proj-status-task");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    org.run(&["status", "t", "done"])
        .assert_ok("task status still works")
        .assert_contains("→ done");

    let r = org.run(&["status", "ghost", "done"]);
    assert!(!r.ok());
    r.assert_contains("no project or task");
}

// --------------------------------------------------------------- archive ------

#[test]
fn archiving_hides_a_project_until_all_is_asked_for() {
    let (org, _) = with_playbook("arch-hide");
    org.run(&["archive", "caching"])
        .assert_ok("archive")
        .assert_contains("archived caching");

    org.run(&["tree"])
        .assert_ok("tree")
        .assert_contains("every project is archived");
    org.run(&["tree", "--all"])
        .assert_ok("tree --all")
        .assert_contains("caching")
        .assert_contains("archived");

    org.run(&["unarchive", "caching"])
        .assert_ok("unarchive")
        .assert_contains("visible again");
    org.run(&["tree"]).assert_contains("caching");
}

#[test]
fn archiving_parks_the_work_rather_than_only_hiding_it() {
    // The scheduler will scan live projects only, so `ready` has to agree with it.
    let (org, _) = with_playbook("arch-park");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    org.run(&["assign", "t", "--to", "impl"])
        .assert_ok("assign");
    org.run(&["ready"]).assert_contains("t");

    org.run(&["archive", "caching"]).assert_ok("archive");
    org.run(&["ready"])
        .assert_ok("ready")
        .assert_lacks("stale entry");

    org.run(&["unarchive", "caching"]).assert_ok("unarchive");
    org.run(&["ready"]).assert_contains("stale entry");
}

#[test]
fn archiving_refuses_to_hide_work_that_is_mid_flight() {
    let (org, _) = with_playbook("arch-live");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    org.run(&["assign", "t", "--to", "impl"])
        .assert_ok("assign");
    org.run(&["start", "t"]).assert_ok("start");

    let r = org.run(&["archive", "caching"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("mid-flight").assert_contains("t");

    org.run(&["archive", "caching", "--force"])
        .assert_ok("forced")
        .assert_contains("archived");
}

#[test]
fn archiving_is_idempotent_and_says_so() {
    let (org, _) = with_playbook("arch-twice");
    org.run(&["archive", "caching"]).assert_ok("archive");
    org.run(&["archive", "caching"])
        .assert_ok("second time is not an error")
        .assert_contains("already archived");
}

#[test]
fn an_archived_project_stays_reachable_by_name() {
    // Hiding must not make a project unusable — only unlisted.
    let (org, _) = with_playbook("arch-reach");
    org.run(&["archive", "caching"]).assert_ok("archive");

    org.run(&["show", "caching"])
        .assert_ok("show still works")
        .assert_contains("objective");
    org.run(&["playbook", "bug", "--project", "caching"])
        .assert_ok("playbook still resolves")
        .assert_contains("Reproduce first");
    org.run(&["status", "caching", "done"])
        .assert_ok("status still works");
}

#[test]
fn a_worktree_in_an_archived_project_is_still_listed() {
    // Otherwise archiving orphans the checkout: invisible, and impossible to clean up.
    let (org, _) = with_playbook("arch-wt");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    org.run(&["start", "t"]).assert_ok("start");
    org.run(&["archive", "caching", "--force"])
        .assert_ok("archive");

    org.run(&["worktree"])
        .assert_ok("worktree")
        .assert_contains("t");
    org.run(&["worktree", "remove", "t"])
        .assert_ok("removable while archived");
}

#[test]
fn archive_applies_to_projects_not_tasks() {
    let (org, _) = with_playbook("arch-task");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    let r = org.run(&["archive", "t"]);
    assert!(!r.ok());
    r.assert_contains("projects, not tasks");
}

// ----------------------------------------------------------- task scope ------

#[test]
fn a_scope_can_be_amended_without_erasing_what_was_recorded() {
    // Re-planning, not laundering. The ledger is append-only, so widening a scope
    // lets a later verify pass while the earlier violation stays visible.
    let (org, repo) = with_playbook("scope-amend");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "declared/**",
    ])
    .assert_ok("task add");

    // Work that lands outside the declared scope.
    std::fs::write(repo.join("elsewhere.rs"), "fn x() {}\n").unwrap();
    org.run(&["verify", "t"])
        .assert_ok("verify runs")
        .assert_contains("outside scope")
        .assert_contains("failed");
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_contains("elsewhere.rs");

    org.run(&["task", "scope", "t", "--write", "elsewhere.rs"])
        .assert_ok("amend")
        .assert_contains("was  declared/**")
        .assert_contains("now  elsewhere.rs");

    org.run(&["verify", "t"])
        .assert_ok("verify again")
        .assert_lacks("outside scope");

    // The point: the old denial is still on the record.
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_contains("elsewhere.rs");
}

#[test]
fn amending_a_scope_into_a_collision_is_refused() {
    let (org, _) = with_playbook("scope-collide");
    for (id, glob) in [("a", "one/**"), ("b", "two/**")] {
        org.run(&[
            "task",
            "add",
            id,
            "--project",
            "caching",
            "--kind",
            "bug",
            "the cache returns a stale entry after eviction",
            "--write",
            glob,
        ])
        .assert_ok(id);
    }
    // Widening `a` onto `b`'s files is a real conflict, not a formality.
    let r = org.run(&["task", "scope", "a", "--write", "two/**"]);
    r.assert_contains("overlaps").assert_contains("not changed");

    org.run(&["task", "scope", "a", "--write", "two/**", "--force"])
        .assert_ok("forced")
        .assert_contains("now  two/**");
}

#[test]
fn amending_a_scope_needs_at_least_one_glob() {
    let (org, _) = with_playbook("scope-empty");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    let r = org.run(&["task", "scope", "t"]);
    assert!(!r.ok());
    r.assert_contains("at least one");
}
