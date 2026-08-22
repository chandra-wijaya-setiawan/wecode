//! Dispatching an agent, judging what it did, and committing the attempt.
//!
//! Also what the run cost — the spend an agent reports about itself — and the build
//! cache it and the commands that judge it are both handed.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use support::Org;
use support::agent::{a_task, a_task_in_src, with_agent};
use support::playbook::{PLAYBOOK, with_playbook, with_playbook_body};

// ------------------------------------------------------------------- run ------

#[test]
fn run_spawns_the_agent_and_verifies_what_it_did() {
    let (org, _) = with_agent("run-ok", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    let r = org.run(&["run", "t"]);
    r.assert_ok("run")
        .assert_contains("post     impl")
        .assert_contains("exit 0")
        .assert_contains("✓ a.txt")
        .assert_contains("passed");

    // Passing is not landed. The work is on a branch nobody has merged, so it waits
    // for the signature rather than claiming to be done.
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");
}

// ------------------------------------------------------------ build cache ------

/// A cache directory outside every worktree and outside the workspace, which is what
/// the setting is for: `Org` wipes its own directory on each run, and a cache that went
/// with it would be shared with nothing.
fn cache_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wecode-e2e-cache-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("target")
}

/// The shared playbook with a build cache declared on top of it.
fn with_cache(target: &Path) -> String {
    format!(
        "{PLAYBOOK}\n[project.build_cache]\nCARGO_TARGET_DIR = \"{}\"\n",
        target.display()
    )
}

#[test]
fn one_build_cache_reaches_both_the_agent_and_the_commands_that_judge_it() {
    // The whole path in one test, because half of it is worse than none: an agent
    // building into the shared directory while acceptance rebuilds from scratch in the
    // worktree pays the cost this exists to remove, and looks like it did not.
    let target = cache_dir("both");
    let (org, _) = with_playbook_body("cache-both", &with_cache(&target));
    org.agent("echo \"$CARGO_TARGET_DIR\" > seen.txt");

    let seen = format!("grep -qx {} seen.txt", target.display());
    let judged = format!("test \"$CARGO_TARGET_DIR\" = {}", target.display());
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "chore",
        "append a marker comment to the source",
        "--write",
        "seen.txt",
        "--accept-cmd",
        &seen,
        "--accept-cmd",
        &judged,
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("task add");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("exit 0")
        .assert_contains("passed");
    // Made by wecode rather than by whatever ran first: a toolchain handed a path it
    // cannot create either fails obscurely or quietly builds into the worktree.
    assert!(target.is_dir(), "{} was not created", target.display());
}

#[test]
fn the_shared_cache_is_shown_in_the_guidance_and_reported_where_work_is_prepared() {
    let target = cache_dir("shown");
    let (org, _) = with_playbook_body("cache-shown", &with_cache(&target));

    // In the playbook view as written, since that is a view of the file.
    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("cache")
        .assert_contains("CARGO_TARGET_DIR");

    // And resolved where the operator is told which directory to work in — a hand-run
    // task that built somewhere else would be the one build not sharing the cache.
    a_task(&org, "t", "a.txt", "true");
    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_contains(&format!("cache    CARGO_TARGET_DIR={}", target.display()));
}

#[test]
fn a_cache_that_would_land_inside_a_worktree_is_refused_by_name() {
    // `target/shared` resolves against whichever worktree is running, so it would be a
    // per-task directory with a name promising the opposite. Refused where the playbook
    // is read, which is before any budget is spent.
    let (org, _) = with_playbook_body(
        "cache-relative",
        &format!("{PLAYBOOK}\n[project.build_cache]\nCARGO_TARGET_DIR = \"target/shared\"\n"),
    );
    let r = org.run(&["playbook"]);
    assert!(!r.ok(), "a playbook that cannot be honoured must not load");
    r.assert_contains("CARGO_TARGET_DIR")
        .assert_contains("relative");
}

#[test]
fn a_failing_agent_is_not_verified() {
    // Verification would be meaningless: the work never finished.
    let (org, _) = with_agent("run-fail", "echo nope >&2; exit 4");
    a_task(&org, "t", "a.txt", "true");

    org.run(&["run", "t"])
        .assert_ok("command itself succeeds")
        .assert_contains("exit 4")
        .assert_contains("not verified");
    org.run(&["show", "t"]).assert_contains("status     failed");
}

