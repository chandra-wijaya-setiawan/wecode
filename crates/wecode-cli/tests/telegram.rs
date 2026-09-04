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
        format_args!(
            "\"message\":{{\"message_id\":1,\"chat\":{{\"id\":{from}}},\"text\":\"{under}\"}}"
        ),
    );
    format!("{{\"update_id\":{id},\"callback_query\":{query}}}")
}

/// The same tap, from a keyboard whose notification Telegram will no longer hand over.
/// The `callback_query` still arrives and still carries `data`; what is missing is the
/// message the button is on, and so any way to take the button off it.
fn tapped_orphaned(id: i64, from: &str, data: &str) -> String {
    format!(
        "{{\"update_id\":{id},\"callback_query\":{{\"id\":\"cb{id}\",{}\"data\":\"{data}\"}}}}",
        format_args!("\"from\":{{\"id\":{from},\"is_bot\":false,\"username\":\"you\"}},"),
    )
}

/// Gives the workspace something to say what came of a tap with, added to the
/// `[telegram]` block [`chatting`] wrote. Returns the file that command appends to.
///
/// `echo` rather than `curl`, for [`chatting`]'s reason: what is being proved is that the
/// callback, the button's own address and the outcome reach the operator's line, and a
/// real `answerCallbackQuery` would prove that only on a machine with a bot token on it.
///
/// The whole environment on one line, in the order a hook uses it: what to acknowledge,
/// which message to edit, which task was decided, which chat asked, and what to say.
/// `at:/` with nothing after it is the shape of a button that cannot be taken off
/// anything — see [`tapped_orphaned`] — and an empty callback is the shape of a decision
/// nobody tapped. `ask:` empty is everything that is a receipt rather than an answer.
fn acknowledging(org: &Org) -> PathBuf {
    let said = org.path("answered.txt");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    assert!(text.contains("[telegram]"), "chatting() comes first");
    std::fs::write(
        &conf,
        format!(
            "{text}answer = \"echo \\\"cb:$WECODE_TELEGRAM_CALLBACK at:$WECODE_TELEGRAM_CHAT/$WECODE_TELEGRAM_MESSAGE for:$WECODE_TASK#$WECODE_TASK_NUMBER ask:$WECODE_TELEGRAM_ASKED $WECODE_TELEGRAM_ANSWER\\\" >> {}\"\n",
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
fn a_decided_button_is_told_where_it_is_so_it_can_stop_looking_like_an_offer() {
    // The receipt is a toast: three seconds and it is gone. What stays on the phone is
    // the notification, still saying *needs your signature*, still carrying *Approve* —
    // a question that has been answered, still asking. The next thumb to land on it
    // decides something already decided.
    //
    // wecode holds no token and cannot edit that message. So it says which message: the
    // chat and the message id the tapped keyboard hangs on, beside the callback, and one
    // `editMessageReplyMarkup` with no keyboard on it turns the offer into a record.
    let (org, _) = mergeable("tg-tap-settled", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(
            700_126,
            "48210934",
            "approve",
            "t needs you: approval",
        )],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("approved merge");

    let back = std::fs::read_to_string(&said).expect("the tap was acknowledged");
    // Everything an edit needs, in one environment with the callback the spinner needs:
    // one command, because taking the buttons off and saying why are one act.
    assert!(back.contains("cb700126"), "{back}");
    assert!(back.contains("at:48210934/1"), "{back}");
    assert!(back.contains("approved merge"), "{back}");
    // And which task it was, under the names the notify hook was given when it sent the
    // message: a hook that noted its own message id per task is the hook that clears the
    // row, and a receipt that cannot name the task cannot clear anything.
    assert!(back.contains("for:t#2"), "{back}");
}

#[test]
fn a_signature_typed_at_a_terminal_stops_the_phone_asking() {
    // The other half of the same failure. A tap that signs turns the message it came from
    // into a record; a signature typed where the operator happens to be standing said
    // nothing into the chat at all, so the notification went on offering a decision that
    // had been taken — and the next thumb to land on it decided a settled question.
    let (org, _) = mergeable("tg-typed-at-terminal", "approved");
    landed_task(&org, "t");
    chatting(&org, "48210934");
    let said = acknowledging(&org);

    org.run(&["approve", "merge", "--task", "t"])
        .assert_ok("sign it where the operator is standing")
        .assert_contains("approved merge");

    let back = std::fs::read_to_string(&said).expect("the chat was told");
    // No callback and no address, and empty is the answer rather than half of one: nothing
    // was tapped, so no spinner is waiting on this — and wecode never learns the id its own
    // notification landed as, because the hook that sent it is what was told that.
    assert!(back.contains("cb: at:/"), "{back}");
    // So the task is what the message is found by, named the way the notify hook was told
    // it. This is the only handle a decision taken away from the chat has.
    assert!(back.contains("for:t#2"), "{back}");
    assert!(back.contains("approved merge"), "{back}");
}

#[test]
fn work_landed_at_a_terminal_stops_the_phone_asking_too() {
    // The case with no signature anywhere in it. An `auto` project lands verified work
    // without one, and the notification that announced it carried *Approve* all the same —
    // so nothing else in the run would ever tell the chat the question had gone away.
    let (org, _) = mergeable("tg-merged-at-terminal", "auto");
    landed_task(&org, "t");
    chatting(&org, "48210934");
    let said = acknowledging(&org);

    org.run(&["merge", "t"])
        .assert_ok("land it")
        .assert_contains("MERGED  t → dev");

    let back = std::fs::read_to_string(&said).expect("the chat was told");
    assert!(back.contains("for:t#2"), "{back}");
    // One sentence and not the report: what is being turned from an offer into a record
    // has a caption's worth of room, and what it has to say is that this is done.
    assert!(back.contains("merged t → dev"), "{back}");
}

#[test]
fn a_terminal_signature_says_nothing_where_there_is_nothing_to_say_it_with() {
    // A workspace that reads replies but has no line to answer with keeps working, and
    // quietly: warning about a chat nobody asked to be told would make `[telegram] answer`
    // effectively compulsory for anyone who ever typed `wecode approve`.
    let (org, _) = mergeable("tg-terminal-quiet", "approved");
    landed_task(&org, "t");
    chatting(&org, "48210934");

    org.run(&["approve", "merge", "--task", "t"])
        .assert_ok("sign")
        .assert_contains("approved merge")
        .assert_lacks("⚠");
    org.run(&["merge", "t"]).assert_ok("the signature stands");
}

#[test]
fn a_terminal_signature_a_chat_could_not_be_told_about_is_still_a_signature() {
    // The order the two happen in, and it is the whole of why this is a warning: the
    // ledger first, the chat second. A `wecode approve` that failed because a `curl` did
    // would leave the operator believing they had not signed something they had — and
    // exiting non-zero over a receipt is how that belief gets formed.
    let (org, _) = mergeable("tg-terminal-mute", "approved");
    landed_task(&org, "t");
    chatting(&org, "48210934");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}answer = \"echo chat not found >&2; exit 6\"\n"),
    )
    .unwrap();

    org.run(&["approve", "merge", "--task", "t"])
        .assert_ok("a receipt that bounced is a report, not a crash")
        .assert_contains("approved merge")
        // Said under the signature, so it is clear which of the two failed.
        .assert_contains("could not say so in the chat")
        .assert_contains("chat not found");
    org.run(&["merge", "t"])
        .assert_ok("the signature stands")
        .assert_contains("MERGED  t → dev");
}

