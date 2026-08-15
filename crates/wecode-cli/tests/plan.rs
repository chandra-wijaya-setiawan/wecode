//! The plan: projects, tasks, the two relations between them, and admission.
//!
//! Everything here is about what may be written down before anything runs, which is
//! where a scope collision, a stranded chain, or a task nobody can be assigned has
//! to be caught. Removing and assigning work belong here too: both are decisions
//! about the plan rather than about a run.

mod support;

use support::agent::{a_task, with_agent};
use support::{Org, Run};

// ----------------------------------------------------------------- plan --------

#[test]
fn a_vague_project_is_refused_with_specific_questions() {
    let org = Org::new("vague", "solo");
    let r = org.run(&[
        "project",
        "add",
        "speedup",
        "make the export faster",
        "--repo",
        "app",
    ]);
    r.assert_ok("command itself succeeds")
        .assert_contains("not admitted")
        .assert_contains("faster")
        .assert_contains("not saved");

    // Nothing was written.
    org.run(&["tree"]).assert_contains("no projects yet");
}

#[test]
fn force_admits_a_defective_project_and_says_so() {
    let org = Org::new("force", "solo");
    org.run(&[
        "project",
        "add",
        "speedup",
        "make the export faster",
        "--repo",
        "app",
        "--force",
    ])
    .assert_ok("forced add")
    .assert_contains("forced")
    .assert_contains("saved");
    org.run(&["tree"]).assert_contains("speedup");
}

#[test]
fn a_project_must_name_a_repo_the_company_knows() {
    let org = Org::new("repo-unknown", "solo");
    let r = org.run(&[
        "project",
        "add",
        "x",
        "add response caching to the export endpoint",
        "--repo",
        "nonexistent",
        "--measure-cmd",
        "cargo test",
        "--tokens",
        "100",
    ]);
    r.assert_contains("not admitted").assert_contains("app");
}

#[test]
fn a_task_needs_a_project_that_exists() {
    let org = Org::new("task-orphan", "solo");
    let r = org.run(&[
        "task",
        "add",
        "t",
        "do the thing",
        "--project",
        "ghost",
        "--accept-cmd",
        "cargo test",
        "--write",
        "src/**",
        "--tokens",
        "10",
    ]);
    assert!(!r.ok(), "should be refused");
    r.assert_contains("no such project");
}

#[test]
fn a_spike_is_the_only_kind_admitted_without_a_write_scope() {
    let org = Org::new("spike", "solo");
    org.seed();

    // A feature that writes nothing is a defect...
    org.run(&[
        "task",
        "add",
        "f",
        "implement the eviction policy",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--tokens",
        "10",
    ])
    .assert_contains("not admitted");

    // ...but a spike produces no code, so it needs no write scope.
    org.run(&[
        "task",
        "add",
        "s",
        "investigate the eviction strategies",
        "--project",
        "caching",
        "--kind",
        "spike",
        "--accept-cmd",
        "cargo test",
        "--tokens",
        "10",
    ])
    .assert_ok("spike")
    .assert_contains("admitted")
    .assert_contains("saved");
}

#[test]
fn the_plan_survives_a_restart() {
    let org = Org::new("persist", "solo");
    org.seed();

    // A separate process reads what earlier processes wrote.
    org.run(&["tree"])
        .assert_ok("tree")
        .assert_contains("caching")
        .assert_contains("cache-tests")
        .assert_contains("after cache-tests");

    org.run(&["show", "cache-tests"])
        .assert_ok("show")
        .assert_contains("cover the cache layer")
        .assert_contains("caching");
}

#[test]
fn show_resolves_either_level_and_says_so_when_neither_matches() {
    let org = Org::new("show", "solo");
    org.seed();
    org.run(&["show", "caching"])
        .assert_ok("show project")
        .assert_contains("objective");
    org.run(&["show", "cache-tests"])
        .assert_ok("show task")
        .assert_contains("acceptance");
    let r = org.run(&["show", "nope"]);
    assert!(!r.ok());
    r.assert_contains("no project or task");
}

