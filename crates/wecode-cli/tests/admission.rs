//! What a task is held to before anyone works on it.
//!
//! The gate itself is decided in core and tested there, a case per defect. What this
//! file covers is the part core structurally cannot: that a verdict reaches the person
//! typing the command, through the real binary, against a real workspace and a real
//! playbook — and that the advisory half of it still refuses nothing on the way.

mod support;

use support::Org;
use support::playbook::{PLAYBOOK, with_playbook, with_playbook_body};

/// `caching` is budgeted 1000 tokens and 60 seconds of wall time, and every kind in
/// the shared playbook is written for exactly those figures. So a task that states
/// them is at its project's ceiling and not over it, which is what makes the one that
/// steps over it unambiguous.
fn a_chore(org: &Org, id: &str, title: &str, scope: &str, tokens: &str) -> support::Run {
    org.run(&[
        "task", "add", id, title, "--project", "caching", "--kind", "chore", "--write", scope,
        "--tokens", tokens, "--wall", "60",
    ])
}

#[test]
fn a_task_worth_more_than_its_whole_project_is_told_so_and_still_admitted() {
    // The one advisory note that is not read off a playbook. A kind's default budget
    // is written once, in a repository, and applied in every project on it — so the
    // figure a task ends up carrying can exceed what its project was given without
    // anyone having compared the two. Nothing did compare them until now: the project
    // budget was read on the board, against spend, which is after it has been paid.
    let (org, _) = with_playbook("admission-over-project");
    a_chore(&org, "over", "bump the serde dependency", "src/**", "400000")
        .assert_ok("a task may ask for more than its project has")
        .assert_contains("saved task over")
        .assert_contains("⚠ 1 note")
        .assert_contains("400000 tokens")
        .assert_contains("project `caching` was given 1000 for all of its work")
        .assert_contains("advisory — nothing is refused");

    // The half that makes it advice rather than a gate: it is still admitted, and
    // `check` — which is where an operator goes to find out — says both things.
    org.run(&["check", "over"])
        .assert_ok("check")
        .assert_contains("✓ admitted")
        .assert_contains("was given 1000 for all of its work");
}

/// The shared guidance, plus the one line a project writes to say what it will not have
/// written. `vendor/**` because it is the honest case: the paths a repository keeps under
/// another tool's control are exactly the ones a well-formed task asks for in good faith.
const WHY: &str = "vendored code is updated by its own tool, never by hand";

fn refusing() -> String {
    format!("{PLAYBOOK}\n[project.refuses]\n\"vendor/**\" = \"{WHY}\"\n")
}

#[test]
fn a_task_that_would_write_what_its_project_refuses_is_refused_and_told_why() {
    // Unlike the note above, this is a gate: the declaration is answerable — narrow the
    // scope — so it is put as a question and nothing is saved until it is answered.
    let (org, _) = with_playbook_body("admission-refused-path", &refusing());
    a_chore(&org, "vendored", "bump the serde dependency", "vendor/serde/**", "1000")
        .assert_ok("the verdict is printed rather than raised")
        // Both globs, because they are different lines in different files: one is the
        // task's to narrow, the other the playbook's that said no.
        .assert_contains("\"vendor/serde/**\"")
        .assert_contains("\"vendor/**\"")
        .assert_contains(WHY)
        .assert_contains("not saved")
        .assert_lacks("saved task");

    // And it is waivable, like every other defect: a project's line is its own, not the
    // charter's, and the operator who overrides it leaves a record of having done so.
    org.run(&[
        "task", "add", "vendored", "bump the serde dependency", "--project", "caching",
        "--kind", "chore", "--write", "vendor/serde/**", "--tokens", "1000", "--wall", "60",
        "--force",
    ])
    .assert_ok("forced")
    .assert_contains("forced — defects recorded as waivers")
    .assert_contains("saved task vendored");

    // It is that project's line and not wecode's opinion: the same declaration against a
    // playbook that refuses nothing is admitted, which is also what keeps every project
    // written before the setting existed working exactly as it did.
    let (quiet, _) = with_playbook("admission-refuses-nothing");
    a_chore(&quiet, "vendored", "bump the serde dependency", "vendor/serde/**", "1000")
        .assert_ok("a project that says nothing refuses nothing")
        .assert_contains("saved task vendored");
}

#[test]
fn a_scope_widened_into_what_the_project_refuses_is_not_changed_either() {
    // The path that matters most, because it is the one a refusal is usually written in
    // answer to: the task was declared somewhere harmless and the paths were widened
    // afterwards. Held back like an overlap, and `check` keeps saying so.
    let (org, _) = with_playbook_body("admission-refused-amend", &refusing());
    a_chore(&org, "widen", "bump the serde dependency", "src/**", "1000")
        .assert_ok("a task on paths nobody refused")
        .assert_contains("saved task widen");

    org.run(&["task", "scope", "widen", "--write", "vendor/serde/**"])
        .assert_ok("the verdict is printed rather than raised")
        .assert_contains("\"vendor/**\"")
        .assert_contains(WHY)
        .assert_contains("not changed");

    // Nothing was written, so the task still stands on the scope it was admitted with.
    org.run(&["check", "widen"])
        .assert_ok("check")
        .assert_contains("✓ admitted");
}

