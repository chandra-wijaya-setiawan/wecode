//! Signing an approval from a reply — or a tap — in a chat.
//!
//! [`crate::notify`] is half a loop. A task stops for a person at 02:14, the hook
//! pushes *`t` needs your signature* to wherever that person is, and then the only way
//! to give the signature is a terminal. On the workspace that found this, the message
//! arrived on a phone and the queue still stood still until morning — the notification
//! moved the *knowing* forward by six hours and the *doing* not at all.
//!
//! So a reply signs it. The operator types `approve` under the message wecode sent,
//! and the next pass of `wecode loop` turns that into the same ledger record `wecode
//! approve` writes, given by the same post, checked by the same Broker.
//!
//! And on a phone, typing is the part still left. A notification the operator sent with
//! an inline keyboard on it is answered by tapping *Approve* — one thumb, no keyboard,
//! nothing to remember about which task it was. Telegram hands that back as a
//! `callback_query` rather than a message, and [`tap_of`] reads it as the same
//! [`Message`]: the button's `callback_data` is the words a reply would have carried,
//! the notification it hangs under is the message a reply would have answered. So a tap
//! is not a second way to sign anything. It is the same sentence, delivered without a
//! keyboard, through the same identity check and the same Broker call.
//!
//! And a channel an operator can answer from is one they will ask from. *Why is nothing
//! running* was the question actually asked, six times in two days, of a machine the phone
//! could not reach. So a message that asks is parsed into a wecode verb and answered out of
//! the store — [`asked`] reads the question, [`crate::commands::gov::from_the_ledger`]
//! answers it from the functions `wecode board` prints. A view onto the ledger, never a
//! second brain: nothing is kept per chat, so reconnecting shows the same state, the state
//! never having been in the chat.
//!
//! Nine things are load-bearing:
//!
//! - **wecode holds no token and speaks no HTTP.** `[telegram] fetch` is a command the
//!   operator writes — a `curl` of the Bot API's `getUpdates` — and what it prints is
//!   what this reads. The offset to ask from arrives in its environment. That keeps
//!   the bot token in the operator's shell, keeps this testable against a file, and
//!   keeps wecode a program that runs commands rather than one that has a network
//!   stack and a credential store.
//! - **The account is an identity, never an authority.** A reply carries a numeric
//!   Telegram account. It resolves to a `[[users]]` entry that names it, or to nobody
//!   at all — there is no fallback seat. What that person may then sign is their
//!   post's business, decided by the Broker at the moment of signing, exactly as at a
//!   terminal. A stranger messaging the bot is a stranger, and signs nothing.
//! - **Asking is a read, and free-form instruction is refused.** A question passes the
//!   same identity check a signature does — the ledger is not public — and writes no
//!   record, because `wecode board` writes none either. What the channel will not do is
//!   take work: *"fix the login bug"* is planning, and planning is a task with a scope, a
//!   budget and somebody's signature. Addressed to the bot and naming no verb, it is told
//!   so out loud — silence would read as *taken care of*. Said to a person in the chat
//!   instead, the same sentence is left alone; see [`instructed`].
//! - **A message is read once.** Whatever came of an update — signed, refused, or not
//!   a decision at all — the cursor moves past it. The alternative is a week-old "yes"
//!   re-applied on every pass, and a "no" answered again every five seconds.
//! - **A refusal is a decision, and goes on the ledger as one.** An operator answering
//!   from a phone is answering for real, and the answer has to survive the pass it
//!   arrived on. Without a record, a task nobody has looked at and a task somebody
//!   looked at and said no to are the same task in the morning — and the person who has
//!   to decide again is the person who already decided. So a "no" is put past the same
//!   Broker as a "yes", against the same approval, under the same seat, and lands as a
//!   denial of it: `wecode audit --task t --denied` says who said no, and to what.
//!   What it is not is a status change. "No" to a merge and "no" to a design mean
//!   different things and a one-word reply cannot pick between them; withholding the
//!   signature is the part it *is* precise enough to say, and the task stays where it
//!   is, in front of a person.
//! - **A bad reply is reported, not raised.** One message that names no task must not
//!   stop the four behind it, and a fetch that failed must not take `wecode loop` down
//!   with it. Only a fetch that could not be believed at all is an error.
//! - **A tap is told what it did.** A typed reply is its own receipt — the words are in
//!   the chat, in front of the person who typed them. A tap leaves nothing: the phone
//!   shows a spinner, the spinner stops, and whether a merge was signed is a question
//!   for a terminal. So `[telegram] answer` says the outcome back into the chat, in the
//!   same shape `fetch` reads it — a command the operator wrote, given the callback to
//!   answer and the one line to say. Not saying it would leave a button that signs and a
//!   button that is broken looking exactly alike.
//! - **A decided button stops being an offer.** The acknowledgement above is a toast: it
//!   is gone in three seconds, and what stays in the chat is the notification — still
//!   saying *needs your signature*, still carrying *Approve* and *Hold*. A merge signed
//!   at 02:14 looks at 09:00 exactly like one nobody has answered, and the next thumb
//!   that lands on it is a second decision on a settled question. wecode cannot edit that
//!   message; it holds no token. What it can do is say **which** message it was, so the
//!   `answer` line can: the chat and the message id the tapped keyboard hangs on go into
//!   its environment beside the callback, and an `editMessageReplyMarkup` carrying no
//!   keyboard turns the offer into a record. Without them the operator's hook has to keep
//!   its own map from task to message and guess which row a receipt belongs to — a second
//!   store of what wecode was already holding, wrong whenever the guess is.
//! - **A decision is a decision wherever it was taken.** The same failure arrives from the
//!   other side: `wecode approve merge` and `wecode merge` settle exactly what the keyboard
//!   is offering, and the message on the phone used to hear nothing about it — going on
//!   asking for a signature to work that landed hours ago. So [`settled`] runs the same
//!   `answer` line for a decision taken anywhere, with no callback in front of it, there
//!   being no spinner to stop. What it names is the **task** rather than the message,
//!   because wecode cannot name the message here: the notification was sent by the
//!   operator's own hook and the id came back to that hook, which makes it the one thing
//!   that can find it again. That is what the map above is *for*. What it was missing was
//!   being told which task had been decided at the moment of the deciding, rather than only
//!   when a button was pressed.
//!
//! What is deliberately *not* here is a second gate. A reply is not a weaker signature
//! than a typed one — it is the same record, and the reason to trust it is the same
//! reason to trust the terminal: the operator said who they are in `company.toml`, and
//! the charter still outranks them both.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::Value;
use wecode_core::{Plan, Task, TaskId, TaskStatus, short};
use wecode_gov::ActionKind;
use wecode_org::Company;
use wecode_store::Store;

use crate::commands::ctx::*;
use crate::{commands, notify};

/// The name this channel is read under, in `inbox_cursor`.
pub(crate) const CHANNEL: &str = "telegram";

/// Words that mean yes. Matched on the first word of a reply, lowercased and stripped
/// of punctuation, so `Approve!` and `yes` both land here.
///
/// Short on purpose. This is not a language model: a message that is not clearly one
/// of these is chat, and chat is left alone rather than guessed at.
const YES: &[&str] = &[
    "approve", "approved", "yes", "y", "ok", "okay", "lgtm", "ship",
];

/// Words that mean no. Nothing is signed, and — this is the point of recognising them
/// at all — the message is answered rather than sitting in the channel being re-read.
const NO: &[&str] = &["no", "n", "nope", "reject", "rejected", "deny", "hold"];

/// What a reply said.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Verdict {
    Sign,
    Decline,
}

/// What a message asked for, when it asked rather than answered.
///
/// Four questions, each a verb wecode already has — a summary, a board, a blocker chain,
/// the open runs. No new state and no new judgement in any of them:
/// [`crate::commands::gov::from_the_ledger`] answers all four out of the store, so what
/// arrives on the phone is what the desk would have printed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Question {
    /// `status`, or a bare `?` — the summary sentence, and the cause when nothing runs.
    Status,
    /// `board` / `what` — what is waiting on a person, with the command that clears each.
    Board,
    /// `why <task>` — what that row waits behind, and whether it can clear on its own.
    Why,
    /// `agents` — the open runs, and how long since each last did anything.
    Agents,
}

