//! `[notify]` and `[telegram]`: how the operator hears, and how they answer.
//!
//! Two blocks and one round trip. `[notify]` runs when a task stops for a person;
//! `[telegram]` is the way back, so the answer need not be typed at the terminal the
//! notification was sent away from. They are here together because they are one
//! feature read from either end, and because they fail the same way — a command
//! written blank, or a timeout that could never finish, is a block that reads as
//! configured and behaves as absent. Both are refused at load rather than discovered
//! as silence.
//!
//! wecode holds no network client and no bot token. Both blocks are commands the
//! operator writes, so the secret stays in their shell and wecode stays a program that
//! runs commands.

use std::time::Duration;

use serde::Deserialize;

use super::{OrgError, parse_duration};

/// The hook run when a task starts waiting on a person.
///
/// `command` is an `Option` rather than a defaulted string so that writing it empty
/// can be refused: a `[notify]` block with nothing to run means to notify and does
/// not, and the whole point of the block is to be believed.
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct NotifyBlock {
    command: Option<String>,
    #[serde(default = "ten_seconds")]
    timeout: String,
    /// How many changed paths the hook is handed. See [`Notify::max_files`].
    #[serde(default = "twenty")]
    max_files: u64,
}

fn ten_seconds() -> String {
    "10s".to_string()
}

fn twenty() -> u64 {
    20
}

// Hand-written, like `SessionBlock`'s: a derived `Default` would take the empty
// string rather than the `#[serde(default)]` function, and an absent block would
// then fail to parse the timeout it never named.
impl Default for NotifyBlock {
    fn default() -> Self {
        Self {
            command: None,
            timeout: ten_seconds(),
            max_files: twenty(),
        }
    }
}

/// The commands that hand replies back and say what came of them, and how long either
/// may take.
///
/// Both are an `Option` for the reason `[notify] command` is: a block that reads as
/// configured and does nothing is worse than no block, so writing either empty is
/// refused.
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct TelegramBlock {
    fetch: Option<String>,
    answer: Option<String>,
    #[serde(default = "thirty_seconds")]
    timeout: String,
}

fn thirty_seconds() -> String {
    "30s".to_string()
}

// Hand-written for the same reason `NotifyBlock`'s is.
impl Default for TelegramBlock {
    fn default() -> Self {
        Self {
            fetch: None,
            answer: None,
            timeout: thirty_seconds(),
        }
    }
}

/// What to run when a task stops for a person, and how long to let it take.
///
/// The other half of the attention budget. `max_open_items` bounds what may be in
/// flight; this is how the operator finds out that one of those things now needs
/// them, without having to be watching when it happens.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Notify {
    /// `None` — the default — is no hook, and nothing is run.
    pub command: Option<String>,
    /// How long the hook may take before it is killed. A notifier that hangs must
    /// not take the loop with it.
    pub timeout: Duration,
    /// How many of the paths the task changed are named to the hook.
    ///
    /// A bound on the *names*, never on the count that goes beside them, so a hook
    /// handed ten paths of forty can still say forty. Configurable because the channel
    /// is the operator's — a desktop notification has a line where a chat message has a
    /// screen and a log file has room for everything — and bounded by default because an
    /// environment is not the place to put a thousand paths.
    ///
    /// `0` is legal and means the count alone. Unlike a blank `command` it is not a
    /// setting that reads as configured and does nothing: the notification still fires
    /// and still says how much changed.
    pub max_files: u64,
}

/// How replies get back from the chat the notification went out to.
///
/// The other half of [`Notify`]. That one pushes *a task has stopped for you* to
/// wherever the operator is; without this, the way back was still a terminal, and a
/// signature nobody is near to give is a queue standing still.
///
/// wecode holds no network client and no bot token. `fetch` is a command the operator
/// writes — a `curl` of the Bot API's `getUpdates`, usually — and what it prints on
/// stdout is what wecode reads. The offset to ask from arrives in its environment as
/// `WECODE_TELEGRAM_OFFSET`, so the secret stays in the operator's shell and wecode
/// stays a program that runs commands.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Telegram {
    /// `None` — the default — means replies are not read at all.
    pub fetch: Option<String>,
    /// The command that tells the chat what came of a tap — a `curl` of
    /// `answerCallbackQuery`, usually. The callback to answer and the line to say arrive
    /// in its environment as `WECODE_TELEGRAM_CALLBACK` and `WECODE_TELEGRAM_ANSWER`.
    ///
    /// `None` means a tap is acted on and nothing is said back. That works, and it is
    /// the wrong shape of working: a button that signs a merge silently looks exactly
    /// like a button that is broken, and the operator goes to a terminal to find out
    /// which — the journey this whole channel exists to save. Only taps use it; a typed
    /// reply is already visible in the chat that carries it.
    pub answer: Option<String>,
    /// How long the fetch may take before it is killed. `wecode loop` runs this every
    /// pass; a poll that hangs must not take the loop with it. The answer is held to the
    /// same limit, for the same reason and against the same clock-bound loop.
    pub timeout: Duration,
}

