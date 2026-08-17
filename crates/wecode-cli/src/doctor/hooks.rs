//! Running the way out and the way back, instead of reading them back.
//!
//! [`crate::notify`] pushes *a task has stopped for you* to wherever the operator is,
//! and [`crate::telegram`] reads the answer. Both halves are command lines the operator
//! writes into `company.toml` by hand — a `notify-send`, a `curl` of the Bot API — and
//! nothing ran either of them until a real task stopped for a real person. That is the
//! worst moment to find out: the chat id is one digit out, the token has expired, the
//! machine has no notification daemon, the charter forbids the line.
//!
//! And every one of those failures looks the same from where the operator is standing.
//! A hook that was never run and a queue with nothing in it are both **silence**, which
//! is the one report this channel cannot tell apart — the board says a task is waiting,
//! and nothing anywhere says whether anybody was told. So a configuration is trusted
//! for exactly as long as it takes for something to depend on it.
//!
//! The drill runs them. Not a parse of the config and not a `which` of the first word:
//! the hook itself, with a task in its environment, against whatever network and
//! whatever daemon this machine actually has. What comes back is read the way wecode
//! already reads it — an exit status, and [`crate::notify`]'s rule that a hook which
//! delivered has no reason to speak.
//!
//! Three things it deliberately does not do.
//!
//! - **It decides nothing and consumes nothing.** No signature, no ledger record, no
//!   status write, and no inbox cursor: the fetch is asked from offset `0`, which is
//!   *everything Telegram still holds* and confirms none of it. A drill that swallowed
//!   the reply it was checking for would be the failure it exists to find, and one that
//!   signed something would be worse than never running.
//! - **It does not run `[telegram] answer`.** `answerCallbackQuery` takes a live
//!   callback id and there is not one; a made-up id is refused whatever the token is, so
//!   running it would report a working channel as broken. The line is checked against
//!   the charter and read no further, and the report says which of the two happened
//!   rather than letting a configured line look like an exercised one.
//! - **It cannot say the message arrived.** wecode holds no chat and cannot see a phone.
//!   `[notify] command` exiting `0` in silence is the strongest thing knowable from this
//!   side, and it is a weaker claim than *delivered* — which is exactly why the drill
//!   sends a real message rather than a simulated one. The last line of the report is
//!   the half only the operator can answer.
//!
//! An absent hook is reported and is not a failure. Nothing here is compulsory: a
//! workspace whose operator watches a terminal is not misconfigured, it is configured
//! for a terminal. What the report says about it is where the line goes, and the exit
//! status stays clean — `wecode doctor && wecode loop` should refuse to start on a hook
//! that is broken, never on one nobody wanted.

use std::path::Path;

use wecode_gov::ActionKind;
use wecode_org::{Company, User};

use super::{Check, Outcome, Section, plural};
use crate::{notify, telegram};

/// What a reply can sign, in the order the report names them.
///
/// Not every [`ActionKind`]. A budget increase and a measure amendment are not waits a
/// task puts in front of a person, so a seat that cannot sign them is not a seat that
/// cannot answer a notification — see [`crate::telegram::implied`], which is the list
/// this mirrors.
const SIGNABLE: [ActionKind; 3] = [
    ActionKind::Merge,
    ActionKind::Admission,
    ActionKind::Design,
];

/// The names the checks are reported under: what the operator would grep `company.toml`
/// for, so a report can be acted on without a translation step.
const PUSH: &str = "[notify] command";
const PULL: &str = "[telegram] fetch";
const ACK: &str = "[telegram] answer";
const WHO: &str = "who may answer";

/// The half of the report about reaching a person, and hearing back.
pub(super) fn section(company: &Company, org: &Path) -> Section {
    let checks = drill(company, org);
    let note = note(&checks);
    Section {
        title: "hooks",
        checks,
        note,
    }
}

/// Everything the drill tries, in the order the path runs: out to the operator, back
/// from them, the receipt for a tap, and whether the person replying may sign at all.
fn drill(company: &Company, org: &Path) -> Vec<Check> {
    vec![
        pushed(company, org),
        read_back(company, org),
        acknowledged(company),
        who_answers(company),
    ]
}

