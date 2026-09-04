//! The plan: projects, tasks, the two relations between them, and admission.
//!
//! Everything here is about what may be written down before anything runs, which is
//! where a scope collision, a stranded chain, or a task nobody can be assigned has
//! to be caught. Removing and assigning work belong here too: both are decisions
//! about the plan rather than about a run.

mod support;

use support::agent::{a_task, a_task_in_src, signs_first, with_agent};
use support::playbook::with_playbook;
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
    org.run(&["project", "add", "speedup", "make the export faster", "--repo", "app",
              "--force"])
        .assert_ok("forced add").assert_contains("forced").assert_contains("saved");
    org.run(&["tree"]).assert_contains("speedup");
}

#[test]
fn a_project_must_name_a_repo_the_company_knows() {
    let org = Org::new("repo-unknown", "solo");
    let r = org.run(&["project", "add", "x", "add response caching to the export endpoint",
                      "--repo", "nonexistent", "--measure-cmd", "cargo test",
                      "--tokens", "100"]);
    r.assert_contains("not admitted").assert_contains("app");
}

#[test]
fn a_task_needs_a_project_that_exists() {
    let org = Org::new("task-orphan", "solo");
    let r = org.run(&["task", "add", "t", "do the thing", "--project", "ghost",
                      "--accept-cmd", "cargo test", "--write", "src/**",
                      "--tokens", "10"]);
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
    org.run(&["task", "add", "s", "investigate the eviction strategies",
              "--project", "caching", "--kind", "spike", "--accept-cmd", "cargo test",
              "--tokens", "10"])
        .assert_ok("spike").assert_contains("admitted").assert_contains("saved");
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
fn a_design_step_is_prepared_in_the_projects_own_checkout() {
    // `parent` decides which tree a task works in, and the design is the one kind it
    // does not decide for: what finishes a design is a person reading the document and
    // signing it. Filed under a chore — which does own a tree here — the design was
    // prepared on that chore's branch, under the run root, so the decision the plan was
    // waiting on sat somewhere the signer could not read without checking it out.
    let (org, repo) = with_playbook("design-checkout");
    org.run(&["task", "add", "f", "add response caching to the export endpoint",
              "--project", "caching", "--kind", "chore", "--write", "src/**",
              "--accept-cmd", "true", "--tokens", "100", "--wall", "30", "--to", "impl"])
        .assert_ok("the main task, which owns a tree");
    org.run(&["task", "add", "d", "decide the cache key format", "--project", "caching",
              "--kind", "design", "--parent", "f", "--write", "docs/wecode/d/design.md",
              "--accept-cmd", "true", "--tokens", "100", "--wall", "30", "--to", "impl"])
        .assert_ok("the design step under it");

    org.run(&["start", "d"])
        .assert_ok("start the design")
        // The kind asked is the design's own, and the answer is the project's checkout.
        .assert_contains("no worktree — the design playbook does not ask for one")
        .assert_contains(&format!("work in {}", repo.display()))
        .assert_lacks("wecode/f");
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
///
/// Forced: one repo carries one live project at a time, and these tests are about
/// what happens between the tasks of two an operator insisted on anyway.
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
        "--force",
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

#[test]
fn a_repo_carries_one_live_project_at_a_time() {
    // The project-level gate the tests above step over with --force: a repository is
    // one integration branch and one playbook, and a second live project on it is a
    // second owner for both. Archiving parks the holder, and the refusal names it
    // because the repair is done to it.
    let org = Org::new("one-per-repo", "solo");
    org.seed();
    let add = &["project", "add", "exports", "cut the export payload in half",
                "--repo", "app", "--measure-cmd", "cargo test",
                "--tokens", "1000", "--wall", "60"];
    org.run(add)
        .assert_ok("a refusal is a verdict, not an error")
        .assert_contains("not admitted")
        .assert_contains("caching")
        .assert_contains("not saved");

    org.run(&["archive", "caching"]).assert_ok("archive");
    org.run(add)
        .assert_ok("the archived holder freed its repo")
        .assert_contains("admitted")
        .assert_contains("saved");
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

// ----------------------------------------------------------- task budget -------

#[test]
fn a_budget_is_raised_on_the_task_that_ran_rather_than_on_a_new_one() {
    // The whole point. `task rm` is the way a task used to be re-declared, and it is
    // refused once anything real has happened — which is exactly when a budget turns
    // out to have been short.
    let (org, _) = with_agent("budget-amend", "true");
    a_task(&org, "t", "src/**", "true");
    org.run(&["run", "t"]).assert_ok("run");

    let r = org.run(&["task", "rm", "t"]);
    assert!(!r.ok(), "the old way out is closed once a task has run");
    r.assert_contains("it ran, so it is history");

    org.run(&["task", "budget", "t", "--tokens", "400000", "--wall", "900"])
        .assert_ok("raise")
        .assert_contains("was  100 tokens, 30s wall")
        .assert_contains("now  400000 tokens, 900s wall");

    org.run(&["show", "t"])
        .assert_ok("show")
        .assert_contains("budget     400000 tokens")
        .assert_contains("wall       900s");

    // Still the same task, so what the earlier run spent is still filed under it.
    org.run(&["audit", "--task", "t"])
        .assert_ok("audit")
        .assert_contains("spend");
}

#[test]
fn each_figure_is_amended_on_its_own() {
    // Unlike a scope, which is replaced whole. An unstated wall is the agent
    // template's, not zero, so a --tokens raise that dropped it would be a second
    // change nobody asked for.
    let org = Org::new("budget-one-figure", "solo");
    org.seed();

    org.run(&["task", "budget", "cache-tests", "--wall", "900"])
        .assert_ok("state a wall where there was none")
        .assert_contains("was  50000 tokens, — wall")
        .assert_contains("now  50000 tokens, 900s wall");
    org.run(&["task", "budget", "cache-tests", "--tokens", "400000"])
        .assert_ok("raise the tokens alone")
        .assert_contains("now  400000 tokens, 900s wall");

    org.run(&["show", "cache-tests"])
        .assert_ok("show")
        .assert_contains("budget     400000 tokens")
        .assert_contains("wall       900s");
}

#[test]
fn a_figure_that_is_not_a_number_is_refused_rather_than_ignored() {
    // The silent failure this guards: a budget left exactly as it was, under a message
    // saying it had been raised.
    let org = Org::new("budget-bad-figure", "solo");
    org.seed();

    let nothing = org.run(&["task", "budget", "cache-tests"]);
    assert!(!nothing.ok(), "an amendment that says nothing is not one");
    nothing.assert_contains("--tokens");

    let bad = org.run(&["task", "budget", "cache-tests", "--tokens", "200k"]);
    assert!(!bad.ok(), "`200k` is not a number of tokens");
    bad.assert_contains("wants a number");

    org.run(&["show", "cache-tests"])
        .assert_contains("budget     50000 tokens");
}

#[test]
fn raising_a_budget_after_a_signature_asks_for_it_again() {
    // A signature given to a task budgeted at 100 tokens did not cover the same task
    // with four hundred thousand to spend, so the amendment has to retract it — the
    // same rule `task scope` is held to, through the same `define` record.
    let org = signs_first("budget-signed", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign");

    org.run(&["task", "budget", "t", "--tokens", "400000"])
        .assert_ok("raise");
    let r = org.run(&["run", "t"]);
    assert!(!r.ok(), "the signature was for the cheaper task");
    r.assert_contains("was changed after it was signed")
        .assert_contains("wecode approve admission --task t");

    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign what it is now");
    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
}

#[test]
fn a_failed_task_is_told_what_puts_it_back_in_the_queue() {
    // Nothing moves a failed task on its own, so a raised budget sitting on one is a
    // command that looks like it worked and changes nothing.
    let org = Org::new("budget-failed", "solo");
    org.seed();
    org.run(&["status", "cache-tests", "failed"])
        .assert_ok("fail it");

    org.run(&["task", "budget", "cache-tests", "--tokens", "400000"])
        .assert_ok("raise")
        .assert_contains("wecode status cache-tests waiting");
}

// ------------------------------------------------------- task add --amend ------

/// A task to group the seeded work under. Written by hand rather than through
/// [`Org::seed`] because a sprint is exactly what nobody thinks of until the items
/// already exist.
fn a_sprint(org: &Org, id: &str) {
    org.run(&[
        "task",
        "add",
        id,
        "land the caching work on one branch",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--write",
        "docs/sprint/**",
        "--tokens",
        "1000",
    ])
    .assert_ok("add the sprint");
}

#[test]
fn a_task_joins_a_sprint_and_leaves_it_again_without_being_recreated() {
    // Sprint planning as it actually happens: the items are written down first, and
    // what belongs together is noticed afterwards.
    let org = Org::new("amend-join", "solo");
    org.seed();
    a_sprint(&org, "cache-sprint");

    org.run(&[
        "task",
        "add",
        "cache-tests",
        "--amend",
        "--parent",
        "cache-sprint",
    ])
    .assert_ok("join the sprint")
    .assert_contains("was  top level, after nothing")
    .assert_contains("now  in cache-sprint, after nothing")
    // Being part of something is not waiting for it, here as everywhere else.
    .assert_lacks("waiting:");
    org.run(&["show", "cache-tests"])
        .assert_ok("show")
        .assert_contains("part of    cache-sprint");

    org.run(&["task", "add", "cache-tests", "--amend", "--top"])
        .assert_ok("leave the sprint")
        .assert_contains("now  top level, after nothing");
    org.run(&["show", "cache-tests"]).assert_lacks("part of");
}

#[test]
fn an_ordering_can_be_declared_after_both_tasks_exist() {
    // Nothing could do this before: `--after` was readable only at creation, so a
    // sequence discovered later meant retyping the task under a new id.
    let org = Org::new("amend-after", "solo");
    org.seed();
    org.run(&[
        "task",
        "add",
        "cache-docs",
        "write up the cache eviction rules",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--write",
        "docs/cache/**",
        "--tokens",
        "1000",
    ])
    .assert_ok("a task nobody sequenced");
    org.run(&["show", "cache-docs"])
        .assert_lacks("must come after");

    org.run(&["task", "add", "cache-docs", "--amend", "--after", "bench"])
        .assert_ok("sequence it")
        .assert_contains("now  top level, after bench")
        .assert_contains("waiting: bench is not done");
    org.run(&["show", "cache-docs"])
        .assert_contains("must come after")
        .assert_contains("bench");

    // Replaced whole, so the way back is saying so out loud.
    org.run(&["task", "add", "cache-docs", "--amend", "--no-after"])
        .assert_ok("unsequence it")
        .assert_contains("now  top level, after nothing");
    org.run(&["show", "cache-docs"])
        .assert_lacks("must come after");
}

#[test]
fn dropping_an_ordering_that_kept_two_scopes_apart_is_refused() {
    // The seeded `bench` writes under `tests/`, which `cache-tests` already claims —
    // legal only because it is sequenced after it. Removing the ordering puts the
    // collision back, and the check that caught it at `task add` has to catch it here
    // or the gate has a back door.
    let org = Org::new("amend-overlap", "solo");
    org.seed();

    org.run(&["task", "add", "bench", "--amend", "--no-after"])
        .assert_ok("the command itself succeeds")
        .assert_contains("overlaps")
        .assert_contains("cache-tests")
        .assert_contains("not moved");
    // Refused, not half-done.
    org.run(&["show", "bench"]).assert_contains("cache-tests");

    org.run(&["task", "add", "bench", "--amend", "--no-after", "--force"])
        .assert_ok("forced")
        .assert_contains("now  top level, after nothing");
}

#[test]
fn a_move_that_would_loop_is_refused_and_changes_nothing() {
    let org = Org::new("amend-loop", "solo");
    org.seed();
    a_sprint(&org, "cache-sprint");
    org.run(&[
        "task",
        "add",
        "cache-tests",
        "--amend",
        "--parent",
        "cache-sprint",
    ])
    .assert_ok("join");

    let r = org.run(&[
        "task",
        "add",
        "cache-sprint",
        "--amend",
        "--parent",
        "cache-tests",
    ]);
    assert!(!r.ok(), "a sprint may not be part of its own item");
    r.assert_contains("subtask loop");
    org.run(&["show", "cache-tests"])
        .assert_contains("part of    cache-sprint");

    // And an ordering that loops, which is the other relation and a separate check.
    let dep = org.run(&["task", "add", "cache-tests", "--amend", "--after", "bench"]);
    assert!(!dep.ok(), "bench already comes after cache-tests");
    dep.assert_contains("dependency loop");
}

#[test]
fn an_amendment_has_to_say_what_it_changes() {
    let org = Org::new("amend-empty", "solo");
    org.seed();

    let nothing = org.run(&["task", "add", "cache-tests", "--amend"]);
    assert!(!nothing.ok(), "an amendment that says nothing is not one");
    nothing.assert_contains("--parent").assert_contains("--top");

    // Silence leaves a relation alone, so clearing one has its own flag — and naming
    // both at once is a contradiction rather than a precedence puzzle.
    for argv in [
        vec![
            "task",
            "add",
            "cache-tests",
            "--amend",
            "--parent",
            "bench",
            "--top",
        ],
        vec![
            "task",
            "add",
            "bench",
            "--amend",
            "--after",
            "cache-tests",
            "--no-after",
        ],
    ] {
        let r = org.run(&argv);
        assert!(!r.ok(), "{argv:?} should be refused");
        r.assert_contains("opposite things");
    }
}

#[test]
fn adding_a_task_whose_id_is_taken_says_what_moves_it_instead() {
    // Where the amendment is discovered: the wall an operator hits is retyping the
    // declaration, and the refusal is the only thing they read at that moment.
    let org = Org::new("amend-taken", "solo");
    org.seed();

    let r = org.run(&[
        "task",
        "add",
        "cache-tests",
        "cover the cache layer with tests",
        "--project",
        "caching",
        "--parent",
        "bench",
    ]);
    assert!(!r.ok(), "a taken id is not a new task");
    r.assert_contains("already exists")
        .assert_contains("--amend");
}

#[test]
fn a_task_that_has_run_is_regrouped_rather_than_recreated() {
    // The whole point, and the same wall `task budget` was built against: `task rm` is
    // refused the moment a task has run, which is exactly when a grouping turns out to
    // have been wrong.
    let (org, _) = with_agent("amend-ran", "true");
    a_task(&org, "t", "src/**", "true");
    org.run(&["run", "t"]).assert_ok("run");
    a_sprint(&org, "sprint");

    let r = org.run(&["task", "rm", "t"]);
    assert!(!r.ok(), "the old way out is closed once a task has run");
    r.assert_contains("it ran, so it is history");

    org.run(&["task", "add", "t", "--amend", "--parent", "sprint"])
        .assert_ok("regroup it")
        .assert_contains("now  in sprint, after nothing")
        // `parent` is what decides the worktree, so a move is also a change of branch.
        .assert_contains("wecode/sprint")
        .assert_contains("stays on the branch they landed on");

    // Still the same task, so what the earlier run spent is still filed under it.
    org.run(&["audit", "--task", "t"])
        .assert_ok("audit")
        .assert_contains("spend");
}

#[test]
fn a_running_task_keeps_the_worktree_it_started_in() {
    // The one refusal that is about a process rather than about the plan: moving the
    // group moves the checkout, and there is a run standing in it.
    let org = Org::new("amend-running", "solo");
    org.seed();
    a_sprint(&org, "cache-sprint");
    org.run(&["status", "cache-tests", "running"])
        .assert_ok("mark it running");

    let r = org.run(&[
        "task",
        "add",
        "cache-tests",
        "--amend",
        "--parent",
        "cache-sprint",
    ]);
    assert!(!r.ok(), "a run may not have its tree moved under it");
    r.assert_contains("keeps the worktree it started in")
        .assert_contains("wecode status cache-tests waiting");

    // The ordering is read on the next scan, not by the run in flight, so it may move.
    org.run(&[
        "task",
        "add",
        "cache-tests",
        "--amend",
        "--after",
        "cache-sprint",
    ])
    .assert_ok("an ordering is not a checkout");
}

#[test]
fn moving_a_sprint_is_refused_while_something_inside_it_is_running() {
    // The case a status check on the named task alone walks straight past: the sprint is
    // not running, the item in it is, and moving the sprint re-roots the item too. It
    // matters because nothing holds a run to the path it started in — `verify` asks for
    // the worktree by owner again when the run is done, and a task re-rooted under one
    // nobody cut falls back to judging the project's own checkout instead of the work.
    let org = Org::new("amend-running-child", "solo");
    org.seed();
    a_sprint(&org, "cache-sprint");
    org.run(&[
        "task",
        "add",
        "cache-tests",
        "--amend",
        "--parent",
        "cache-sprint",
    ])
    .assert_ok("join the sprint");
    org.run(&["status", "cache-tests", "running"])
        .assert_ok("mark the item running");
    org.run(&[
        "task",
        "add",
        "outer",
        "hold the whole caching effort",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--write",
        "docs/outer/**",
        "--tokens",
        "1000",
    ])
    .assert_ok("a sprint to move the sprint into");

    let r = org.run(&[
        "task",
        "add",
        "cache-sprint",
        "--amend",
        "--parent",
        "outer",
    ]);
    assert!(!r.ok(), "the item inside it is standing in the worktree");
    // Named by the run that holds the tree open, not by the task that was typed.
    r.assert_contains("cache-tests")
        .assert_contains("keeps the worktree it started in")
        .assert_contains("wecode status cache-tests waiting");
    org.run(&["show", "cache-sprint"])
        .assert_lacks("part of    outer");
}

#[test]
fn a_move_that_leaves_the_worktree_where_it_is_goes_through() {
    // The refusal asks whose worktree would change, not who is running, so a move
    // inside a chain is not held up by a run: the root is the same before and after,
    // and the checkout it names never moves.
    let org = Org::new("amend-running-within", "solo");
    org.seed();
    a_sprint(&org, "cache-sprint");
    org.run(&[
        "task",
        "add",
        "cache-step",
        "one step of the sprint",
        "--project",
        "caching",
        "--parent",
        "cache-sprint",
        "--accept-cmd",
        "cargo test",
        "--write",
        "docs/step/**",
        "--tokens",
        "1000",
    ])
    .assert_ok("a step in the sprint");
    org.run(&[
        "task",
        "add",
        "cache-tests",
        "--amend",
        "--parent",
        "cache-sprint",
    ])
    .assert_ok("join the sprint");
    org.run(&["status", "cache-tests", "running"])
        .assert_ok("mark it running");

    // Still owned by cache-sprint either way, so the tree under the run does not move.
    org.run(&[
        "task",
        "add",
        "cache-tests",
        "--amend",
        "--parent",
        "cache-step",
    ])
    .assert_ok("regroup within the same worktree")
    .assert_contains("now  in cache-step, after nothing")
    .assert_lacks("worktree");
    org.run(&["show", "cache-tests"])
        .assert_contains("part of    cache-sprint / cache-step / cache-tests");
}

#[test]
fn moving_a_signed_task_asks_for_the_signature_again() {
    // A signature given to a task that was going to ship on its own did not cover the
    // same task shipping inside a sprint, on a different branch. The same rule
    // `task scope` and `task budget` are held to, through the same `define` record.
    let org = signs_first("amend-signed", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    a_sprint(&org, "sprint");
    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign");

    org.run(&["task", "add", "t", "--amend", "--parent", "sprint"])
        .assert_ok("move it");
    let r = org.run(&["run", "t"]);
    assert!(!r.ok(), "the signature was for the task standing alone");
    r.assert_contains("was changed after it was signed");

    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign what it is now");
    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
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

// ------------------------------------------------------------- advisory --------

#[test]
fn a_task_the_playbook_would_not_have_written_is_told_so_and_still_admitted() {
    // The second verdict. Every departure here is legal — an acceptance command of
    // one's own, a smaller budget, another post — so the gate is structurally unable
    // to mention it, and each was typed over guidance already there: `task add` fills
    // only what a declaration leaves blank, which is why `--tokens` alone takes the
    // wall limit off too. A case per divergence is in core; this is the wiring.
    let (org, _) = with_playbook("advise");
    let add = |id: &str, scope: &str, extra: &[&str]| {
        let mut v = vec!["task", "add", id, "the export returns a stale body",
                         "--project", "caching", "--kind", "bug", "--write", scope];
        v.extend_from_slice(extra);
        org.run(&v)
    };
    add("stale", "src/**", &["--accept-cmd", "cargo test -p export", "--tokens", "100", "--to", "chief"])
        .assert_ok("a legal task").assert_contains("saved task stale")
        .assert_contains("would have written this differently")
        .assert_contains("`true` is how this project accepts")
        .assert_contains("100 tokens, under the 1000").assert_contains("done by `impl`")
        .assert_contains("60 seconds of wall time and this task declares none")
        .assert_contains("advisory — nothing is refused");
    org.run(&["check", "stale"]).assert_ok("check").assert_contains("✓ admitted");
    // The control that matters most for a warning: a declaration that states nothing
    // takes all of it from the playbook, so there is nothing to say about it.
    add("quiet", "docs/**", &[]).assert_ok("add").assert_lacks("would have written");
}

// ------------------------------------------------------------------ doer -------

#[test]
fn who_does_the_work_is_recorded() {
    // The flag parses here and nowhere else, so a typo has to be named as a typo: an
    // operator who wrote `--by prson` is owed that, not a lecture about a column.
    let org = Org::new("by-doer", "solo");
    org.seed();
    let add = |id: &str, by: &str| {
        org.run(&["task", "add", id, "mint the API token", "--project", "caching",
                  "--by", by])
    };
    add("mint", "nobody").assert_contains("unknown doer `nobody`")
        .assert_contains("manual").assert_lacks("cannot be recorded");

    // The column landed (manual-task-store) and the guard came out as its own comment
    // ordered, so every word an operator reaches for now records: the task saves, no
    // agent is dispatched, and the tree says whose it is.
    add("mint", "person").assert_ok("a person's task")
        .assert_contains("saved task mint");
    org.run(&["tree"]).assert_contains("mint");

    // The default is untouched, and saying it out loud changes nothing.
    org.run(&["task", "add", "mint-auto", "mint the API token", "--project", "caching",
              "--by", "agent", "--write", "src/mint/**", "--accept-cmd", "cargo test",
              "--tokens", "1000"])
        .assert_ok("an agent's task").assert_contains("saved task mint-auto");
}

// ---------------------------------------------------------- requirements -------

/// A project with a story under it, ready to be given obligations.
fn a_story(name: &str) -> Org {
    let org = Org::new(name, "solo");
    org.seed();
    org.run(&["task", "add", "reply-story", "answer a task from a chat reply",
              "--project", "caching", "--kind", "story"])
        .assert_ok("add story");
    org
}

#[test]
fn a_story_states_what_it_owes_and_the_store_keeps_it() {
    let org = a_story("req-stated");
    // The handle is minted, never typed: two people asked to name FR-1 name it twice.
    org.run(&["task", "add", "reply-story", "--amend", "--requirement",
              "a reply naming a task by number signs it"])
        .assert_ok("state one")
        .assert_contains("reply-story/FR-1");
    org.run(&["task", "add", "reply-story", "--amend", "--nfr", "--requirement",
              "a reply is answered inside two seconds"])
        .assert_ok("state another")
        .assert_contains("reply-story/NFR-1");

    // Read back off the ledger rather than out of the command that wrote it.
    org.run(&["check", "reply-story"])
        .assert_ok("check the story")
        .assert_contains("what this story owes")
        .assert_contains("reply-story/FR-1")
        .assert_contains("a reply naming a task by number signs it")
        .assert_contains("reply-story/NFR-1");

    // And it is a row in the ledger, with the keys that correlate it.
    org.run(&["audit", "--task", "reply-story"])
        .assert_ok("audit")
        .assert_contains("require")
        .assert_contains("reply-story/FR-1");
}

#[test]
fn a_story_owing_nothing_is_asked_what_it_owes() {
    // Not a refusal: a story is created before anybody has written its obligations
    // down, and refusing it would only teach people to type a placeholder.
    let org = a_story("req-empty");
    org.run(&["check", "reply-story"])
        .assert_ok("check")
        .assert_contains("What must be true for this story to be done?");
}

#[test]
fn a_task_serves_an_obligation_and_holds_it_open_until_it_is_done() {
    let org = a_story("req-served");
    org.run(&["task", "add", "reply-story", "--amend", "--requirement",
              "a reply naming a task by number signs it"])
        .assert_ok("state one");
    org.run(&["task", "add", "reply-parse", "parse a chat reply into a task id",
              "--project", "caching", "--parent", "reply-story",
              "--accept-cmd", "cargo test", "--write", "src/reply/**",
              "--tokens", "5000", "--requirement", "reply-story/FR-1"])
        .assert_ok("serve it")
        .assert_contains("serves    reply-story/FR-1");

    // Open while an attempt is unfinished — the reset rule, derived rather than stored.
    org.run(&["check", "reply-story"]).assert_contains("open")
        .assert_contains("1 attempt: reply-parse");
    org.run(&["status", "reply-parse", "done"]).assert_ok("finish it");
    org.run(&["check", "reply-story"]).assert_contains("met");

    // The task's own side of the join: what it answers to.
    org.run(&["check", "reply-parse"])
        .assert_contains("the obligations this task answers to")
        .assert_contains("reply-story/FR-1");
}

#[test]
fn a_handle_no_story_stated_is_refused_before_the_task_is_written() {
    let org = a_story("req-unknown");
    org.run(&["task", "add", "reply-story", "--amend", "--requirement",
              "a reply naming a task by number signs it"])
        .assert_ok("state one");
    let r = org.run(&["task", "add", "typo", "do the thing", "--project", "caching",
                      "--accept-cmd", "cargo test", "--write", "docs/**",
                      "--tokens", "100", "--requirement", "reply-story/FR-9"]);
    assert!(!r.ok(), "a stale handle is refused");
    r.assert_contains("reply-story/FR-9").assert_contains("reply-story/FR-1");
    // Nothing was written: a task pointing at an obligation nobody stated is a row
    // the operator would otherwise have to find and unpick.
    org.run(&["tree"]).assert_lacks("typo");
}