/// What a message asked, if it asked anything.
///
/// The first word, like [`verdict`], against a list as short — and the two lists are
/// disjoint on purpose: `what` asks and `ok` answers, and a word that could do either
/// would be a signature given to somebody who was enquiring.
///
/// **The word has to be the whole message**, unlike a verdict's, `why <task>` excepted
/// because it takes one. *"what is this one doing?"* is a person talking to a person and a
/// channel that answered it would be a nuisance in every group chat; `what` on its own is
/// somebody asking the bot. A leading `/` is that said explicitly — Telegram's own way of
/// addressing one, stripped by [`word`] — and lifts the restriction, since a message
/// addressed to wecode is one whose first word was meant for it.
pub(crate) fn asked(text: &str) -> Option<Question> {
    let mut words = text.split_whitespace();
    let raw = words.next()?;
    let asking = words.next().is_none() || raw.starts_with('/');
    Some(match word(raw).as_str() {
        "why" => Question::Why,
        "status" if asking => Question::Status,
        "board" | "what" if asking => Question::Board,
        "agents" if asking => Question::Agents,
        // `?`, and only `?`. The shortest way to ask *how are we doing* from a phone,
        // spelled as the whole word rather than as "no letters in it" so that a bare 👍
        // under a notification stays what it is — an answer, not a query.
        _ if asking && raw.chars().all(|c| c == '?') => Question::Status,
        _ => return None,
    })
}

/// Whether a message is an instruction to wecode that this channel does not take.
///
/// The leading `/` is the whole test, and it is what keeps two failures apart. `fix the
/// login bug` said to somebody in the chat is that person's business; a notifier that
/// answers every sentence in a channel is one people leave. `/fix the login bug` is aimed
/// at wecode, and the answer is no.
fn instructed(text: &str) -> bool {
    text.split_whitespace()
        .next()
        .is_some_and(|w| w.starts_with('/'))
}

/// What the channel says to an instruction it will not take. Planning is a task — a scope,
/// a budget, an acceptance command, somebody's signature — and a message carries none of
/// those. Refused by name rather than by silence: an instruction nobody answered reads
/// exactly like one somebody took care of.
const REFUSED: &str = "    ✗ the channel answers questions and signs approvals — \
     planning is a task with a scope and a signature, not a message\n      \
     ask: status · board · why <task> · agents\n";

/// One update, in the shape the Bot API hands it over.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Update {
    pub(crate) id: i64,
    /// What a person said in it — typed as a message, or pressed as a button. `None` for
    /// everything else the channel may contain — an edit, a join, a poll answer. Those
    /// are read and passed over, because an update nothing understands still has to be
    /// got past or the cursor stops at it forever.
    pub(crate) message: Option<Message>,
}

/// A message somebody sent, reduced to what a signature needs.
///
/// A tapped button becomes one of these too, and that is the point: everything past this
/// struct — who may sign, which task, what kind, what the Broker says — cannot tell the
/// two apart and therefore cannot answer them differently.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Message {
    /// The numeric account that sent it. The only field with any authority in it.
    pub(crate) from: String,
    /// The display name Telegram supplies, for the report. Never for identity: it is
    /// chosen by the sender and two people may pick the same one.
    pub(crate) who: String,
    /// What was said: the text of a reply, or the `callback_data` of a button.
    pub(crate) text: String,
    /// The text of the message this answers — replied to, or carrying the keyboard that
    /// was tapped. Empty when it answers nothing, which is most chat, and is why an
    /// answer to something is what this reads.
    pub(crate) quoted: String,
    /// The chat it was said in, which is where an answer to it has to go.
    ///
    /// Only a question needs it — a typed signature is its own receipt. Distinct from
    /// [`Tap::chat`], which is half of an address to *edit* and empty whenever the other
    /// half is; this is where to *speak*.
    pub(crate) chat: String,
    /// What a tap has to be answered with, and `None` when a person typed it.
    ///
    /// Load-bearing twice over: it is what `[telegram] answer` is given, and its presence
    /// is the only thing that makes a tap a tap. Nothing decides anything by it.
    pub(crate) tap: Option<Tap>,
}

/// A tap's return address: what acknowledges it, and where the button that sent it is.
///
/// Two answers to two different questions, which is why they travel together. The
/// callback stops the spinner on the phone that tapped; the chat and message say which
/// notification carried the keyboard, so the same hook can strike the buttons off it.
/// One without the other leaves either a spinner that never stops or an offer that
/// outlives the decision it was offering.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Tap {
    /// Not the message id and not the account: the callback, which is the only thing
    /// `answerCallbackQuery` will take and the only reason this field exists.
    pub(crate) callback: String,
    /// The chat the tapped notification is in.
    pub(crate) chat: String,
    /// The message in it that carries the keyboard.
    ///
    /// Empty together with [`Self::chat`], never one without the other — see
    /// [`located`]. Empty is Telegram declining to hand that message over any more,
    /// which is the same staleness that puts the task in the button's `callback_data`:
    /// the tap is still worth acting on and still worth acknowledging, and the keyboard
    /// on a message nobody can name is a keyboard nobody can edit.
    pub(crate) message: String,
}

/// Parses a `getUpdates` response.
///
/// Tolerant about shape and strict about the envelope. Telegram adds fields to updates
/// between versions, and a parser that insisted on knowing all of them would break on a
/// message with a photo in it; but `ok: false` is the API saying it did not answer the
/// question, and reading an empty `result` out of that would report "no replies" when
/// what happened is "the token is wrong".
pub(crate) fn updates(body: &str) -> Result<Vec<Update>, String> {
    let root: Value = serde_json::from_str(body.trim())
        .map_err(|e| format!("the fetch did not print JSON: {e}"))?;
    if root.get("ok") == Some(&Value::Bool(false)) {
        let why = root
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("no description");
        return Err(format!("telegram refused the request: {why}"));
    }
    let result = root
        .get("result")
        .and_then(Value::as_array)
        .ok_or("no `result` array — is this a getUpdates response?")?;

    let mut out: Vec<Update> = result
        .iter()
        .filter_map(|u| {
            Some(Update {
                id: u.get("update_id")?.as_i64()?,
                // A typed message first, a tapped button second, and nothing else. An
                // update is one or the other; the order is only so this reads in the
                // order the channel is used.
                message: u
                    .get("message")
                    .and_then(message_of)
                    .or_else(|| u.get("callback_query").and_then(tap_of)),
            })
        })
        .collect();
    // Ascending, because the cursor advances per update and the batch decides what is
    // read. Telegram already orders them; a fetch that concatenates two batches, or an
    // operator replaying a file by hand, does not.
    out.sort_by_key(|u| u.id);
    Ok(out)
}

fn message_of(m: &Value) -> Option<Message> {
    let (from, who) = sender(m.get("from")?)?;
    Some(Message {
        from,
        who,
        text: m.get("text").map(scalar).unwrap_or_default(),
        quoted: text_of(m.get("reply_to_message")),
        // Where an answer goes back to. Not the account: the two are the same number in a
        // private chat and nothing alike in a group, and a reply to the wrong one of them
        // is either silence or somebody else's business said out loud.
        chat: located(Some(m)).0,
        tap: None,
    })
}

/// A button press, read as the message it stands for.
///
/// This is the whole of what a keyboard costs. A `callback_query` carries an account, a
/// string wecode's own operator put on the button, and the notification that button hangs
/// under — which is a sender, something said, and something answered, and so is a reply.
/// Read as a [`Message`] it goes through the identity check, the target resolution and
/// the Broker call that were already there, and cannot come to a different conclusion
/// from the typed word it stands for.
fn tap_of(q: &Value) -> Option<Message> {
    let (from, who) = sender(q.get("from")?)?;
    let (chat, message) = located(q.get("message"));
    Some(Message {
        from,
        who,
        // `data` is what the operator wrote on the button, read as the words a reply
        // would have used. One grammar and not two: `approve` means the same thing
        // whichever way it arrives, and a button is not a private language.
        text: q.get("data").map(scalar).unwrap_or_default(),
        // The message the keyboard is attached to — wecode's own notification, which is
        // where the task id usually is. Empty when Telegram will not hand that message
        // over any more, which is the reason to put the task in the button's `data`: 64
        // bytes is plenty for `approve #12`, and it never goes stale.
        quoted: text_of(q.get("message")),
        // Nothing to say into: a tap is answered through the callback it arrived on, which
        // is the receipt a thumb is owed and the only one Telegram will stop a spinner
        // with. A keyboard is for deciding; asking is typed.
        chat: String::new(),
        tap: Some(Tap {
            callback: q.get("id").map(scalar)?,
            chat,
            message,
        }),
    })
}