/// The notify hook as configured, with the two ways of writing it wrong refused.
///
/// A blank command and a zero timeout are both a block that reads as configured and
/// behaves as absent — the first announces nothing, the second kills the hook before
/// it can run. Neither is a shape anyone means, and both are silent.
pub(super) fn notify_of(b: &NotifyBlock) -> Result<Notify, OrgError> {
    let command = match b.command.as_deref().map(str::trim) {
        None => None,
        Some("") => {
            return Err(OrgError::BadValue {
                at: "[notify] command".into(),
                value: b.command.clone().unwrap_or_default(),
            });
        }
        Some(cmd) => Some(cmd.to_string()),
    };
    let timeout = parse_duration(&b.timeout)
        .filter(|d| !d.is_zero())
        .ok_or_else(|| OrgError::BadValue {
            at: "[notify] timeout".into(),
            value: b.timeout.clone(),
        })?;
    Ok(Notify {
        command,
        timeout,
        max_files: b.max_files,
    })
}

/// The reply channel as configured, refused every way it can read as on and behave as
/// off. Exactly [`notify_of`]'s argument, at the other end of the same round trip.
pub(super) fn telegram_of(b: &TelegramBlock) -> Result<Telegram, OrgError> {
    let fetch = command_at("[telegram] fetch", b.fetch.as_deref())?;
    let answer = command_at("[telegram] answer", b.answer.as_deref())?;
    // Not a `BadValue`: the line is fine, and what is wrong is that nothing would ever
    // reach it. Silence configured this way is indistinguishable from a broken button.
    if answer.is_some() && fetch.is_none() {
        return Err(OrgError::AnswerWithoutFetch);
    }
    let timeout = parse_duration(&b.timeout)
        .filter(|d| !d.is_zero())
        .ok_or_else(|| OrgError::BadValue {
            at: "[telegram] timeout".into(),
            value: b.timeout.clone(),
        })?;
    Ok(Telegram {
        fetch,
        answer,
        timeout,
    })
}

