//! Running what a task will depend on, before a task depends on it: the machine the
//! work happens on, and the hooks that reach the operator when it stops.

mod support;

use std::path::{Path, PathBuf};

use support::Org;

/// Makes everything the machine half asks about true: a repository that is there, a
/// harness this machine has, and an allowlist whose every name is set.
///
/// Called by every test that expects a clean exit, and stated rather than assumed,
/// because the alternative is a suite that passes or fails on what the developer
/// running it happens to have — `claude` on their PATH, `ANTHROPIC_API_KEY` in their
/// shell. What those tests are about is the hooks, so the machine is held still and
/// cannot answer for them.
fn grounded(org: &Org) {
    org.repo();
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let ground = text
        .replace("command = \"claude\"", "command = \"sh\"")
        .lines()
        .map(|l| {
            if l.starts_with("env_allowlist = ") {
                "env_allowlist = [\"PATH\"]".to_string()
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert_ne!(ground, text, "the agent template was not replaced");
    std::fs::write(&conf, ground).unwrap();
}

/// Points the workspace's notify hook at `command`.
///
/// Written in full rather than through a helper that wraps it in a redirect: half of
/// what the drill is for is what a hook *says*, and a command wrapped in `>> log` says
/// nothing whatever it prints.
fn hooked(org: &Org, command: &str) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[notify]\ncommand = \"{command}\"\ntimeout = \"20s\"\n"),
    )
    .unwrap();
}

/// Points the reply channel at a file, and records the offset each fetch was asked
/// for. Returns the two files: what the channel is holding, and what has been asked.
///
/// `cat` rather than `curl`, for the reason the rest of the suite uses one: what is
/// being proved is which offset wecode asks from, and a real bot token would prove that
/// only on a machine that has one.
fn chatting(org: &Org) -> (PathBuf, PathBuf) {
    let (replies, asked) = (org.path("replies.json"), org.path("offsets.txt"));
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let claimed = text.replace(
        "[[users]]\nname = \"you\"\npost = \"chief\"",
        "[[users]]\nname = \"you\"\npost = \"chief\"\ntelegram = \"48210934\"",
    );
    assert_ne!(claimed, text, "the template's user block was not replaced");
    std::fs::write(
        &conf,
        format!(
            "{claimed}\n[telegram]\nfetch = \"echo $WECODE_TELEGRAM_OFFSET >> {}; cat {}\"\n",
            asked.display(),
            replies.display()
        ),
    )
    .unwrap();
    (replies, asked)
}

fn lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn a_configured_hook_is_run_rather_than_read_back() {
    // The whole of it. A notify line is a command the operator wrote and nothing ran it
    // until a real task stopped for a real person — which is both the worst moment to
    // find out and the one where the failure is invisible, since a hook that never fired
    // and a queue with nothing in it are the same silence.
    let org = Org::new("doctor-runs", "solo");
    org.seed();
    grounded(&org);
    let log = org.path("drilled.txt");
    hooked(
        &org,
        &format!(
            "echo $WECODE_TASK $WECODE_WAITING_FOR $WECODE_TASK_STATUS >> {}",
            log.display()
        ),
    );

    org.run(&["doctor"])
        .assert_ok("the drill")
        .assert_contains("✓ [notify] command");
    assert_eq!(
        lines(&log),
        vec!["doctor-drill approval needs-approval"],
        "the hook was not run, or not with a task in its environment"
    );
}

#[test]
fn the_message_carries_no_number_for_a_reply_to_sign_against() {
    // The one thing a drill must not do. `WECODE_TASK_NUMBER` is the handle a reply is
    // typed against, so a rehearsal that put a live number into a real chat message
    // would be one `approve` away from signing work nobody had looked at.
    let org = Org::new("doctor-no-number", "solo");
    org.seed();
    grounded(&org);
    let log = org.path("number.txt");
    hooked(
        &org,
        &format!("echo [$WECODE_TASK_NUMBER] >> {}", log.display()),
    );

    org.run(&["doctor"]).assert_ok("the drill");
    assert_eq!(lines(&log), vec!["[]"]);
}

#[test]
fn a_hook_that_does_not_work_is_found_here_rather_than_at_02_14() {
    // And says so in the exit status, because `wecode doctor && wecode loop` is the
    // shape this is for: a report nobody reads is the state it was written to end.
    let org = Org::new("doctor-broken", "solo");
    org.seed();
    grounded(&org);
    hooked(&org, "echo could not resolve host >&2; exit 6");

    let out = org.run(&["doctor"]);
    assert!(!out.ok(), "a broken hook exited 0:\n{}", out.all());
    out.assert_contains("exited 6");
    out.assert_contains("could not resolve host");
}