#[test]
fn a_failed_run_leaves_the_reason_on_the_record_and_not_only_in_the_terminal() {
    // `exit 1` is what a crashed harness, an agent that gave up and a machine with no
    // credential on it all look like from outside. The sentence that tells them apart
    // was captured, printed once to whoever was standing at the machine, and dropped —
    // so the retry read an exit code, and so did the operator who was somewhere else.
    let (org, _) = with_agent(
        "run-cause",
        "echo half >> a.txt; echo 'Error: invalid x-api-key' >&2; exit 1",
    );
    a_task(&org, "t", "a.txt", "true");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("not verified");

    // The durable half. `show` reads the execution record, which is what is left once
    // the terminal that ran it has scrolled away or belongs to a machine nobody is at.
    org.run(&["show", "t"])
        .assert_contains("exit 1 — Error: invalid x-api-key");

    // And on the attempt's own commit, beside the diff it explains. The database and
    // the branch travel separately — one of them is what somebody clones — and a
    // half-finished change with `exit 1` under it is a puzzle either way.
    let tree = org
        .recorded()
        .into_iter()
        .find(|w| w.task == "t")
        .expect("the task's worktree");
    let message = support::git_out(Path::new(&tree.path), &["log", "-1", "--format=%B"]);
    assert!(
        message.contains("exit 1 — Error: invalid x-api-key"),
        "the commit says only how it ended: {message}"
    );

    // And the next attempt is handed it, which is the whole point of keeping it: a
    // retry that cannot see why the last one failed pays for the same failure again.
    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_contains("YOUR PREVIOUS ATTEMPTS")
        .assert_contains("exit 1 — Error: invalid x-api-key");
}

#[test]
fn a_clean_run_is_not_given_a_reason_it_does_not_have() {
    // The other half of the rule. A working agent's last line is a warning or a
    // progress note, and hanging it off `exit 0` would put a cause on every record
    // that has none — including the ones that passed.
    let (org, _) = with_agent(
        "run-clean-cause",
        "echo 'warning: deprecated flag' >&2; echo done >> a.txt",
    );
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    org.run(&["show", "t"]).assert_lacks("deprecated flag");
}

#[test]
fn work_outside_the_declared_scope_fails_a_run_that_exited_cleanly() {
    // The case the whole design turns on: the agent says it succeeded, and the diff
    // says it went somewhere it was not allowed.
    let (org, _) = with_agent(
        "run-scope",
        "echo done >> a.txt; echo sneaky >> elsewhere.txt",
    );
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    let r = org.run(&["run", "t"]);
    r.assert_contains("exit 0")
        .assert_contains("elsewhere.txt")
        .assert_contains("outside scope")
        .assert_contains("failed");
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_contains("elsewhere.txt");
}

#[test]
fn a_failed_check_is_recorded_as_a_failure_not_a_denial() {
    // The scope violation above is a denial: authority was breached. A red check is
    // not — the supervisor ran it itself, and the work failed it. Filing the second
    // as "command not permitted" filled the governance channel with test runs, and
    // the board said "denied" about a task that was merely wrong.
    let (org, _) = with_agent("run-fail-check", "echo wrong >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q right a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("failed");

    // The check and its exit are on the record, as something we ran and observed...
    org.run(&["audit", "--task", "t"])
        .assert_contains("grep -q right a.txt")
        .assert_contains("exit 1, wanted 0");
    // ...and not as a denial: nothing was refused.
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_lacks("grep -q right");
}

#[test]
fn an_agent_that_hangs_is_killed_on_its_idle_limit() {
    let (org, _) = with_agent("run-idle", "sleep 60");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, text.replace("idle_secs = 300", "idle_secs = 1")).unwrap();
    a_task(&org, "t", "a.txt", "true");

    let r = org.run(&["run", "t"]);
    r.assert_contains("no output")
        .assert_contains("not verified");
    org.run(&["show", "t"]).assert_contains("status     failed");
}

