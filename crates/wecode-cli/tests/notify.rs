//! Telling a person that the work has stopped in front of them.

mod support;

use std::path::{Path, PathBuf};

use support::agent::{a_task, a_task_in_src, signs_first, with_agent};
use support::merge::{landed_task, mergeable};
use support::{Org, git_out};

// ---------------------------------------------------------------- notify ------

/// Points the workspace's notify hook at a file, and returns where it will write.
///
/// A file rather than a real notifier: what is being proved is that a command runs
/// with the task in its environment, and `notify-send` would prove the same thing
/// only on a machine with a desktop on it.
fn notified(org: &Org, body: &str) -> PathBuf {
    notified_with(org, body, "")
}

/// The same, with `extra` lines added to the `[notify]` block.
fn notified_with(org: &Org, body: &str, extra: &str) -> PathBuf {
    let log = org.path("notified.txt");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!(
            "{text}\n[notify]\ncommand = \"{body} >> {}\"\ntimeout = \"30s\"\n{extra}",
            log.display()
        ),
    )
    .unwrap();
    log
}

/// Points the workspace's notify hook at `command` itself.
///
/// For the cases where what the hook *says* is the thing under test rather than what
/// it is told, so the command is not wrapped in a redirect to a log.
fn hooked(org: &Org, command: &str) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[notify]\ncommand = \"{command}\"\ntimeout = \"20s\"\n"),
    )
    .unwrap();
}