#[test]
fn a_tap_whose_message_is_gone_is_acknowledged_with_no_address_rather_than_half_of_one() {
    // Telegram stops handing out the message an old keyboard belongs to, and then there
    // is no message to take the buttons off. The tap still signs — the task is in the
    // `callback_data`, which is why it belongs there — and is still acknowledged, so the
    // spinner stops. What is empty is the address, and both halves of it: a hook tests
    // one variable before it edits, and a half-addressed edit would be a `curl` failing
    // at the API instead of a branch the hook could have taken.
    let (org, _) = mergeable("tg-tap-orphan", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(&replies, &[tapped_orphaned(12, "48210934", "approve t")]);

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("approved merge");

    let back = std::fs::read_to_string(&said).expect("the tap was acknowledged");
    assert!(back.contains("cb12"), "{back}");
    assert!(
        back.contains("at:/ "),
        "no address at all, not half of one: {back}"
    );
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
        .assert_contains("refused merge")
        .assert_contains("t stays needs-approval")
        .assert_lacks("approved");
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");
    assert!(!org.run(&["merge", "t"]).ok(), "nothing was signed");
}

#[test]
fn a_refusal_is_on_the_record_the_way_a_signature_is() {
    // The gap this closes, and the one an operator answering from a phone feels first:
    // the reply scrolls away, and in the morning a task nobody has looked at and a task
    // somebody looked at and said no to are the same task. The decision was made — it
    // has to survive the pass it arrived on.
    let (org, _) = mergeable("tg-no-record", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(3, "48210934", "no", "t needs you: approval")],
    );
    org.run(&["telegram"]).assert_ok("read the channel");

    // Against the same approval, under the same seat, and saying how it arrived — the
    // whole of what makes it answerable later. Not "someone somewhere declined".
    org.run(&["audit", "--task", "t", "--denied"])
        .assert_ok("audit")
        .assert_contains("approve")
        .assert_contains("chief       telegram")
        .assert_contains("signature withheld: merge");

    // And it is a record, not a lock: the same holder changing their mind signs it, and
    // the work lands. What the ledger keeps is that they said no first.
    holding(
        &replies,
        &[reply(4, "48210934", "approve", "t needs you: approval")],
    );
    org.run(&["telegram"])
        .assert_ok("second read")
        .assert_contains("approved merge");
    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("MERGED  t → dev");
}