#[test]
fn the_agent_is_launched_where_the_task_says_and_the_launch_is_recorded() {
    let (org, _) = with_agent("run-record", "pwd > where.txt; echo done >> a.txt");
    a_task(&org, "t", "*.txt", "grep -q done a.txt");
    org.run(&["run", "t"]).assert_ok("run");

    // The configured launch line reaches the ledger, prompt placeholder intact.
    org.run(&["audit", "--task", "t"])
        .assert_contains("sh -c")
        .assert_contains("exit 0");
}

/// An agent that does its work and then reports what it cost, the way a coding CLI
/// speaking `claude-stream-json` does.
fn reporting_agent(work: &str, input: u64, output: u64) -> String {
    format!(
        "{work}; echo '{{\"type\":\"result\",\"usage\":\
         {{\"input_tokens\":{input},\"output_tokens\":{output}}}}}'"
    )
}

#[test]
fn what_the_agent_reported_spending_reaches_the_row_it_was_spent_on() {
    // The spend column was a zero on every board until something wrote to it. The
    // whole path: the agent's own output, the ledger, the task row, the attempt.
    let (org, _) = with_agent("run-spend", &reporting_agent("echo done >> a.txt", 60, 30));
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("spent    90 tokens");

    // On the board, against the budget the task declared — 100 tokens.
    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_contains("90/100");

    // In the ledger, attributed to the task and marked as the agent's own account of
    // itself rather than as something wecode measured.
    org.run(&["audit", "--task", "t"])
        .assert_ok("audit")
        .assert_contains("spend")
        .assert_contains("90t/")
        .assert_contains("harness");

    // And against the attempt, so a task with several tries can say which was
    // expensive.
    org.run(&["show", "t"]).assert_contains("90t");
}

#[test]
fn an_agent_that_reports_nothing_leaves_the_column_empty_rather_than_zero() {
    // The stub speaks no protocol wecode can read, so there is no number. Printing
    // one would be a claim nobody made, and the budget would be checked against it.
    let (org, _) = with_agent("run-unmetered", "echo done >> a.txt");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        text.replace(
            "protocol = \"claude-stream-json\"",
            "protocol = \"invented\"",
        ),
    )
    .unwrap();
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("unmetered");

    // The wall clock is still ours to record, and it is still recorded — as
    // something wecode observed, unlike a token count.
    org.run(&["audit", "--task", "t"])
        .assert_contains("spend")
        .assert_contains("supervisor")
        .assert_lacks("harness");

    // Neither half is invented. An unreadable protocol says nothing about what the
    // run added and nothing about what it re-read, and a `+0` here would be the
    // second claim being made on the first one's behalf.
    org.run(&["show", "t"])
        .assert_ok("show")
        .assert_lacks("re-read");
}

#[test]
fn an_overspending_agent_turns_its_row_red_after_the_fact() {
    // Enforcement of a token budget is post-hoc by necessity: the tokens are gone
    // before wecode hears about them. What the board can do is stop calling the run
    // healthy, which it could not do while nothing counted. Health is the colour
    // of the needs-you cell, so red is the ANSI code around the words.
    let (org, _) = with_agent(
        "run-overspend",
        &reporting_agent("echo done >> a.txt", 4000, 1000),
    );
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    org.run(&["run", "t"]).assert_ok("run");

    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_contains("\u{1b}[31mover budget");
}

#[test]
fn a_conversation_is_not_billed_for_the_context_it_re_read() {
    // The budget is a number a person wrote — 100 tokens for this task — and the
    // agent added 90. It also replayed half a million tokens of its own context,
    // which is what a long conversation does every turn and what no budget is
    // written in. Counted into the spend, this run is 5,000x over and the board is
    // red for every task that ever ran; kept in its own unit, the row is honest and
    // the replay is still on the screen.
    let (org, _) = with_agent(
        "run-cached",
        "echo done >> a.txt; echo '{\"type\":\"result\",\"usage\":\
         {\"input_tokens\":60,\"output_tokens\":30,\
         \"cache_read_input_tokens\":500000}}'",
    );
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("spent    90 tokens")
        .assert_contains("500000 re-read from cache");

    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_contains("90/100")
        .assert_lacks("over budget");

    // And it survives the terminal it was printed to. Cache reads are billed, at a
    // tenth of the rate, so the figure that is deliberately kept out of the budget is
    // still money — and until it was written to the attempt, the only place it had
    // ever existed was one line of output nobody was necessarily watching.
    org.run(&["show", "t"])
        .assert_ok("show")
        .assert_contains("90t +500000 re-read");
}