/// A command line as configured: absent, or something there is to run. A key written
/// blank is refused rather than read as absent, because the two look the same from the
/// outside and only one of them was meant.
fn command_at(at: &str, written: Option<&str>) -> Result<Option<String>, OrgError> {
    match written.map(str::trim) {
        None => Ok(None),
        Some("") => Err(OrgError::BadValue {
            at: at.into(),
            // As written, whitespace and all: an operator looking for what to fix wants
            // the value the file holds and not a tidied one.
            value: written.unwrap_or_default().to_string(),
        }),
        Some(cmd) => Ok(Some(cmd.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::{Company, MINIMAL};

    #[test]
    fn no_notify_block_is_no_hook() {
        // The default has to be silence: a workspace that has never heard of the
        // setting must not try to run anything when a task stops.
        let c = Company::parse(MINIMAL).unwrap();
        assert_eq!(c.notify.command, None);
        assert_eq!(c.notify.timeout, Duration::from_secs(10));
        assert_eq!(c.notify.max_files, 20, "enough paths to read, not a report");
    }

    #[test]
    fn a_notify_command_is_taken_with_its_own_timeout() {
        let text = format!("{MINIMAL}\n[notify]\ncommand = \"say hello\"\ntimeout = \"2m\"\n");
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.notify.command.as_deref(), Some("say hello"));
        assert_eq!(c.notify.timeout, Duration::from_secs(120));
    }

    #[test]
    fn how_much_of_the_diff_the_hook_is_handed_is_the_operators_call() {
        // The channel decides: one line on a desktop, a screen in a chat message. Zero
        // is legal and is not the failure a blank `command` is — the notification still
        // fires, and still says how many files changed.
        for (written, want) in [("max_files = 3", 3), ("max_files = 0", 0)] {
            let text = format!("{MINIMAL}\n[notify]\ncommand = \"true\"\n{written}\n");
            let c = Company::parse(&text).unwrap();
            assert_eq!(c.notify.max_files, want, "{written}");
        }
    }

    #[test]
    fn a_blank_notify_command_is_refused_rather_than_read_as_off() {
        // The failure a gate must not have, in its quiet form: a block that says a
        // notification will happen, and a value that means none ever will.
        for blank in ["\"\"", "\"   \""] {
            let text = format!("{MINIMAL}\n[notify]\ncommand = {blank}\n");
            match Company::parse(&text).unwrap_err() {
                OrgError::BadValue { at, .. } => assert!(at.contains("[notify] command"), "{at}"),
                other => panic!("expected BadValue, got {other}"),
            }
        }
    }

    #[test]
    fn a_notify_timeout_that_could_never_finish_is_refused() {
        // Zero kills the hook before it runs, which is a hook that silently never
        // fires; an unparseable one would default to something nobody asked for.
        for bad in ["0s", "later"] {
            let text = format!("{MINIMAL}\n[notify]\ncommand = \"true\"\ntimeout = \"{bad}\"\n");
            match Company::parse(&text).unwrap_err() {
                OrgError::BadValue { at, value } => {
                    assert!(at.contains("[notify] timeout"), "{at}");
                    assert_eq!(value, bad);
                }
                other => panic!("expected BadValue, got {other}"),
            }
        }
    }

    #[test]
    fn no_telegram_block_reads_no_replies() {
        // The default has to be silence in this direction too: a workspace that has
        // never heard of the setting must not run anything to see whether somebody
        // approved something in a chat it does not know about.
        let c = Company::parse(MINIMAL).unwrap();
        assert_eq!(c.telegram.fetch, None);
        assert_eq!(c.telegram.answer, None);
        assert_eq!(c.telegram.timeout, Duration::from_secs(30));
    }

    #[test]
    fn a_fetch_command_is_taken_with_its_own_timeout() {
        let text = format!("{MINIMAL}\n[telegram]\nfetch = \"curl -s x\"\ntimeout = \"5s\"\n");
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.telegram.fetch.as_deref(), Some("curl -s x"));
        assert_eq!(c.telegram.timeout, Duration::from_secs(5));
    }

    #[test]
    fn a_tap_may_be_acknowledged_by_a_command_of_its_own() {
        // The other direction, and the reason a button beats a typed reply: what the tap
        // did comes back to the phone that made it, so nobody has to open a terminal to
        // find out whether it worked.
        let text = format!(
            "{MINIMAL}\n[telegram]\nfetch = \"curl -s x\"\nanswer = \"curl -s answerCallbackQuery\"\n"
        );
        let c = Company::parse(&text).unwrap();
        assert_eq!(
            c.telegram.answer.as_deref(),
            Some("curl -s answerCallbackQuery")
        );
        // One timeout for both. A command that answers a chat is on the same clock as the
        // one that reads it, and a second knob would be a second thing to get wrong.
        assert_eq!(c.telegram.timeout, Duration::from_secs(30));
    }

    #[test]
    fn an_answer_with_no_fetch_to_read_taps_is_refused_at_load() {
        // Nothing would ever run it: taps arrive through the fetch. Configured this way
        // it is a button that stays silent, which is the shape of broken that sends the
        // operator back to a terminal to find out what happened.
        let text = format!("{MINIMAL}\n[telegram]\nanswer = \"curl -s answerCallbackQuery\"\n");
        match Company::parse(&text).unwrap_err() {
            OrgError::AnswerWithoutFetch => {}
            other => panic!("expected AnswerWithoutFetch, got {other}"),
        }
    }

    #[test]
    fn a_blank_command_or_an_impossible_timeout_is_refused_at_load() {
        // Same shapes as `[notify]`, refused in the same place: a block that says
        // replies will be read or answered, and a value that means none ever are.
        for (block, at) in [
            ("fetch = \"\"", "[telegram] fetch"),
            ("fetch = \"true\"\nanswer = \"\"", "[telegram] answer"),
            ("fetch = \"true\"\ntimeout = \"0s\"", "[telegram] timeout"),
            ("fetch = \"true\"\ntimeout = \"soon\"", "[telegram] timeout"),
        ] {
            let text = format!("{MINIMAL}\n[telegram]\n{block}\n");
            match Company::parse(&text).unwrap_err() {
                OrgError::BadValue { at: got, .. } => assert!(got.contains(at), "{got}"),
                other => panic!("expected BadValue for {block}, got {other}"),
            }
        }
    }
}
