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
//!   that has been waiting a week fires once rather than every tick — a notifier saying
//!   so every five seconds is the thing you turn off. The state goes out on its own clock
//!   instead, as one message about everything standing: [`on_digest`], keeping the rhythm
//!   `[attention] digest_interval_mins` has always promised.
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
//!
//! And **the report**, which is neither of those. A diff is the evidence and the names
//! are the shape, and between them they still leave the signer adding the change up
//! themselves: how much of it there is, which corners of the tree it fell in, what it
//! was held to, and what has been waiting behind it. wecode already writes that document
//! — [`crate::record`] commits it beside the merge — and it wrote it *after* the merge,
//! which is after the decision it would have informed. So the same body is rendered
//! here, from the same functions, and handed over in `WECODE_REPORT`. See [`Produced`].
//!
//! And **what may be signed, and by whom** — see [`signing`] and [`signers`]. A message
//! that says *you are wanted* under an *Approve* button is offering a decision, and the
//! hook writing that button knew neither of the two things that decide whether it is
//! real. Not *whether there is a signature to give*: `input` and `failed` are waits no
//! `approve` answers, and a tap on one is refused after the operator has already decided
//! they dealt with it. And not *who may give it*: authority is the post's, checked by the
//! Broker at the moment of signing, so a message that reached the wrong seat offered
//! something that seat never held — and the refusal is printed on the machine the
//! operator is not standing at. Both are known here, before the message goes out, and
//! both are handed over: a hook can put the button only where a thumb decides something,
//! and address it to somebody who can.
//!
//! And, for the one kind of task nobody dispatches, **the instructions themselves** — see
//! [`Sheet`]. A person's task waits for the opposite reason to every other wait: nothing
//! has been done and the doing is theirs, so there is no diff to read and what the message
//! must carry is the work. `WECODE_STEPS` holds it, `WECODE_STEPS_FILE` the whole of it.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use wecode_core::{Plan, Task, TaskId, TaskStatus};
use wecode_gov::ActionKind;
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

/// How much of a task's steps the message carries, in characters. [`DIFF`]'s figure by
/// [`DIFF`]'s arithmetic and for the same channel, but a cheaper cut: the whole document
/// goes over as a file beside it.
const STEPS: usize = 4000;

/// How many waits a digest names. The rest are counted and not listed, the bargain the
/// file list makes: the tally above them is never bounded, so twenty of forty says forty.
const STANDING: usize = 20;

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

/// The signature this wait is for, and `None` when it is a wait no signature answers.
///
/// Asked of [`crate::telegram::implied`] — the function that decides what a bare
/// `approve` in a reply signs — rather than mapped a second time here. The two are the
/// same question asked from opposite ends: *what is this notification offering* and
/// *what did that answer sign*. Two mappings would be one gaining a case, and the shape
/// of that bug is a message that offers a decision the channel behind it refuses.
///
/// So `input` and `failed` come back `None`, because a reply signs nothing for either.
/// That is not a claim that nothing can be done about them — what happens to work that
/// failed is a decision, and a real one. It is that the decision is not a signature:
/// there is no `approve` that takes it, so a message offering one is offering a button
/// whose only outcome is a refusal.
///
/// `status` rather than `task.status`, for the reason [`on_status_change`] takes both:
/// a caller that has already written one holds a copy that is out of date, and the
/// signature a stale status implies is the wrong one — or none.
fn signing(task: &Task, status: TaskStatus, why: Waiting) -> Option<ActionKind> {
    let mut asking = task.clone();
    asking.status = status;
    // The dispatch gate is exactly what `Waiting::Signature` means, and it is the one
    // wait the status cannot express — which is why that argument exists at all.
    crate::telegram::implied(&asking, why == Waiting::Signature)
}