#[test]
fn a_hook_that_exits_well_and_says_something_is_not_taken_for_a_delivery() {
    // The failure the whole command is aimed at. `curl` handed a `400 chat not found`
    // exits 0 having done exactly what it was asked, so the exit status is not the
    // question — and the drill reads it under the same rule the loop does.
    let org = Org::new("doctor-refused", "solo");
    org.seed();
    grounded(&org);
    hooked(&org, "echo Bad Request: chat not found");

    let out = org.run(&["doctor"]);
    assert!(!out.ok(), "a refused message exited 0:\n{}", out.all());
    out.assert_contains("chat not found");
}

#[test]
fn the_channel_is_read_from_the_start_and_no_reply_is_consumed() {
    // `getUpdates` treats an offset as an acknowledgement of everything below it, so a
    // drill that asked from where the cursor actually is would delete the operator's
    // unread replies as a side effect of checking it could read them.
    let org = Org::new("doctor-offset", "solo");
    org.seed();
    grounded(&org);
    let (replies, asked) = chatting(&org);
    // Chat, not an instruction: read, moved past, and nothing signed. What matters here
    // is that reading it moves the cursor.
    std::fs::write(
        &replies,
        "{\"ok\":true,\"result\":[{\"update_id\":700123,\"message\":{\"message_id\":1,\
         \"from\":{\"id\":48210934,\"username\":\"you\"},\"text\":\"morning\"}}]}",
    )
    .unwrap();

    org.run(&["telegram"]).assert_ok("read the channel once");
    org.run(&["telegram"]).assert_ok("read it again");
    assert_eq!(
        lines(&asked),
        vec!["0", "700124"],
        "the cursor did not move, so this proves nothing"
    );

    org.run(&["doctor"])
        .assert_ok("the drill")
        // Everything still held, which is what asking from zero means — and what the
        // report says it read.
        .assert_contains("1 update held");
    assert_eq!(lines(&asked).last().unwrap(), "0", "the drill confirmed");

    // And the cursor is where the loop left it: the next real pass asks from the same
    // place it would have without the drill.
    org.run(&["telegram"]).assert_ok("read it again");
    assert_eq!(lines(&asked).last().unwrap(), "700124");
}

#[test]
fn the_drill_signs_nothing_and_leaves_the_work_where_it_found_it() {
    let org = Org::new("doctor-moves-nothing", "solo");
    org.seed();
    grounded(&org);
    let (replies, _) = chatting(&org);
    // A reply that would sign a merge, sitting unread in the channel. The drill reads
    // the same channel and must come to no conclusion about it.
    std::fs::write(
        &replies,
        "{\"ok\":true,\"result\":[{\"update_id\":700123,\"message\":{\"message_id\":1,\
         \"from\":{\"id\":48210934,\"username\":\"you\"},\"text\":\"approve\",\
         \"reply_to_message\":{\"message_id\":0,\"text\":\"cache-tests needs you\"}}}]}",
    )
    .unwrap();
    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    let before = org.run(&["audit"]).stdout;

    org.run(&["doctor"]).assert_ok("the drill");

    assert_eq!(
        org.run(&["audit"]).stdout,
        before,
        "the drill wrote to the ledger"
    );
    org.run(&["show", "cache-tests"])
        .assert_contains("needs-approval");
}

#[test]
fn a_channel_nobody_can_answer_from_is_reported_as_the_silence_it_is() {
    // A fetch that works perfectly and no account claiming a seat: wecode reads the
    // channel every pass and can answer from it never. There is no fallback seat, by
    // design, so every reply resolves to nobody — and the refusal is printed on the
    // machine the operator is not at.
    let org = Org::new("doctor-nobody", "solo");
    org.seed();
    grounded(&org);
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[telegram]\nfetch = \"echo '{{\\\"ok\\\":true,\\\"result\\\":[]}}'\"\n"),
    )
    .unwrap();

    let out = org.run(&["doctor"]);
    assert!(!out.ok(), "an unanswerable channel exited 0:\n{}", out.all());
    out.assert_contains("resolves to nobody");
}

