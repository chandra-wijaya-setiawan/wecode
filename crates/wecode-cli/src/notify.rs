//! Telling a person that something has stopped for them.
//!
//! wecode is built to be left running: a task is dispatched under a budget, into a
//! worktree, and judged before anything it produced can land. What it cannot do
//! unattended is the half that was always a person's — signing a merge, answering a
//! question, deciding what happens to work that failed. Until this existed the only
//! way to learn that a task had stopped for you was to *look*: at the loop's output,
//! at the board, at `wecode ready`. Work that finished at 02:14 waited until somebody
//! next looked at a terminal, which on the workspace that found this was the morning.
//!
//! So `[notify] command` runs when a task starts waiting on a human, and the operator
//! decides what "tell me" means: a desktop notification, a message, a line in a file.
//!
//! Four things are load-bearing:
//!
//! - **The edge, not the state.** It fires on the *transition* into waiting, so a task
//!   that has been waiting a week fires once rather than every tick. The loop already
//!   prints the standing condition every pass; a notifier that did the same would be
//!   the thing you turn off.
//! - **It cannot fail the work.** A hook that exits non-zero, hangs, or does not exist
//!   is reported and stepped over. A task is not less finished because a notification
//!   did not arrive, and a supervisor that fell over telling you about a success would
//!   be worse than no supervisor.
//! - **It is bounded.** The hook is killed at `[notify] timeout`. `wecode loop` runs
//!   for days; a notifier blocked on a network call must not take it with it.
//! - **A refusal is not a delivery** — see [`said`]. A hook is believed when it exits
//!   `0` *and says nothing*; anything it printed is quoted back beside the wait. That
//!   is the one report the operator cannot get any other way, because the board says a
//!   task is waiting whether or not anything managed to say so.
//!
//! The task is passed in the environment rather than substituted into the command
//! line. A title is arbitrary prose written by whoever planned the work — pasted into
//! a shell line it is a quoting bug at best, and `wecode` is holding the shell.
//!
//! What the hook is told includes **what the task produced** — see [`Produced`]. A
//! notification that only names the task answers "you are wanted" and not "for what":
//! deciding whether to sign a diff meant opening a terminal to see the diff, which is
//! the trip this exists to save. So the paths the attempt wrote go out with the
//! message, read out of git rather than asked of the agent, for the reason the verdict
//! is.
//!
//! And **the diff itself**, not only the paths it touched. A list of names says what a
//! change reached and never what it did: `notify.rs, config.md` reads the same whether
//! the attempt rewrote a module or fixed a typo in it. So an operator with a phone
//! could be told they were wanted, and — once a reply could sign — sign, without ever
//! having been shown the thing they were signing. The way out was `$WECODE_WORKTREE`:
//! ask git yourself. That is a shell, and a notification's whole premise is that there
//! is not one where the operator is standing. See [`diff_of`] for what is sent instead,
//! and [`DIFF`] for how much of it.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use wecode_core::{Task, TaskId, TaskStatus};
use wecode_org::{Company, Workspace};
use wecode_store::Store;

/// How often to look at a running hook. Short: these finish in milliseconds, and the
/// interval is dead time on every notification.
const POLL: Duration = Duration::from_millis(20);

/// How much of a hook's output is read back, in bytes. Only the first line of it is
/// ever quoted, and nothing past this could be part of one. The rest stays where the
/// hook wrote it and goes away with the file.
const KEEP: u64 = 4096;

/// How much of that line is printed. Long enough to carry `chat not found`, short
/// enough that a hook cannot take the pass it fired on with it.
const QUOTE: usize = 120;

/// How much of the diff the hook is handed, in characters.
///
/// A bound, because an environment is not the place to put a megabyte and no channel
/// would carry it if it were. This much, because the tightest channel an operator
/// actually reads a diff on is a chat message: Telegram refuses one over 4096
/// characters outright — which is also why this counts characters and not lines — and
/// the difference is the room a hook needs for its own words around it, truncation mark
/// included.
///
/// Not the operator's to set, unlike [`Notify::max_files`](wecode_org::Notify), because
/// there is nothing to trade. That one buys a shorter message by naming fewer files,
/// and the count beside it stays true either way; a diff is not shorter for being cut,
/// it is only less of a diff. A hook that wants all of it is handed the tree.
const DIFF: usize = 4000;

/// Why a task is waiting on a person.
///
/// Four reasons and not three: the dispatch gate holds a task that is `ready`, so the
/// status alone cannot say why the operator is wanted. What the hook is told is this,
/// not the status, because "what do you want from me" is the question a notification
/// exists to answer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Waiting {
    /// Verified. A holder must sign before it can land.
    Approval,
    /// The agent asked something only a person can answer.
    Input,
    /// Attempts exhausted. What happens next is a decision.
    Failed,
    /// Startable, and the project's dispatch gate wants a signature first.
    Signature,
}

impl Waiting {
    /// The word the hook is handed, in `WECODE_WAITING_FOR`.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Approval => "approval",
            Self::Input => "input",
            Self::Failed => "failed",
            Self::Signature => "signature",
        }
    }

    /// The reason a *status* carries, if that status is one that stops for a person.
    ///
    /// Defined against [`TaskStatus::needs_a_human`] rather than beside it: the board's
    /// "needs you" column, the loop's pause and this hook must not be able to disagree
    /// about what waiting means. The test below is what holds them together.
    fn of(status: TaskStatus) -> Option<Self> {
        match status {
            TaskStatus::NeedsApproval => Some(Self::Approval),
            TaskStatus::NeedsInput => Some(Self::Input),
            TaskStatus::Failed => Some(Self::Failed),
            _ => None,
        }
    }
}