/// Fires `[notify] command` for real.
///
/// Read through the same rule the loop reads it by, because it *is* the same call: a
/// hook is believed when it exits `0` and says nothing, and anything it printed is
/// quoted back. There is no second, gentler standard for a rehearsal — a drill that
/// forgave what the loop would report would be measuring the wrong thing.
fn pushed(company: &Company, org: &Path) -> Check {
    let outcome = match company.notify.command {
        None => Outcome::Absent(
            "not set — a task that stops for you waits until you look at a terminal".to_string(),
        ),
        Some(_) => match notify::rehearse(company, org).trim() {
            "" => Outcome::Sound(
                "ran and said nothing, which is what a delivery looks like".to_string(),
            ),
            said => Outcome::Broken(complaint(said)),
        },
    };
    Check::new(PUSH, outcome)
}

/// A notify warning as the drill quotes it: the mark and the prefix taken off, since
/// the report has a column for both and `✗ [notify] command  ⚠ notify: …` says it
/// twice.
fn complaint(said: &str) -> String {
    let said = said.trim();
    // The whole prefix or none of it. Trimming the words separately would eat a hook's
    // own `notify: …` — which is a thing `notify-send` says about itself, and the
    // reason the operator is reading this line at all.
    said.strip_prefix("⚠ notify:")
        .unwrap_or(said)
        .trim()
        .to_string()
}

/// Runs `[telegram] fetch` and parses what it printed.
///
/// Both halves, because either can be the thing that is wrong and they fail at
/// different ends of the pipe: a `curl` that cannot resolve the host exits non-zero,
/// and a token that has been revoked exits `0` with `{"ok":false,…}` in its body. The
/// second is the one worth the whole check — it is indistinguishable from a quiet
/// channel to everything except the parser, which is why the parser is run here rather
/// than the command alone.
///
/// From offset `0`. `getUpdates` treats an offset as an acknowledgement of everything
/// below it, so asking from where the cursor actually is would have the drill delete
/// the operator's unread replies as a side effect of checking that it could read them.
/// Zero asks for everything still held and confirms nothing.
fn read_back(company: &Company, org: &Path) -> Check {
    let outcome = match company.telegram.fetch {
        None => Outcome::Absent(
            "not set — the answer to a notification is still a terminal".to_string(),
        ),
        Some(_) => {
            match telegram::fetch(company, org, 0).and_then(|body| telegram::updates(&body)) {
                Err(e) => Outcome::Broken(e),
                Ok(held) => Outcome::Sound(format!(
                    "read the channel: {} held, none acted on",
                    plural(held.len(), "update")
                )),
            }
        }
    };
    Check::new(PULL, outcome)
}

/// Reads `[telegram] answer` as far as it can be read without a callback to answer.
///
/// Not run — see the module note. What is checked is the one thing that can be: the
/// charter, which refuses a line by pattern and never needs to execute one. Absent is
/// reported against whether replies are read at all, because a workspace with no
/// channel has nothing to acknowledge and a workspace with one has a button that signs
/// in silence.
fn acknowledged(company: &Company) -> Check {
    let outcome = match &company.telegram.answer {
        None if company.telegram.fetch.is_none() => {
            Outcome::Absent("not set — nothing reads the channel either".to_string())
        }
        None => Outcome::Absent("not set — a tap signs, and the chat says nothing back".into()),
        Some(line) => match crate::commands::exec::forbidden_by_charter(company, line) {
            Some(pattern) => {
                Outcome::Broken(format!("forbidden by the charter: never_run {pattern}"))
            }
            None => Outcome::Sound(
                "set, and not run: answerCallbackQuery needs a live callback id".to_string(),
            ),
        },
    };
    Check::new(ACK, outcome)
}