#[test]
fn a_no_from_a_seat_that_may_not_approve_withholds_nothing() {
    // The mirror of the same reply saying yes. Naming an account says who somebody is;
    // whether their answer decides anything is the post's business either way. A seat
    // that never held the signature cannot withhold it, and recording that as a
    // holder's refusal would put a decision on the ledger nobody was entitled to make.
    let (org, _) = mergeable("tg-no-ungranted", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[[users]]\nname = \"dev\"\npost = \"impl\"\ntelegram = \"777\"\n"),
    )
    .unwrap();
    holding(&replies, &[reply(1, "777", "no", "t needs you: approval")]);

    org.run(&["telegram"])
        .assert_ok("a refused reply is a report, not a crash")
        .assert_contains("may not sign merge for t")
        .assert_lacks("refused merge");
    // Recorded all the same, as the attempt it was rather than as a decision.
    org.run(&["audit", "--task", "t", "--denied"])
        .assert_ok("audit")
        .assert_contains("capability missing")
        .assert_lacks("signature withheld");
}

#[test]
fn a_tap_that_says_no_is_told_what_it_put_on_the_record() {
    // The *Hold* button beside *Approve*, and the reason it needs answering at all: a
    // spinner that stops says nothing, and a refusal that decided nothing looks from a
    // phone exactly like one that did.
    let (org, _) = mergeable("tg-tap-no", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(6, "48210934", "no", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("refused merge");

    let back = std::fs::read_to_string(&said).expect("the tap was acknowledged");
    assert!(back.contains("cb6"), "{back}");
    assert!(back.contains("refused merge"), "{back}");
    assert!(!org.run(&["merge", "t"]).ok(), "nothing was signed");
}

#[test]
fn a_dry_run_records_no_refusal_either() {
    // "Moves nothing" has to include the ledger. A refusal is one row nothing takes
    // back, so a dry run that wrote one would be the same mistake as one that signed.
    let (org, _) = mergeable("tg-no-dry", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(7, "48210934", "no", "t needs you: approval")],
    );

    org.run(&["telegram", "--dry-run"])
        .assert_ok("dry run")
        .assert_contains("would record merge refused for t");
    org.run(&["audit", "--task", "t", "--denied"])
        .assert_ok("audit")
        .assert_contains("no matching audit records");

    // And the reply is still there to be acted on for real.
    org.run(&["telegram"])
        .assert_ok("for real")
        .assert_contains("refused merge");
}

#[test]
fn a_no_to_a_task_with_nothing_outstanding_refuses_nothing() {
    // A refusal has to name what it refused or it records nothing, which makes the two
    // verdicts agree about when there is nothing to answer: the reply that would be
    // told "nothing is waiting to be signed" for saying yes is told it for saying no.
    let (org, _) = mergeable("tg-no-idle", "approved");
    // Added and not run: nothing has been produced, so there is nothing to refuse.
    a_task_in_src(&org, "t", "src/**", "grep -q landed src/app.txt");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(2, "48210934", "no", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("nothing is waiting to be signed");
    org.run(&["audit", "--task", "t", "--denied"])
        .assert_ok("audit")
        .assert_contains("no matching audit records");
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

// --------------------------------------------------------------- asking ------

#[test]
fn a_message_that_asks_is_answered_out_of_the_ledger_and_said_into_the_chat() {
    // The other half of the channel, and the question actually asked six times in two
    // days: *what is waiting on me*. It used to have one answer, on the machine, in a
    // terminal — so an operator away from their desk could say yes and could not ask
    // anything. The reply is the board's own row, wrapped for a phone.
    let (org, _) = mergeable("tg-asked", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(&replies, &[reply(20, "48210934", "board", "")]);

    org.run(&["telegram"])
        .assert_ok("read the channel")
        // The needs-human cell, from the same function `wecode board` draws it with: the
        // category, and the one command that clears it.
        .assert_contains("NEEDS YOU (1)")
        .assert_contains("caching/t")
        .assert_contains("wecode merge t")
        // And nothing was signed for asking.
        .assert_lacks("approved merge");

    // Said back where it was asked, which is the whole point of asking from a phone: an
    // answer that only reached the machine's own log would be the gap this closes.
    let back = std::fs::read_to_string(&said).expect("the question was answered");
    assert!(back.contains("ask:48210934"), "{back}");
    assert!(back.contains("wecode merge t"), "{back}");
    // No callback to acknowledge, no message to edit, and no task decided: a question is
    // not a receipt, and the three variables a receipt travels in stay empty.
    assert!(back.contains("cb: at:/ for:#"), "{back}");

    // A read moves nothing: no signature, and no row on the ledger for the asking.
    assert!(!org.run(&["merge", "t"]).ok(), "asking signed something");
    org.run(&["audit", "--task", "t", "--denied"])
        .assert_ok("audit")
        .assert_contains("no matching audit records");
}

#[test]
fn the_summary_says_what_is_moving_or_names_the_cause_when_nothing_is() {
    // `status` and a bare `?`, which is what somebody types one-handed. Four counts alone
    // describe a workspace that has finished everything and one whose operator forgot to
    // start `wecode loop` identically, so the line names the cause.
    let (org, _) = mergeable("tg-status", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(&replies, &[reply(21, "48210934", "?", "")]);

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("needs you 1 · moving 0")
        .assert_contains("nothing is moving: caching/t");
}

#[test]
fn why_answers_what_a_task_waits_behind() {
    // The question a queue makes somebody ask, and the one the board answers with a
    // column they cannot see from a phone. Both halves: the chain, and whether anything
    // is coming for it.
    let (org, _) = mergeable("tg-why", "approved");
    landed_task(&org, "t");
    org.run(&[
        "task", "add", "u", "--project", "caching", "--kind", "chore", "the next one",
        "--write", "src/**", "--accept-cmd", "true", "--tokens", "100", "--wall", "30",
        "--to", "impl", "--after", "t",
    ])
    .assert_ok("task add");
    let replies = chatting(&org, "48210934");
    holding(&replies, &[reply(22, "48210934", "why u", "")]);

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("u  ")
        .assert_contains("waits on t is not done");

    // A bare number names nothing in a chat, here as everywhere else in the channel: the
    // sigil is required, and one reading of *which task* serves both grammars.
    holding(&replies, &[reply(23, "48210934", "why 2", "")]);
    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("why needs a task");
}

#[test]
fn agents_says_which_runs_are_open_and_how_long_since_each_moved() {
    // A stalled run from a phone. `> running` is a fact four rows share; what tells them
    // apart is the last thing the agent did and how long ago it did it.
    let (org, _) = mergeable("tg-agents", "approved");
    landed_task(&org, "t");
    org.run(&["status", "t", "running"]).assert_ok("force it live");
    let replies = chatting(&org, "48210934");
    holding(&replies, &[reply(24, "48210934", "agents", "")]);

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("MOVING (1)")
        .assert_contains("caching/t");
}

#[test]
fn a_free_form_instruction_is_refused_rather_than_taken_as_a_plan() {
    // The thing this must never become. *"fix the login bug"* wants a scope, a budget, an
    // acceptance command and somebody's signature, and a chat message carries none of
    // them. Refused out loud, because an instruction nobody answered reads exactly like
    // one somebody took care of.
    let (org, _) = mergeable("tg-instructed", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(&replies, &[reply(25, "48210934", "/fix the login bug", "")]);

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("planning is a task with a scope and a signature")
        .assert_contains("ask: status");

    // And the same sentence said to a person in the chat is that person's business.
    holding(&replies, &[reply(26, "48210934", "fix the login bug", "")]);
    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("nothing to sign")
        .assert_lacks("planning is a task");
}

#[test]
fn a_question_from_an_account_nobody_claims_is_answered_nowhere() {
    // The plan, the queue and the ledger are the company's business. A stranger who found
    // the bot gets nothing out of them — and nothing said back either, since a channel
    // that answered strangers would be a nuisance anybody could aim. The operator still
    // sees it, where an operator reads things.
    let (org, _) = mergeable("tg-asked-stranger", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(&replies, &[reply(27, "99999999", "board", "")]);

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("no user in company.toml")
        .assert_lacks("NEEDS YOU");
    assert!(!said.exists(), "a stranger was talked back to");
}

#[test]
fn a_question_is_read_once_like_everything_else_in_the_channel() {
    // `wecode loop` reads the channel every five seconds. Answering the same question on
    // every pass is how a channel becomes something nobody reads.
    let (org, _) = mergeable("tg-asked-once", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(&replies, &[reply(28, "48210934", "status", "")]);

    org.run(&["telegram"])
        .assert_ok("first read")
        .assert_contains("needs you 1");
    org.run(&["telegram"])
        .assert_ok("second read")
        .assert_contains("nothing to sign")
        .assert_lacks("needs you");
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