/// The reason to announce, when a status change is a task *starting* to wait.
///
/// `None` when it already was: a failed task re-marked failed, or one moving from
/// `needs-input` to `needs-approval`, has not newly acquired a person — it has had one
/// all along, and telling them twice for one wait is how a notifier becomes noise.
pub(crate) fn crossing(from: TaskStatus, to: TaskStatus) -> Option<Waiting> {
    if from.needs_a_human() {
        return None;
    }
    Waiting::of(to)
}

/// Announces a status change, when it is a task starting to wait on a person.
///
/// The one entry point for every place a status is written, so a new one cannot
/// quietly acquire a status change without the announcement that goes with it.
///
/// Both statuses are passed rather than read off `task`: a caller that has already
/// written one — `run`, which marks a task `running` before spawning — holds a copy
/// that is out of date, and a stale `from` is how an announcement gets swallowed.
pub(crate) fn on_status_change(
    company: &Company,
    org: &Path,
    task: &Task,
    from: TaskStatus,
    to: TaskStatus,
) -> String {
    match crossing(from, to) {
        Some(why) => fire(company, org, task, to, why),
        None => String::new(),
    }
}

/// Announces a task the dispatch gate is holding for a signature.
///
/// Its status is unchanged and stays that way — `ready` is the truth, the task *is*
/// startable — so this is the one announcement whose reason cannot be read off the
/// board. See [`Announced`] for how it fires once.
pub(crate) fn on_signature_wait(company: &Company, org: &Path, task: &Task) -> String {
    fire(company, org, task, task.status, Waiting::Signature)
}

/// The task the drill announces. Named rather than inlined so the one place that has
/// to know it — the report telling an operator what they are about to receive — cannot
/// disagree with the message they actually get.
pub(crate) const DRILL: &str = "doctor-drill";

/// Fires the hook on purpose, so an operator can find out what it does before a task
/// depends on it. Returns what [`fire`] returns: nothing when it ran clean, a warning
/// when it did not.
///
/// Here rather than in [`crate::doctor`] because the whole value of the drill is that it
/// is not a second implementation. A rehearsal that assembled its own environment would
/// be a test of the rehearsal — the point is that this goes out through the call the
/// loop makes, past the same charter check, under the same timeout, read back under the
/// same rule about a hook that had nothing to say.
///
/// The task is invented and stands for nothing, which costs two things worth stating.
/// It carries **no number**: `WECODE_TASK_NUMBER` is the handle a reply is typed
/// against, and a drill that put a live number into a real chat message would be one
/// `approve` away from signing work nobody had looked at. And it has no worktree, so
/// the four artifact variables arrive empty — the shape a `signature` wait has anyway.
/// What the operator receives is therefore a thinner message than a real one, in
/// exactly the fields that could do damage.
///
/// The id it does carry names no task in any plan, so a reply to the drill resolves to
/// nothing and signs nothing. A workspace that genuinely has a task called
/// `doctor-drill` is the exception, and it costs a message naming it rather than
/// anything being decided: the drill writes no status and takes no signature itself.
///
/// `needs-approval` and [`Waiting::Approval`], because that is the wait an operator
/// actually answers from a phone. A drill should exercise the branch the hook will be
/// asked for at 02:14 rather than the quietest one it has.
pub(crate) fn rehearse(company: &Company, org: &Path) -> String {
    let task = Task::new(
        DRILL,
        DRILL,
        "wecode doctor — a drill. Nothing is waiting, and nothing can be signed.",
    );
    fire(
        company,
        org,
        &task,
        TaskStatus::NeedsApproval,
        Waiting::Approval,
    )
}

/// The task's short number for the hook's environment, or empty when it has none.
fn number_env(task: &Task) -> String {
    task.number
        .map(|n| n.get().to_string())
        .unwrap_or_default()
}

/// What a task has to show for itself: the tree the work is in, the paths written in
/// it, and what was written in them.
///
/// Read out of git, never asked of the agent — the same rule the verdict is judged
/// under, and for the same reason: a diff is ground truth where a self-report is a
/// claim, and a notification carrying a claim would be one more thing to go and check.
///
/// It is the *uncommitted* diff, which is precisely the one `verify` judged: an attempt
/// is committed only after the verdict, so the announcement and the verdict that
/// triggered it describe the same work by construction. A hook wanting more than this —
/// the rest of a diff past [`DIFF`], the attempts before this one — is handed the tree
/// and can ask git anything.
#[derive(Debug)]
struct Produced {
    /// The worktree the work happened in.
    dir: PathBuf,
    /// Every path changed in it, sorted, untracked files included.
    files: Vec<String>,
    /// What changed in them, as a bounded diff — see [`diff_of`].
    diff: String,
}

impl Produced {
    /// What this task has produced, and `None` when there is nothing that can be said:
    /// no tree yet, no database to find out which tree, or a directory git will not
    /// answer about.
    ///
    /// `None` and *changed nothing* reach the hook differently — empty against `0` —
    /// because "has not started" and "started and wrote nothing" are different things
    /// to be woken up for, and a notification that spelled the first as the second
    /// would be reporting an empty diff nobody produced.
    fn of(org: &Path, task: &Task) -> Option<Self> {
        let dir = tree_of(org, task)?;
        let files = crate::git::changed_files(&dir).ok()?;
        let diff = diff_of(&dir);
        Some(Self { dir, files, diff })
    }

