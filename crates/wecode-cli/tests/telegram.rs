//! Answering wecode from a chat: what a reply signs, and what a tap does.

mod support;

use std::path::{Path, PathBuf};

use support::Org;
use support::agent::{a_task_in_src, signs_first};
use support::merge::{landed_task, mergeable};

// -------------------------------------------------------------- telegram ------

/// Points the workspace's reply channel at a file, and says which account the user in
/// the chief's seat replies from. Returns the file to write updates into.
///
/// `cat` rather than `curl`: what is being proved is that what the channel says gets
/// signed, and a real bot token would prove the same thing only on a machine that has
/// one. The fetch being a command line is exactly what makes the substitution possible.
fn chatting(org: &Org, account: &str) -> PathBuf {
    let replies = org.path("replies.json");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let claimed = text.replace(
        "[[users]]\nname = \"you\"\npost = \"chief\"",
        &format!("[[users]]\nname = \"you\"\npost = \"chief\"\ntelegram = \"{account}\""),
    );
    assert_ne!(claimed, text, "the template's user block was not replaced");
    std::fs::write(
        &conf,
        format!(
            "{claimed}\n[telegram]\nfetch = \"cat {}\"\n",
            replies.display()
        ),
    )
    .unwrap();
    replies
}

/// One update, shaped the way the Bot API hands it over. `from` is unquoted, because
/// Telegram sends account ids as numbers and `company.toml` writes them as strings.
fn reply(id: i64, from: &str, text: &str, answering: &str) -> String {
    let message = format!(
        "{{\"message_id\":{id},{}{}{}{}}}",
        format_args!("\"from\":{{\"id\":{from},\"is_bot\":false,\"username\":\"you\"}},"),
        format_args!("\"chat\":{{\"id\":{from},\"type\":\"private\"}},\"date\":1770000000,"),
        format_args!("\"text\":\"{text}\","),
        format_args!("\"reply_to_message\":{{\"message_id\":1,\"text\":\"{answering}\"}}"),
    );
    format!("{{\"update_id\":{id},\"message\":{message}}}")
}

/// One tapped button, shaped the way the Bot API hands it over. A `callback_query` rather
/// than a message: it carries the `data` the operator put on the button, and the
/// notification the keyboard hangs under in place of a message replied to.
fn tapped(id: i64, from: &str, data: &str, under: &str) -> String {
    let query = format!(
        "{{\"id\":\"cb{id}\",{}{}{}}}",
        format_args!("\"from\":{{\"id\":{from},\"is_bot\":false,\"username\":\"you\"}},"),
        format_args!("\"chat_instance\":\"-176\",\"data\":\"{data}\","),
        format_args!("\"message\":{{\"message_id\":1,\"text\":\"{under}\"}}"),
    );
    format!("{{\"update_id\":{id},\"callback_query\":{query}}}")
}

/// Gives the workspace something to say what came of a tap with, added to the
/// `[telegram]` block [`chatting`] wrote. Returns the file that command appends to.
///
/// `echo` rather than `curl`, for [`chatting`]'s reason: what is being proved is that the
/// callback and the outcome reach the operator's line, and a real `answerCallbackQuery`
/// would prove that only on a machine with a bot token on it.
fn acknowledging(org: &Org) -> PathBuf {
    let said = org.path("answered.txt");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    assert!(text.contains("[telegram]"), "chatting() comes first");
    std::fs::write(
        &conf,
        format!(
            "{text}answer = \"echo \\\"$WECODE_TELEGRAM_CALLBACK $WECODE_TELEGRAM_ANSWER\\\" >> {}\"\n",
            said.display()
        ),
    )
    .unwrap();
    said
}

/// What the channel is holding right now.
fn holding(replies: &Path, updates: &[String]) {
    std::fs::write(
        replies,
        format!("{{\"ok\":true,\"result\":[{}]}}", updates.join(",")),
    )
    .unwrap();
}