#[test]
fn a_turn_announced_once_per_block_does_not_spend_the_budget_four_times() {
    // A coding CLI announces one `assistant` line per content block, so a turn that
    // thought and then called a tool says the same thing — same message, same usage —
    // three or four times over. Added up line by line, this 60-token run reads as 240
    // against a 100-token budget, and the supervisor kills it while it is still
    // working. Nothing that survives the run agrees: the total the harness states at
    // the end, and every figure read off it afterwards, says 60.
    let turn = "echo '{\"type\":\"assistant\",\"message\":{\"id\":\"msg_1\",\"usage\":\
                {\"input_tokens\":40,\"output_tokens\":20}}}'; sleep 0.15";
    let (org, _) = with_agent(
        "run-blocks",
        &format!(
            "echo done >> a.txt; {turn}; {turn}; {turn}; {turn}; \
             echo '{{\"type\":\"result\",\"usage\":\
             {{\"input_tokens\":40,\"output_tokens\":20}}}}'"
        ),
    );
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_lacks("token budget")
        .assert_contains("spent    60 tokens");

    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_contains("60/100")
        .assert_lacks("over budget");
}

#[test]
fn a_run_killed_on_its_limit_still_reports_what_it_burned() {
    // The case a spend recorded only on success would hide, and the expensive one:
    // an agent that ran away with the budget and had to be killed.
    let (org, _) = with_agent(
        "run-killed",
        "echo '{\"type\":\"assistant\",\"message\":{\"usage\":\
         {\"input_tokens\":40,\"output_tokens\":10,\
         \"cache_read_input_tokens\":120000}}}'; sleep 60",
    );
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, text.replace("idle_secs = 300", "idle_secs = 1")).unwrap();
    a_task(&org, "t", "a.txt", "true");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("no output")
        .assert_contains("spent    50 tokens");
    org.run(&["board", "caching"]).assert_contains("50/100");
    // Both halves, and on the branch that had no verdict to record: a run killed
    // mid-conversation is exactly the one whose replay is worth having, since a long
    // conversation is how it got to the limit.
    org.run(&["show", "t"])
        .assert_ok("show")
        .assert_contains("50t +120000 re-read");
}

#[test]
fn an_unassigned_task_cannot_be_run() {
    // There is no post to name an agent, so there is nothing to launch. The fixture
    // playbook has no [refactor] section, so nothing fills the assignee either.
    let (org, _) = with_agent("run-unassigned", "true");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "refactor",
        "append a marker comment to the source",
        "--write",
        "a.txt",
        "--accept-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "5",
    ])
    .assert_ok("task add");

    let r = org.run(&["run", "t"]);
    assert!(!r.ok());
    r.assert_contains("unassigned")
        .assert_contains("wecode assign");
}

#[test]
fn running_a_task_that_does_not_exist_says_so() {
    let (org, _) = with_agent("run-ghost", "true");
    let r = org.run(&["run", "ghost"]);
    assert!(!r.ok());
    r.assert_contains("no such task");
}

#[test]
fn a_charter_forbidden_launch_is_refused_before_anything_runs() {
    // Invariants outrank configuration: an agent template that would run a forbidden
    // command is itself the bug, and is caught before the process starts.
    let (org, _) = with_agent("run-charter", "true");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        text.replace("never_run = [", "never_run = [\"sh *\", "),
    )
    .unwrap();
    a_task(&org, "t", "a.txt", "true");

    let r = org.run(&["run", "t"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("charter forbids")
        .assert_contains("never_run");
}

// ----------------------------------------------------------------- claim ------

/// The charter refusing the configured launch line: a dispatch that gets all the way past
/// preparation and still never reaches an agent. Answers with the file as it was, for a
/// test that wants to put it back.
///
/// `sh *` is one glob segment, so it only matches a launch line with no `/` in it — which
/// is a constraint on the stand-in agent's script, not on this.
fn forbid_the_harness(org: &Org) -> String {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        text.replace("never_run = [", "never_run = [\"sh *\", "),
    )
    .unwrap();
    text
}