    /// How many paths there are, however few of them are listed.
    fn count(&self) -> String {
        self.files.len().to_string()
    }

    /// The paths, one per line, at most `max` of them.
    ///
    /// Truncated rather than elided, and never in a way that lies: the count beside it
    /// is the whole number, so a hook handed ten paths of forty can say forty. The bound
    /// is the operator's because the channel is — a desktop notification has a line, a
    /// chat message has a screen — and it is a bound at all because an environment is
    /// not the place to put a thousand paths.
    fn listed(&self, max: u64) -> String {
        let max = usize::try_from(max).unwrap_or(usize::MAX);
        self.files
            .iter()
            .take(max)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The tree this task's work is in, and `None` when there is not one.
///
/// A subtask works in its parent's tree, so *which* tree is a question about the plan
/// rather than about the task in hand — which is why an announcement reads the
/// workspace database. Read-only, and only when one is already there: [`Store::open`]
/// creates and migrates, and a notification must not bring a workspace into being.
///
/// A task whose playbook said it needed no worktree is reported as nothing rather than
/// as the repository, deliberately. The operator's own checkout holds the operator's
/// own uncommitted work, and handing that over as *what the task produced* would be the
/// notification inventing a diff.
fn tree_of(org: &Path, task: &Task) -> Option<PathBuf> {
    let db = Workspace::at(org).db_path();
    if !db.is_file() {
        return None;
    }
    let plan = Store::open(&db).ok()?.load_plan().ok()?;
    let owner = crate::work::owner(&plan, &task.id)?;
    let dir = crate::work::worktree_for(&crate::work::org_name(org), &owner.id);
    dir.is_dir().then_some(dir)
}

/// The uncommitted diff of `dir`, bounded to [`DIFF`] characters — the change itself,
/// so that the message carrying it can be judged rather than only acted on.
///
/// Against `HEAD`, the same base [`crate::git::changed_files`] names its paths against,
/// so the names and the diff beside them are two views of one change and not two
/// changes. That is what lets a hook print a heading and a body without either
/// contradicting the other.
///
/// Read, never written. A tree can have an agent in it while this runs — a subtask
/// works in its parent's — so a file git has not seen yet is rendered with `--no-index`
/// against `/dev/null` rather than with the shorter `add -N`, which would stage
/// somebody else's work in the middle of it. An announcement that edited what it was
/// describing would be worse than one that said nothing.
fn diff_of(dir: &Path) -> String {
    let mut text = asked(dir, &["diff", "--no-color", "HEAD"]);
    let mut wide = text.chars().count();

    // The half a plain `git diff` leaves out, and for a lot of tasks the whole of the
    // work: a new module, a new test file, a playbook. Listed and never shown, those
    // are a notification that looks complete and is empty. Abandoned as soon as there
    // is enough to fill the bound, so a tree of new files costs a handful of reads
    // rather than one per file.
    for path in asked(dir, &["ls-files", "--others", "--exclude-standard"]).lines() {
        if wide > DIFF {
            break;
        }
        let more = asked(
            dir,
            &["diff", "--no-color", "--no-index", "--", "/dev/null", path],
        );
        wide += more.chars().count();
        text.push_str(&more);
    }

    match text.char_indices().nth(DIFF) {
        // Marked and never quietly cut, for the reason the count goes beside the names
        // rather than being replaced by them: a hook handed part of a diff has to be
        // able to say that it is a part. Counted in characters and cut on one, because
        // a diff is arbitrary text and halving a multi-byte character would panic.
        Some((at, _)) => format!("{}\n… truncated, {} bytes in full", &text[..at], text.len()),
        None => text,
    }
}

/// git in `dir`, and whatever it printed on stdout — nothing at all if it could not be
/// run or would not answer.
///
/// Here rather than beside the rest of [`crate::git`], where every call hands back a
/// `Result` its caller is expected to do something about. This one deliberately cannot
/// fail: a diff wecode could not read is a thinner notification and never a missing
/// one, and `--no-index` spells *these two files differ* as a non-zero exit, which is
/// the answer rather than an error.
fn asked(dir: &Path, args: &[&str]) -> String {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .output()
        // Lossy, like the hook's own output and for the same reason: a diff touching a
        // file in some other encoding is still worth reading, and an announcement is
        // not the place to stop over a byte.
        .map_or_else(
            |_| String::new(),
            |out| String::from_utf8_lossy(&out.stdout).into_owned(),
        )
}

/// Runs the hook. Returns what the caller should print: nothing when it ran or when
/// none is configured, a warning when it did not. Never an error — see the module note.
fn fire(company: &Company, org: &Path, task: &Task, status: TaskStatus, why: Waiting) -> String {
    let Some(command) = company.notify.command.as_deref() else {
        return String::new();
    };

    // The same charter check the agent launch line gets, from the same function, so
    // the two cannot drift apart. An invariant outranks every grant, and a config is
    // not an exception: `never_run` is the operator telling themselves no, and a
    // notify hook is one more place the operator writes a command line.
    if let Some(pattern) = crate::commands::exec::forbidden_by_charter(company, command) {
        return warn(&format!(
            "`{command}` is forbidden by the charter: never_run {pattern}"
        ));
    }

    // Asked for after the two refusals above, so a workspace with no hook — and a hook
    // the charter forbids — pays nothing for it. Resolved here rather than passed in by
    // the caller because there is no call site that already holds it: every other one is
    // a status write, and a signature wait is not a status write at all.
    let made = Produced::of(org, task);

    // Through `sh -c`, like acceptance: what an operator writes here is a shell line —
    // a pipe, a quoted argument, a `||` fallback — not an argv this could split.
    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(org)
        // Inherited, like acceptance and unlike an agent's: this is the operator's own
        // command, run on their behalf, and a desktop notifier needs the session it
        // was configured in — DISPLAY, DBUS_SESSION_BUS_ADDRESS, an API token. There is
        // nothing to confine here; the hook is the operator, not a worker.
        .env("WECODE_TASK", task.id.as_str())
        // The short handle, so the message that reaches a phone can carry the thing the
        // operator has to type back. Without it the notification names a slug and the
        // only way to answer is to spell it out exactly, which is what kept the answer
        // waiting until somebody reached a terminal.
        //
        // The digits alone, no `#`: a hook that wants the sigil writes `#$…` and a hook
        // that wants a bare number cannot portably strip one. Empty when the task has no
        // number, which no task loaded from a workspace does.
        .env("WECODE_TASK_NUMBER", number_env(task))
        .env("WECODE_TASK_TITLE", &task.title)
        .env("WECODE_TASK_STATUS", status.as_str())
        .env("WECODE_PROJECT", task.project.as_str())
        .env("WECODE_WAITING_FOR", why.as_str())
        .env("WECODE_COMPANY", &company.name)
        // So a hook can call wecode back — `wecode show "$WECODE_TASK"` — from whatever
        // directory it happens to be started in.
        .env("WECODE_ORG", org)
        // What the task produced. Four variables and not one string, because a hook
        // composes its own message and every channel has a different amount of room: a
        // desktop line holds the count, a chat message holds the names and the diff
        // under them, and a script wanting more than the diff is handed the directory.
        //
        // All four empty means there is nothing to say — see [`Produced::of`]. That is
        // the normal case for `signature`, which is a wait for permission to *start*.
        .env(
            "WECODE_WORKTREE",
            made.as_ref()
                .map_or_else(OsString::new, |m| m.dir.clone().into_os_string()),
        )
        .env(
            "WECODE_CHANGED_COUNT",
            made.as_ref().map_or_else(String::new, Produced::count),
        )
        .env(
            "WECODE_CHANGED_FILES",
            made.as_ref()
                .map_or_else(String::new, |m| m.listed(company.notify.max_files)),
        )
        // The one that answers *what did it do*, where the three above answer *what did
        // it touch*. Bounded when it was read rather than here: what is held in memory
        // between a worktree and an environment should be a message's worth of diff and
        // not a repository's.
        .env("WECODE_DIFF", made.as_ref().map_or("", |m| m.diff.as_str()))
        .stdin(Stdio::null());

    // Caught rather than inherited. Letting a notifier write straight into the loop's
    // output interleaved chatter with the record of the work and made both unreadable;
    // throwing it away instead lost the only thing that says a message was refused. So
    // it is caught here and reported as one line, by [`said`].
    //
    // A hook whose output cannot be caught still runs, with its streams thrown away as
    // they always were. The notification is the point and the quote is the extra, and a
    // temp directory wecode cannot write to is not a reason to stop telling the operator
    // their work has stopped.
    let caught = Caught::new();
    cmd.stdout(caught.as_ref().map_or_else(Stdio::null, Caught::writer))
        .stderr(caught.as_ref().map_or_else(Stdio::null, Caught::writer));

    let code = match cmd.spawn() {
        Err(e) => return warn(&format!("could not run `{command}`: {e}")),
        Ok(mut child) => wait_for(&mut child, company.notify.timeout),
    };
    let said = said(&caught.as_ref().map_or_else(String::new, Caught::read));

    match code {
        // The only silence: it exited well and had nothing to say. That is the shape of
        // a notification that arrived — `notify-send` prints nothing, and neither does
        // a `curl` that got its `200`.
        Ok(Some(0)) if said.is_empty() => String::new(),
        Ok(Some(0)) => warn(&format!("`{command}` said: {said}")),
        Ok(Some(code)) => warn(&format!("`{command}` exited {code}{}", because(&said))),
        // What a killed hook managed to say before the limit, for the same reason: a
        // notifier that printed `resolving proxy…` and then hung has named the thing
        // that hung it.
        Ok(None) => warn(&format!(
            "`{command}` was killed after {}s{}",
            company.notify.timeout.as_secs(),
            because(&said)
        )),
        Err(e) => warn(&format!("`{command}`: {e}")),
    }
}

/// A file the hook's output is caught in while it runs, removed when this is dropped.
///
/// A file and not a pipe, deliberately. A pipe holds a fixed amount and then blocks
/// whoever is writing into it, so a parent that waits for the hook before reading
/// deadlocks the moment the hook is chatty — and the notification, killed at its
/// timeout, would be reported as slow when it had already said everything it had to
/// say. Draining the pipe as it fills instead means a reader thread, and then a
/// deadline for *that* thread, because `sh` forks and a killed hook can leave a
/// grandchild holding the write end open forever. A deadline on a read is a race: the
/// same hook is quoted on an idle machine and reported silent on a loaded one, which
/// is the exact failure — a refusal indistinguishable from a delivery — reintroduced
/// as a flake.
///
/// A file has no capacity and needs no reader. The hook never blocks, wecode never
/// waits, and what was written is there to be read the moment the hook is gone: one
/// answer, the same every time.
struct Caught(PathBuf);

impl Caught {
    /// A new one, or `None` if it cannot be made.
    ///
    /// Named for the process and a counter, not for the task. Two `wecode loop`s over
    /// two workspaces share a temp directory, and one pass can announce several tasks —
    /// a name either of them could pick twice is one notification reading another's
    /// output back and quoting a refusal at the wrong wait.
    fn new() -> Option<Self> {
        static NTH: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "wecode-notify-{}-{}.out",
            std::process::id(),
            NTH.fetch_add(1, Ordering::Relaxed)
        ));
        File::create(&path).ok()?;
        Some(Self(path))
    }