#[test]
fn a_reply_signs_the_merge_it_answers() {
    // The gap this closes. Everything up to the signature happens unattended, the
    // notification reaches a phone, and until now the signature still needed a
    // terminal — so work that passed at 02:14 landed in the morning anyway.
    let (org, _) = mergeable("tg-merge", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(
            700_123,
            "48210934",
            "approve",
            "t needs you: approval",
        )],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("approved merge");

    // How it arrived is on the record, and the post's coding agent is not: nobody typed
    // this at a keyboard, and a row saying `claude-code` would say so.
    org.run(&["audit", "--task", "t"])
        .assert_ok("audit")
        .assert_contains("chief       telegram");

    // The gate that reads the signature has no idea a phone was involved, which is the
    // whole design: one ledger record, given by the post, however it arrived.
    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("MERGED  t → dev");
}

#[test]
fn a_tap_signs_the_merge_the_notification_is_about() {
    // The last of the typing gone. The operator is holding a phone at 02:14, the
    // notification has an *Approve* button on it, and one thumb lands the work — no
    // keyboard, and nothing to remember about which task it was.
    let (org, _) = mergeable("tg-tap", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(
            700_125,
            "48210934",
            "approve",
            "t needs you: approval",
        )],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("approved merge");

    // Told back to the phone that sent it, which is the half a tap needs and a typed
    // reply does not: the callback to answer, and what came of it.
    let back = std::fs::read_to_string(&said).expect("the tap was acknowledged");
    assert!(back.contains("cb700125"), "{back}");
    assert!(back.contains("approved merge"), "{back}");

    // And it is the same signature by the same seat as a typed reply — one ledger
    // record, given by the post, however it arrived.
    org.run(&["audit", "--task", "t"])
        .assert_ok("audit")
        .assert_contains("chief       telegram");
    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("MERGED  t → dev");
}

