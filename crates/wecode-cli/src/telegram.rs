//! Signing an approval from a reply in a chat.
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
//! Four things are load-bearing:
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
//! - **A message is read once.** Whatever came of an update — signed, refused, or not
//!   a decision at all — the cursor moves past it. The alternative is a week-old "yes"
//!   re-applied on every pass, and a "no" that can never be got rid of because it
//!   leaves no signature to remember it by.
//! - **A bad reply is reported, not raised.** One message that names no task must not
//!   stop the four behind it, and a fetch that failed must not take `wecode loop` down
//!   with it. Only a fetch that could not be believed at all is an error.
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
use wecode_core::{Plan, Task, TaskId, TaskStatus};
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

/// One update, in the shape the Bot API hands it over.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Update {
    pub(crate) id: i64,
    /// The message it carries, when it is one a person sent. `None` for everything
    /// else the channel may contain — an edit, a join, a poll answer. Those are read
    /// and passed over, because an update nothing understands still has to be got past
    /// or the cursor stops at it forever.
    pub(crate) message: Option<Message>,
}

/// A message somebody sent, reduced to what a signature needs.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Message {
    /// The numeric account that sent it. The only field with any authority in it.
    pub(crate) from: String,
    /// The display name Telegram supplies, for the report. Never for identity: it is
    /// chosen by the sender and two people may pick the same one.
    pub(crate) who: String,
    pub(crate) text: String,
    /// The text of the message this replies to. Empty when it replies to nothing —
    /// which is most chat, and is why a reply is what this reads.
    pub(crate) quoted: String,
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
                message: u.get("message").and_then(message_of),
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
    let from = m.get("from")?;
    Some(Message {
        // As written, whatever it is: the id is compared against `company.toml` and
        // never arithmetic, so a future non-integer id costs nothing here.
        from: from.get("id").map(scalar)?,
        who: from
            .get("username")
            .or_else(|| from.get("first_name"))
            .map_or_else(|| "?".to_string(), scalar),
        text: m.get("text").map(scalar).unwrap_or_default(),
        quoted: m
            .get("reply_to_message")
            .and_then(|r| r.get("text"))
            .map(scalar)
            .unwrap_or_default(),
    })
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
        .filter(|w| plan.task(&TaskId::new(*w)).is_none())
        .find_map(|w| ActionKind::parse(&word(w)))
}

/// Every task the text names, in the order it names them.
///
/// Ids are slugs, and so is every word put through `TaskId::new` — which is what makes
/// `approve cache-tests.` and `approve Cache-Tests` find the same task without this
/// having to strip punctuation itself.
fn tasks_named(text: &str, plan: &Plan) -> Vec<TaskId> {
    let mut out: Vec<TaskId> = Vec::new();
    for w in text.split_whitespace() {
        let id = TaskId::new(w);
        if plan.task(&id).is_some() && !out.contains(&id) {
            out.push(id);
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

    // The same charter check the agent launch line and the notify hook get, from the
    // same function. An invariant outranks every grant, and a config is not an
    // exception: this is one more place the operator writes a command line for wecode
    // to run.
    if let Some(pattern) = commands::exec::forbidden_by_charter(company, command) {
        return Err(format!(
            "`{command}` is forbidden by the charter: never_run {pattern}"
        ));
    }

    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(org)
        // The offset, not the URL: the operator's line names the API and holds the
        // token, and wecode says only how far it has already read. Substituting into
        // the command line instead would put wecode in the business of quoting a URL
        // that has a credential in it.
        .env("WECODE_TELEGRAM_OFFSET", offset.to_string())
        .env("WECODE_ORG", org)
        .env("WECODE_COMPANY", &company.name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
    let flat: String = said.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(ECHO) {
        Some((at, _)) => format!("{}…", &flat[..at]),
        None => flat,
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
            out.push_str(&apply(store, company, msg, dry));
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

/// Applies one message. Never fails: a refusal is the report, not an error, because
/// four good replies behind a bad one still have to be read.
fn apply(store: &Store, company: &Company, msg: &Message, dry: bool) -> String {
    let Some(verdict) = verdict(&msg.text) else {
        // Chat. Not every message in a channel is an instruction, and answering the
        // ones that are not is how a notifier becomes a nuisance.
        return String::new();
    };
    let said = format!(
        "  {} ({}): {}",
        echo(&msg.who),
        echo(&msg.from),
        echo(&msg.text)
    );

    let Some(user) = company.user_by_telegram(&msg.from) else {
        return format!(
            "{said}\n    ✗ no user in company.toml gives telegram = \"{}\" — nothing signed\n",
            echo(&msg.from)
        );
    };
    match decide(store, company, msg, user, verdict, dry) {
        Ok(report) => format!("{said}\n{report}"),
        Err(e) => format!("{said}\n    ✗ {e}\n"),
    }
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

    if verdict == Verdict::Decline {
        // Deliberately not a status change. "No" to a merge and "no" to a design mean
        // different things, and a reply is too blunt an instrument to pick — what it
        // is good for is saying *do not land this*, which is what withholding the
        // signature already does. The task stays where it is, in front of a person.
        return Ok(format!(
            "    ⏸ {id} stays {} — nothing signed\n",
            task.status.as_str()
        ));
    }

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
        return Ok(format!("    · would sign {} for {id}\n", kind.as_str()));
    }

    let post = find_post(company, &user.post)?;
    // `telegram` as the session and the agent, the way `--as` records `adhoc`: the
    // ledger should say how a signature arrived, and a reply is not somebody sitting at
    // a terminal — nor is it the post's coding agent, which is what typed nothing here.
    let who = Actor::over(company, &post, CHANNEL, user.name.clone());
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

    fn message(text: &str, quoted: &str) -> Message {
        Message {
            from: "48210934".into(),
            who: "cws".into(),
            text: text.into(),
            quoted: quoted.into(),
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