#[test]
fn the_two_relations_are_reported_separately() {
    // The modelling error this design exists to avoid: a subtask is part of its
    // parent, a dependency comes after its predecessor, and they are not the same.
    let org = Org::new("relations", "solo");
    org.seed();
    org.run(&[
        "task",
        "add",
        "keys",
        "design the cache key format",
        "--project",
        "caching",
        "--parent",
        "cache-tests",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/keys/**",
        "--tokens",
        "10",
    ])
    .assert_ok("subtask");

    org.run(&["show", "cache-tests"])
        .assert_contains("subtasks")
        .assert_contains("not blocked by it");

    org.run(&["show", "bench"])
        .assert_contains("depends on")
        .assert_contains("must come after");
}

#[test]
fn a_dependency_is_a_sibling_in_the_tree_not_a_child() {
    let org = Org::new("tree-shape", "solo");
    org.seed();
    let out = org.run(&["tree"]).assert_ok("tree").stdout.clone();
    let indent = |needle: &str| {
        let line = out
            .lines()
            .find(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("no line for {needle} in:\n{out}"));
        line.len() - line.trim_start().len()
    };
    assert_eq!(
        indent("cache-tests"),
        indent("benchmark the cache"),
        "a predecessor is not a parent:\n{out}"
    );
}

#[test]
fn ready_reports_only_what_a_dispatcher_could_pick_up() {
    let org = Org::new("ready", "software-company");
    org.seed();

    // Fresh tasks are drafts: nothing is dispatchable until it is assigned.
    org.run(&["ready"]).assert_contains("nothing ready");

    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign");
    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign dependent");

    org.run(&["ready"])
        .assert_ok("ready")
        .assert_contains("cache-tests")
        .assert_lacks("benchmark the cache");
}

#[test]
fn finishing_a_predecessor_releases_its_dependent() {
    let org = Org::new("release", "software-company");
    org.seed();
    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign");
    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign");
    org.run(&["ready"]).assert_lacks("benchmark the cache");

    org.run(&["status", "cache-tests", "done"])
        .assert_ok("status")
        .assert_contains("done");

    org.run(&["ready"])
        .assert_ok("ready")
        .assert_contains("benchmark the cache");
}

#[test]
fn status_rejects_a_name_that_is_not_a_status() {
    let org = Org::new("status-bad", "solo");
    org.seed();
    let r = org.run(&["status", "cache-tests", "finished"]);
    assert!(!r.ok());
    r.assert_contains("unknown status")
        .assert_contains("waiting");
}

#[test]
fn a_duplicate_task_id_is_refused() {
    let org = Org::new("dupe", "solo");
    org.seed();
    let r = org.run(&[
        "task",
        "add",
        "cache-tests",
        "cover the cache layer twice",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--write",
        "other/**",
        "--tokens",
        "10",
    ]);
    assert!(!r.ok(), "a duplicate id must be refused");
}

#[test]
fn sibling_scope_overlap_is_reported() {
    let org = Org::new("overlap", "solo");
    org.seed();
    let r = org.run(&[
        "task",
        "add",
        "more-tests",
        "extend the cache tests",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/**",
        "--tokens",
        "1000",
    ]);
    r.assert_contains("overlaps").assert_contains("cache-tests");
}

#[test]
fn sequenced_tasks_may_share_a_scope() {
    // Two tasks that cannot run at once are not competing for the same files, so
    // the overlap check must exempt them.
    let org = Org::new("overlap-seq", "solo");
    org.seed();
    org.run(&[
        "task",
        "add",
        "more-tests",
        "extend the cache tests",
        "--project",
        "caching",
        "--after",
        "cache-tests",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/**",
        "--tokens",
        "1000",
    ])
    .assert_ok("sequenced overlap")
    .assert_contains("admitted");
}

#[test]
fn a_chain_stays_admissible_past_its_second_link() {
    // Ordering is transitive, so the overlap exemption must be too. The third link
    // here shares the first's scope and can never run beside it.
    let org = Org::new("overlap-chain", "solo");
    org.seed();
    let add = |id: &str, after: &str, glob: &str| {
        org.run(&[
            "task",
            "add",
            id,
            "a link in the chain",
            "--project",
            "caching",
            "--after",
            after,
            "--accept-cmd",
            "cargo test",
            "--write",
            glob,
            "--tokens",
            "1000",
        ])
    };
    // Seeded: cache-tests (tests/**) <- bench. The fourth link below shares
    // cache-tests' scope, three edges upstream.
    add("link-two", "bench", "crates/two/**").assert_contains("admitted");
    add("link-three", "link-two", "tests/**")
        .assert_ok("third link")
        .assert_contains("admitted");
}

/// Declares a second repository, so a test can put two projects on different ones.
///
/// The path need not exist: nothing resolves it until a task starts, and the point
/// here is which name a project registers, not what is checked out under it.
fn second_repo(org: &Org, name: &str) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[[repos]]\nname = \"{name}\"\npath = \"~/projects/{name}\"\n"),
    )
    .unwrap();
}

/// A second project, so its tasks meet the seeded ones across a project boundary.
fn second_project(org: &Org, id: &str, repo: &str) {
    org.run(&[
        "project",
        "add",
        id,
        "cut the export payload in half",
        "--repo",
        repo,
        "--measure-cmd",
        "cargo test",
        "--tokens",
        "200000",
        "--wall",
        "1800",
    ])
    .assert_ok("add second project");
}

/// A task on `tests/**` — the paths the seeded `cache-tests` already claims.
fn claims_the_seeded_scope(org: &Org, id: &str, project: &str, after: Option<&str>) -> Run {
    let mut args = vec![
        "task",
        "add",
        id,
        "extend the export tests",
        "--project",
        project,
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/**",
        "--tokens",
        "1000",
    ];
    if let Some(dep) = after {
        args.extend_from_slice(&["--after", dep]);
    }
    org.run(&args)
}

#[test]
fn a_second_project_on_the_same_repo_may_not_claim_the_same_files() {
    // The gap using wecode on itself kept finding. A repository carries as many
    // projects as anyone starts, and the overlap check only ever looked inside one
    // of them — so both admitted a task on the same paths, and nothing said no until
    // two worktrees came back having changed the same lines.
    let org = Org::new("overlap-cross", "solo");
    org.seed();
    second_project(&org, "exports", "app");

    let r = claims_the_seeded_scope(&org, "export-tests", "exports", None);
    r.assert_contains("overlaps")
        .assert_contains("cache-tests")
        // The reader is looking at `exports` and will not find `cache-tests` on it.
        .assert_contains("caching")
        .assert_contains("not saved");
}

#[test]
fn projects_on_different_repos_do_not_collide() {
    // The control. Identical globs against different checkouts are different files,
    // and without this the check would refuse most of a company's board at once.
    let org = Org::new("overlap-cross-repos", "solo");
    org.seed();
    second_repo(&org, "other");
    second_project(&org, "exports", "other");

    claims_the_seeded_scope(&org, "export-tests", "exports", None)
        .assert_ok("different repo")
        .assert_contains("admitted")
        .assert_lacks("overlaps");
}

#[test]
fn a_dependency_across_projects_settles_a_shared_scope() {
    // The repair the message offers has to work across the boundary it reports, or
    // the only way past the gate is --force. A dependency may name any task in the
    // plan, and ordering removes the conflict the same way it does for siblings.
    let org = Org::new("overlap-cross-seq", "solo");
    org.seed();
    second_project(&org, "exports", "app");

    claims_the_seeded_scope(&org, "export-tests", "exports", Some("cache-tests"))
        .assert_ok("sequenced across projects")
        .assert_contains("admitted");
}

#[test]
fn archiving_a_project_stops_its_tasks_claiming_files() {
    // Archiving parks a project: the scheduler never dispatches from it, so its
    // tasks cannot be running while anything else is. Reporting one would say "could
    // run at the same time" about work that cannot start at all — and unarchiving is
    // all it takes to get the conflict back.
    let org = Org::new("overlap-cross-parked", "solo");
    org.seed();
    second_project(&org, "exports", "app");
    org.run(&["archive", "caching"]).assert_ok("archive");

    claims_the_seeded_scope(&org, "export-tests", "exports", None)
        .assert_ok("parked is not competition")
        .assert_contains("admitted");

    org.run(&["unarchive", "caching"]).assert_ok("unarchive");
    org.run(&["check", "export-tests"])
        .assert_contains("overlaps")
        .assert_contains("cache-tests");
}

#[test]
fn widening_a_scope_onto_another_projects_files_is_refused() {
    // `task scope` re-runs the same check, so the hole would reopen through the back
    // door if only `task add` had been widened.
    let org = Org::new("overlap-cross-scope", "solo");
    org.seed();
    second_project(&org, "exports", "app");
    org.run(&[
        "task",
        "add",
        "export-writer",
        "rewrite the export writer",
        "--project",
        "exports",
        "--accept-cmd",
        "cargo test",
        "--write",
        "crates/export/**",
        "--tokens",
        "1000",
    ])
    .assert_ok("add on its own paths")
    .assert_contains("admitted");

    org.run(&["task", "scope", "export-writer", "--write", "tests/**"])
        .assert_contains("overlaps")
        .assert_contains("caching")
        .assert_contains("not changed");
}

// -------------------------------------------------------------- design ---------

#[test]
fn a_design_that_passes_waits_for_a_signature_rather_than_finishing() {
    // Every other kind is done when its acceptance passes. A design is a proposal,
    // and whether it is the right one is exactly what no command can check.
    let (org, _) = with_agent("design-sign", "mkdir -p docs && echo proposal > docs/d.md");
    org.run(&[
        "task",
        "add",
        "d",
        "propose how threading is reconstructed",
        "--project",
        "caching",
        "--kind",
        "design",
        "--accept-cmd",
        "test -f docs/d.md",
        "--write",
        "docs/**",
        "--tokens",
        "1000",
        "--to",
        "impl",
    ])
    .assert_ok("add design");

    org.run(&["run", "d"])
        .assert_ok("run")
        .assert_contains("passed");
    org.run(&["show", "d"]).assert_contains("needs-approval");

    // Nothing downstream may treat it as settled until someone signs.
    org.run(&["approve", "design", "--task", "d"])
        .assert_ok("approve design")
        .assert_contains("needs-approval → done");
    org.run(&["show", "d"]).assert_contains("done");
}

#[test]
fn a_design_step_waits_for_its_signature_even_though_it_is_a_subtask() {
    // The exception to a step finishing when it passes, and it is there for the other
    // reason: a step has nothing of its own to land, but a design has nothing landing
    // would settle. The document exists — all a command can check — and whether it is
    // the right design is exactly the part no command can. The steps built on it must
    // not start on the strength of a file being present.
    let (org, _) = with_agent("design-step", "mkdir -p docs && echo proposal > docs/d.md");
    org.run(&[
        "task",
        "add",
        "threading",
        "reconstruct threading in the export writer",
        "--project",
        "caching",
        "--kind",
        "chore",
        "--accept-cmd",
        "true",
        "--write",
        "src/**",
        "--tokens",
        "1000",
        "--to",
        "impl",
    ])
    .assert_ok("main task");
    org.run(&[
        "task",
        "add",
        "threading-design",
        "propose how threading is reconstructed",
        "--project",
        "caching",
        "--kind",
        "design",
        "--parent",
        "threading",
        "--accept-cmd",
        "test -f docs/d.md",
        "--write",
        "docs/**",
        "--tokens",
        "1000",
        "--to",
        "impl",
    ])
    .assert_ok("design step");

    org.run(&["run", "threading-design"])
        .assert_ok("run")
        .assert_contains("passed")
        .assert_contains("passing is not approval");
    org.run(&["show", "threading-design"])
        .assert_contains("status     needs-approval");
    org.run(&["approve", "design", "--task", "threading-design"])
        .assert_ok("sign")
        .assert_contains("needs-approval → done");
}

#[test]
fn only_a_design_is_signed_off_that_way() {
    let (org, _) = with_agent("design-wrong-kind", "true");
    a_task(&org, "t", "src/**", "true");
    let r = org.run(&["approve", "design", "--task", "t"]);
    assert!(!r.ok(), "a feature must not be signed off as a design");
    r.assert_contains("only a design is signed");
}

// ------------------------------------------------------------- task rm ---------

#[test]
fn a_task_that_never_ran_can_be_removed_outright() {
    // Distinct from dropping it. Dropping records a judgement; removing says the task
    // should not have existed, and leaving those on the board makes it a graveyard.
    let org = Org::new("task-rm", "solo");
    org.seed();
    org.run(&["task", "rm", "bench"])
        .assert_ok("rm")
        .assert_contains("removed bench");
    org.run(&["tree"]).assert_lacks("bench");

    // The ledger is not rewritten — that is the one thing an audit log must not do.
    org.run(&["audit", "--task", "bench"])
        .assert_ok("audit")
        .assert_contains("define");
}

#[test]
fn removing_a_task_something_waits_on_is_refused() {
    // Seeded: `bench` waits on `cache-tests`.
    let org = Org::new("task-rm-dep", "solo");
    org.seed();

    let r = org.run(&["task", "rm", "cache-tests"]);
    assert!(!r.ok(), "removing a prerequisite must be refused");
    r.assert_contains("waited on by bench");
    // Refused, not half-done.
    org.run(&["tree"]).assert_contains("cache-tests");
}

#[test]
fn a_task_that_ran_is_history_and_cannot_be_removed() {
    let (org, _) = with_agent("task-rm-ran", "true");
    a_task(&org, "t", "src/**", "true");
    org.run(&["run", "t"]).assert_ok("run");

    let r = org.run(&["task", "rm", "t"]);
    assert!(!r.ok(), "a task with an execution must not be removable");
    r.assert_contains("it ran, so it is history");
}

// --------------------------------------------------------------- assign --------

#[test]
fn assign_refuses_a_post_whose_scope_cannot_cover_the_work() {
    let org = Org::new("assign-scope", "software-company");
    org.seed();

    // cache-tests writes tests/**; the engineer writes src/crates/lib.
    let r = org.run(&["assign", "cache-tests", "--to", "impl"]);
    assert!(!r.ok(), "should be refused");
    r.assert_contains("may not write")
        .assert_contains("tests/**");

    // The tester can.
    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign to tester")
        .assert_contains("assigned")
        .assert_contains("codex");
}

#[test]
fn assigning_a_dependent_task_says_what_it_waits_on() {
    let org = Org::new("assign-waits", "software-company");
    org.seed();
    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign")
        .assert_contains("waiting")
        .assert_contains("cache-tests");
}

#[test]
fn dropping_a_prerequisite_flags_the_chain_it_strands() {
    // bench waits on cache-tests. Drop the prerequisite and bench can never
    // advance on its own — no tick promotes it, no agent is dispatched to it.
    // Every surface has to say so, or the chain sits green until someone digs.
    let org = Org::new("stuck-chain", "software-company");
    org.seed();
    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign");

    // Flagged at the moment of the act, when reconsidering is still cheap.
    org.run(&["status", "cache-tests", "dropped"])
        .assert_ok("drop")
        .assert_contains("now stuck behind it: bench");

    org.run(&["board"])
        .assert_ok("board")
        .assert_contains("stuck on cache-tests (dropped)")
        .assert_contains("1 stuck");
    org.run(&["ready"])
        .assert_ok("ready")
        .assert_contains("stuck on failed or dropped work");
    org.run(&["show", "bench"])
        .assert_ok("show")
        .assert_contains("will not finish on its own");

    // Reopening the prerequisite is exactly how the operator resolves it, so the
    // flag must come down by itself.
    org.run(&["status", "cache-tests", "waiting"])
        .assert_ok("reopen");
    org.run(&["ready"]).assert_ok("ready").assert_lacks("stuck");
    org.run(&["board"]).assert_ok("board").assert_lacks("stuck");
}

#[test]
fn a_defective_task_cannot_be_dispatched() {
    let org = Org::new("assign-draft", "software-company");
    org.seed();
    org.run(&[
        "task",
        "add",
        "vague",
        "make it faster",
        "--project",
        "caching",
        "--force",
    ])
    .assert_ok("forced");
    org.run(&["assign", "vague", "--to", "test"])
        .assert_contains("not assigned")
        .assert_contains("cannot be dispatched");
}

#[test]
fn assign_names_the_available_posts_when_given_a_bad_one() {
    let org = Org::new("assign-post", "software-company");
    org.seed();
    let r = org.run(&["assign", "cache-tests", "--to", "nobody"]);
    assert!(!r.ok());
    r.assert_contains("no such post").assert_contains("chief");
}