#[test]
fn a_workspace_that_configures_nothing_is_told_where_the_lines_go() {
    // Nothing here is compulsory: an operator who watches a terminal is configured for
    // a terminal rather than misconfigured. So it is a report and a clean exit, which is
    // what lets the drill sit in front of `wecode loop` in a script.
    let org = Org::new("doctor-bare", "solo");
    org.seed();
    grounded(&org);

    org.run(&["doctor"])
        .assert_ok("nothing configured is not a failure")
        .assert_contains("· [notify] command")
        .assert_contains("nothing is configured")
        // Both halves, because either alone is a loop that only goes one way: a
        // notification nobody can answer, or a reply channel nothing speaks into.
        .assert_contains("config/notify.md")
        .assert_contains("config/telegram.md");
}

#[test]
fn a_workspace_nobody_has_edited_yet_is_told_its_repository_is_not_there() {
    // `wecode init` writes `path = "~/projects/your-repo"`, which parses, validates and
    // names a directory that has never existed. Nothing asked about it until a task on
    // that repo was dispatched — and then it was that *task* that failed, with a
    // worktree cut and a run recorded against it.
    let org = Org::new("doctor-repo-example", "solo");
    org.seed();

    let out = org.run(&["doctor"]);
    assert!(!out.ok(), "an unusable repository exited 0:\n{}", out.all());
    out.assert_contains("[[repos]] app");
    out.assert_contains("your-repo");
    out.assert_contains("is not there");
}

#[test]
fn a_harness_this_machine_does_not_have_is_found_before_a_task_is_dispatched() {
    // The failure this half exists for. Left to dispatch it arrives as a task that
    // could not be done, once per promotion, and it is nothing of the kind.
    let org = Org::new("doctor-no-harness", "solo");
    org.seed();
    grounded(&org);
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        text.replace("command = \"sh\"", "command = \"wecode-no-such-harness\""),
    )
    .unwrap();

    let out = org.run(&["doctor"]);
    assert!(!out.ok(), "a missing harness exited 0:\n{}", out.all());
    out.assert_contains("wecode-no-such-harness");
    // Which seats are waiting on it, since that is what decides whether the repair is
    // this morning's — and it is the harness that is named, not the task.
    out.assert_contains("post");
}

#[test]
fn a_variable_the_agent_was_promised_is_read_off_the_environment_wecode_is_in() {
    // A worker is started with `env_clear`, so the allowlist is not a filter over the
    // environment — it *is* the environment. A name on it that is unset here is carried
    // through as nothing, and the agent finds out on its first authenticated call,
    // having spent the task's budget getting there.
    let org = Org::new("doctor-no-key", "solo");
    org.seed();
    grounded(&org);
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        text.replace(
            "env_allowlist = [\"PATH\"]",
            "env_allowlist = [\"PATH\", \"WECODE_DOCTOR_UNSET\"]",
        ),
    )
    .unwrap();

    let out = org.run(&["doctor"]);
    assert!(!out.ok(), "a variable that never arrives exited 0:\n{}", out.all());
    out.assert_contains("[agents.claude-code] env_allowlist");
    out.assert_contains("WECODE_DOCTOR_UNSET");
}

#[test]
fn a_machine_that_can_do_the_work_says_so_and_says_where() {
    // The good day. Worktrees land outside both the repository and the workspace, which
    // is the commonest question asked about them, so the answer is in the report whether
    // or not anything is wrong with it.
    let org = Org::new("doctor-machine-ok", "solo");
    org.seed();
    grounded(&org);

    org.run(&["doctor"])
        .assert_ok("a machine that can do the work")
        .assert_contains("machine")
        .assert_contains("✓ git")
        .assert_contains("worktree root")
        .assert_contains("wecode-e2e-doctor-machine-ok")
        // Resolved, and not started: a coding agent launched to see whether it launches
        // is a session and a bill.
        .assert_contains("resolved, not started");
}

#[test]
fn the_seat_that_would_sign_is_named_with_what_it_may_sign() {
    // The other silent half: a reply that resolves to a person whose post may sign
    // nothing is read, attributed, put past the Broker and refused — a round trip that
    // ends where it started, six hours later.
    let org = Org::new("doctor-seat", "solo");
    org.seed();
    grounded(&org);
    chatting(&org);
    std::fs::write(org.path("replies.json"), "{\"ok\":true,\"result\":[]}").unwrap();

    org.run(&["doctor"])
        .assert_ok("the drill")
        .assert_contains("you (chief) signs")
        .assert_contains("merge");
}