/// Where a message is: the chat, and its id in that chat.
///
/// Read of a tapped button's own notification — the keyboard's address — and of a typed
/// message, whose chat is where an answer to it goes.
///
/// Both or neither, deliberately. What reads these is a shell line the operator wrote,
/// and an edit half-addressed is a `curl` that fails at the API rather than a branch the
/// hook could have taken — so one test on one variable is the whole check it needs.
fn located(message: Option<&Value>) -> (String, String) {
    message
        .and_then(|m| {
            Some((
                scalar(m.get("chat")?.get("id")?),
                scalar(m.get("message_id")?),
            ))
        })
        .unwrap_or_default()
}

/// Who sent something: the account, and the name to print for it.
fn sender(from: &Value) -> Option<(String, String)> {
    Some((
        // As written, whatever it is: the id is compared against `company.toml` and
        // never arithmetic, so a future non-integer id costs nothing here.
        from.get("id").map(scalar)?,
        from.get("username")
            .or_else(|| from.get("first_name"))
            .map_or_else(|| "?".to_string(), scalar),
    ))
}

/// The text of a message wecode was handed a reference to, and nothing when there is
/// none — an image with no caption, or a message Telegram no longer gives out.
fn text_of(message: Option<&Value>) -> String {
    message
        .and_then(|m| m.get("text"))
        .map(scalar)
        .unwrap_or_default()
}

/// A JSON scalar as the string it prints as — `48210934`, not `"48210934"`.
fn scalar(v: &Value) -> String {
    v.as_str().map_or_else(|| v.to_string(), str::to_string)
}

/// What the first word of a reply decided, if it decided anything.
pub(crate) fn verdict(text: &str) -> Option<Verdict> {
    let first = word(text.split_whitespace().next()?);
    if YES.contains(&first.as_str()) {
        Some(Verdict::Sign)
    } else if NO.contains(&first.as_str()) {
        Some(Verdict::Decline)
    } else {
        None
    }
}

/// The kind of approval a reply names, if it names one: `approve merge`.
///
/// Skips the verdict word, and skips anything that is also a task id — a project may
/// legitimately have a task called `design`, and reading its name as a kind would sign
/// something other than what was asked for.
pub(crate) fn named_kind(text: &str, plan: &Plan) -> Option<ActionKind> {
    text.split_whitespace()
        .skip(1)
        .filter(|w| task_named(w, plan).is_none())
        .find_map(|w| ActionKind::parse(&word(w)))
}

/// One word of a message, as a task reference.
///
/// Punctuation goes from the end, so `approve cache-tests.` works. A leading `#` stays,
/// because here it is the whole difference between a reference and a number in a
/// sentence — see [`task_named`].
fn reference(raw: &str) -> &str {
    raw.trim_end_matches(|c: char| !c.is_alphanumeric())
        .trim_start_matches(|c: char| !(c.is_alphanumeric() || c == short::SIGIL))
}

/// The task one word names, if it names one.
///
/// **A short number must wear its `#` here**, unlike on the command line, and that is a
/// deliberate difference rather than an inconsistency. An argv position where a task is
/// wanted has nothing else it could be; a word in a chat message has everything else it
/// could be. `approve 2` is as likely to mean *two of them look fine* as it is to mean
/// task two, and a signature given on the wrong reading of that is a signature nobody
/// gave — the one failure the whole channel must not have. `approve #2` is unambiguous
/// and costs one keystroke.
fn task_named<'a>(raw: &str, plan: &'a Plan) -> Option<&'a Task> {
    let w = reference(raw);
    if w.starts_with(short::SIGIL) {
        plan.task_ref(w)
    } else {
        plan.task(&TaskId::new(w))
    }
}

/// Every task the text names, in the order it names them.
///
/// Ids are slugs, and so is every word put through `TaskId::new` — which is what makes
/// `approve cache-tests.` and `approve Cache-Tests` find the same task without this
/// having to strip punctuation itself.
///
/// Shared with the question side, so `why cache-tests` and `approve cache-tests` resolve
/// a name by one rule, the `#` on a bare number included. Two readings of *which task* is
/// how a channel comes to answer about one and sign for another.
pub(crate) fn tasks_named(text: &str, plan: &Plan) -> Vec<TaskId> {
    let mut out: Vec<TaskId> = Vec::new();
    for w in text.split_whitespace() {
        if let Some(t) = task_named(w, plan)
            && !out.contains(&t.id)
        {
            out.push(t.id.clone());
        }
    }
    out
}

/// Which task a reply is about.
///
/// The message it replies to is the ordinary answer — that is the notification wecode
/// sent, and it names the task. Naming a task in the reply itself overrides it, which
/// is the way out for an operator whose `[notify] command` does not include the id, or
/// who wants to sign something other than what they were pinged about.
///
/// Two different tasks in one text is refused rather than resolved. Whichever one was
/// picked, half the time it would be the other.
pub(crate) fn target(msg: &Message, plan: &Plan) -> Result<TaskId, String> {
    for (text, whose) in [
        (&msg.text, "the reply"),
        (&msg.quoted, "the message it answers"),
    ] {
        match tasks_named(text, plan).as_slice() {
            [] => {}
            [one] => return Ok(one.clone()),
            many => {
                let names: Vec<&str> = many.iter().map(TaskId::as_str).collect();
                return Err(format!(
                    "{whose} names {} — reply to one of them",
                    names.join(" and ")
                ));
            }
        }
    }
    Err("names no task, and neither does the message it answers".to_string())
}

/// What a bare `approve` means for a task in this state.
///
/// `gated` is the dispatch gate holding it — the one wait with no status of its own,
/// per the notify hook's fourth reason. Order matters: a task can only be in one of
/// these states, but reading them in the wrong order would offer to sign a merge for
/// work that has not run.
///
/// `None` is a task with nothing outstanding, and is refused rather than defaulted.
/// Signing a merge for a task that is still running would be a signature given before
/// there was anything to look at.
pub(crate) fn implied(task: &Task, gated: bool) -> Option<ActionKind> {
    match task.status {
        TaskStatus::NeedsApproval if task.kind.needs_a_signature() => Some(ActionKind::Design),
        TaskStatus::NeedsApproval => Some(ActionKind::Merge),
        TaskStatus::Ready if gated => Some(ActionKind::Admission),
        _ => None,
    }
}

/// Runs the fetch and returns what it printed.
///
/// An error, unlike the notify hook's — and for the mirror image of that reason. A
/// notification that failed to arrive does not change what happened to the work; a
/// fetch that failed and reported "no replies" would be wecode claiming to have looked.
pub(crate) fn fetch(company: &Company, org: &Path, offset: i64) -> Result<String, String> {
    let command = company
        .telegram
        .fetch
        .as_deref()
        .ok_or("no [telegram] fetch is configured")?;
    run(
        company,
        org,
        command,
        &[("WECODE_TELEGRAM_OFFSET", &offset.to_string())],
    )
}

/// Tells the chat that a decision has been taken — and says where the button was, so the
/// line that says it can also stop it offering. Does nothing at all when no `[telegram]
/// answer` is configured.
///
/// Reported and not raised, which is the notify hook's argument rather than [`fetch`]'s:
/// an acknowledgement that did not arrive does not un-sign the signature it was about,
/// and the four taps queued behind this one still have to be read. What it must not be is
/// skipped — see the module's fifth reason.
///
/// One command and not two. Editing the message and answering the callback are one act
/// from where the operator is standing — *this decision has been taken* — and two hooks
/// would be two places for one of them to be missing, with a live *Approve* on a merged
/// task as the failure. The whole decision is put in the environment and what the line
/// does with it is the line's business.
///
/// Both halves of what it is told are optional, and neither can be read off the other: a
/// tap on a keyboard whose message names no task still has a spinner to stop, and a
/// signature typed at a terminal names its task with no button behind it — see [`settled`].
///
/// `asked` is the third thing this line does and the only one that is not a receipt: the
/// chat a question came from, for the answer to be said into. Empty for everything else,
/// which is what a hook branches on — the two existing variables keep the meanings they
/// had, so a line written before questions existed still does its job and says nothing
/// to one.
fn answer(
    company: &Company,
    org: &Path,
    task: Option<&Task>,
    tap: Option<&Tap>,
    asked: &str,
    said: &str,
) -> Result<(), String> {
    let Some(command) = company.telegram.answer.as_deref() else {
        return Ok(());
    };
    // All three empty when nothing was tapped, the way the address alone is empty when
    // Telegram will not name the message: one test on one variable is the whole check a hook
    // needs, and there is nothing here to acknowledge.
    let (callback, chat, message) = tap.map_or(("", "", ""), |t| {
        (t.callback.as_str(), t.chat.as_str(), t.message.as_str())
    });
    let number = task
        .and_then(|t| t.number)
        .map_or_else(String::new, |n| n.get().to_string());
    run(
        company,
        org,
        command,
        &[
            ("WECODE_TELEGRAM_CALLBACK", callback),
            // The keyboard's address, empty together when Telegram will not name the
            // message. Handed over as they arrived: an id is compared and pasted, never
            // arithmetic, so nothing here needs it to be a number.
            ("WECODE_TELEGRAM_CHAT", chat),
            ("WECODE_TELEGRAM_MESSAGE", message),
            // What was decided, under the two names the notify hook was given when it sent
            // the message this is about — which is the whole point of them being these
            // names: a hook that noted its own message id per task looks the row up under
            // the key it filed it under. Empty when nothing named a task at all.
            ("WECODE_TASK", task.map_or("", |t| t.id.as_str())),
            ("WECODE_TASK_NUMBER", &number),
            // The chat a question came from, and empty for a receipt — the one variable
            // that says *speak* rather than *edit*.
            ("WECODE_TELEGRAM_ASKED", asked),
            // Cut to what the destination will take, the two differing by an order of
            // magnitude: `answerCallbackQuery` refuses a text over 200 characters
            // outright, and a chat message has a screen. A toast is flattened as well,
            // being one line by construction; an answer keeps its lines, the way
            // `[notify]` hands a digest over — a board folded onto one line is unreadable.
            (
                "WECODE_TELEGRAM_ANSWER",
                &if asked.is_empty() {
                    oneline(said, ANSWER)
                } else {
                    bounded(said, SAID)
                },
            ),
        ],
    )
    .map(|_| ())
}