    /// A handle for the hook to write through, falling back to discarding the stream if
    /// the file cannot be opened again.
    ///
    /// Appending, and one of these per stream: stdout and stderr are two descriptors
    /// onto the one file, so what is quoted is what the hook said *first* rather than
    /// which stream it happened to choose. A refusal is a refusal on either.
    fn writer(&self) -> Stdio {
        File::options()
            .append(true)
            .open(&self.0)
            .map_or_else(|_| Stdio::null(), Stdio::from)
    }

    /// What the hook wrote, bounded, and empty when it wrote nothing or the file is
    /// gone. Never an error: this is the extra, not the notification.
    fn read(&self) -> String {
        let mut buf = Vec::new();
        if let Ok(file) = File::open(&self.0) {
            let _ = file.take(KEEP).read_to_end(&mut buf);
        }
        // Lossy, because a hook's output is bytes and a notification is not the place
        // to fail over one.
        String::from_utf8_lossy(&buf).into_owned()
    }
}

impl Drop for Caught {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// What the hook said for itself, as one bounded line — empty when it said nothing.
///
/// **This is what tells a refused notification from a delivered one.** An exit status
/// says whether the *command* ran, which is not the question: a channel refuses a
/// message in its reply, and the command that carried it exits `0` having done exactly
/// what it was asked. Telegram answers a wrong chat id with an HTTP 400 whose body
/// `curl` prints on stdout, and `curl` is content — so wecode used to report a message
/// that never arrived exactly as it reports one that did, which is silence. The
/// operator then waits on a phone for a notification that was refused an hour ago,
/// which is the failure this whole module exists to prevent.
///
/// wecode does not parse it and does not judge it. The hook may be a chat API, a
/// desktop notifier, or `mail`, and their refusals have nothing in common but the fact
/// of being *said*. So the rule is the weakest one that is always true: a hook that
/// delivered has no reason to speak, and anything it did say is put in front of the
/// operator to read.
///
/// The first line it managed, blank ones skipped: a `curl` that prints headers before a
/// body still leads with the thing that went wrong, and a hook that opens with an empty
/// line has said nothing yet.
///
/// One line, flattened and cut, because this prints inside `wecode loop`'s output: a
/// hook that returns a page of proxy HTML must not bury the pass it fired on, and one
/// that prints a `\n⏸ t needs you` must not be able to forge a line of wecode's.
fn said(text: &str) -> String {
    let Some(line) = text.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return String::new();
    };
    let flat = line.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(QUOTE) {
        Some((at, _)) => format!("{}…", &flat[..at]),
        None => flat,
    }
}