#[test]
fn a_dispatch_that_lost_the_race_stands_down_rather_than_running_it_twice() {
    // A real second dispatch, sent while the first one's agent is up: the stand-in agent
    // runs its own task again from inside its own worktree, which is the race the loop
    // and a hand-typed `wecode run` can lose against each other. Two agents on one
    // checkout overwrite each other's work — and the loser's `git reset --hard` takes the
    // winner's away before they get that far.
    let (org, _) = with_playbook("run-contended");
    let dir = org.dir.display().to_string();
    // Guarded on the redirect's own file, which the shell creates before the nested
    // command starts: a check that did not refuse would otherwise dispatch for ever.
    org.agent(&format!(
        "[ -f {dir}/race.txt ] || {} --org {dir} run t > {dir}/race.txt 2>&1; \
         echo done >> src/app.txt",
        env!("CARGO_BIN_EXE_wecode")
    ));
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");

    org.run(&["run", "t"]).assert_ok("run").assert_contains("passed");

    let raced = std::fs::read_to_string(org.dir.join("race.txt")).expect("the second dispatch ran");
    assert!(raced.contains("already running"), "{raced}");
    // And a way back, because nothing moves a `running` task on its own: a supervisor
    // that died holding the claim would otherwise be unrecoverable.
    assert!(raced.contains("wecode status t ready"), "{raced}");
}

#[test]
fn taking_the_same_task_by_hand_again_is_not_a_race_it_lost() {
    // The other half of the rule, and why the status alone cannot be it: `start` writes
    // `running` and launches nothing, so the operator holds the task and starting again
    // is how the tree is reset for a second look. Nothing else moves a `running` task,
    // so refusing this would strand the work on a word.
    let (org, _) = with_agent("run-restart", "true");
    a_task_in_src(&org, "t", "src/**", "true");
    org.run(&["start", "t"]).assert_ok("take it");
    org.run(&["start", "t"])
        .assert_ok("take it again")
        .assert_contains("(reset)");
}

#[test]
fn a_dispatch_refused_after_it_claimed_leaves_the_task_where_it_found_it() {
    // The claim is written before the tree is cut, which is what makes it a claim rather
    // than a note — so every refusal after it has to give the task back. Left standing,
    // this was a task shown as `running` with nothing running: it holds a slot the loop
    // counts, and the tick never authors `running`, so nothing takes it back.
    //
    // The script is slash-free so the charter's glob matches — see `forbid_the_harness`.
    let (org, _) = with_agent("run-released", "cd src && echo done >> app.txt");
    let restore = forbid_the_harness(&org);
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");

    let r = org.run(&["run", "t"]);
    assert!(!r.ok(), "the charter refuses the launch");
    r.assert_contains("charter forbids");
    org.run(&["show", "t"]).assert_contains("status     waiting");

    // And it is still a dispatch, not a task somebody has to unstick first.
    std::fs::write(org.path("company.toml"), restore).unwrap();
    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
}

#[test]
fn a_task_whose_groundwork_is_unfinished_is_given_back_too() {
    // The shallow end of the same path, and the one an operator actually hits: this is
    // refused inside preparation, before a tree is cut, and the claim still has to come
    // off. `running` on a task whose predecessor has not finished would be the queue
    // lying in both directions at once.
    let (org, _) = with_agent("run-blocked", "true");
    a_task_in_src(&org, "first", "src/app.txt", "true");
    a_task_in_src(&org, "second", "src/other.txt", "true");
    org.run(&["task", "add", "second", "--amend", "--after", "first"])
        .assert_ok("chain them");

    let r = org.run(&["run", "second"]);
    assert!(!r.ok(), "its groundwork is not done");
    r.assert_contains("first is not done");
    org.run(&["show", "second"])
        .assert_contains("status     waiting");
}

#[test]
fn naming_a_post_on_task_add_assigns_it_rather_than_half_assigning_it() {
    // A task left `draft` with an assignee is invisible to `ready` and to the loop,
    // with nothing on screen saying why. The playbook fills assign_to on most tasks,
    // so this was the common case.
    let (org, _) = with_playbook("add-assigns");
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
    .assert_ok("task add")
    .assert_contains("draft → waiting");

    org.run(&["ready"]).assert_contains("t");
}