/// Says into the chat that a decision has been taken somewhere the chat cannot see: a
/// signature typed at a terminal, or work landed by hand.
///
/// The module's eighth reason. The same line as a tap's acknowledgement with no callback in
/// front of it — nothing is waiting on a spinner — because what is left to do is the half
/// that outlives the toast anyway: a message still offering a decision already taken.
///
/// Returns the warning rather than printing or raising it, which is [`answer`]'s bargain one
/// step out. The signature is on the ledger before this runs, so a chat that could not be
/// reached is not a decision that did not happen — and the command that took it still has
/// to say which of the two failed.
pub(crate) fn settled(company: &Company, org: &Path, task: &Task, said: &str) -> String {
    match answer(company, org, Some(task), None, "", said) {
        Ok(()) => String::new(),
        Err(e) => format!("  ⚠ telegram: could not say so in the chat: {e}\n"),
    }
}

/// How much of an outcome a tap is told. Telegram's own ceiling for the text of an
/// answered callback — asking it to show more is a call it refuses outright, which would
/// turn a long refusal into no answer at all.
const ANSWER: usize = 200;

/// How much of an answer a question gets. A phone screen, and a long way inside the 4096
/// characters a chat message allows: the rows are already bounded by the board's own
/// attention limit, so this is the backstop rather than the shape of the reply.
const SAID: usize = 1000;

/// Runs one of the operator's command lines, with what wecode has to tell it in the
/// environment, bounded by `[telegram] timeout`.
///
/// Shared by both directions of the channel, so the line that reads it and the line that
/// answers it get the same charter check, the same clock, and the same care about a pipe
/// nobody is draining.
fn run(
    company: &Company,
    org: &Path,
    command: &str,
    env: &[(&str, &str)],
) -> Result<String, String> {
    // The same charter check the agent launch line and the notify hook get, from the
    // same function. An invariant outranks every grant, and a config is not an
    // exception: this is one more place the operator writes a command line for wecode
    // to run.
    if let Some(pattern) = commands::exec::forbidden_by_charter(company, command) {
        return Err(format!(
            "`{command}` is forbidden by the charter: never_run {pattern}"
        ));
    }

    let mut spawning = Command::new("sh");
    spawning
        .arg("-c")
        .arg(command)
        .current_dir(org)
        .env("WECODE_ORG", org)
        .env("WECODE_COMPANY", &company.name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The parameters, never the URL: the operator's line names the API and holds the
    // token, and wecode says only how far it has already read and what it decided.
    // Substituting into the command line instead would put wecode in the business of
    // quoting a line with a credential in it.
    for (key, value) in env {
        spawning.env(key, value);
    }
    let mut child = spawning
        .spawn()
        .map_err(|e| format!("could not run `{command}`: {e}"))?;

    // Drained on threads rather than after waiting. A getUpdates batch is comfortably
    // larger than a pipe buffer, and a child blocked writing into a pipe nobody is
    // reading, watched by a parent waiting for it to exit, is a deadlock that would
    // only show up on a busy channel.
    let began = Instant::now();
    let limit = company.telegram.timeout;
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let code = notify::wait_for(&mut child, limit)?;

    // Collected against the clock, not by joining. `sh` forks rather than execs, so
    // killing the fetch at its limit leaves a grandchild holding the write end open —
    // and a reader waiting for a pipe that nobody will close is the same hang the
    // timeout exists to prevent, moved one line down. What is left of the budget is
    // what reading gets; a fetch killed at the limit has none left and is an error
    // whatever it managed to print.
    let body = collect(&out, limit.saturating_sub(began.elapsed()));
    let errors = collect(&err, GRACE);

    match code {
        Some(0) => Ok(body),
        Some(n) => Err(format!("`{command}` exited {n}{}", tail(&errors))),
        None => Err(format!("`{command}` was killed after {}s", limit.as_secs())),
    }
}

/// How long to wait for the failure message of a command that has already exited. Its
/// stderr is a nicety; the exit code is the fact.
const GRACE: Duration = Duration::from_millis(200);

/// Reads a pipe to the end on a thread of its own, and hands the whole of it over at
/// once. A channel rather than a `JoinHandle` because only a channel can be waited on
/// with a deadline.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_string(&mut s);
        }
        // The receiver may be long gone: nothing here outlives the deadline above.
        let _ = tx.send(s);
    });
    rx
}

fn collect(rx: &Receiver<String>, within: Duration) -> String {
    rx.recv_timeout(within).unwrap_or_default()
}

/// What the failed command complained about, trimmed to one line: `curl` says
/// something useful, and a page of HTML from a proxy says nothing worth printing.
fn tail(errors: &str) -> String {
    match errors.lines().find(|l| !l.trim().is_empty()) {
        Some(line) if line.len() <= 200 => format!(" — {}", line.trim()),
        _ => String::new(),
    }
}

/// A message as it is quoted back into wecode's own output: one line, and bounded.
///
/// Everything here — the text, the display name, in principle the id — was typed by
/// whoever sent it, and this report is read by an operator deciding whether their queue
/// is behaving. A message with a newline in it could otherwise print a line that looks
/// like one of wecode's, and one with a novel in it could bury the pass it arrived on.
fn echo(said: &str) -> String {
    oneline(said, ECHO)
}

/// One line of at most `limit` characters, whatever it was given.
///
/// Shared by the two places one line is the whole of what there is room for — the report
/// an operator reads and the toast a tap is given — because the two need it for two
/// reasons. The report must not gain a line that looks like one of wecode's; the toast is
/// a value in a command's environment, where a newline could end the line the operator
/// wrote and a long one is a call Telegram refuses outright.
fn oneline(said: &str, limit: usize) -> String {
    bounded(&said.split_whitespace().collect::<Vec<_>>().join(" "), limit)
}

/// As much of what was said as the channel will take, lines and all.
///
/// Counted in characters and never bytes: cutting a multi-byte one in half would panic.
fn bounded(said: &str, limit: usize) -> String {
    match said.char_indices().nth(limit) {
        Some((at, _)) => format!("{}…", &said[..at]),
        None => said.to_string(),
    }
}

/// How much of a message is quoted back. Long enough to recognise what was replied to,
/// short enough that a pass of the loop stays one screen.
const ECHO: usize = 80;

/// A word as it is compared: lowercased, and stripped of the punctuation that ends a
/// sentence. `Approve!` and `approve` are the same answer.
fn word(raw: &str) -> String {
    raw.trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
}