/// Whether anybody's reply would resolve to a seat, and whether that seat may sign.
///
/// The silent half of the way back, and the reason this is a check of its own. A
/// `fetch` that works perfectly and a `company.toml` where nobody gives a `telegram`
/// id is a channel wecode reads every pass and answers from never: the account
/// resolves to nobody, there is no fallback seat by design, and the operator replying
/// `approve` on a phone gets no reply and no signature. Nothing is broken anywhere a
/// log would show it.
///
/// A seat that may sign nothing is the same failure one step later — the reply is read,
/// attributed, put past the Broker and refused. Worth its own mark, because the fix is
/// in a different block of the same file.
fn who_answers(company: &Company) -> Check {
    let who = company.telegram_users();
    let outcome = if who.is_empty() {
        if company.telegram.fetch.is_none() {
            Outcome::Absent("no [[users]] gives a telegram id".to_string())
        } else {
            Outcome::Broken(
                "the channel is read and no [[users]] gives a telegram id — every reply \
                 resolves to nobody and signs nothing"
                    .to_string(),
            )
        }
    } else {
        let seats: Vec<String> = who.iter().map(|u| seat(company, u)).collect();
        if who.iter().all(|u| signs(company, u).is_empty()) {
            Outcome::Broken(format!("{} — a reply is read, and refused", seats.join("; ")))
        } else {
            Outcome::Sound(seats.join("; "))
        }
    };
    Check::new(WHO, outcome)
}

/// One person who can reply, and what their seat may put its name to.
fn seat(company: &Company, user: &User) -> String {
    match signs(company, user).as_slice() {
        [] => format!("{} ({}) may sign nothing", user.name, user.post),
        kinds => format!("{} ({}) signs {}", user.name, user.post, kinds.join(", ")),
    }
}

/// The waits this user's post may sign off.
///
/// Read off the grant rather than asked of the Broker, which is the same answer for
/// the same reason `wecode brief` is derived: the grant is where the authority is
/// written, and a Broker call would need a session, a task and something to decide
/// about — none of which a drill has, and inventing them is how a rehearsal starts
/// answering a different question from the real one.
fn signs(company: &Company, user: &User) -> Vec<&'static str> {
    company.post(&user.post).map_or_else(Vec::new, |post| {
        let held = company.effective(post);
        SIGNABLE
            .iter()
            .filter(|k| held.allows_approve(**k))
            .map(|k| k.as_str())
            .collect()
    })
}