#[test]
fn a_post_that_cannot_reach_the_work_keeps_the_task_but_not_the_assignment() {
    // Refusing outright would discard a whole declaration over a post that one flag
    // could change.
    let (org, _) = with_playbook("add-uncovered");
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
        "somewhere-else/**",
    ])
    .assert_ok("the task is still created")
    .assert_contains("not assigned")
    .assert_contains("may not write");

    org.run(&["show", "t"]).assert_contains("status     draft");
    org.run(&["ready"]).assert_lacks("stale entry");
}

#[test]
fn declaring_the_worker_area_does_not_break_assignment() {
    // `verify` exempts .wecode/run/** because the envelope tells the agent to write
    // there. The assign-time check has to agree, or declaring it fails one and passes
    // the other.
    let (org, _) = with_playbook("worker-area");
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
        "--write",
        ".wecode/run/**",
    ])
    .assert_ok("task add")
    .assert_contains("draft → waiting")
    .assert_lacks("not assigned");
}

#[test]
fn the_fixture_is_planted_as_a_real_repository() {
    // The fixture cannot be committed as a repo — nested repos — so this checks the
    // planting worked rather than assuming it.
    let org = Org::new("fixture", "solo");
    let repo = org.repo();
    assert!(repo.join("src/app.txt").is_file(), "content copied");
    assert!(
        repo.join(".wecode/playbook.toml").is_file(),
        "playbook copied"
    );
    assert!(repo.join(".git").is_dir(), "git init ran");

    // Committed, so a task's diff shows only what the task did.
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        "the fixture must start clean"
    );
}

// ---------------------------------------------------------------- commit ------

#[test]
fn a_passing_attempt_is_committed_on_its_branch() {
    let (org, repo) = with_agent("commit-pass", "echo done >> src/app.txt");
    a_task(&org, "t", "src/**", "grep -q done src/app.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed")
        .assert_contains("committed");

    // The main branch is untouched — output is a branch to review.
    let main = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", "main:src/app.txt"])
        .output()
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&main.stdout).contains("done"),
        "main must not move until a merge"
    );
}

#[test]
fn a_failed_attempt_is_committed_too_so_a_retry_can_learn_from_it() {
    // The reason this matters: a retry resets the worktree. Uncommitted, the failed
    // diff — the only evidence of what went wrong — would be destroyed.
    let (org, _) = with_agent("commit-fail", "echo wrong >> src/app.txt");
    a_task(&org, "t", "src/**", "grep -q correct src/app.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("failed")
        .assert_contains("committed");
}

#[test]
fn two_attempts_leave_two_commits() {
    let (org, _) = with_agent("commit-twice", "echo mark >> src/app.txt");
    a_task(&org, "t", "src/**", "grep -q nope src/app.txt");

    org.run(&["run", "t"]).assert_contains("attempt 1");
    org.run(&["status", "t", "waiting"]).assert_ok("reopen");
    org.run(&["run", "t"]).assert_contains("attempt 2");

    // Both runs are on the record, and the first is not overwritten.
    org.run(&["show", "t"])
        .assert_contains("#1")
        .assert_contains("#2");
}

#[test]
fn an_agent_that_changed_nothing_is_reported_rather_than_committed() {
    let (org, _) = with_agent("commit-none", "true");
    a_task(&org, "t", "src/**", "test -f src/app.txt");
    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("nothing to commit");
}

#[test]
fn work_without_a_worktree_is_never_committed() {
    // Committing into the operator's own checkout is not wecode's decision to take.
    let (org, repo) = with_agent("commit-nowt", "echo x >> README.md");
    org.playbook(
        &repo,
        "[docs]\nworktree = false\nassign_to = \"impl\"\naccept = [\"true\"]\n\
         tokens = 10\nwall_secs = 5\nguidance = \"x\"\n",
    );
    org.run(&[
        "task",
        "add",
        "d",
        "--project",
        "caching",
        "--kind",
        "docs",
        "note the eviction policy in the readme",
        "--write",
        "README.md",
    ])
    .assert_ok("task add");

    org.run(&["run", "d"])
        .assert_ok("run")
        .assert_lacks("committed");
}