/// Reads whatever the channel is holding and signs what it approved.
///
/// The whole command, so `wecode telegram` and `wecode loop` cannot drift into
/// answering the same reply differently. Returns the report; the only errors are the
/// ones that mean nothing was read at all.
///
/// `dry` reads the channel and moves nothing: no signature, and no cursor either, so
/// the same messages are there to be acted on for real afterwards. That costs an
/// `offset` that does not advance, which Telegram is content with.
pub(crate) fn drain_channel(
    ws: &wecode_org::Workspace,
    store: &Store,
    company: &Company,
    dry: bool,
) -> Result<String, Box<dyn std::error::Error>> {
    // The offset is the *next* update wanted, so it is one past where reading got to.
    // A channel nobody has read asks for 0, which is everything still held.
    let read_to = store.inbox_cursor(CHANNEL)?;
    let offset = read_to.map_or(0, |last| last + 1);
    let updates = updates(&fetch(company, ws.root(), offset)?)?;

    let mut out = String::new();
    // Filtered here as well as asked for in the fetch, and that is not belt and braces.
    // The offset is a request, and what honours it is a command line the operator
    // wrote: one that leaves the parameter off, or a `getUpdates` retried after a
    // network error, hands the same batch back. Read-once has to be a property of
    // wecode, because wecode is the thing that would sign twice.
    for update in updates.iter().filter(|u| read_to.is_none_or(|l| u.id > l)) {
        if let Some(msg) = &update.message {
            out.push_str(&apply(store, company, ws.root(), msg, dry));
        }
        if !dry {
            // After acting, and for every update whatever came of it. A reply that was
            // refused has been answered; re-reading it would report the same refusal
            // every pass forever, which is how the report becomes something nobody
            // reads.
            store.mark_inbox_read(CHANNEL, update.id)?;
        }
    }
    if out.is_empty() {
        out.push_str("  nothing to sign\n");
    }
    Ok(out)
}

/// Applies one message, and tells a tap what came of it. Never fails: a refusal is the
/// report, not an error, because four good replies behind a bad one still have to be read.
fn apply(store: &Store, company: &Company, org: &Path, msg: &Message, dry: bool) -> String {
    let outcome = match (decided(store, company, msg, dry), &msg.tap) {
        (Some(outcome), _) => outcome,
        // Chat. Not every message in a channel is an instruction, and answering the ones
        // that are not is how a notifier becomes a nuisance.
        (None, None) => return String::new(),
        // A tap is never chat: `data` is a string wecode's own operator wrote on a
        // button, so one that decides nothing is a keyboard to fix. Said out loud in
        // both directions, because the operator holding the phone is the one who can fix
        // it and a spinner that stops with nothing said tells them nothing.
        (None, Some(_)) => "    ✗ that button decides nothing — nothing signed\n".to_string(),
    };

    let mut report = format!(
        "  {} ({}): {}\n{outcome}",
        echo(&msg.who),
        echo(&msg.from),
        echo(&msg.text)
    );
    // What the tap was about, named beside its address for the reason a terminal decision
    // is named at all: the hook keeping a note of which message it sent per task is the
    // hook that has to clear the row once one is decided. Resolved here rather than carried
    // out of `decided`, which resolves it behind an account check this side does not
    // repeat — and only for a tap that is going to be answered.
    let about = (msg.tap.is_some() && !dry)
        .then(|| store.load_plan().ok())
        .flatten();
    let about = about
        .as_ref()
        .and_then(|plan| target(msg, plan).ok().and_then(|id| plan.task(&id)));

    // Every tap, whatever it came to, and every question — and no typed signature ever.
    // The module's fifth reason and its extension: a typed `approve` is its own receipt,
    // in front of the person who typed it, but the answer to a question was never in the
    // chat at all, and one answered into a log on the machine is the gap this direction of
    // the channel exists to close. Not in a dry run, which moves nothing anywhere.
    //
    // A question from an account nobody claims is reported above and answered nowhere: a
    // channel that talked back to strangers would be a nuisance anybody could aim.
    let asked_in = asked(&msg.text)
        .filter(|_| company.user_by_telegram(&msg.from).is_some())
        .map_or("", |_| msg.chat.as_str());
    if !dry
        && (msg.tap.is_some() || !asked_in.is_empty())
        && let Err(e) = answer(company, org, about, msg.tap.as_ref(), asked_in, &outcome)
    {
        // Reported under the outcome rather than in place of it. The signature is
        // already given, and the answer is already worked out; what failed is saying so,
        // and an operator whose taps have gone quiet needs to see which of the two it was.
        // It is also the only place a button left offering will be mentioned: the chat is
        // precisely where nothing was said.
        report.push_str(&format!("    ⚠ could not say so in the chat: {e}\n"));
    }
    report
}

/// What came of one message, and `None` for one that wanted nothing.
///
/// Separate from the reporting because a tap and a question each need this sentence twice:
/// once in the output of the pass it arrived on, and once back in the chat that sent it.
///
/// Three things a message can be, read in this order. Asking is read first because the two
/// grammars must not overlap and this is where that is enforced. Deciding is next. What is
/// left is chat, or — where it was addressed to the bot — an instruction, which is the one
/// thing the channel says no to.
fn decided(store: &Store, company: &Company, msg: &Message, dry: bool) -> Option<String> {
    if let Some(question) = asked(&msg.text) {
        // The same account check a signature gets, and for a reason of its own: the plan,
        // the queue and the ledger are this company's business, and a stranger who found
        // the bot is owed nothing out of them.
        if company.user_by_telegram(&msg.from).is_none() {
            return Some(unclaimed(&msg.from, "nothing answered"));
        }
        return Some(
            match commands::gov::from_the_ledger(store, company, question, &msg.text) {
                Ok(said) => said,
                Err(e) => format!("    ✗ {e}\n"),
            },
        );
    }
    let Some(verdict) = verdict(&msg.text) else {
        return instructed(&msg.text).then(|| REFUSED.to_string());
    };
    let Some(user) = company.user_by_telegram(&msg.from) else {
        return Some(unclaimed(&msg.from, "nothing signed"));
    };
    Some(match decide(store, company, msg, user, verdict, dry) {
        Ok(report) => report,
        Err(e) => format!("    ✗ {e}\n"),
    })
}

/// The one identity failure, said the same way whatever the message wanted. An account no
/// `[[users]]` entry names is a stranger, and there is no fallback seat to be one instead.
fn unclaimed(from: &str, got: &str) -> String {
    format!(
        "    ✗ no user in company.toml gives telegram = \"{}\" — {got}\n",
        echo(from)
    )
}

/// Everything about one reply that can go wrong, in one place with one error type.
fn decide(
    store: &Store,
    company: &Company,
    msg: &Message,
    user: &wecode_org::User,
    verdict: Verdict,
    dry: bool,
) -> Result<String, Box<dyn std::error::Error>> {
    // Loaded per message rather than once for the batch: two replies can be about the
    // same task, and the second must see what the first did to it.
    let plan = store.load_plan()?;
    let id = target(msg, &plan)?;
    let task = plan.task(&id).ok_or("no such task")?.clone();

    // Resolved before the verdict is looked at, because both verdicts answer the same
    // question and a refusal has to name what it refused or it records nothing. It also
    // makes the two answers agree about when there is nothing to answer: a task with
    // nothing outstanding gets the same message either way, rather than a "yes" that is
    // refused and a "no" that is politely accepted for something nobody asked.
    let kind = match named_kind(&msg.text, &plan) {
        Some(named) => named,
        None => {
            let gated = plan
                .project(&task.project)
                .and_then(|p| playbook_of(company, p).ok().flatten())
                .map(|pb| commands::exec::unsigned(store, Some(&pb), &task))
                .transpose()?
                .flatten()
                .is_some();
            implied(&task, gated).ok_or_else(|| {
                format!(
                    "{id} is {} — nothing is waiting to be signed for it",
                    task.status.as_str()
                )
            })?
        }
    };

    if dry {
        return Ok(match verdict {
            Verdict::Sign => format!("    · would sign {} for {id}\n", kind.as_str()),
            // Said in the same shape, because it is the same weight of act: both write
            // one row nothing takes back, and a dry run exists to show which.
            Verdict::Decline => {
                format!("    · would record {} refused for {id}\n", kind.as_str())
            }
        });
    }

    let post = find_post(company, &user.post)?;
    // `telegram` as the session and the agent, the way `--as` records `adhoc`: the
    // ledger should say how a signature arrived, and a reply is not somebody sitting at
    // a terminal — nor is it the post's coding agent, which is what typed nothing here.
    let who = Actor::over(company, &post, CHANNEL, user.name.clone());
    if verdict == Verdict::Decline {
        return refuse(store, company, &who, &task, kind);
    }
    let signed = commands::gov::sign(
        store,
        company,
        &plan,
        &who,
        &commands::gov::Signature {
            kind,
            task: Some(&task),
            // What the reply said is not a note on the signature: the ledger already
            // carries the words that decided it, and repeating them as commentary
            // would put a sender-controlled string into the approval record.
            note: "",
            on: (Some(task.project.to_string()), Some(id.to_string())),
        },
    )?;
    // Two more than it prints itself, so what a signature did lines up under the
    // message that gave it and beside the `✗` of one that gave nothing.
    Ok(signed
        .lines()
        .map(|l| format!("  {l}\n"))
        .collect::<String>())
}

