//! Templated guidance: the subtasks it emits, and the design it can insist on.
//!
//! Both sit on the same fixture — a playbook that decomposes a feature — because a
//! gate satisfied by the expansion is the point of having one.

mod support;

use std::path::PathBuf;

use support::Org;

// --------------------------------------------------------------- expand ------

/// A playbook that templates a feature. The scopes stay under `src/` so the solo
/// template's engineer can reach them — an expansion nobody can be assigned would
/// prove the wrong thing.
const TEMPLATED: &str = r#"
[project]
language = "rust"

[feature]
worktree  = true
assign_to = "impl"
accept    = ["true"]
tokens    = 1000
wall_secs = 60
subtasks  = ["design", "build"]
guidance  = "A feature here is a design, then the code."

[feature.design]
kind   = "design"
title  = "decide how {{task}} should work"
write  = ["src/design/{{task}}.md"]
accept = ["test -f src/design/{{task}}.md"]

[feature.build]
after  = ["design"]
write  = ["src/{{task}}/**"]

[design]
worktree  = false
assign_to = "impl"
tokens    = 500
wall_secs = 30

[chore]
worktree  = true
assign_to = "impl"
accept    = ["true"]
tokens    = 1000
wall_secs = 60
guidance  = "One task. Nothing to break down."
"#;

/// The same workspace `with_playbook` builds, over a playbook that templates.
fn with_template(name: &str) -> (Org, PathBuf) {
    let org = Org::new(name, "solo");
    let repo = org.repo();
    org.playbook(&repo, TEMPLATED);
    org.run(&[
        "project",
        "add",
        "caching",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "1000",
        "--wall",
        "60",
    ])
    .assert_ok("add project");
    (org, repo)
}

const EXPANDABLE: &[&str] = &[
    "task",
    "add",
    "retry",
    "--project",
    "caching",
    "retry a failed task once",
    "--write",
    "src/**",
];

#[test]
fn expand_emits_the_subtasks_the_playbook_declares() {
    let (org, _) = with_template("exp-emits");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("task add --expand")
        .assert_contains("expanded retry into 2 subtasks")
        .assert_contains("retry-design")
        .assert_contains("retry-build")
        .assert_contains("after retry-design");

    // Each is an ordinary task, with the placeholders resolved.
    org.run(&["show", "retry-design"])
        .assert_ok("show the design subtask")
        .assert_contains("decide how retry should work")
        .assert_contains("src/design/retry.md")
        // The step named its own kind; the budget came from [design].
        .assert_contains("design");

    org.run(&["show", "retry-build"])
        .assert_ok("show the build subtask")
        .assert_contains("src/retry/**")
        // `after` names a sibling in the playbook and a task id in the plan.
        .assert_contains("retry-design");

    // Part of the main task, and both assigned — a template that produced drafts
    // nobody could pick up would be a worse version of typing them out.
    org.run(&["tree"])
        .assert_ok("tree")
        .assert_contains("retry-design")
        .assert_contains("retry-build");
}

#[test]
fn the_playbook_shows_what_expand_would_emit() {
    // An orchestrator reads this before decomposing, so a decomposition the project
    // has already decided must be visible without opening the file.
    let (org, _) = with_template("exp-shown");
    org.run(&["playbook", "feature"])
        .assert_ok("playbook feature")
        .assert_contains("expand    design → build")
        .assert_contains("src/design/{{task}}.md")
        .assert_contains("after design");

    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("--expand emits subtasks for: feature");

    // A kind that templates nothing says nothing about it.
    org.run(&["playbook", "chore"])
        .assert_ok("playbook chore")
        .assert_lacks("expand");
}

#[test]
fn an_expansion_is_ordered_so_only_the_first_step_is_startable() {
    let (org, _) = with_template("exp-order");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv).assert_ok("task add --expand");
    org.run(&["tick"]).assert_ok("tick");

    org.run(&["ready"])
        .assert_ok("ready")
        .assert_contains("retry-design")
        .assert_lacks("retry-build");
}