// ----------------------------------------------------------- components ------

/// A project that has said what its parts are, and a `feature` whose steps are scoped
/// by name rather than by glob. The paths stay under `src/` so the solo template's
/// engineer can reach them: an expansion nobody could be assigned would prove the wrong
/// thing.
const COMPONENTS: &str = r#"
[project.components]
cache = ["src/cache/**", "src/store/cache.rs"]
probe = ["src/probe/**"]

[feature]
worktree  = true
assign_to = "impl"
accept    = ["true"]
tokens    = 1000
wall_secs = 60
subtasks  = ["build", "instrument"]

[feature.build]
write = ["@cache"]

[feature.instrument]
after = ["build"]
write = ["@probe"]
read  = ["@cache"]
"#;

/// The main task an expansion hangs off. `scope` is its own, which every step here
/// overrides with a component of its own — so a refusal that lands is the step's.
fn a_feature(org: &Org, id: &str, scope: &str) -> support::Run {
    org.run(&[
        "task", "add", id, "add response caching", "--project", "caching", "--kind", "feature",
        "--write", scope, "--tokens", "1000", "--wall", "60", "--expand",
    ])
}

#[test]
fn a_step_scoped_by_component_is_admitted_on_the_paths_that_component_owns() {
    // Why this is worth a test through the binary: the name is resolved while the
    // playbook is read, so what reaches the plan — and assignment, and the envelope,
    // and verification — is paths. A scope stored as `@cache` would clear this gate and
    // then be a task no post could be given and no diff could be judged against.
    let (org, _) = with_playbook_body("admission-component-scope", COMPONENTS);
    a_feature(&org, "caching-1", "src/**")
        .assert_ok("a template whose steps name components")
        .assert_contains("expanded caching-1 into 2 subtasks");

    org.run(&["show", "caching-1-build"])
        .assert_ok("show the step")
        // Every path the component owns, in the order the table gives them.
        .assert_contains("src/cache/**")
        .assert_contains("src/store/cache.rs")
        // And nothing carrying the name onward: one table was followed, once.
        .assert_lacks("@cache");

    // Both sides of a scope, because both are scopes.
    org.run(&["show", "caching-1-instrument"])
        .assert_ok("show the step that reads one component and writes another")
        .assert_contains("src/probe/**")
        .assert_contains("src/cache/**");
}

/// A reason for a path a component owns, distinct from [`WHY`] so the verdict below
/// cannot pass on the wrong project's sentence.
const GENERATED: &str = "the probe is generated: `cargo run -p codegen`";

#[test]
fn a_component_whose_paths_the_project_refuses_is_refused_by_its_paths() {
    // The two settings meeting: `refuses` states paths, a scope states a name, and the
    // verdict has to be about the files — they are what the reader has to narrow. The
    // main task keeps clear of the refusal so the one that lands is the step's.
    let body = format!("{COMPONENTS}\n[project.refuses]\n\"src/probe/**\" = \"{GENERATED}\"\n");
    let (org, _) = with_playbook_body("admission-component-refused", &body);
    a_feature(&org, "caching-2", "src/cache/**")
        .assert_ok("the verdict is printed rather than raised")
        .assert_contains("not expanded")
        // The path, not the name: it is the line the playbook said no about.
        .assert_contains("\"src/probe/**\"")
        .assert_contains(GENERATED);
}

#[test]
fn a_scope_naming_a_component_no_one_declared_refuses_the_playbook_where_it_is_read() {
    // A typo in a scope is a typo in one file, and this is the whole reason the names
    // are resolved as the playbook is read: `@cahce` left to stand as a glob would match
    // no file, and a task that can write nothing is discovered at verification, once its
    // budget is spent. Refused here it costs one edit, and the message names both the
    // line to fix and what the project does declare.
    let typo = COMPONENTS.replace("[\"@cache\"]", "[\"@cahce\"]");
    let (org, _) = with_playbook_body("admission-component-unknown", &typo);
    let r = a_feature(&org, "caching-3", "src/cache/**");
    assert!(!r.ok(), "a playbook that cannot be read admits nothing");
    r.assert_contains("cahce")
        .assert_contains("[feature.build] write")
        .assert_contains("@cache");
}

#[test]
fn a_task_inside_what_its_project_was_given_is_said_nothing_about() {
    // The control. A note on every task would be a note nobody reads, and the ceiling
    // is a ceiling rather than a target: at it is not over it.
    let (org, _) = with_playbook("admission-within-project");
    a_chore(&org, "within", "bump the serde dependency", "src/**", "1000")
        .assert_ok("a task at its project's ceiling")
        .assert_contains("saved task within")
        .assert_lacks("would have written this differently");
}