/// Every line the hook has written, in order.
fn announcements(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn a_task_that_stops_for_a_person_runs_the_hook() {
    // The gap using wecode on itself kept finding. Everything up to the moment a task
    // needs a signature happens unattended; the notification that it does was the
    // operator remembering to look at a terminal.
    let org = Org::new("notify-stops", "solo");
    org.seed();
    let log = notified(
        &org,
        "echo $WECODE_TASK $WECODE_WAITING_FOR $WECODE_TASK_STATUS $WECODE_PROJECT",
    );

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    assert_eq!(
        announcements(&log),
        vec!["cache-tests approval needs-approval caching"]
    );
}

#[test]
fn the_hook_is_handed_the_number_to_reply_with() {
    // The notification and the answer, closed. A message naming only `cache-tests`
    // leaves the operator spelling a slug back on a phone keyboard; one that carries
    // the number leaves them typing `approve #2`.
    let org = Org::new("notify-number", "solo");
    org.seed();
    let log = notified(&org, "echo $WECODE_TASK '#'$WECODE_TASK_NUMBER");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    // The digits alone in the variable, so the hook decides how to write it.
    assert_eq!(announcements(&log), vec!["cache-tests #2"]);
}

#[test]
fn work_that_does_not_stop_announces_nothing() {
    // The control, and the whole reason this is edge-triggered: a hook that fired on
    // every status change would be one the operator silences within a day.
    let org = Org::new("notify-quiet", "solo");
    org.seed();
    let log = notified(&org, "echo $WECODE_TASK");

    for status in ["running", "verifying", "done"] {
        org.run(&["status", "cache-tests", status])
            .assert_ok(status);
    }
    assert!(announcements(&log).is_empty(), "{:?}", announcements(&log));
}

#[test]
fn one_wait_is_announced_once_however_it_is_renamed() {
    // `failed` → `needs-input` is a person who is already holding this task being
    // told about it again. The wait began once, and that is what is announced.
    let org = Org::new("notify-once", "solo");
    org.seed();
    let log = notified(&org, "echo $WECODE_WAITING_FOR");

    for status in ["failed", "needs-input", "needs-approval"] {
        org.run(&["status", "cache-tests", status])
            .assert_ok(status);
    }
    assert_eq!(announcements(&log), vec!["failed"]);

    // Released, then stuck again: a second wait, and a second announcement.
    org.run(&["status", "cache-tests", "ready"]).assert_ok("go");
    org.run(&["status", "cache-tests", "failed"])
        .assert_ok("stuck again");
    assert_eq!(announcements(&log), vec!["failed", "failed"]);
}

#[test]
fn a_run_that_ends_in_front_of_a_person_announces_it() {
    // The path that matters most: nobody is watching when this happens, which is the
    // entire premise of `wecode loop`.
    let (org, _) = with_agent("notify-run", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    let log = notified(&org, "echo $WECODE_TASK $WECODE_WAITING_FOR");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    assert_eq!(announcements(&log), vec!["t approval"]);
}

#[test]
fn the_message_carries_what_the_run_produced() {
    // The other half of answering from a phone. `t approval` says you are wanted; it
    // does not say what for, and deciding whether to sign meant opening a terminal to
    // look at the diff — which is the trip the hook exists to save. So the paths go
    // out with it, read out of git rather than taken from the agent's word for it.
    let (org, _) = with_agent("notify-made", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    let log = notified(
        &org,
        "echo $WECODE_CHANGED_COUNT $WECODE_CHANGED_FILES $WECODE_WORKTREE",
    );

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    let said = announcements(&log);
    assert_eq!(said.len(), 1, "one wait, one announcement: {said:?}");
    let mut parts = said[0].split_whitespace();
    assert_eq!(parts.next(), Some("1"), "one path changed: {said:?}");
    assert_eq!(parts.next(), Some("a.txt"), "and it is named: {said:?}");
    // The tree itself, so a hook wanting the diff rather than the names can ask git
    // for it. It is the work's own worktree, not the workspace or the repository.
    let tree = PathBuf::from(parts.next().expect("the tree: {said:?}"));
    assert!(tree.join("a.txt").is_file(), "not the worktree: {said:?}");
    assert_eq!(parts.next(), None, "nothing else on the line: {said:?}");
}

#[test]
fn the_message_carries_the_change_and_not_only_the_shape_of_it() {
    // What the names alone cannot answer. `1 a.txt` says the same thing whether the
    // attempt rewrote the file or corrected a letter in it, so an operator who can now
    // sign from a phone could sign without ever being shown what they were signing —
    // and the way to see it was `git -C $WECODE_WORKTREE diff`, which is a terminal,
    // which is the trip the whole hook exists to save.
    let (org, _) = with_agent("notify-diff", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    let log = notified(&org, "echo \\\"$WECODE_DIFF\\\"");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    let said = announcements(&log).join("\n");
    assert!(said.contains("a.txt"), "the file is not named: {said}");
    assert!(said.contains("+done"), "the change itself is missing: {said}");
}

#[test]
fn the_message_carries_the_report_the_record_will_keep() {
    // The last thing the operator was still doing by hand. The names say what was
    // touched and the diff says what happened in it, and adding those up — how much of
    // it there is, what it was held to, what has been queued behind it — was left to a
    // person holding a phone. wecode already writes that document; it wrote it *after*
    // the merge, which is after the decision it exists to inform.
    let (org, _) = with_agent("notify-report", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    let log = notified(&org, "echo \\\"$WECODE_REPORT\\\"");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    let said = announcements(&log).join("\n");
    assert!(said.contains("summary"), "no summary: {said}");
    assert!(said.contains("1 file, +1 −0"), "the change unadded-up: {said}");
    assert!(said.contains("a.txt"), "the file is not named: {said}");
    // What it was held to, which no diff contains and which is half of deciding.
    assert!(said.contains("acceptance"), "nothing to hold it to: {said}");
    assert!(said.contains("grep -q done a.txt"), "not the measure: {said}");
    // Listed and not ticked: the report goes out on `failed` waits too, and a tick
    // belongs to the record, which is written after a verdict that passed.
    assert!(!said.contains('✓'), "a proposal has passed nothing yet: {said}");
}

#[test]
fn the_report_and_the_record_are_one_document_and_not_two() {
    // The reason it is rendered from the merge record's own functions. An operator who
    // approved from a phone and the repository they approved it into have to agree about
    // what was signed; two renderers are two accounts of one change, free to drift, and
    // the shape of that bug is a signature given against a summary the record contradicts.
    let (org, repo) = mergeable("notify-report-kept", "auto");
    let log = notified(&org, "echo \\\"$WECODE_REPORT\\\"");
    landed_task(&org, "t");
    org.run(&["merge", "t"]).assert_ok("land it");

    let before = announcements(&log).join("\n");
    let after = git_out(&repo, &["show", "dev:docs/wecode/t/report.md"]);
    for shared in [
        "1 file, +1 −0",
        "what changed",
        "src/app.txt",
        "grep -q landed src/app.txt",
    ] {
        assert!(before.contains(shared), "missing before the merge: {before}");
        assert!(after.contains(shared), "missing after it: {after}");
    }
}

#[test]
fn the_names_are_capped_where_the_operator_says_and_the_count_never_is() {
    // Why the count is its own variable. The bound is on what an environment should
    // carry to a channel with one line in it; a message that answered "how much
    // changed" with the bound would be the notification agreeing with itself instead
    // of with the diff.
    let (org, _) = with_agent("notify-capped", "echo done >> a.txt; echo done >> b.txt");
    a_task(&org, "t", "*.txt", "grep -q done b.txt");
    let log = notified_with(
        &org,
        "echo $WECODE_CHANGED_COUNT $WECODE_CHANGED_FILES",
        "max_files = 1\n",
    );

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    assert_eq!(announcements(&log), vec!["2 a.txt"]);
}

#[test]
fn a_wait_for_permission_to_start_has_nothing_to_show_yet() {
    // `signature` is the one wait that comes before any work, and empty is what says
    // so. Reporting `0` here would have the notification describing an empty diff
    // that nothing produced — and a report of it would be worse still, since a report
    // is a document and an empty one reads as a finding rather than as an absence.
    let org = signs_first("notify-unmade", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    let log = notified(
        &org,
        "echo $WECODE_WAITING_FOR [$WECODE_CHANGED_COUNT] [$WECODE_WORKTREE] [$WECODE_REPORT]",
    );

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("⏸ t needs your signature");
    // The digest of that same pass is in front of it, and empty in the same fields for
    // the same reason: nothing has run, so there is nothing either could show.
    assert_eq!(
        announcements(&log),
        vec!["digest [] [] []", "signature [] [] []"]
    );
}

#[test]
fn the_message_says_what_may_be_signed_and_who_may_sign_it() {
    // The other half of answering from a phone, and the half that decides whether the
    // answer counts. A notification that says *you are wanted* under an *Approve* button
    // is offering a decision, and until this the hook writing that button knew neither
    // which approval it was nor whether the person it reached held one.
    let org = Org::new("notify-authority", "solo");
    org.seed();
    let log = notified(&org, "echo [$WECODE_SIGN] [$WECODE_SIGNERS]");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    // `merge` is the word that goes after `approve`, in a reply or on a button, and
    // `you` is the person whose seat holds it — the chief, in this template.
    assert_eq!(announcements(&log), vec!["[merge] [you]"]);
}

#[test]
fn the_gate_names_the_signature_it_is_holding_out_for() {
    // The wait with no status behind it names a different approval from the one at the
    // other end of the work: `admission` lets it start, `merge` lands it. A hook that
    // wrote `approve merge` on both would offer to sign work that has not run.
    let org = signs_first("notify-authority-gate", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    let log = notified(&org, "echo $WECODE_WAITING_FOR [$WECODE_SIGN] [$WECODE_SIGNERS]");

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("⏸ t needs your signature");
    // The pass's digest first — it names no single task, so it offers no signature of
    // its own — and then the wait itself, which does.
    assert_eq!(
        announcements(&log),
        vec!["digest [] []", "signature [admission] [you]"]
    );
}

#[test]
fn a_wait_that_no_signature_answers_offers_nothing_to_sign() {
    // `failed` is a decision for a person and not one a signature takes: there is no
    // `approve` for it, and a reply saying so is refused. So the button must not be
    // offered — a thumb that lands on it has decided something and settled nothing,
    // and the refusal prints where the operator is not standing.
    let org = Org::new("notify-unsignable", "solo");
    org.seed();
    let log = notified(&org, "echo [$WECODE_SIGN] [$WECODE_SIGNERS]");

    org.run(&["status", "cache-tests", "failed"])
        .assert_ok("stop it for a person");
    assert_eq!(announcements(&log), vec!["[] []"]);
}

#[test]
fn a_signature_no_seat_holds_is_announced_with_nobody_to_give_it() {
    // The empty list is the report. A workspace whose chart gives that approval to
    // nobody will refuse every `approve` for it, and the operator finds out by tapping
    // the button — from a phone, an hour after the wait began. Named at the wait
    // instead, the hook can say *this needs a seat that may sign merges* rather than
    // offering one that cannot be given.
    let org = Org::new("notify-unheld", "solo");
    org.seed();
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let stripped = text.replace(
        "approve = [\"admission\", \"design\", \"merge\"]",
        "approve = [\"admission\", \"design\"]",
    );
    assert_ne!(stripped, text, "the template's chief no longer signs merges");
    std::fs::write(&conf, stripped).unwrap();
    let log = notified(&org, "echo [$WECODE_SIGN] [$WECODE_SIGNERS]");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    // Still named: what is waiting has not changed, only who can end it.
    assert_eq!(announcements(&log), vec!["[merge] []"]);
}

#[test]
fn a_run_that_fails_its_acceptance_announces_that_instead() {
    let (org, _) = with_agent("notify-run-fail", "echo nothing >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    let log = notified(&org, "echo $WECODE_TASK $WECODE_WAITING_FOR");

    org.run(&["run", "t"]).assert_ok("run");
    assert_eq!(announcements(&log), vec!["t failed"]);
}

#[test]
fn the_loop_announces_a_task_it_is_holding_for_a_signature() {
    // The one wait with no status change behind it: the task is `ready` and stays
    // ready. Without this the dispatch gate is a queue that stops silently.
    let org = signs_first("notify-signature", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    let log = notified(
        &org,
        "echo $WECODE_TASK $WECODE_WAITING_FOR $WECODE_TASK_STATUS",
    );

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("⏸ t needs your signature");
    // With the pass's digest in front of it, which is about the queue and so names no
    // task, no reason of its own, and no status.
    assert_eq!(announcements(&log), vec!["digest", "t signature ready"]);
}

// ----------------------------------------------------------------- steps ------

/// A person's task with a briefing, promoted by the tick the way one really arrives.
///
/// `--steps` at declaration, `waiting` to hand it to the graph, and then nothing but a
/// tick: a manual task is never dispatched, so the promotion to `needs-approval` is the
/// whole of it becoming somebody's. Every steps test below goes through that path rather
/// than setting the status by hand, because a briefing that only reaches a phone when the
/// operator moves the task themselves is a briefing for a wait they already knew about.
fn a_manual_task(org: &Org, id: &str, steps: &str) {
    let file = org.path(&format!("{id}-steps.md"));
    std::fs::write(&file, steps).unwrap();
    org.run(&[
        "task",
        "add",
        id,
        "mint the fares token",
        "--project",
        "caching",
        "--by",
        "person",
        "--steps",
        file.to_str().unwrap(),
    ])
    .assert_ok("a person's task with its steps");
    // Startable and stated so, which is what a declaration with a post on it would have
    // said on its own. Announced by nothing: `waiting` is not a wait on a person.
    org.run(&["status", id, "waiting"])
        .assert_ok("hand it to the graph");
    org.run(&["tick"])
        .assert_ok("the tick hands it to a person");
}

#[test]
fn the_tick_tells_the_person_about_the_task_it_just_made_theirs() {
    // The promotion and the notification, closed. Nothing dispatches a person's task, so
    // this move is not a step on the way to the work — it *is* the work being handed
    // over, and the tick was making it silently. The operator learned they owned
    // something by opening the board, which is the one place a notifier exists to save
    // them from having to look.
    let org = Org::new("notify-promoted", "solo");
    org.seed();
    let log = notified(
        &org,
        "echo $WECODE_TASK $WECODE_WAITING_FOR $WECODE_TASK_STATUS [$WECODE_STEPS]",
    );

    a_manual_task(&org, "mint", "1. open the console");
    // The whole message, from the tick alone: what it is, what is wanted, and the work.
    assert_eq!(
        announcements(&log),
        vec!["mint approval needs-approval [1. open the console]"]
    );
}

#[test]
fn a_promotion_into_the_queue_announces_nothing() {
    // The control, and the reason this could be wired to every move the tick makes: an
    // agent's task becoming startable is not a wait. A hook that fired on `waiting →
    // ready` would announce every task in the plan on the pass that unblocked it, which
    // is the notifier the operator switches off.
    let org = Org::new("notify-promoted-agent", "solo");
    org.seed();
    let log = notified(&org, "echo $WECODE_TASK $WECODE_TASK_STATUS");

    org.run(&["status", "cache-tests", "waiting"])
        .assert_ok("hand it to the graph");
    org.run(&["tick"])
        .assert_ok("tick")
        .assert_contains("waiting → ready");
    assert!(announcements(&log).is_empty(), "{:?}", announcements(&log));
}

#[test]
fn the_loop_announces_the_promotion_it_makes_itself() {
    // The same move, from the command that actually runs unattended. The tick command is
    // the one an operator types; this is the one that is running at 02:14, and a
    // notification only the typed one sends is a notification nobody receives.
    let org = Org::new("notify-promoted-loop", "solo");
    org.seed();
    let log = notified(&org, "echo $WECODE_TASK $WECODE_WAITING_FOR");
    let file = org.path("mint-steps.md");
    std::fs::write(&file, "1. open the console\n").unwrap();
    org.run(&[
        "task",
        "add",
        "mint",
        "mint the fares token",
        "--project",
        "caching",
        "--by",
        "person",
        "--steps",
        file.to_str().unwrap(),
    ])
    .assert_ok("a person's task with its steps");
    org.run(&["status", "mint", "waiting"])
        .assert_ok("hand it to the graph");

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("mint  waiting → needs-approval");
    // First, and before the pass's digest: the promotion is the edge, and the digest
    // behind it is the standing condition it has just joined.
    assert_eq!(
        announcements(&log).first().map(String::as_str),
        Some("mint approval"),
        "{:?}",
        announcements(&log)
    );
}

#[test]
fn a_persons_task_hands_the_hook_the_work_itself() {
    // The complaint this answers, in the owner's words: "I don't have instruction on the
    // ticket — what should I do step by step?" Every other wait has a diff behind it and
    // the message is about work already done; this one has nothing behind it, so the
    // instructions *are* the message. A title and a number is an operator being woken up
    // and asked to guess.
    let org = Org::new("notify-steps", "solo");
    org.seed();
    let log = notified(&org, "echo [$WECODE_STEPS]");
    a_manual_task(&org, "mint", "1. open the console\n2. create a token\n");

    let said = announcements(&log).join("\n");
    assert!(said.contains("1. open the console"), "no steps: {said}");
    assert!(said.contains("2. create a token"), "cut short: {said}");
}

#[test]
fn the_steps_go_over_as_a_document_as_well_as_a_message() {
    // Both shapes, because a runbook longer than a chat message is exactly the one worth
    // sending — and a manual task has no worktree, so a hook that wanted to attach the
    // document had nothing to attach. The file is wecode's, written for the length of the
    // hook and taken away after it: what it holds is the whole of the steps, uncut.
    let org = Org::new("notify-steps-doc", "solo");
    org.seed();
    // One pipeline, because the redirect `notified` appends belongs to the last command
    // in it: the path first, then the document itself read back out of the file.
    let log = notified(&org, "echo [$WECODE_STEPS_FILE] | cat - $WECODE_STEPS_FILE");
    let steps = "1. open the console\n2. create a token\n3. paste it into the vault\n";
    a_manual_task(&org, "mint", steps);

    let said = announcements(&log).join("\n");
    assert!(said.contains("3. paste it into the vault"), "not it: {said}");
    // The path the hook was handed, and the file is gone by now: it is a handle for one
    // `sendDocument`, not a second place the steps live.
    let path = said
        .rsplit('[')
        .next()
        .and_then(|s| s.split(']').next())
        .expect("the path was handed over");
    assert!(path.contains("wecode-steps"), "not wecode's file: {said}");
    assert!(
        !Path::new(path).exists(),
        "the handed-over document outlived the notification: {path}"
    );
}

#[test]
fn a_briefing_longer_than_a_message_is_marked_and_not_quietly_cut() {
    // The bound is the channel's — Telegram refuses a message over 4096 characters — and
    // the cut has to say so, for the reason the diff's does: a person reading step 40 of
    // 60 has to know there are 60. Unlike a diff, where the rest is only in the tree, the
    // rest of this is in the file named in the same breath.
    let org = Org::new("notify-steps-long", "solo");
    org.seed();
    let log = notified(&org, "echo \\\"$WECODE_STEPS\\\" | tail -2");
    let long: String = (1..=300).map(|n| format!("{n}. do the next thing\n")).collect();
    assert!(long.len() > 4000, "the fixture has to exceed the bound");
    a_manual_task(&org, "mint", &long);

    let said = announcements(&log).join("\n");
    assert!(said.contains("truncated"), "cut without saying so: {said}");
    assert!(
        said.contains("WECODE_STEPS_FILE"),
        "cut off mid-instruction with nowhere to look: {said}"
    );
}

#[test]
fn an_agents_wait_carries_no_steps_at_all() {
    // The control. An agent is told what to do at dispatch, out of the plan and the
    // repository, and `--steps` is refused on its task — so both variables are empty for
    // every wait wecode was announcing before this existed. Empty rather than a title
    // repeated back: a hook that put a heading over these would be printing an empty
    // document as instructions.
    let org = Org::new("notify-steps-none", "solo");
    org.seed();
    let log = notified(&org, "echo [$WECODE_STEPS][$WECODE_STEPS_FILE]");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    assert_eq!(announcements(&log), vec!["[][]"]);
}

// ---------------------------------------------------------------- digest ------

#[test]
fn the_loop_sends_the_standing_condition_on_the_rhythm_the_config_promises() {
    // The half an edge cannot cover. A wait is announced once, as it begins; an hour
    // later nothing has said so again, and the operator is not standing at the terminal
    // the loop prints its pauses to. `[attention] digest_interval_mins` has promised a
    // rhythm since the first company.toml, and until now nothing kept it.
    let org = Org::new("notify-digest", "solo");
    org.seed();
    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    // Hooked after the wait began, so what reaches the log is the digest by itself.
    let log = notified(&org, "echo [$WECODE_WAITING_FOR] \\\"$WECODE_DIGEST\\\"");

    org.run(&["loop", "--once"]).assert_ok("one pass");
    let said = announcements(&log).join("\n");
    // A fifth word, not one of the four: this message is about no single task, and a
    // hook that branches on the reason is handed one it does not know rather than one
    // that is wrong.
    assert!(said.contains("[digest]"), "not marked as a digest: {said}");
    assert!(said.contains("1 waiting on you"), "no tally: {said}");
    assert!(said.contains("cache-tests"), "which work is it: {said}");
    // Answerable from where it arrives, which is the whole point of sending it: the
    // number to name and the word that goes after `approve`.
    assert!(said.contains("approve merge #2"), "not answerable: {said}");
}

#[test]
fn the_digest_carries_the_dispatch_gate_beside_the_statuses() {
    // Both halves of a stopped queue, because they are one thing from where the operator
    // stands. The gate holds a task that is `ready` — no status says it is waiting — so a
    // digest built from the board alone would report an empty queue while nothing moved.
    let org = signs_first("notify-digest-gate", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    let log = notified(&org, "echo [$WECODE_WAITING_FOR] \\\"$WECODE_DIGEST\\\"");

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("⏸ t needs your signature");
    let said = announcements(&log).join("\n");
    assert!(said.contains("[digest]"), "no digest: {said}");
    assert!(said.contains("t "), "the task is not in it: {said}");
    assert!(said.contains("approve admission #"), "not answerable: {said}");
    // And the wait's own announcement still went out beside it. The digest is the state
    // and does not replace the edge — a task that stops at 02:14 still says so at 02:14.
    assert!(said.contains("[signature]"), "the edge is missing: {said}");
}

#[test]
fn a_digest_is_not_sent_when_nothing_is_standing() {
    // A message that arrived to report an empty queue is an interruption spent saying
    // there was no reason to interrupt, which is how a notifier gets switched off.
    let org = Org::new("notify-digest-quiet", "solo");
    org.seed();
    let log = notified(&org, "echo $WECODE_WAITING_FOR");

    org.run(&["loop", "--once"]).assert_ok("one pass");
    assert!(announcements(&log).is_empty(), "{:?}", announcements(&log));
}

#[test]
fn a_zero_interval_is_a_digest_switched_off() {
    // `0` cannot mean one every pass: the loop passes every five seconds, and a
    // notification that repeats until it is silenced is the failure this file is about.
    let org = Org::new("notify-digest-off", "solo");
    org.seed();
    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    let log = notified(&org, "echo $WECODE_WAITING_FOR");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let off = text.replace("digest_interval_mins = 20", "digest_interval_mins = 0");
    assert_ne!(off, text, "the template's interval was not replaced");
    std::fs::write(&conf, off).unwrap();

    org.run(&["loop", "--once"]).assert_ok("one pass");
    assert!(announcements(&log).is_empty(), "{:?}", announcements(&log));
}

#[test]
fn a_hook_that_fails_is_reported_without_touching_the_verdict() {
    // A notification is not part of judging the work. The task stopped for a person
    // whether or not anything managed to tell them, and a command that failed because
    // its notifier did would send the operator hunting in the wrong place.
    let org = Org::new("notify-broken", "solo");
    org.seed();
    hooked(&org, "exit 7");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("the status change still succeeds")
        .assert_contains("⚠ notify")
        .assert_contains("exited 7");
    org.run(&["show", "cache-tests"])
        .assert_contains("status     needs-approval");
}

#[test]
fn a_hook_that_exits_well_and_refuses_the_message_is_not_reported_as_a_delivery() {
    // The failure this half of the module exists for. A chat API refuses a wrong id in
    // its *reply*: the `curl` carrying the refusal exits `0` having done exactly what it
    // was asked, and its body went to stdout, which wecode used to throw away. So a
    // message that never arrived reached the terminal as the same silence a delivered
    // one does — and the operator waits on a phone for a notification that was refused
    // an hour ago, which is the whole thing this module is for.
    let org = Org::new("notify-refused", "solo");
    org.seed();
    hooked(&org, "echo Bad Request: chat not found");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("the status change still succeeds")
        .assert_contains("⚠ notify")
        .assert_contains("Bad Request: chat not found");
    // Still not a verdict about the work: the task stopped for a person whether or not
    // anything managed to tell them.
    org.run(&["show", "cache-tests"])
        .assert_contains("status     needs-approval");
}

#[test]
fn a_hook_that_delivers_quietly_is_left_alone() {
    // The control, and the reason the rule can be this weak. A notifier that got its
    // `200` has nothing to say, and a report on every announcement would be a warning
    // the operator learns to read past — which is how the refusal above gets missed.
    let org = Org::new("notify-quiet-hook", "solo");
    org.seed();
    hooked(&org, "true");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person")
        .assert_lacks("⚠ notify");
}

#[test]
fn a_hook_that_fails_is_reported_with_the_reason_it_gave_for_failing() {
    // `exited 6` names the failure and not the cause. The cause was in the sentence the
    // hook wrote on the way out, and answering "why did nothing tell me" from a status
    // number alone means going and running the notifier by hand.
    let org = Org::new("notify-why", "solo");
    org.seed();
    hooked(&org, "echo could not resolve api.example.invalid >&2; exit 6");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("the status change still succeeds")
        .assert_contains("exited 6")
        // Caught on stderr as readily as on stdout: `curl` complains on one and prints
        // the refusal it is complaining about on the other.
        .assert_contains("could not resolve api.example.invalid");
}

#[test]
fn a_hook_that_floods_is_quoted_by_one_line_and_does_not_stall_the_run() {
    // Two bounds at once. A notifier's chatter must not become the record of the work —
    // that is why it was thrown away in the first place — so however much it wrote, one
    // line of it goes beside the wait. And it must be able to write more than a pipe
    // holds without the run stopping to wait on it.
    let org = Org::new("notify-loud", "solo");
    org.seed();
    hooked(&org, "seq 1 40000");

    let r = org.run(&["status", "cache-tests", "needs-approval"]);
    r.assert_ok("the status change still succeeds")
        .assert_contains("said: 1")
        .assert_lacks("39999");
    assert!(
        r.all().lines().count() < 20,
        "the hook buried the run:\n{}",
        r.all()
    );
}

#[test]
fn a_workspace_with_no_hook_runs_nothing() {
    // The default. Every workspace that has never heard of the setting is one of
    // these, and none of them may start a process because a task stopped.
    let org = Org::new("notify-absent", "solo");
    org.seed();
    org.run(&["status", "cache-tests", "failed"])
        .assert_ok("stop it")
        .assert_lacks("notify");
}

#[test]
fn a_notify_command_the_charter_forbids_is_refused_rather_than_run() {
    // An invariant outranks every grant, and company.toml does not get to be the
    // exception because the line happens to be in a different block of it.
    let org = Org::new("notify-forbidden", "solo");
    org.seed();
    // Written relative, because the hook runs in the workspace: an absolute path in
    // the command line would put a `/` in it, and `*` stays inside one segment.
    let log = org.path("notified.txt");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let charter = text.replace(
        "never_run = [\"git push --force*\", \"npm publish*\"]",
        "never_run = [\"git push --force*\", \"curl *\"]",
    );
    assert_ne!(charter, text, "the template's never_run was not replaced");
    std::fs::write(
        &conf,
        format!("{charter}\n[notify]\ncommand = \"curl -so notified.txt example.invalid\"\n"),
    )
    .unwrap();

    org.run(&["status", "cache-tests", "failed"])
        .assert_ok("the task still stops")
        .assert_contains("never_run");
    assert!(!log.exists(), "the hook must not have run");
}

#[test]
fn the_profile_says_whether_anything_will_tell_you() {
    // Both ways round, because "why did nothing tell me" is answered by the absence
    // as much as by the command, and a line only printed when a hook exists answers
    // it with the same silence being complained about.
    let org = Org::new("notify-shown", "solo");
    org.run(&["company", "show"])
        .assert_ok("show")
        .assert_contains("notify:    nothing");

    notified(&org, "echo $WECODE_TASK");
    org.run(&["company", "show"])
        .assert_ok("show")
        .assert_contains("when a task starts waiting, killed after 30s");
}

#[test]
fn a_notify_block_with_nothing_to_run_is_refused_at_load() {
    // The failure a gate must not have: a setting that reads as configured and
    // behaves as absent. Refused where every other bad value in this file is.
    let org = Org::new("notify-blank", "solo");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, format!("{text}\n[notify]\ncommand = \"\"\n")).unwrap();

    let r = org.run(&["company", "show"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("[notify] command");
}