#[test]
fn expand_is_refused_when_the_playbook_declares_no_subtasks() {
    // Nothing is created: a main task saved beside an expansion that silently did
    // nothing is the failure mode this refusal exists for.
    let (org, _) = with_template("exp-none");
    let refused = org.run(&[
        "task",
        "add",
        "tidy-up",
        "--project",
        "caching",
        "--kind",
        "chore",
        "delete the unused export helper",
        "--write",
        "src/**",
        "--expand",
    ]);
    assert!(!refused.ok(), "should refuse: {}", refused.all());
    refused
        .assert_contains("no subtasks for `chore`")
        .assert_contains("wecode playbook chore");

    let shown = org.run(&["show", "tidy-up"]);
    assert!(!shown.ok(), "nothing should have been created");
}

#[test]
fn a_step_whose_kind_the_playbook_omits_refuses_the_whole_expansion() {
    // All or nothing. A half-built expansion leaves the later steps depending on
    // tasks that were never created, which is worse than creating none.
    let (org, repo) = with_template("exp-partial");
    org.playbook(&repo, &TEMPLATED.replace("[design]\n", "[refactor]\n"));

    let out = org.run(&{
        let mut argv = EXPANDABLE.to_vec();
        argv.push("--expand");
        argv
    });
    out.assert_ok("the main task still admits")
        .assert_contains("saved task retry")
        .assert_contains("not expanded")
        .assert_contains("[design] has no section");

    for id in ["retry-design", "retry-build"] {
        assert!(!org.run(&["show", id]).ok(), "{id} should not exist");
    }
}

#[test]
fn expanding_onto_ids_that_exist_creates_none_of_it() {
    // The ids are derived, so one can already be held by a task nobody meant to
    // collide with. Refused as a whole and named, rather than raised on the first
    // collision with the rest of the expansion left unstated.
    let (org, _) = with_template("exp-taken");
    org.run(&[
        "task",
        "add",
        "retry-design",
        "--project",
        "caching",
        "sketch the retry state machine",
        "--write",
        "crates/notes/**",
    ])
    .assert_ok("a task that happens to hold the id");

    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("a collision is a verdict, not a crash")
        .assert_contains("saved task retry")
        .assert_contains("not expanded")
        .assert_contains("retry-design already exists")
        .assert_contains("wecode task rm");
}

#[test]
fn a_defective_main_task_expands_into_nothing() {
    let (org, _) = with_template("exp-defective");
    org.run(&[
        "task",
        "add",
        "retry",
        "--project",
        "caching",
        // Two outcomes in one title: the gate refuses it.
        "retry a failed task and report why",
        "--write",
        "src/**",
        "--expand",
    ])
    .assert_ok("refusal is not an error")
    .assert_contains("not saved")
    .assert_contains("nothing was expanded either");

    assert!(!org.run(&["show", "retry-design"]).ok());
}

#[test]
fn without_expand_a_templated_playbook_behaves_exactly_as_before() {
    // The un-expanded path is the one every existing task takes, so it must not
    // change because a template appeared in the file.
    let (org, _) = with_template("exp-optout");
    org.run(EXPANDABLE)
        .assert_ok("task add")
        .assert_lacks("expanded");
    assert!(!org.run(&["show", "retry-design"]).ok());
}

// ------------------------------------------------------------ numbered ids ------

/// `TEMPLATED` with the kind naming its tasks by number. The steps are unchanged; what
/// changes is the string an operator has to spell back.
fn with_numbered_ids(name: &str) -> (Org, PathBuf) {
    let (org, repo) = with_template(name);
    org.playbook(
        &repo,
        &TEMPLATED.replace("[feature]\n", "[feature]\nnumbered  = true\n"),
    );
    (org, repo)
}