/// Puts a refusal on the ledger, under the authority the signature would have needed.
///
/// The Broker is asked rather than told. Whether a "no" decides anything is the same
/// question as whether a "yes" would have: an account is an identity, and the post is
/// the authority. A seat that may not sign this is not withholding it — it never held
/// it — and that reply has to land on the record as the refusal its "yes" would have
/// got, rather than as a holder's decision it was not entitled to make.
///
/// Its own Broker rather than [`crate::commands::ctx::record`], because that call asks
/// permission for something about to happen and nothing is about to happen here. This
/// *is* the act: the row is the whole of what a refusal does.
fn refuse(
    store: &Store,
    company: &Company,
    who: &Actor,
    task: &Task,
    kind: ActionKind,
) -> Result<String, Box<dyn std::error::Error>> {
    let id = &task.id;
    let mut broker = wecode_gov::Broker::new(company.charter.clone());
    let session = wecode_gov::Session::new(
        who.session.clone(),
        who.post.clone(),
        who.agent.clone(),
        who.effective.clone(),
    )
    .on(Some(task.project.to_string()), Some(id.to_string()))
    .with_human(who.human.clone());

    let decision = broker.withhold(&session, kind);
    // Appended whichever way it went — an attempt to decide something is worth knowing
    // about even when it decided nothing, which is what the sign path does too.
    store.append_records(broker.ledger())?;
    if !decision.is_withheld() {
        let why = match &decision {
            wecode_gov::Decision::Deny { reason, .. } => reason.to_string(),
            // An approval is never itself gated behind an approval, so there is no
            // third answer to get here. Printed rather than assumed away: a refusal
            // that reported nothing at all would be worse than one that reports this.
            other => format!("{other:?}"),
        };
        return Err(format!(
            "`{}` may not sign {} for {id}, so it cannot withhold it either: {why}",
            who.post,
            kind.as_str()
        )
        .into());
    }

    Ok(format!(
        "    ⏸ {} refused {} — {id} stays {}, nothing signed\n      \
         on the record: wecode audit --task {id} --denied\n",
        who.describe(),
        kind.as_str(),
        task.status.as_str(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Measure, Project, Scope, TaskKind};

    /// A getUpdates response with one text message in it.
    const ONE: &str = r#"{
      "ok": true,
      "result": [
        {
          "update_id": 700123,
          "message": {
            "message_id": 42,
            "from": {"id": 48210934, "is_bot": false, "first_name": "C", "username": "cws"},
            "chat": {"id": 48210934, "type": "private"},
            "date": 1770000000,
            "text": "approve",
            "reply_to_message": {
              "message_id": 41,
              "from": {"id": 700, "is_bot": true, "username": "wecode_bot"},
              "text": "cache-tests needs you: approval"
            }
          }
        }
      ]
    }"#;

    fn plan() -> Plan {
        let mut p = Plan::new();
        p.add_project(Project::new("caching", "an objective sentence", "app"))
            .unwrap();
        for id in ["cache-tests", "bench"] {
            p.add_task(task(id, TaskKind::Chore)).unwrap();
        }
        p
    }

    fn task(id: &str, kind: TaskKind) -> Task {
        Task::new(id, "caching", "cover the cache layer with tests")
            .of_kind(kind)
            .accepting(Measure::Command {
                cmd: "true".into(),
                expect_status: 0,
            })
            .scoped(Scope::write(&["tests/**"]))
            .budgeted(Budget {
                tokens: Some(10),
                wall_secs: Some(1),
            })
    }

    /// A getUpdates response with one tapped button in it, from the same account and
    /// under the same notification as [`ONE`]. The pair is the comparison every test
    /// about taps is really making.
    const TAPPED: &str = r#"{
      "ok": true,
      "result": [
        {
          "update_id": 700124,
          "callback_query": {
            "id": "4382abc",
            "from": {"id": 48210934, "is_bot": false, "first_name": "C", "username": "cws"},
            "chat_instance": "-176",
            "data": "approve",
            "message": {
              "message_id": 41,
              "from": {"id": 700, "is_bot": true, "username": "wecode_bot"},
              "chat": {"id": 48210934, "type": "private"},
              "text": "cache-tests needs you: approval"
            }
          }
        }
      ]
    }"#;

    /// What a tap is answered with, spelled once: a return address and no task named
    /// beside it, which is the half of [`answer`] the tests below are about.
    fn answering(company: &Company, said: &str) -> Result<(), String> {
        answer(
            company,
            &std::env::temp_dir(),
            None,
            Some(&tap("4382abc")),
            "",
            said,
        )
    }

    /// A tap's return address, as one arrives from a keyboard on a live message.
    fn tap(callback: &str) -> Tap {
        Tap {
            callback: callback.into(),
            chat: "48210934".into(),
            message: "41".into(),
        }
    }

    fn message(text: &str, quoted: &str) -> Message {
        Message {
            from: "48210934".into(),
            who: "cws".into(),
            text: text.into(),
            quoted: quoted.into(),
            chat: "48210934".into(),
            tap: None,
        }
    }

    #[test]
    fn a_reply_is_read_down_to_who_said_what_about_which_message() {
        let got = updates(ONE).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, 700123);
        let m = got[0].message.clone().expect("a message");
        // The id as it is compared against company.toml: a number in JSON, a string
        // here, and never quoted into `"48210934"`.
        assert_eq!(m.from, "48210934");
        assert_eq!(m.who, "cws");
        assert_eq!(m.text, "approve");
        assert_eq!(m.quoted, "cache-tests needs you: approval");
    }

    #[test]
    fn a_tap_is_read_as_the_reply_it_stands_for() {
        // The whole of what a keyboard costs. Read down to the same four fields, from the
        // same account, about the same notification — so nothing past here can tell the
        // two apart, and nothing past here needs a second opinion about a tap.
        let typed = updates(ONE).unwrap()[0].message.clone().expect("a message");
        let tapped = updates(TAPPED).unwrap()[0]
            .message
            .clone()
            .expect("a tap is a message");
        assert_eq!(tapped.from, typed.from);
        assert_eq!(tapped.who, typed.who);
        // `data` is read as the words a reply would have used: one grammar, not two.
        assert_eq!(tapped.text, typed.text);
        // The notification the keyboard hangs under is the message a reply answers.
        assert_eq!(tapped.quoted, typed.quoted);

        // And so the decisions come out the same, which is the property that matters.
        assert_eq!(verdict(&tapped.text), verdict(&typed.text));
        assert_eq!(
            target(&tapped, &plan()).unwrap(),
            target(&typed, &plan()).unwrap()
        );

        // The one field that differs, and it decides nothing: it is the return address —
        // what the tap is acknowledged with, and where the button that sent it is.
        let tap = tapped.tap.clone().expect("a tap has a return address");
        assert_eq!(tap.callback, "4382abc");
        assert_eq!(typed.tap, None);
    }

    #[test]
    fn a_tap_says_which_message_the_button_it_came_from_is_on() {
        // The half that makes a decided button stop offering. The acknowledgement is a
        // toast and goes; the notification stays, still saying *needs your signature* and
        // still carrying *Approve*. wecode cannot edit it — no token — so it says which
        // message it is, and the operator's one line strikes the keyboard off.
        let tap = updates(TAPPED).unwrap()[0]
            .message
            .clone()
            .expect("a tap")
            .tap
            .expect("a return address");
        assert_eq!(tap.chat, "48210934");
        // As it arrived, unquoted: an id is pasted into an API call and never counted.
        assert_eq!(tap.message, "41");
    }

    #[test]
    fn a_button_on_a_message_telegram_will_not_name_has_no_address_at_all() {
        // Both halves empty rather than one, so the hook has one thing to test before it
        // tries an edit. The tap is still acted on and still acknowledged: what is gone
        // is the ability to edit a message nobody can name, not the decision it carried.
        let got = updates(
            r#"{"ok":true,"result":[{"update_id":9,"callback_query":{
                 "id":"77","from":{"id":48210934,"username":"cws"},"data":"approve #2"}}]}"#,
        )
        .unwrap();
        let tap = got[0].message.clone().expect("a tap").tap.expect("a tap");
        assert_eq!(tap.callback, "77");
        assert_eq!((tap.chat.as_str(), tap.message.as_str()), ("", ""));

        // And a message with no chat on it is the same answer, not half of one.
        let got = updates(
            r#"{"ok":true,"result":[{"update_id":9,"callback_query":{
                 "id":"77","from":{"id":48210934,"username":"cws"},"data":"approve",
                 "message":{"message_id":41,"text":"cache-tests needs you"}}}]}"#,
        )
        .unwrap();
        let tap = got[0].message.clone().expect("a tap").tap.expect("a tap");
        assert_eq!((tap.chat.as_str(), tap.message.as_str()), ("", ""));
    }

    #[test]
    fn a_button_carries_its_task_even_when_the_notification_it_hangs_under_is_gone() {
        // Telegram stops handing out the message an old keyboard belongs to, and a tap
        // then answers nothing. Which is the reason to put the task in `callback_data`:
        // 64 bytes is plenty for `approve #2`, and unlike the quoted text it cannot go
        // stale.
        let got = updates(
            r#"{"ok":true,"result":[{"update_id":9,"callback_query":{
                 "id":"77","from":{"id":48210934,"username":"cws"},"data":"approve #2"}}]}"#,
        )
        .unwrap();
        let m = got[0].message.clone().expect("a tap");
        assert_eq!(m.quoted, "");
        assert_eq!(target(&m, &numbered()).unwrap().as_str(), "cache-tests");
    }

    #[test]
    fn a_tap_with_no_callback_to_answer_is_not_read_as_a_message() {
        // It could be signed and never acknowledged, which is the one shape of silence
        // this whole direction of the channel exists to remove. An update nothing can
        // read is still got past — the id is there — so this costs a button that cannot
        // work anyway and nothing else.
        let got = updates(
            r#"{"ok":true,"result":[{"update_id":9,"callback_query":{
                 "from":{"id":48210934,"username":"cws"},"data":"approve"}}]}"#,
        )
        .unwrap();
        assert!(got[0].message.is_none());
        assert_eq!(got[0].id, 9);
    }

    #[test]
    fn an_answer_is_flattened_and_bounded_to_what_telegram_will_take() {
        // Both halves are load-bearing here rather than cosmetic. This value goes into a
        // command's environment, where a newline could end the line the operator wrote;
        // and `answerCallbackQuery` refuses a text over its own ceiling outright, which
        // would turn a long refusal into no answer at all.
        let out = oneline("    ✗ names no task\n    nothing signed\n", ANSWER);
        assert_eq!(out, "✗ names no task nothing signed");

        let long = oneline(&"é".repeat(400), ANSWER);
        assert_eq!(long.chars().count(), ANSWER + 1, "200 and an ellipsis");
    }

    #[test]
    fn nothing_is_said_back_and_nothing_fails_when_no_answer_is_configured() {
        // The channel still works one-way: taps sign, and the operator finds out in a
        // terminal. Worse than configuring it, better than refusing to read the channel.
        let c = company("\n[telegram]\nfetch = \"true\"\n");
        assert!(answering(&c, "signed").is_ok());
    }

    #[test]
    fn a_decision_taken_elsewhere_reports_a_chat_it_could_not_reach() {
        // Reported rather than raised, one step further out than a tap's receipt is: by the
        // time this runs the signature is on the ledger, and a `wecode approve` that failed
        // because the chat did would be an approval undone by its own receipt.
        let c = company(
            "\n[telegram]\nfetch = \"true\"\nanswer = \"echo chat not found >&2; exit 6\"\n",
        );
        let t = task("cache-tests", TaskKind::Chore);
        let out = settled(&c, &std::env::temp_dir(), &t, "approved merge");
        assert!(out.contains("could not say so in the chat"), "{out}");
        assert!(out.contains("exited 6"), "{out}");

        // And nothing said at all where there is no line to say it with. A workspace that
        // never wired a chat up pays nothing for a signature typed at its own terminal.
        let quiet = company("\n[telegram]\nfetch = \"true\"\n");
        assert!(settled(&quiet, &std::env::temp_dir(), &t, "approved merge").is_empty());
    }

    #[test]
    fn an_answer_the_charter_forbids_is_not_run() {
        // Both directions of the channel are command lines in the same file as the
        // charter, and an invariant outranks the operator in both.
        let c = company(
            "\n[invariants]\nnever_run = [\"curl *\"]\n\n[telegram]\nfetch = \"true\"\nanswer = \"curl example.invalid\"\n",
        );
        let e = answering(&c, "signed").unwrap_err();
        assert!(e.contains("never_run"), "{e}");
    }

    #[test]
    fn an_answer_that_fails_says_what_the_command_complained_about() {
        // Reported and not raised, up in `apply` — but it has to arrive there saying
        // which of the two commands broke.
        let c = company(
            "\n[telegram]\nfetch = \"true\"\nanswer = \"echo query is too old >&2; exit 6\"\n",
        );
        let e = answering(&c, "signed").unwrap_err();
        assert!(e.contains("exited 6"), "{e}");
        assert!(e.contains("query is too old"), "{e}");
    }

    #[test]
    fn an_api_that_says_no_is_an_error_and_not_an_empty_channel() {
        // The failure that has to be loud. Reading `ok: false` as "no replies" would
        // report a healthy quiet channel to an operator whose token is wrong.
        let e =
            updates(r#"{"ok":false,"error_code":401,"description":"Unauthorized"}"#).unwrap_err();
        assert!(e.contains("Unauthorized"), "{e}");

        assert!(updates("not json at all").unwrap_err().contains("JSON"));
        assert!(updates(r#"{"ok":true}"#).unwrap_err().contains("result"));
    }

    #[test]
    fn an_update_carrying_nothing_readable_still_has_its_id() {
        // It has to: the cursor moves per update, and one this cannot read would
        // otherwise be a message the channel hands back forever.
        let got = updates(
            r#"{"ok":true,"result":[
                 {"update_id":5,"edited_message":{"text":"approve"}},
                 {"update_id":6,"poll_answer":{"option_ids":[0]}}
               ]}"#,
        )
        .unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|u| u.message.is_none()));
        assert_eq!(got[1].id, 6);
    }

    #[test]
    fn updates_come_back_in_the_order_they_are_acted_on() {
        let got = updates(r#"{"ok":true,"result":[{"update_id":9},{"update_id":2}]}"#).unwrap();
        assert_eq!(got.iter().map(|u| u.id).collect::<Vec<_>>(), vec![2, 9]);
    }

    #[test]
    fn an_empty_channel_is_no_updates_rather_than_an_error() {
        assert!(updates(r#"{"ok":true,"result":[]}"#).unwrap().is_empty());
    }

    #[test]
    fn the_first_word_decides_and_everything_else_is_chat() {
        for yes in ["approve", "Approve!", "yes", "ok", "LGTM", "approve merge"] {
            assert_eq!(verdict(yes), Some(Verdict::Sign), "{yes}");
        }
        for no in ["no", "No.", "reject", "hold off for now"] {
            assert_eq!(verdict(no), Some(Verdict::Decline), "{no}");
        }
        // Not a decision. Guessing at these is how a chat channel becomes a hazard.
        for chat in ["", "what is this one doing?", "I approve of that", "maybe"] {
            assert_eq!(verdict(chat), None, "{chat}");
        }
    }

    #[test]
    fn asking_and_deciding_are_two_grammars_that_do_not_overlap() {
        for (text, q) in [
            ("status", Question::Status),
            ("?", Question::Status),
            ("/board", Question::Board),
            ("what", Question::Board),
            ("/status now", Question::Status),
            ("why cache-tests", Question::Why),
            ("Agents!", Question::Agents),
        ] {
            assert_eq!(asked(text), Some(q), "{text}");
            // The property that matters: no word asks and decides. A message read both
            // ways would be a signature given to somebody who was enquiring.
            assert_eq!(verdict(text), None, "{text}");
        }
        // Deciding words ask nothing; a sentence a verb happens to start is chat, as is a
        // thumbs-up — which is an answer somebody typed, not a query.
        for chat in ["approve", "no", "", "what is this one doing?", "status at 5", "👍"] {
            assert_eq!(asked(chat), None, "{chat}");
        }
        // Addressed to the bot and naming no verb: planning, which is a task.
        assert!(instructed("/fix the login bug"));
        assert!(!instructed("fix the login bug"));
    }

    #[test]
    fn a_reply_may_name_the_kind_it_signs() {
        let p = plan();
        assert_eq!(named_kind("approve merge", &p), Some(ActionKind::Merge));
        assert_eq!(named_kind("yes design", &p), Some(ActionKind::Design));
        assert_eq!(named_kind("approve", &p), None);
        // The verdict word is not a kind, and neither is a task id that happens to
        // read like one.
        let mut p = plan();
        p.add_task(task("design", TaskKind::Chore)).unwrap();
        assert_eq!(named_kind("approve design", &p), None);
    }

    #[test]
    fn the_message_being_answered_says_which_task() {
        // The ordinary case, and the reason this reads replies rather than commands:
        // the operator types one word under the notification wecode sent them.
        let p = plan();
        let m = message("approve", "cache-tests needs you: approval");
        assert_eq!(target(&m, &p).unwrap().as_str(), "cache-tests");
    }

    #[test]
    fn naming_a_task_in_the_reply_overrides_what_it_answers() {
        // The way out for an operator whose notify hook does not print the id, and for
        // signing something other than what they were pinged about.
        let p = plan();
        let m = message("approve bench", "cache-tests needs you: approval");
        assert_eq!(target(&m, &p).unwrap().as_str(), "bench");
    }

    #[test]
    fn punctuation_and_case_do_not_hide_a_task() {
        let p = plan();
        let m = message("approve Cache-Tests.", "");
        assert_eq!(target(&m, &p).unwrap().as_str(), "cache-tests");
    }

    /// The plan above, with numbers, since a plan an operator replies about is one that
    /// came out of a store.
    fn numbered() -> Plan {
        let mut p = plan();
        for (id, n) in [("cache-tests", 2), ("bench", 3)] {
            let mut t = p.task(&TaskId::new(id)).unwrap().clone();
            t.number = Some(wecode_core::Number::new(n));
            p.update_task(t).unwrap();
        }
        let mut proj = p.project(&"caching".into()).unwrap().clone();
        proj.number = Some(wecode_core::Number::new(1));
        p.update_project(proj).unwrap();
        p
    }

    #[test]
    fn a_reply_may_name_a_task_by_its_number() {
        // The point of the whole channel, one step further: the notification carries
        // `#3`, and answering it is four characters on a phone keyboard.
        let p = numbered();
        let m = message("approve #3", "cache-tests needs you: approval");
        assert_eq!(target(&m, &p).unwrap().as_str(), "bench");

        // And out of the message being answered, which is where the number usually is.
        let m = message("approve", "#2 needs you: approval");
        assert_eq!(target(&m, &p).unwrap().as_str(), "cache-tests");

        // Punctuation and brackets around it, the way a hook's message template puts it.
        for text in ["approve (#3)", "yes #3.", "ok — #3!"] {
            assert_eq!(
                target(&message(text, ""), &p).unwrap().as_str(),
                "bench",
                "{text}"
            );
        }
    }

    #[test]
    fn a_bare_number_in_a_chat_message_names_nothing() {
        // The rule that separates this from the command line. `approve 2` is as likely
        // to be "2 of them look fine" as a reference, and a signature given on the
        // wrong reading of that is a signature nobody gave. So the sigil is required
        // here, and only here.
        let p = numbered();
        let e = target(&message("approve 3", ""), &p).unwrap_err();
        assert!(e.contains("names no task"), "{e}");

        // Prose with numbers in it is prose, however much of it there is.
        let e = target(
            &message("approve", "3 tasks are waiting, 2 of them for you"),
            &p,
        )
        .unwrap_err();
        assert!(e.contains("names no task"), "{e}");

        // A project's number is not a task's, either: approvals are given per task.
        let e = target(&message("approve #1", ""), &p).unwrap_err();
        assert!(e.contains("names no task"), "{e}");
    }

    #[test]
    fn a_number_and_the_id_it_names_are_not_two_tasks() {
        // Both spellings of one task must not trip the two-tasks refusal, which is
        // exactly what a hook printing `cache-tests (#2)` would produce.
        let p = numbered();
        let m = message("approve", "cache-tests (#2) needs you: approval");
        assert_eq!(target(&m, &p).unwrap().as_str(), "cache-tests");
    }

    #[test]
    fn a_reply_naming_two_tasks_is_refused_rather_than_resolved() {
        let p = plan();
        let e = target(&message("approve cache-tests and bench", ""), &p).unwrap_err();
        assert!(e.contains("cache-tests and bench"), "{e}");
        // And the same in the message being answered — a digest of everything waiting
        // is exactly the message somebody would reply `approve` to.
        let e = target(&message("approve", "waiting: cache-tests, bench"), &p).unwrap_err();
        assert!(e.contains("reply to one"), "{e}");
    }

    #[test]
    fn a_reply_about_nothing_recognisable_names_no_task() {
        let e = target(&message("approve", "all clear"), &plan()).unwrap_err();
        assert!(e.contains("names no task"), "{e}");
    }

    #[test]
    fn what_a_bare_approve_means_is_read_off_the_task() {
        let mut t = task("t", TaskKind::Chore);
        t.status = TaskStatus::NeedsApproval;
        assert_eq!(implied(&t, false), Some(ActionKind::Merge));

        // A design is signed off, not merged: passing verification only makes it
        // reviewable.
        let mut d = task("d", TaskKind::Design);
        d.status = TaskStatus::NeedsApproval;
        assert_eq!(implied(&d, false), Some(ActionKind::Design));

        // The dispatch gate: `ready` is the truth about the status and says nothing
        // about the wait, so the gate is what distinguishes them.
        let mut r = task("r", TaskKind::Chore);
        r.status = TaskStatus::Ready;
        assert_eq!(implied(&r, true), Some(ActionKind::Admission));
        assert_eq!(implied(&r, false), None, "ungated: nothing to sign");
    }

    #[test]
    fn a_task_with_nothing_outstanding_is_refused_rather_than_defaulted() {
        // Signing a merge for work that is still running would be a signature given
        // before there was anything to look at.
        for status in [
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::Done,
            TaskStatus::Failed,
            TaskStatus::Draft,
        ] {
            let mut t = task("t", TaskKind::Chore);
            t.status = status;
            assert_eq!(implied(&t, true), None, "{}", status.as_str());
        }
    }

    #[test]
    fn a_message_quoted_back_cannot_forge_a_line_of_wecodes_own() {
        // The text is a stranger's until an account resolves, and it is printed either
        // way — a rejection has to say what was rejected. Flattened, so it cannot add
        // a line that reads like a verdict.
        let out = echo("approve\n  chief (you via cli) approved merge");
        assert_eq!(out, "approve chief (you via cli) approved merge");
        assert!(!out.contains('\n'));

        // Bounded, so one long message does not bury the pass it arrived on. Counted in
        // characters rather than bytes: cutting a multi-byte one in half would panic.
        let long = echo(&"é".repeat(200));
        assert_eq!(long.chars().count(), ECHO + 1, "80 and an ellipsis");
        assert_eq!(echo("approve"), "approve");
    }

    #[test]
    fn a_fetch_that_fails_is_an_error_and_says_what_the_command_complained_about() {
        // Unlike the notify hook: a fetch that failed and reported "no replies" would
        // be wecode claiming to have looked.
        let c = company("\n[telegram]\nfetch = \"echo could not resolve host >&2; exit 6\"\n");
        let e = fetch(&c, &std::env::temp_dir(), 0).unwrap_err();
        assert!(e.contains("exited 6"), "{e}");
        assert!(e.contains("could not resolve host"), "{e}");
    }

    #[test]
    fn a_fetch_that_hangs_is_killed_at_its_timeout() {
        // What makes it safe on a loop that polls every pass.
        let c = company("\n[telegram]\nfetch = \"sleep 60\"\ntimeout = \"1s\"\n");
        let began = std::time::Instant::now();
        let e = fetch(&c, &std::env::temp_dir(), 0).unwrap_err();
        assert!(e.contains("killed after 1s"), "{e}");
        assert!(began.elapsed() < std::time::Duration::from_secs(30));
    }

    #[test]
    fn the_offset_reaches_the_command_as_the_environment() {
        let c = company(
            "\n[telegram]\nfetch = \"echo {\\\\\\\"ok\\\\\\\":true,\\\\\\\"result\\\\\\\":[]} $WECODE_TELEGRAM_OFFSET\"\n",
        );
        let body = fetch(&c, &std::env::temp_dir(), 700_124).unwrap();
        assert!(body.contains("700124"), "{body}");
    }

    #[test]
    fn a_fetch_the_charter_forbids_is_not_run() {
        // An invariant outranks every grant, and the line that polls a chat channel is
        // no more above the charter than the line that launches an agent.
        let c = company(
            "\n[invariants]\nnever_run = [\"curl *\"]\n\n[telegram]\nfetch = \"curl example.invalid\"\n",
        );
        let e = fetch(&c, &std::env::temp_dir(), 0).unwrap_err();
        assert!(e.contains("never_run"), "{e}");
    }

    fn company(telegram: &str) -> Company {
        Company::parse(&format!(
            "[company]\nname = \"cws\"\n\n[roles.engineer]\nwrite = [\"src/**\"]\n{telegram}"
        ))
        .expect("the profile parses")
    }
}