#[test]
fn a_tap_from_an_account_nobody_claims_is_told_it_signed_nothing() {
    // A button is more findable than a sentence: anyone in the chat can press it. The
    // identity check is the same one a typed reply gets — and the refusal goes back to
    // the phone, because a stranger left looking at a spinner learns less than the
    // operator whose own id is missing from `company.toml` does.
    let (org, _) = mergeable("tg-tap-stranger", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(1, "99999999", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("no user in company.toml");

    let back = std::fs::read_to_string(&said).expect("the tap was acknowledged");
    assert!(back.contains("cb1"), "{back}");
    assert!(back.contains("no user in company.toml"), "{back}");
    assert!(
        !org.run(&["merge", "t"]).ok(),
        "an unclaimed account must not be able to land work by button either"
    );
}

#[test]
fn a_button_that_decides_nothing_is_told_so_rather_than_left_looking_broken() {
    // `data` is a string the operator put on their own keyboard, so a tap that says
    // nothing recognisable is a keyboard to fix — and the person who can fix it is the
    // one holding the phone. Chat is passed over silently; a button never is.
    let (org, _) = mergeable("tg-tap-odd", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(
            3,
            "48210934",
            "sure why not",
            "t needs you: approval",
        )],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("that button decides nothing");

    let back = std::fs::read_to_string(&said).expect("the tap was acknowledged");
    assert!(back.contains("cb3"), "{back}");
    assert!(!org.run(&["merge", "t"]).ok(), "nothing was signed");
}

#[test]
fn a_typed_reply_is_left_to_be_its_own_receipt() {
    // The asymmetry is the whole reason `answer` exists. A typed `approve` is already in
    // the chat, in front of the person who typed it; saying it back would be wecode
    // repeating them. A tap leaves nothing behind, so it is told what it did.
    let (org, _) = mergeable("tg-typed-quiet", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[reply(2, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("approved merge");
    assert!(!said.exists(), "a typed reply was answered back at");
}

#[test]
fn a_dry_run_says_nothing_into_the_chat_either() {
    // "Moves nothing" has to include the chat. A dry run that acknowledged a tap would
    // tell the operator their button had been dealt with, and leave it to be dealt with
    // again on the next pass.
    let (org, _) = mergeable("tg-tap-dry", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(11, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram", "--dry-run"])
        .assert_ok("dry run")
        .assert_contains("would sign merge for t");
    assert!(!said.exists(), "a dry run spoke into the chat");

    // And the tap is still there to be acted on, and acknowledged, for real.
    org.run(&["telegram"])
        .assert_ok("for real")
        .assert_contains("approved merge");
    assert!(
        std::fs::read_to_string(&said).unwrap().contains("cb11"),
        "the tap was acknowledged on the pass that acted on it"
    );
}

#[test]
fn a_tap_that_could_not_be_acknowledged_keeps_its_signature() {
    // `answerCallbackQuery` refuses a query more than a minute old, so this is the
    // ordinary failure and not an exotic one. It must be a warning: the signature is
    // already given, and un-signing it because the receipt bounced would lose the
    // approval the operator actually gave.
    let (org, _) = mergeable("tg-tap-mute", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}answer = \"echo query is too old >&2; exit 6\"\n"),
    )
    .unwrap();
    holding(
        &replies,
        &[tapped(4, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("a receipt that bounced is a report, not a crash")
        .assert_contains("approved merge")
        // Said under the outcome, so it is clear which of the two failed.
        .assert_contains("could not say so in the chat")
        .assert_contains("query is too old");
    org.run(&["merge", "t"]).assert_ok("merge");
}

#[test]
fn an_answer_with_no_fetch_to_read_the_taps_is_refused_at_load() {
    // Nothing would ever run it — taps arrive through the fetch — so it reads as
    // configured and behaves as absent, which is the shape `[telegram]` already refuses.
    let org = Org::new("tg-answer-alone", "solo");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, format!("{text}\n[telegram]\nanswer = \"true\"\n")).unwrap();

    let r = org.run(&["company", "show"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("nothing would read");
}

#[test]
fn a_reply_from_an_account_nobody_claims_signs_nothing() {
    // The only identity check there is. There is no fallback seat for a stranger who
    // finds the bot, and a message from one must be worth exactly nothing.
    let (org, _) = mergeable("tg-stranger", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(1, "99999999", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("no user in company.toml");

    let r = org.run(&["merge", "t"]);
    assert!(
        !r.ok(),
        "an unclaimed account must not be able to land work"
    );
    r.assert_contains("needs a signature");
}

#[test]
fn a_reply_from_a_seat_that_may_not_approve_is_refused_and_recorded() {
    // Naming an account says who somebody is. What they may sign is the post's
    // business, decided by the Broker at the moment of signing — the same refusal the
    // same person would get typing it at a terminal.
    let (org, _) = mergeable("tg-ungranted", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    // The engineer's seat: it writes code and signs nothing.
    std::fs::write(
        &conf,
        format!("{text}\n[[users]]\nname = \"dev\"\npost = \"impl\"\ntelegram = \"777\"\n"),
    )
    .unwrap();
    holding(
        &replies,
        &[reply(1, "777", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("a refused reply is a report, not a crash")
        .assert_contains("refused for `impl`");
    // Recorded, like every other refusal: an attempt to sign is worth knowing about.
    org.run(&["audit", "--denied"])
        .assert_ok("audit")
        .assert_contains("approve");

    assert!(!org.run(&["merge", "t"]).ok(), "nothing was signed");
}

#[test]
fn a_message_is_acted_on_once_however_often_the_channel_is_read() {
    // The channel hands the same message back until it is told not to, and `wecode
    // loop` reads it every five seconds. Without a cursor, one "approve" would be a
    // signature per pass, forever.
    let (org, _) = mergeable("tg-once", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(42, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("first read")
        .assert_contains("approved merge");
    org.run(&["telegram"])
        .assert_ok("second read")
        .assert_contains("nothing to sign")
        .assert_lacks("approved merge");
}

#[test]
fn a_reply_that_says_no_signs_nothing_and_leaves_the_task_in_front_of_a_person() {
    // Withholding the signature is what "no" already means, and it is the only thing a
    // one-word reply is precise enough to say. The task stays where it is.
    let (org, _) = mergeable("tg-no", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(3, "48210934", "no", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("t stays needs-approval")
        .assert_lacks("approved");
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");
    assert!(!org.run(&["merge", "t"]).ok(), "nothing was signed");
}

#[test]
fn chat_that_is_not_a_decision_is_left_alone() {
    // A channel people talk in is a channel wecode has to be quiet in. Guessing at
    // "what is this one doing?" is how a signature gets given by accident.
    let (org, _) = mergeable("tg-chat", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(
            5,
            "48210934",
            "what is t doing?",
            "t needs you: approval",
        )],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("nothing to sign")
        .assert_lacks("approved");
}

#[test]
fn a_reply_answering_nothing_recognisable_says_so_and_is_still_got_past() {
    // Two properties at once, because they are the same property: a message that
    // cannot be acted on is reported *and* consumed. One reported and left behind
    // would be the same complaint on every pass, forever.
    let (org, _) = mergeable("tg-nothing", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(&replies, &[reply(8, "48210934", "approve", "all clear")]);

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("names no task");
    org.run(&["telegram"])
        .assert_ok("second read")
        .assert_contains("nothing to sign");
}

#[test]
fn a_dry_run_says_what_would_be_signed_and_moves_neither_a_signature_nor_the_cursor() {
    let (org, _) = mergeable("tg-dry", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(11, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram", "--dry-run"])
        .assert_ok("dry run")
        .assert_contains("would sign merge for t");
    assert!(!org.run(&["merge", "t"]).ok(), "a dry run signed something");

    // And the message is still there to be acted on for real, which is the half of
    // "moves nothing" that is easy to get wrong.
    org.run(&["telegram"])
        .assert_ok("for real")
        .assert_contains("approved merge");
    org.run(&["merge", "t"]).assert_ok("merge");
}

#[test]
fn the_loop_signs_the_dispatch_gate_from_a_reply_and_then_dispatches() {
    // The whole loop closed, in one pass: a task the gate is holding, a reply to the
    // notification about it, and the work starting — with nobody at a terminal.
    let org = signs_first("tg-loop", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(9, "48210934", "approve", "t needs your signature")],
    );

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("approved admission")
        // Read before the queue is, so a signature releases work on the pass that
        // finds it rather than the one after.
        .assert_contains("▶ t")
        .assert_lacks("⏸ t needs your signature");
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");
}

#[test]
fn a_loop_whose_channel_is_unreachable_keeps_working() {
    // A channel that cannot be reached is a reason to keep going unattended, not a
    // reason to stop: the work is what the loop is for.
    let org = Org::new("tg-unreachable", "solo");
    org.seed();
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[telegram]\nfetch = \"echo no route to host >&2; exit 6\"\n"),
    )
    .unwrap();

    org.run(&["loop", "--once"])
        .assert_ok("the pass still runs")
        .assert_contains("⚠ telegram")
        .assert_contains("no route to host");
}

#[test]
fn a_fetch_the_charter_forbids_is_refused_rather_than_run() {
    // The line that polls a chat channel is no more above the charter than the line
    // that launches an agent, and it is written in the same file the charter is.
    let org = Org::new("tg-forbidden", "solo");
    org.seed();
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let charter = text.replace(
        "never_run = [\"git push --force*\", \"npm publish*\"]",
        "never_run = [\"git push --force*\", \"curl *\"]",
    );
    assert_ne!(charter, text, "the template's never_run was not replaced");
    std::fs::write(
        &conf,
        format!("{charter}\n[telegram]\nfetch = \"curl -so replies.json example.invalid\"\n"),
    )
    .unwrap();

    let r = org.run(&["telegram"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("never_run");
    assert!(
        !org.path("replies.json").exists(),
        "the fetch must not have run"
    );
}

#[test]
fn a_workspace_with_no_channel_says_so_rather_than_reading_nothing() {
    let org = Org::new("tg-absent", "solo");
    let r = org.run(&["telegram"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("[telegram] fetch");
}

#[test]
fn the_profile_says_whether_a_reply_can_sign_anything() {
    // "I replied and nothing happened" has two answers — nothing reads the channel, or
    // nothing knows the account that replied — and both are in one place.
    let org = Org::new("tg-shown", "solo");
    org.run(&["company", "show"])
        .assert_ok("show")
        .assert_contains("replies:   nothing");

    chatting(&org, "48210934");
    org.run(&["company", "show"])
        .assert_ok("show")
        .assert_contains("signed by: you");
}

#[test]
fn a_telegram_block_with_nothing_to_run_is_refused_at_load() {
    // The failure a gate must not have, in the shape `[notify]` already refuses: a
    // block that says replies will be read and a value that means none ever are.
    let org = Org::new("tg-blank", "solo");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, format!("{text}\n[telegram]\nfetch = \"\"\n")).unwrap();

    let r = org.run(&["company", "show"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("[telegram] fetch");
}