/// Who may give that signature, one name per line, and empty when nobody may.
///
/// A post's own `approve` list, read the way the Broker reads it, because that is what
/// will be asked when the answer arrives: an account is an identity and the seat behind
/// it is the authority. A hook that knows this can address the message to somebody who
/// can act on it rather than to whoever the channel reaches — and when the list is
/// empty, say so instead of offering a button that cannot do anything.
///
/// **People where a seat has them, the seat itself where it has none.** A notification
/// goes to a person, so their name is what a message can be addressed with; but a vacant
/// seat still signs, at a terminal, with `--as <post>` — and a list that dropped it would
/// report *nobody may sign this* about work somebody can sign in one command. Both are an
/// answer to "who do I go to", which is the only question this is asked.
///
/// Not filtered to the people who can be reached from this hook: wecode does not know
/// what channel the operator wrote, and a name it declined to print is one the operator
/// cannot chase.
fn signers(company: &Company, kind: Option<ActionKind>) -> String {
    let Some(kind) = kind else {
        return String::new();
    };
    let mut who: Vec<String> = Vec::new();
    for post in &company.posts {
        if !company.effective(post).allows_approve(kind) {
            continue;
        }
        match company.users_of(&post.name).as_slice() {
            [] => who.push(post.name.clone()),
            held => who.extend(held.iter().map(|u| u.name.clone())),
        }
    }
    who.join("\n")
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
/// the five artifact variables arrive empty — the shape a `signature` wait has anyway.
/// What the operator receives is therefore a thinner message than a real one, in
/// exactly the fields that could do damage.
///
/// What it does carry truthfully is the signature the wait is for and the seats that
/// hold it — [`signing`] and [`signers`] read the company, not the task — which is the
/// half of the rehearsal worth having: a drill that named nobody would be the operator
/// checking their notifier and learning nothing about whether it reaches a holder.
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

/// Announces everything standing in front of a person at once, on [`Rhythm`]'s clock.
///
/// The counterpart to [`fire`] and deliberately not a repeat of it. An announcement is an
/// edge: it fires as a wait begins and never again, which keeps a notifier worth leaving
/// on and leaves the wait that began at 02:14 unmentioned ever after. This is the state,
/// both halves of it — the tasks whose status stopped for somebody, and the ones the
/// dispatch gate holds, which have no status to be read off the board. Each line carries
/// the words that end that wait, from the same function that will judge them, so a digest
/// cannot offer what the channel behind it refuses.
///
/// It is about no single task and says so, in a fifth `WECODE_WAITING_FOR` rather than one
/// of the four: a message about five waits carrying one of their numbers is one a bare
/// `approve` answers wrongly, so the number to reply with is on each line instead. And
/// nothing is sent when nothing is standing — a digest of an empty queue is an
/// interruption spent saying there was no reason to interrupt.
pub(crate) fn on_digest(company: &Company, org: &Path, stuck: &[&Task], gated: &[&Task]) -> String {
    let stopped = stuck.iter().filter_map(|t| Waiting::of(t.status).map(|w| (*t, w)));
    let waits: Vec<(&Task, Waiting)> = stopped
        .chain(gated.iter().map(|t| (*t, Waiting::Signature)))
        .collect();
    // No hook, or nothing standing in front of anybody: either way, no message.
    let Some(command) = company.notify.command.as_deref().filter(|_| !waits.is_empty()) else {
        return String::new();
    };
    let mut body = format!("{} waiting on you\n\n", waits.len());
    for (task, why) in waits.iter().take(STANDING) {
        // What a reply is typed against: four characters against a slug spelled exactly.
        let reply = task.number.map_or_else(|| task.id.to_string(), |n| n.to_string());
        let ends = signing(task, task.status, *why).map_or_else(
            || "nothing to sign".to_string(),
            |kind| format!("approve {} {reply}", kind.as_str()),
        );
        let row = format!("{:<26} {:<10}", task.id.as_str(), why.as_str());
        body.push_str(&format!("  {reply:<6} {row} {ends}\n"));
    }
    if let Some(rest) = waits.len().checked_sub(STANDING).filter(|n| *n > 0) {
        body.push_str(&format!("  … and {rest} more\n"));
    }

    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(org)
        .env("WECODE_ORG", org)
        .env("WECODE_COMPANY", &company.name)
        .env("WECODE_WAITING_FOR", "digest")
        .env("WECODE_DIGEST", &body)
        .stdin(Stdio::null());
    spoke(company, command, &mut cmd)
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
/// And **the report**: the change added up, the way the merge record adds it up.
///
/// The three above are raw material — a directory, a list, a patch — and a person
/// deciding whether to sign has to do the arithmetic on them. The report is that
/// arithmetic, and wecode was already doing it: [`crate::record::merged`] renders it
/// for the file committed beside the merge. Rendering it here too, from the same
/// functions, means the signer and the repository read one document rather than two
/// tellings of one change — and it carries the two facts no diff contains, which are
/// what the task was held to and what has been waiting behind it.
#[derive(Debug)]
struct Produced {
    /// The worktree the work happened in.
    dir: PathBuf,
    /// Every path changed in it, sorted, untracked files included.
    files: Vec<String>,
    /// What changed in them, as a bounded diff — see [`diff_of`].
    diff: String,
    /// The change as the merge record will state it — see [`crate::record::proposed`].
    report: String,
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
    ///
    /// The plan is loaded once and used twice: it is how the tree is found at all — a
    /// subtask works in its parent's — and it is the only thing that knows what is
    /// queued behind this task, which is a line of the report.
    fn of(org: &Path, task: &Task, most: u64) -> Option<Self> {
        let plan = plan_at(org)?;
        let dir = tree_of(&plan, org, task)?;
        let files = crate::git::changed_files(&dir).ok()?;
        let diff = diff_of(&dir);
        let report = crate::record::proposed(
            task,
            &plan,
            &counted(&dir),
            usize::try_from(most).unwrap_or(usize::MAX),
        );
        Some(Self {
            dir,
            files,
            diff,
            report,
        })
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

/// The workspace's database, and `None` when there is no workspace to read one out of.
///
/// Read-only, and only when a file is already there: [`Store::open`] creates and migrates,
/// and a notification must not bring a workspace into being. One place that knows it, for
/// the two things here that read the store — the plan a task's tree is found through, and
/// the steps a person's task carries.
fn store_at(org: &Path) -> Option<Store> {
    let db = Workspace::at(org).db_path();
    if !db.is_file() {
        return None;
    }
    Store::open(&db).ok()
}

/// The workspace's plan, and `None` when there is none to read.
fn plan_at(org: &Path) -> Option<Plan> {
    store_at(org)?.load_plan().ok()
}

/// What a person's task tells the person, in the two shapes a channel has room for.
///
/// The message and the document, because both already exist on the hook's side and each
/// suits a different briefing: three bullet points belong in the message, a forty-line
/// console runbook attached to it. Text alone would leave a long one cut off on a phone
/// with nowhere else to look — a manual task has no worktree to be told to go and read.
/// The words come back out of the store, as written at `task add --steps`.
struct Sheet {
    /// The steps as written, bounded to [`STEPS`] characters.
    body: String,
    /// The whole of them, in a file the hook may attach. `None` when one could not be
    /// written — which costs the document, not the notification.
    file: Option<PathBuf>,
}

impl Sheet {
    /// What this task tells whoever does it, and `None` when nothing was written for it:
    /// every agent's task, described at dispatch instead, and a person's until somebody
    /// writes the steps — an operator woken for a task that says only its own name.
    fn of(org: &Path, task: &Task) -> Option<Self> {
        let steps = store_at(org)?.task_steps(&task.id).ok().flatten()?;
        let file = Self::written(&steps);
        let body = match steps.char_indices().nth(STEPS) {
            // Marked, and pointing at the whole copy rather than only saying there is
            // more: a person cut off mid-instruction has to know where the rest is, and
            // unlike a diff the rest is right there.
            Some((at, _)) => format!(
                "{}\n… truncated — the whole of it is the file in WECODE_STEPS_FILE",
                &steps[..at]
            ),
            None => steps,
        };
        Some(Self { body, file })
    }

    /// The document on disk, and `None` if it could not be written. A temp file for the
    /// length of one notification, removed when this is dropped — after the hook has been
    /// waited for. The store is where the steps live; this is a handle for a `sendDocument`
    /// and has no business outliving one.
    ///
    /// Named for the process and a counter, like [`Caught`] and for its reason: two loops
    /// share a temp directory and one pass announces several tasks, so a name either could
    /// pick twice is an operator receiving another task's instructions.
    fn written(steps: &str) -> Option<PathBuf> {
        static NTH: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "wecode-steps-{}-{}.md",
            std::process::id(),
            NTH.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, steps).ok()?;
        Some(path)
    }

    /// Where that document is, for the hook's environment. Empty when there is none.
    fn path(&self) -> OsString {
        self.file
            .clone()
            .map_or_else(OsString::new, PathBuf::into_os_string)
    }
}

impl Drop for Sheet {
    fn drop(&mut self) {
        if let Some(path) = &self.file {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// The tree this task's work is in, and `None` when there is not one.
///
/// A subtask works in its parent's tree, so *which* tree is a question about the plan
/// rather than about the task in hand — which is why an announcement reads the
/// workspace database at all.
///
/// A task whose playbook said it needed no worktree is reported as nothing rather than
/// as the repository, deliberately. The operator's own checkout holds the operator's
/// own uncommitted work, and handing that over as *what the task produced* would be the
/// notification inventing a diff.
fn tree_of(plan: &Plan, org: &Path, task: &Task) -> Option<PathBuf> {
    let owner = crate::work::owner(plan, &task.id)?;
    let dir = crate::work::worktree_for(&crate::work::org_name(org), &owner.id);
    dir.is_dir().then_some(dir)
}

/// Every changed path in `dir` with what it gained and lost, untracked files included.
///
/// The same change [`diff_of`] renders, counted instead of quoted, and against the same
/// base — a report whose arithmetic disagreed with the diff printed under it would be
/// worse than one that said nothing. Untracked files are asked for one at a time,
/// because that is the only way git will speak about a file it has never seen, and they
/// are recorded under the path this asked about rather than the one git echoes back:
/// the name is already known here, and parsing it out of a `--no-index` header is a
/// second chance to get it wrong. A new file has no deletions by construction.
///
/// Never an error — see [`asked`]. A tree git will not answer about counts as nothing
/// changed, which is what the rest of the announcement already does with it.
fn counted(dir: &Path) -> Vec<(String, u32, u32)> {
    let mut files = numstat(&asked(dir, &["diff", "--numstat", "HEAD"]));
    for path in asked(dir, &["ls-files", "--others", "--exclude-standard"]).lines() {
        let out = asked(
            dir,
            &["diff", "--numstat", "--no-index", "--", "/dev/null", path],
        );
        let added = out.split('\t').next().and_then(|n| n.parse().ok());
        files.push((path.to_string(), added.unwrap_or(0), 0));
    }
    // Sorted, so the report lists what `changed_files` lists in the order it lists it.
    files.sort();
    files
}

/// git's `--numstat` as the counts it means.
///
/// A binary file reports `-` rather than a number and is carried as a zero: it changed,
/// it is in the list, and there is no line count to be had for it.
fn numstat(out: &str) -> Vec<(String, u32, u32)> {
    out.lines()
        .filter_map(|line| {
            let mut f = line.split('\t');
            let add = f.next()?;
            let del = f.next()?;
            let path = f.next()?;
            Some((
                path.to_string(),
                add.parse().unwrap_or(0),
                del.parse().unwrap_or(0),
            ))
        })
        .collect()
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

    // Asked for after the refusal above, so a workspace with no hook pays nothing for it.
    // Resolved here rather than passed in because no call site already holds it: every
    // other one is a status write, and a signature wait is not a status write at all.
    let made = Produced::of(org, task, company.notify.max_files);
    // What this wait can actually be answered with, and by whom. Resolved here for the
    // reason `made` is: it is a fact about the wait rather than about the status write,
    // and no call site holds it.
    let sign = signing(task, status, why);
    // And what the person is being asked to do, where the task is a person's. A binding
    // rather than an inline call so the document outlives the hook: the file goes away
    // when this is dropped, which is after `spoke` has waited.
    let sheet = Sheet::of(org, task);

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
        // What the notification may offer, and who may take it up. The word is the one
        // that goes after `approve` — in a reply, on a button, or on a command line —
        // and it is empty for a wait no signature answers, so a hook can put the button
        // only where a thumb decides something. The names are empty when nobody holds
        // that authority at all, which is the message worth sending in place of it.
        .env("WECODE_SIGN", sign.map_or("", ActionKind::as_str))
        .env("WECODE_SIGNERS", signers(company, sign))
        .env("WECODE_COMPANY", &company.name)
        // So a hook can call wecode back — `wecode show "$WECODE_TASK"` — from whatever
        // directory it happens to be started in.
        .env("WECODE_ORG", org)
        // What the task produced. Five variables and not one string, because a hook
        // composes its own message and every channel has a different amount of room: a
        // desktop line holds the count, a chat message holds the report or the diff, and
        // a script wanting more than either is handed the directory.
        //
        // All five empty means there is nothing to say — see [`Produced::of`]. That is
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
        // And the one that answers *is this worth waking me for* — the change added up
        // the way the merge record adds it up, so the summary a signature is given
        // against is the summary the repository will keep of it.
        .env(
            "WECODE_REPORT",
            made.as_ref().map_or("", |m| m.report.as_str()),
        )
        // The work itself, for the wait where the work has not happened yet — a person's
        // task, whose notification is its dispatch. Two variables for the two shapes a
        // channel has, and both empty for everything an agent does. See [`Sheet`].
        .env("WECODE_STEPS", sheet.as_ref().map_or("", |s| s.body.as_str()))
        .env(
            "WECODE_STEPS_FILE",
            sheet.as_ref().map_or_else(OsString::new, Sheet::path),
        )
        .stdin(Stdio::null());
    spoke(company, command, &mut cmd)
}

/// Runs the hook and says what came of it: nothing when it ran clean, one line when it
/// did not. Shared by the two things there are to say — one wait beginning, and the
/// standing list of every wait that already has — so a digest is refused, bounded, killed
/// and quoted back under exactly the rules an announcement is. The charter check is here
/// for that reason, at the point the line is run: the same check the agent launch line
/// gets, because an invariant outranks every grant and a config is no exception.
fn spoke(company: &Company, command: &str, cmd: &mut Command) -> String {
    if let Some(pattern) = crate::commands::exec::forbidden_by_charter(company, command) {
        return warn(&format!(
            "`{command}` is forbidden by the charter: never_run {pattern}"
        ));
    }

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

/// The digest's clock: `[attention] digest_interval_mins` is the promise, this is what
/// keeps it. Held by the loop, like [`Announced`] and for the same reason — nothing in
/// the database is the edge of a rhythm. It starts **due**, so a loop just started says
/// what it is holding rather than waiting an interval out first. `0` is off, not one
/// every pass five seconds apart, which is the notifier an operator turns off.
#[derive(Debug)]
pub(crate) struct Rhythm {
    every: Duration,
    next: Option<Instant>,
}

impl Rhythm {
    pub(crate) fn of(company: &Company) -> Self {
        Self {
            every: Duration::from_secs(company.attention.digest_interval_mins.saturating_mul(60)),
            next: None,
        }
    }

    /// Whether the beat has come round, taking it if it has — sent or not, because the
    /// rhythm belongs to the clock and not to the work: an interval that passed over an
    /// empty queue leaves nothing primed to fire the second something stops.
    pub(crate) fn due(&mut self, now: Instant) -> bool {
        if self.every.is_zero() || self.next.is_some_and(|at| now < at) {
            return false;
        }
        self.next = Some(now + self.every);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use wecode_core::{Budget, Measure, Scope, TaskKind};

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
    ///
    /// Two seats, because who may sign is a question about a chart rather than about a
    /// role: `lead` holds the merge signature and has a person in it, `impl` writes code
    /// and holds nothing. A workspace with one seat cannot tell a notification addressed
    /// to a holder from one addressed to whoever was nearest.
    fn company(notify: &str) -> Company {
        Company::parse(&format!(
            "[company]\nname = \"cws\"\n\
             \n[roles.engineer]\nwrite = [\"src/**\"]\n\
             \n[roles.holder]\nread = [\"**\"]\napprove = [\"merge\", \"admission\"]\n\
             \n[[posts]]\nname = \"impl\"\nrole = \"engineer\"\n\
             \n[[posts]]\nname = \"lead\"\nrole = \"holder\"\n\
             \n[[users]]\nname = \"Chandra\"\npost = \"lead\"\n{notify}"
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
    fn what_a_wait_offers_is_what_a_reply_to_it_would_sign() {
        // The two ends of one question, held together the way the statuses and the
        // reasons above are: what the notification offers has to be what the channel
        // behind it accepts, or the button is a refusal with a nicer label.
        let approval = |t: &Task| signing(t, TaskStatus::NeedsApproval, Waiting::Approval);
        assert_eq!(approval(&task()), Some(ActionKind::Merge));
        assert_eq!(
            approval(&task().of_kind(TaskKind::Design)),
            Some(ActionKind::Design),
            "a design is signed off, not merged"
        );
        assert_eq!(
            signing(&task(), TaskStatus::Ready, Waiting::Signature),
            Some(ActionKind::Admission)
        );

        // The waits with no yes in them. A hook that put *Approve* on either would be
        // offering a decision whose only outcome is `nothing is waiting to be signed`.
        assert_eq!(signing(&task(), TaskStatus::Failed, Waiting::Failed), None);
        assert_eq!(signing(&task(), TaskStatus::NeedsInput, Waiting::Input), None);
    }

    #[test]
    fn who_may_sign_is_read_off_the_seats_that_hold_it() {
        let c = company("");
        // The person in the seat, not the seat: a notification is addressed to somebody.
        assert_eq!(signers(&c, Some(ActionKind::Merge)), "Chandra");
        // `impl` writes code and signs nothing, so it is not on the list however many
        // notifications reach whoever sits there.
        assert!(!signers(&c, Some(ActionKind::Merge)).contains("impl"));
        // A kind nobody's role names: empty, which is the report rather than a gap.
        assert_eq!(signers(&c, Some(ActionKind::Design)), "");
        // Nothing to sign, so nobody to name — the same silence, said once.
        assert_eq!(signers(&c, None), "");
    }

    #[test]
    fn a_seat_with_nobody_in_it_is_named_as_the_seat() {
        // It still signs, at a terminal, with `--as <post>`. Dropping it would report
        // "nobody may sign this" about work one command signs, which is worse than the
        // silence it would be replacing.
        let vacant = Company::parse(
            "[company]\nname = \"cws\"\n\n[roles.holder]\nread = [\"**\"]\napprove = [\"merge\"]\n\
             \n[[posts]]\nname = \"lead\"\nrole = \"holder\"\n",
        )
        .expect("the profile parses");
        assert_eq!(signers(&vacant, Some(ActionKind::Merge)), "lead");
    }

    #[test]
    fn a_hook_is_told_what_may_be_signed_and_by_whom() {
        // The gap this closes: the message said *you are wanted* and carried a button,
        // and whether a thumb on it decided anything depended on two things the hook
        // could not see — whether this wait has a signature at all, and whether the
        // person reading holds it.
        let out = std::env::temp_dir().join("wecode-notify-authority.txt");
        let _ = std::fs::remove_file(&out);
        let c = company(&format!(
            "\n[notify]\ncommand = \"echo [$WECODE_SIGN] [$WECODE_SIGNERS] > {}\"\n",
            out.display()
        ));
        assert!(
            on_status_change(
                &c,
                &dir(),
                &task(),
                TaskStatus::Verifying,
                TaskStatus::NeedsApproval
            )
            .is_empty(),
            "ran clean"
        );
        assert_eq!(
            std::fs::read_to_string(&out)
                .expect("the hook wrote its file")
                .trim(),
            "[merge] [Chandra]"
        );
    }

    #[test]
    fn a_wait_no_signature_answers_offers_nothing_to_sign() {
        // Empty, and empty in both: naming who *would* sign a merge beside a failed task
        // would be the notification answering a question nobody can ask of it.
        let out = std::env::temp_dir().join("wecode-notify-unsignable.txt");
        let _ = std::fs::remove_file(&out);
        let c = company(&format!(
            "\n[notify]\ncommand = \"echo [$WECODE_SIGN] [$WECODE_SIGNERS] > {}\"\n",
            out.display()
        ));
        assert!(
            on_status_change(&c, &dir(), &task(), TaskStatus::Running, TaskStatus::Failed)
                .is_empty(),
            "ran clean"
        );
        assert_eq!(
            std::fs::read_to_string(&out)
                .expect("the hook wrote its file")
                .trim(),
            "[] []"
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
            report: String::new(),
        };
        assert_eq!(made.count(), "3");
        assert_eq!(made.listed(2), "a.rs\nb.rs");
        assert_eq!(made.listed(9), "a.rs\nb.rs\nc.rs");
        assert_eq!(made.listed(0), "", "names off; the count still goes");
        assert_eq!(made.listed(u64::MAX), "a.rs\nb.rs\nc.rs", "no overflow");
    }

    #[test]
    fn the_counts_cover_the_files_the_names_do_and_no_others() {
        // The arithmetic under the report, against the list the names come from. A file
        // git has never seen is in `changed_files` and so in the count the hook is
        // handed — a tally that left it out would print `1 file` above a message naming
        // two, and the operator would be reading two reports of one change.
        let r = repo("counted");
        std::fs::write(r.join("kept.txt"), "one\ntwo\n").expect("edit the tracked file");
        std::fs::write(r.join("fresh.txt"), "a\nb\nc\n").expect("write a new one");

        assert_eq!(
            counted(&r),
            vec![
                ("fresh.txt".to_string(), 3, 0),
                ("kept.txt".to_string(), 1, 0),
            ],
            "sorted, and the new file counted as three lines added and none removed"
        );
        // The same paths `changed_files` reports, in the same order: the report and the
        // names beside it are two views of one change.
        assert_eq!(
            counted(&r).into_iter().map(|(p, ..)| p).collect::<Vec<_>>(),
            crate::git::changed_files(&r).expect("git answers")
        );
    }

    #[test]
    fn a_tree_git_will_not_answer_about_is_counted_as_nothing_rather_than_guessed_at() {
        // The module's rule one function further in again. There is no report to be had
        // from a directory git refuses, and a notification is still owed.
        assert!(counted(&dir().join("wecode-notify-no-such-tree")).is_empty());
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

    #[test]
    fn the_digest_keeps_the_interval_and_not_the_pass() {
        // `wecode loop` passes every five seconds, and a digest per pass is the notifier
        // an operator silences within a day.
        let (mut r, t) = (Rhythm::of(&company("")), Instant::now());
        assert_eq!(r.every, Duration::from_secs(20 * 60), "the default, in minutes");
        assert!(r.due(t), "a loop just started says what it holds");
        assert!(!r.due(t + Duration::from_secs(19 * 60)), "not yet");
        assert!(r.due(t + Duration::from_secs(20 * 60)), "the next beat");
        r.every = Duration::ZERO;
        assert!(!r.due(t + Duration::from_secs(99 * 60)), "off, not every pass");
    }
}