#[test]
fn a_numbered_kind_names_its_tasks_by_their_place_in_the_template() {
    let (org, _) = with_numbered_ids("exp-numbered");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("task add --expand")
        .assert_contains("expanded retry into 2 subtasks")
        .assert_contains("retry-1")
        .assert_contains("retry-2")
        // `after` names a sibling in the playbook, so in the plan it has to name the id
        // that sibling was given — a dependency on `retry-design` would name a task
        // this expansion never created.
        .assert_contains("after retry-1")
        .assert_lacks("retry-design");

    // Ordinary tasks under the numbered ids, and `{{task}}` still the main task's id:
    // the steps are numbered, the task above them is not renamed.
    org.run(&["show", "retry-1"])
        .assert_ok("show the first step")
        .assert_contains("decide how retry should work")
        .assert_contains("src/design/retry.md");
    org.run(&["show", "retry-2"])
        .assert_ok("show the second step")
        .assert_contains("src/retry/**")
        .assert_contains("retry-1");
    assert!(
        !org.run(&["show", "retry-design"]).ok(),
        "the step's name is not an id here"
    );

    // And the id is a handle every command already takes, which is the whole of why a
    // project would ask for a shorter one.
    org.run(&["check", "retry-2"])
        .assert_ok("check the second step")
        .assert_contains("admitted");
    org.run(&["tick"]).assert_ok("tick");
    org.run(&["ready"])
        .assert_ok("ready")
        .assert_contains("retry-1")
        .assert_lacks("retry-2");
}

#[test]
fn a_kind_that_asks_for_nothing_keeps_the_ids_it_always_emitted() {
    // Opt-in per kind, so a playbook written before the field existed emits what it
    // did — the ids in it are already on boards, in branches and in the ledger.
    let (org, _) = with_template("exp-unnumbered");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("task add --expand")
        .assert_contains("retry-design")
        .assert_lacks("retry-1");
}

// --------------------------------------------------------- inherited scope ------

/// `TEMPLATED` with the build step's paths removed, so it names none at all. The
/// playbook has no scope to give, so what it writes can only come from the main task.
fn with_a_silent_step(name: &str) -> (Org, PathBuf) {
    let (org, repo) = with_template(name);
    org.playbook(&repo, &TEMPLATED.replace("write  = [\"src/{{task}}/**\"]\n", ""));
    (org, repo)
}

#[test]
fn a_step_that_names_no_scope_writes_where_the_main_task_may() {
    // Otherwise the step is refused for having no scope, and the only repair is to
    // restate `--write` in every block of the template.
    let (org, _) = with_a_silent_step("exp-inherit");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("task add --expand")
        .assert_contains("expanded retry into 2 subtasks")
        // Named back, like every other substitution: the glob is nowhere in the file.
        .assert_contains("write scope from retry: retry-build");

    org.run(&["show", "retry-build"])
        .assert_ok("show the build subtask")
        .assert_contains("src/**");

    // The step that named its own paths still has them, and is not credited with
    // inheriting anything.
    org.run(&["show", "retry-design"])
        .assert_ok("show the design subtask")
        .assert_contains("src/design/retry.md");
}

#[test]
fn an_inheriting_step_is_an_ordinary_task_the_gate_admits() {
    let (org, _) = with_a_silent_step("exp-inherit-admits");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv).assert_ok("task add --expand");

    org.run(&["check", "retry-build"])
        .assert_ok("check the build step")
        .assert_contains("admitted");
    // Inheriting the parent's paths is not overlapping with it: one contains the
    // other rather than competing with it.
    org.run(&["check", "retry"])
        .assert_ok("check the main task")
        .assert_contains("admitted");
}

#[test]
fn two_inheriting_steps_that_nothing_orders_refuse_the_expansion_and_say_why() {
    // Both would claim the main task's paths at the same time. Refused as a whole,
    // and attributed: the glob in the verdict appears nowhere in the playbook, so the
    // repair is an `after` in the template rather than a narrower --write here.
    let (org, repo) = with_template("exp-inherit-clash");
    org.playbook(
        &repo,
        &TEMPLATED.replace(
            "[feature.build]\nafter  = [\"design\"]\nwrite  = [\"src/{{task}}/**\"]\n",
            "[feature.build]\n",
        ),
    );

    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("the main task still admits")
        .assert_contains("saved task retry")
        .assert_contains("not expanded")
        .assert_contains("overlaps")
        .assert_contains("the write scope in that verdict is retry's")
        .assert_contains("order the steps with `after`");

    for id in ["retry-design", "retry-build"] {
        assert!(!org.run(&["show", id]).ok(), "{id} should not exist");
    }
}