/// What the rows cannot say for themselves.
fn note(checks: &[Check]) -> String {
    let mut out = String::new();
    // The half of the question wecode is not entitled to answer. Printed only when the
    // hook actually ran, because it is an instruction — go and look — and a workspace
    // with no hook has nothing to go and look for.
    if checks
        .iter()
        .any(|c| c.is(PUSH) && matches!(c.outcome, Outcome::Sound(_)))
    {
        out.push_str(
            "\n  a real notification went out just now, for a task that does not exist.\n  \
             whether it arrived is the half only you can check.\n",
        );
    }
    if checks.iter().all(|c| c.outcome.is_absent()) {
        out.push_str(
            "\n  nothing is configured, so nothing is broken: the way out and the way back\n  \
             are both a terminal. docs/reference/config/notify.md has the line out,\n  \
             and config/telegram.md the line back.\n",
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A company with the given blocks appended. Parsed rather than built, so what the
    /// drill reads is what an operator would actually have written.
    fn company(blocks: &str) -> Company {
        Company::parse(&format!(
            "[company]\nname = \"cws\"\n\n[roles.engineer]\nwrite = [\"src/**\"]\n{blocks}"
        ))
        .expect("the profile parses")
    }

    /// A directory that is not a workspace, so the drill finds no plan and no tree —
    /// which is the state a hook is configured in, before anything has run.
    fn dir() -> PathBuf {
        std::env::temp_dir()
    }

    fn at<'a>(checks: &'a [Check], what: &str) -> &'a Outcome {
        &checks
            .iter()
            .find(|c| c.is(what))
            .unwrap_or_else(|| panic!("no {what} check"))
            .outcome
    }

    /// The half of the report these checks make, rendered as the operator sees it.
    fn rendered(blocks: &str) -> String {
        super::super::render(&[section(&company(blocks), &dir())])
    }

    #[test]
    fn a_workspace_that_configures_nothing_is_absent_rather_than_broken() {
        // Nothing here is compulsory. An operator who watches a terminal is configured
        // for a terminal, and a drill that failed them would be a check nobody could
        // leave in a script.
        let checks = drill(&company(""), &dir());
        assert!(checks.iter().all(|c| c.outcome.is_absent()), "{checks:?}");
        assert!(checks.iter().all(|c| !c.outcome.is_broken()));

        let out = rendered("");
        assert!(out.contains("nothing is configured"), "{out}");
        // Both halves are named, because either one alone is a loop that only goes one
        // way: a notification nobody can answer, or a reply channel nothing speaks into.
        assert!(out.contains("config/notify.md"), "the line out: {out}");
        assert!(out.contains("config/telegram.md"), "the line back: {out}");
    }

    #[test]
    fn a_notify_hook_that_works_is_run_and_believed() {
        let blocks = "\n[notify]\ncommand = \"true\"\n";
        let checks = drill(&company(blocks), &dir());
        let note = at(&checks, PUSH);
        assert!(!note.is_broken(), "{note:?}");
        assert!(note.note().contains("said nothing"), "{note:?}");

        // And the operator is told the part that is theirs. The hook exiting 0 is not
        // the message arriving, and a report that let those read the same would be the
        // silence this whole command exists to break.
        let out = rendered(blocks);
        assert!(out.contains("only you can check"), "{out}");
    }

    #[test]
    fn a_notify_hook_that_fails_is_reported_with_what_it_complained_about() {
        let checks = drill(
            &company("\n[notify]\ncommand = \"echo could not resolve host >&2; exit 6\"\n"),
            &dir(),
        );
        let note = at(&checks, PUSH);
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("exited 6"), "{note:?}");
        assert!(note.note().contains("could not resolve host"), "{note:?}");
        // The report's own mark, not the loop's: `⚠ notify:` inside a `✗` line is the
        // same fact printed twice.
        assert!(!note.note().contains('⚠'), "{note:?}");
    }

    #[test]
    fn a_hook_that_exits_well_and_says_something_is_not_taken_for_a_delivery() {
        // The drill's whole reason to exist, in one case: `curl` carrying a `400 chat
        // not found` exits 0 having done exactly what it was asked. Read under the same
        // rule the loop reads it by, so the answer here is the answer at 02:14.
        let checks = drill(
            &company("\n[notify]\ncommand = \"echo Bad Request: chat not found\"\n"),
            &dir(),
        );
        let note = at(&checks, PUSH);
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("chat not found"), "{note:?}");
    }

    #[test]
    fn a_notify_hook_the_charter_forbids_is_reported_and_not_run() {
        let checks = drill(
            &company(
                "\n[invariants]\nnever_run = [\"curl *\"]\n\n[notify]\ncommand = \"curl example.invalid\"\n",
            ),
            &dir(),
        );
        assert!(at(&checks, PUSH).note().contains("never_run"), "{checks:?}");
    }

    #[test]
    fn a_fetch_that_answers_is_read_and_counted() {
        let checks = drill(
            &company(
                "\n[telegram]\nfetch = \"echo {\\\\\\\"ok\\\\\\\":true,\\\\\\\"result\\\\\\\":[]}\"\n",
            ),
            &dir(),
        );
        let note = at(&checks, PULL);
        assert!(!note.is_broken(), "{note:?}");
        assert!(note.note().contains("0 updates"), "{note:?}");
        assert!(note.note().contains("none acted on"), "{note:?}");
    }

    #[test]
    fn a_token_that_is_refused_is_broken_rather_than_a_quiet_channel() {
        // The failure the parse is here for. The command exits 0 — it did what it was
        // asked — and the body says the question was never answered. Reading that as
        // "no replies" is a healthy report to an operator whose channel is dead.
        let checks = drill(
            &company(
                "\n[telegram]\nfetch = \"echo {\\\\\\\"ok\\\\\\\":false,\\\\\\\"description\\\\\\\":\\\\\\\"Unauthorized\\\\\\\"}\"\n",
            ),
            &dir(),
        );
        let note = at(&checks, PULL);
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("Unauthorized"), "{note:?}");
    }

    #[test]
    fn a_fetch_that_cannot_run_is_broken_and_says_why() {
        let checks = drill(
            &company("\n[telegram]\nfetch = \"echo no route to host >&2; exit 7\"\n"),
            &dir(),
        );
        let note = at(&checks, PULL);
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("no route to host"), "{note:?}");
    }

    #[test]
    fn an_answer_line_is_checked_against_the_charter_without_being_run() {
        // It cannot be run: `answerCallbackQuery` wants a callback id that only a real
        // tap has. So the report says `not run` in the case that is fine, and the one
        // thing that can be judged from the text is judged.
        let ok = drill(
            &company("\n[telegram]\nfetch = \"true\"\nanswer = \"true\"\n"),
            &dir(),
        );
        assert!(at(&ok, ACK).note().contains("not run"), "{ok:?}");
        assert!(!at(&ok, ACK).is_broken());

        let forbidden = drill(
            &company(
                "\n[invariants]\nnever_run = [\"curl *\"]\n\n[telegram]\nfetch = \"true\"\nanswer = \"curl example.invalid\"\n",
            ),
            &dir(),
        );
        assert!(at(&forbidden, ACK).is_broken());
        assert!(at(&forbidden, ACK).note().contains("never_run"));
    }

    #[test]
    fn a_channel_nobody_can_answer_from_is_broken_rather_than_absent() {
        // The silent half. A `fetch` that works and no account claiming a seat is a
        // channel read every pass and answered from never — there is no fallback seat,
        // deliberately, so every reply resolves to nobody.
        let checks = drill(&company("\n[telegram]\nfetch = \"true\"\n"), &dir());
        let note = at(&checks, WHO);
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("resolves to nobody"), "{note:?}");

        // With no channel at all it is an absence, not a fault: an id nothing reads is
        // not a misconfiguration.
        let none = drill(&company(""), &dir());
        assert!(at(&none, WHO).is_absent());
    }

    #[test]
    fn a_seat_that_may_answer_is_named_with_what_it_may_sign() {
        let checks = drill(
            &company(
                "\n[roles.boss]\napprove = [\"merge\", \"admission\"]\n\n\
                 [[posts]]\nname = \"chief\"\nrole = \"boss\"\n\n\
                 [[users]]\nname = \"you\"\npost = \"chief\"\ntelegram = \"481\"\n\n\
                 [telegram]\nfetch = \"true\"\n",
            ),
            &dir(),
        );
        let note = at(&checks, WHO);
        assert!(!note.is_broken(), "{note:?}");
        assert!(note.note().contains("you (chief)"), "{note:?}");
        assert!(note.note().contains("merge"), "{note:?}");
        assert!(note.note().contains("admission"), "{note:?}");
        // Named because it is not held: the list is what this seat may sign, and a
        // report that padded it would be describing a different seat.
        assert!(!note.note().contains("design"), "{note:?}");
    }

    #[test]
    fn a_seat_that_may_sign_nothing_is_broken_one_step_later() {
        // The reply is read, attributed and refused. Its own mark, because the fix is
        // in the roles block rather than in the channel.
        let checks = drill(
            &company(
                "\n[[posts]]\nname = \"impl\"\nrole = \"engineer\"\n\n\
                 [[users]]\nname = \"you\"\npost = \"impl\"\ntelegram = \"481\"\n\n\
                 [telegram]\nfetch = \"true\"\n",
            ),
            &dir(),
        );
        let note = at(&checks, WHO);
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("may sign nothing"), "{note:?}");
    }

    #[test]
    fn every_check_is_reported_under_the_name_it_is_written_down_as() {
        // The report is a to-do list against `company.toml`. A heading the operator
        // cannot grep for is a finding they have to translate first.
        let out = rendered("");
        for at in [PUSH, PULL, ACK, WHO] {
            assert!(out.contains(at), "{at} is missing from:\n{out}");
        }
    }

    #[test]
    fn what_is_set_and_what_is_missing_carry_different_marks() {
        let out = rendered("\n[notify]\ncommand = \"exit 3\"\n");
        assert!(out.contains("✗ [notify] command"), "{out}");
        assert!(out.contains("· [telegram] fetch"), "{out}");
    }

    #[test]
    fn a_hook_warning_is_quoted_without_the_marks_the_report_already_has() {
        assert_eq!(complaint("⚠ notify: `x` exited 3"), "`x` exited 3");
        assert_eq!(complaint("  ⚠ notify: killed after 1s  \n"), "killed after 1s");
        // Anything that is not the loop's own prefix survives whole: what a hook said
        // for itself is the reason, and trimming into it would eat the answer.
        assert_eq!(
            complaint("notify: daemon is not running"),
            "notify: daemon is not running"
        );
    }
}