/// What the hook said, joined onto the report of how it exited, or nothing when it
/// went quietly. A bare `exited 22` names the failure and not the reason; the reason
/// was in the sentence `curl` wrote and wecode used to drop.
fn because(said: &str) -> String {
    if said.is_empty() {
        String::new()
    } else {
        format!(" — {said}")
    }
}

/// Waits for a hook, killing it at the limit.
///
/// `Ok(None)` means it was killed. Only the hook itself is signalled, not a process
/// group: a notifier that backgrounds children of its own has decided to outlive its
/// own exit, and that is the hook author's business rather than something wecode
/// should undo.
///
/// Shared with the reply fetch in [`crate::telegram`], which is the same bargain in
/// the other direction: an operator-written command line that `wecode loop` runs, and
/// that must not be able to hold the loop open. One implementation, so a bound the
/// notify side has cannot go missing from the side that polls every pass.
pub(crate) fn wait_for(child: &mut Child, limit: Duration) -> Result<Option<i32>, String> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Err(e) => return Err(e.to_string()),
            // A hook killed by a signal reports no code. Reported as such rather than
            // as a success, because it did not finish.
            Ok(Some(status)) => return Ok(Some(status.code().unwrap_or(-1))),
            Ok(None) => {}
        }
        if start.elapsed() >= limit {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(POLL);
    }
}

fn warn(what: &str) -> String {
    format!("  ⚠ notify: {what}\n")
}

/// Which tasks this process has already announced as waiting for a signature.
///
/// The dispatch gate is the one wait with no edge to hang a notification on: nothing
/// in the database changes when a signature becomes due, and the condition is
/// recomputed from the ledger on every pass. So the edge is kept here instead, by the
/// loop that computes it, and a task is announced once however long it goes unsigned.
///
/// A restarted loop announces again, which is the honest behaviour for state that only
/// ever lived in one process — and it says what that loop is stuck on, which is what
/// an operator restarting it wants to know anyway.
#[derive(Default, Debug)]
pub(crate) struct Announced(BTreeSet<TaskId>);