#[test]
fn a_spike_step_is_not_handed_the_paths_the_main_task_may_change() {
    // The one kind admitted without a write scope: it answers a question. Inheriting
    // would quietly grant an exploration the right to rewrite what it explored.
    const SPIKE_SECTION: &str = r#"
[spike]
worktree  = true
assign_to = "impl"
accept    = ["true"]
tokens    = 500
wall_secs = 30
"#;
    let (org, repo) = with_template("exp-inherit-spike");
    let build_is_a_spike = TEMPLATED.replace(
        "after  = [\"design\"]\nwrite  = [\"src/{{task}}/**\"]\n",
        "after  = [\"design\"]\nkind   = \"spike\"\n",
    );
    org.playbook(&repo, &(build_is_a_spike + SPIKE_SECTION));

    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("task add --expand")
        .assert_contains("expanded retry into 2 subtasks")
        // Admitted with no write scope at all, and credited with inheriting nothing.
        .assert_lacks("write scope from retry");
}

// ------------------------------------------------------------ design gate ------

/// `TEMPLATED` with the gate turned on: a feature here is refused unless a design
/// stands before it. The template is what makes satisfying the gate one flag.
fn with_gate(name: &str) -> (Org, PathBuf) {
    let (org, repo) = with_template(name);
    org.playbook(
        &repo,
        &TEMPLATED.replace("[feature]\n", "[feature]\ndesign_required = true\n"),
    );
    (org, repo)
}

#[test]
fn a_feature_with_no_design_behind_it_is_refused() {
    let (org, _) = with_gate("gate-refuses");
    org.run(EXPANDABLE)
        .assert_ok("refusal is a verdict, not an error")
        .assert_contains("requires a design")
        .assert_contains("not saved");
    assert!(!org.run(&["show", "retry"]).ok(), "nothing was created");

    // The gate is visible where an orchestrator plans, not only where it fails.
    org.run(&["playbook", "feature"])
        .assert_ok("playbook feature")
        .assert_contains("design    required");
    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("a design must stand before: feature");
}

#[test]
fn a_feature_built_on_a_design_is_admitted_and_waits_for_its_signature() {
    let (org, _) = with_gate("gate-after");
    org.run(&[
        "task",
        "add",
        "retry-plan",
        "--project",
        "caching",
        "--kind",
        "design",
        "decide how a failed task is retried",
        "--write",
        "src/design/retry.md",
        "--accept-cmd",
        "true",
    ])
    .assert_ok("the design itself is not gated")
    .assert_contains("admitted");

    let mut argv = EXPANDABLE.to_vec();
    argv.extend(["--after", "retry-plan"]);
    org.run(&argv)
        .assert_ok("task add --after design")
        .assert_contains("admitted")
        .assert_contains("saved task retry")
        // The gate asks only that the design exist to wait on; the ordering — and a
        // design's need for a signature — is what keeps the feature from running.
        .assert_contains("retry-plan is not done");
}

#[test]
fn expand_satisfies_the_gate_with_the_design_step_it_creates() {
    let (org, _) = with_gate("gate-expand");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("task add --expand")
        .assert_contains("saved task retry")
        .assert_contains("expanded retry into 2 subtasks");

    // And the main task keeps satisfying the gate afterwards: the design is its
    // subtask now, in the plan where every later check finds it.
    org.run(&["check", "retry"])
        .assert_ok("check")
        .assert_contains("admitted");
    org.run(&["check", "retry-build"])
        .assert_ok("check the build step")
        .assert_contains("admitted");
}

#[test]
fn force_admits_an_undesigned_feature_and_records_the_waiver() {
    let (org, _) = with_gate("gate-forced");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--force");
    org.run(&argv)
        .assert_ok("task add --force")
        .assert_contains("forced — defects recorded as waivers")
        .assert_contains("saved task retry");
}