impl Announced {
    /// Whether this is the first time `id` has come up. Records it either way.
    pub(crate) fn first_time(&mut self, id: &TaskId) -> bool {
        self.0.insert(id.clone())
    }

    /// Forgets everything not still waiting, so a task that is signed, run, and later
    /// rejected back into the queue is announced again rather than silently held.
    pub(crate) fn keep_only(&mut self, still: &[TaskId]) {
        self.0.retain(|id| still.contains(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use wecode_core::{Budget, Measure, Scope};

    fn task() -> Task {
        Task::new("t", "p", "cover the cache layer with tests")
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

    /// A company with the given `[notify]` body, or none at all.
    fn company(notify: &str) -> Company {
        Company::parse(&format!(
            "[company]\nname = \"cws\"\n\n[roles.engineer]\nwrite = [\"src/**\"]\n{notify}"
        ))
        .expect("the profile parses")
    }

    fn dir() -> PathBuf {
        std::env::temp_dir()
    }

    /// A real repository with one commit in it, and one tracked file.
    ///
    /// Real because a diff is whatever git prints: a fake would be testing this module
    /// against its own idea of the output it is bounding.
    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wecode-notify-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
        ] {
            asked(&dir, args);
        }
        std::fs::write(dir.join("kept.txt"), "one\n").expect("a file to track");
        asked(&dir, &["add", "."]);
        asked(&dir, &["commit", "-qm", "first"]);
        dir
    }

    #[test]
    fn every_status_that_needs_a_human_has_a_reason_to_give_them() {
        // The two definitions are in different crates and must agree exactly: a status
        // that stops for a person and carries no reason would stop silently, and a
        // reason for a status the board does not think is waiting would announce work
        // nobody is holding.
        for s in TaskStatus::all() {
            assert_eq!(
                Waiting::of(*s).is_some(),
                s.needs_a_human(),
                "{} disagrees",
                s.as_str()
            );
        }
    }

    #[test]
    fn becoming_stuck_announces_and_staying_stuck_does_not() {
        assert_eq!(
            crossing(TaskStatus::Verifying, TaskStatus::NeedsApproval),
            Some(Waiting::Approval)
        );
        assert_eq!(
            crossing(TaskStatus::Running, TaskStatus::Failed),
            Some(Waiting::Failed)
        );
        // Already had a person: a second reason is not a second wait.
        assert_eq!(
            crossing(TaskStatus::NeedsInput, TaskStatus::NeedsApproval),
            None
        );
        assert_eq!(crossing(TaskStatus::Failed, TaskStatus::Failed), None);
        // Freed rather than stuck.
        assert_eq!(crossing(TaskStatus::NeedsApproval, TaskStatus::Done), None);
        assert_eq!(crossing(TaskStatus::Waiting, TaskStatus::Ready), None);
    }

    #[test]
    fn no_hook_configured_runs_nothing_and_says_nothing() {
        let out = on_status_change(
            &company(""),
            &dir(),
            &task(),
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
        );
        assert!(out.is_empty(), "{out}");
    }

    #[test]
    fn a_hook_is_told_which_task_stopped_and_what_it_wants() {
        // The status reported is the one being written, not the one the task still
        // carries: a hook told `running` about a task that just failed would say the
        // opposite of what happened.
        let out = std::env::temp_dir().join("wecode-notify-env.txt");
        let _ = std::fs::remove_file(&out);
        let c = company(&format!(
            "\n[notify]\ncommand = \"echo $WECODE_TASK $WECODE_WAITING_FOR $WECODE_TASK_STATUS \
             $WECODE_PROJECT $WECODE_TASK_TITLE > {}\"\n",
            out.display()
        ));
        let t = task();
        assert!(
            on_status_change(&c, &dir(), &t, TaskStatus::Running, TaskStatus::Failed).is_empty(),
            "ran clean"
        );
        let written = std::fs::read_to_string(&out).expect("the hook wrote its file");
        assert_eq!(
            written.trim(),
            "t failed failed p cover the cache layer with tests"
        );
    }

    #[test]
    fn a_task_with_no_tree_yet_is_announced_as_nothing_rather_than_as_zero() {
        // The distinction the empty string carries: this task has not written anything
        // *yet*, which is not the same claim as having written nothing. A hook that read
        // `0` here would say an agent produced an empty diff when none has run.
        let out = std::env::temp_dir().join("wecode-notify-nothing.txt");
        let _ = std::fs::remove_file(&out);
        let c = company(&format!(
            "\n[notify]\ncommand = \"echo [$WECODE_CHANGED_COUNT] [$WECODE_WORKTREE] \
             [$WECODE_CHANGED_FILES] > {}\"\n",
            out.display()
        ));
        // `dir()` is a temp directory and no workspace, so there is no plan to ask which
        // tree the work would be in.
        assert!(on_signature_wait(&c, &dir(), &task()).is_empty(), "ran clean");
        assert_eq!(
            std::fs::read_to_string(&out)
                .expect("the hook wrote its file")
                .trim(),
            "[] [] []"
        );
    }

    #[test]
    fn a_capped_list_of_paths_is_still_counted_in_full() {
        // Why the count is its own variable: truncating the names is the operator's
        // choice, and a message that said "2 files" of five would be the notification
        // agreeing with its own bound instead of with the diff.
        let made = Produced {
            dir: dir(),
            files: vec!["a.rs".into(), "b.rs".into(), "c.rs".into()],
            diff: String::new(),
        };
        assert_eq!(made.count(), "3");
        assert_eq!(made.listed(2), "a.rs\nb.rs");
        assert_eq!(made.listed(9), "a.rs\nb.rs\nc.rs");
        assert_eq!(made.listed(0), "", "names off; the count still goes");
        assert_eq!(made.listed(u64::MAX), "a.rs\nb.rs\nc.rs", "no overflow");
    }

    #[test]
    fn a_file_git_has_never_seen_is_in_the_diff_beside_the_ones_it_has() {
        // The half a plain `git diff` leaves out, and for a lot of tasks the whole of
        // the work. `changed_files` counts an untracked file, so a diff that dropped it
        // would show a message naming three files and explaining two — which reads as
        // *nothing happened here*, the one thing a diff must never say by omission.
        let r = repo("diff-new");
        std::fs::write(r.join("kept.txt"), "one\ntwo\n").expect("edit the tracked file");
        std::fs::write(r.join("fresh.txt"), "hello\n").expect("write a new one");

        let d = diff_of(&r);
        assert!(d.contains("kept.txt"), "the tracked file is missing: {d}");
        assert!(d.contains("+two"), "and what changed in it: {d}");
        assert!(d.contains("fresh.txt"), "the new file is missing: {d}");
        assert!(d.contains("+hello"), "and what is in it: {d}");
    }

    #[test]
    fn reading_the_diff_leaves_the_tree_exactly_as_it_found_it() {
        // Why `--no-index` rather than the shorter `add -N`. A subtask works in its
        // parent's tree, so this can run while an agent is still writing in it, and an
        // announcement that staged somebody's half-finished file would be editing the
        // work it was sent to describe.
        let r = repo("diff-readonly");
        std::fs::write(r.join("fresh.txt"), "hello\n").expect("write a new one");

        assert!(!diff_of(&r).is_empty(), "nothing was read at all");
        assert_eq!(
            asked(&r, &["diff", "--cached", "--name-only"]).trim(),
            "",
            "the index was written to"
        );
        assert!(
            asked(&r, &["status", "--porcelain"]).contains("?? fresh.txt"),
            "the file stopped being untracked"
        );
    }

    #[test]
    fn a_diff_too_long_for_a_message_is_cut_and_says_how_much_it_is_short() {
        // A hook pastes this into a channel with a ceiling, so the bound is wecode's to
        // apply — and the mark is what stops the operator reading a truncated diff as a
        // whole one, which is the same failure as a count that agreed with its own cap.
        let r = repo("diff-long");
        std::fs::write(r.join("kept.txt"), "line\n".repeat(4000)).expect("a flood");

        let d = diff_of(&r);
        assert!(d.contains("… truncated,"), "not marked: {}", said(&d));
        assert!(d.contains("bytes in full"), "no size given: {}", said(&d));
        assert!(
            d.chars().count() < DIFF + 60,
            "the bound did not hold: {} characters",
            d.chars().count()
        );
        // Cut on a character and never inside one: a diff is arbitrary text, and the
        // slice below panics rather than truncating if this is got wrong.
        let wide = repo("diff-wide");
        std::fs::write(wide.join("kept.txt"), "é\n".repeat(4000)).expect("a wider flood");
        assert!(diff_of(&wide).contains("… truncated,"), "not marked");
    }

    #[test]
    fn a_directory_git_will_not_answer_about_is_a_thinner_message_and_not_a_failure() {
        // The module's rule reaching one function further in. A notification that could
        // not read a diff still has to go: the task stopped for a person either way.
        assert_eq!(diff_of(&dir().join("wecode-notify-no-such-tree")), "");
    }

    #[test]
    fn a_hook_that_fails_is_reported_and_nothing_else() {
        let c = company("\n[notify]\ncommand = \"exit 3\"\n");
        let out = on_status_change(&c, &dir(), &task(), TaskStatus::Running, TaskStatus::Failed);
        assert!(out.contains("⚠ notify"), "{out}");
        assert!(out.contains("exited 3"), "{out}");
    }

    #[test]
    fn a_hook_that_exits_well_but_says_something_is_not_taken_for_a_delivery() {
        // The rule, in the weakest form that is always true: a hook that delivered has
        // no reason to speak. wecode does not parse what it said — a chat API, a
        // desktop notifier and `mail` have nothing in common but the fact of *having
        // said something* — it only puts it in front of the operator.
        let c = company("\n[notify]\ncommand = \"echo Bad Request: chat not found\"\n");
        let out = on_status_change(
            &c,
            &dir(),
            &task(),
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
        );
        assert!(out.contains("⚠ notify"), "{out}");
        assert!(out.contains("said: Bad Request: chat not found"), "{out}");
    }

    #[test]
    fn a_complaint_on_stderr_counts_the_same_as_a_refusal_on_stdout() {
        // One file behind both, because the operator's question is "did it arrive" and
        // neither stream is the authority on that. `notify-send` complains on stderr;
        // `curl -s` prints the refusal it was handed on stdout.
        let c = company("\n[notify]\ncommand = \"echo no notification daemon >&2\"\n");
        let out = on_status_change(&c, &dir(), &task(), TaskStatus::Running, TaskStatus::Failed);
        assert!(out.contains("said: no notification daemon"), "{out}");
    }

    #[test]
    fn what_a_failing_hook_said_is_reported_beside_the_status_it_failed_with() {
        // `exited 6` is the failure named without its reason, and the reason was in the
        // line the hook wrote on the way out.
        let c = company("\n[notify]\ncommand = \"echo could not resolve host >&2; exit 6\"\n");
        let out = on_status_change(&c, &dir(), &task(), TaskStatus::Running, TaskStatus::Failed);
        assert!(out.contains("exited 6 — could not resolve host"), "{out}");
    }

    #[test]
    fn a_hook_that_says_more_than_a_pipe_holds_still_finishes() {
        // Why the output goes to a file. This is several times what a pipe will hold,
        // and a parent that waited for the hook while the hook blocked on a full pipe
        // would report it killed at its timeout — a notifier that had already said
        // everything it had to say, blamed for being slow.
        let c = company("\n[notify]\ncommand = \"seq 1 40000\"\ntimeout = \"20s\"\n");
        let began = Instant::now();
        let out = on_status_change(&c, &dir(), &task(), TaskStatus::Running, TaskStatus::Failed);
        assert!(out.contains("said: 1"), "{out}");
        assert!(!out.contains("39999"), "the whole flood came through: {out}");
        assert!(began.elapsed() < Duration::from_secs(10), "it blocked");
    }

    #[test]
    fn what_is_quoted_is_the_first_line_there_is_and_a_bounded_one() {
        assert_eq!(said(""), "");
        assert_eq!(said("\n  \n\t\n"), "", "whitespace is not something said");
        assert_eq!(
            said("\n  refused  \nand a second line\n"),
            "refused",
            "the first line with anything on it, trimmed"
        );
        // Flattened, so a hook printing wecode's own shapes cannot forge a line of it.
        assert_eq!(said("⏸ t\tneeds  you"), "⏸ t needs you");

        let cut = said(&"x".repeat(QUOTE + 50));
        assert!(cut.ends_with('…'), "{cut}");
        assert_eq!(cut.chars().count(), QUOTE + 1, "the bound plus the mark");
        // Cut on a character and not inside one: a hook's output is arbitrary bytes.
        assert_eq!(said(&"é".repeat(QUOTE + 50)).chars().count(), QUOTE + 1);
    }

    #[test]
    fn a_hook_that_hangs_is_killed_at_its_timeout() {
        // The property that makes it safe on a loop that runs for days.
        let c = company("\n[notify]\ncommand = \"sleep 60\"\ntimeout = \"1s\"\n");
        let began = Instant::now();
        let out = on_status_change(
            &c,
            &dir(),
            &task(),
            TaskStatus::Running,
            TaskStatus::NeedsInput,
        );
        assert!(out.contains("killed after 1s"), "{out}");
        assert!(
            began.elapsed() < Duration::from_secs(30),
            "did not wait it out"
        );
    }

    #[test]
    fn a_hook_killed_at_its_limit_is_reported_with_whatever_it_managed_to_say() {
        // A notifier that named what it was doing and then hung on it has named the
        // thing that hung it, and `killed after 1s` alone leaves that on the floor.
        let c = company(
            "\n[notify]\ncommand = \"echo resolving proxy; sleep 5\"\ntimeout = \"1s\"\n",
        );
        let out = on_status_change(&c, &dir(), &task(), TaskStatus::Running, TaskStatus::Failed);
        assert!(out.contains("killed after 1s — resolving proxy"), "{out}");
    }

    #[test]
    fn a_hook_the_charter_forbids_is_not_run() {
        // An invariant outranks every grant, and company.toml is not above its own
        // charter — the notify line is a command wecode itself executes.
        let c = company(
            "\n[invariants]\nnever_run = [\"curl *\"]\n\n[notify]\ncommand = \"curl example.invalid\"\n",
        );
        let out = on_status_change(
            &c,
            &dir(),
            &task(),
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
        );
        assert!(out.contains("never_run"), "{out}");
    }

    #[test]
    fn a_task_held_for_a_signature_is_announced_as_the_signature_it_is() {
        // `ready` is the truth about the status and says nothing about the wait, so
        // the reason is what carries it.
        let out = std::env::temp_dir().join("wecode-notify-signature.txt");
        let _ = std::fs::remove_file(&out);
        let c = company(&format!(
            "\n[notify]\ncommand = \"echo $WECODE_WAITING_FOR $WECODE_TASK_STATUS > {}\"\n",
            out.display()
        ));
        let mut t = task();
        t.status = TaskStatus::Ready;
        assert!(on_signature_wait(&c, &dir(), &t).is_empty(), "ran clean");
        assert_eq!(
            std::fs::read_to_string(&out)
                .expect("the hook wrote its file")
                .trim(),
            "signature ready"
        );
    }

    #[test]
    fn a_signature_wait_is_announced_once_and_again_after_it_clears() {
        let mut seen = Announced::default();
        let (a, b) = (TaskId::new("a"), TaskId::new("b"));
        assert!(seen.first_time(&a));
        assert!(!seen.first_time(&a), "still the same wait");
        assert!(seen.first_time(&b));

        // `a` was signed and left the queue; `b` is still unsigned.
        seen.keep_only(std::slice::from_ref(&b));
        assert!(!seen.first_time(&b), "b never stopped waiting");
        assert!(seen.first_time(&a), "a is a new wait, not the old one");
    }
}
