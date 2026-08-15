//! Running a coding agent under supervision.
//!
//! Everything preventable is decided before the process starts — the environment it
//! gets, the directory it runs in, the command line itself. Once it is running the
//! controls left are the clock, what the agent says it has spent, and a signal — so
//! those are what this module provides.
//!
//! Six details are load-bearing:
//!
//! - **The environment is built, not inherited.** A coding CLI inherits every secret
//!   in the shell otherwise. Absent a container this is the only network control
//!   there is.
//! - **A new process group.** Coding CLIs spawn children; signalling only the parent
//!   leaves them orphaned and still running.
//! - **Idle, not just wall.** An agent that has stopped producing output has usually
//!   stopped working, and the wall limit is far too generous to catch it.
//! - **Metered as it streams.** The output buffer is capped, and the line stating what
//!   the run cost is the last one — so spend is counted on the way past rather than
//!   read back out of a buffer that may have dropped it.
//! - **The meter is a limit, not just a gauge.** A count read while the run is still
//!   going is a count something can act on, and the supervisor stops a run that has
//!   spent past the budget its task declared. It is the same count the ledger records
//!   afterwards, and it has to be: a kill the surviving figure cannot account for is
//!   indistinguishable from a bug — see [`crate::usage`] on one report per message.
//! - **How a run ended is not why it ended.** The first is an exit code and the second
//!   is a sentence the harness wrote, and only the second is any use to whoever tries
//!   again. Both leave here together, so the record can carry the one that helps. See
//!   [`Outcome::cause`].
//!
//! No `unsafe`, which the workspace forbids: `process_group` is safe, and signalling
//! shells out to `kill` the way the rest of the tree shells out to `git`.

use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use wecode_core::Task;
use wecode_org::{AgentTemplate, Post};

use crate::render::{kind_tag, truncate_cmd};
use crate::usage::Meter;

/// How much of an agent's output to keep. Past this it is drained and discarded —
/// the pipe must keep moving or the child blocks on a full buffer.
const OUTPUT_CAP: usize = 256 * 1024;

/// How often to check whether the child has finished or overrun.
const POLL: Duration = Duration::from_millis(100);

/// How much of the harness's last line to quote. It goes on the execution record, and
/// every view of a run prints that on one line beside four other columns.
const LAST_WORDS_CAP: usize = 200;

/// How far back to look for it. The run's *ending*, not the last plain sentence
/// anywhere in it: a harness that narrates itself in JSON for a thousand lines after
/// its last prose line did not fail because of that line.
const LAST_WORDS_SEARCH: usize = 20;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Ended {
    Exited(i32),
    /// Killed for exceeding its total time.
    Wall,
    /// Killed after producing no output for too long.
    Idle,
    /// Killed for reporting more spend than its budget allowed.
    Tokens,
    /// Exited on a signal rather than normally.
    Signalled,
}

impl Ended {
    pub(crate) fn ok(self) -> bool {
        self == Self::Exited(0)
    }

    pub(crate) fn describe(self) -> String {
        match self {
            Self::Exited(0) => "exit 0".to_string(),
            Self::Exited(c) => format!("exit {c}"),
            Self::Wall => "killed — wall limit".to_string(),
            Self::Idle => "killed — no output".to_string(),
            Self::Tokens => "killed — token budget".to_string(),
            Self::Signalled => "killed by a signal".to_string(),
        }
    }
}

#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Limits {
    pub(crate) wall: Option<Duration>,
    pub(crate) idle: Option<Duration>,
    /// Tokens the run may add before it is stopped, in the unit [`crate::usage`]
    /// counts in. A budget figure, so it comes from the task rather than from the
    /// harness template, which declares clocks and no spend.
    pub(crate) tokens: Option<u64>,
}

impl Limits {
    pub(crate) fn from(t: &AgentTemplate) -> Self {
        Self {
            wall: t.wall_secs.map(Duration::from_secs),
            idle: t.idle_secs.map(Duration::from_secs),
            // A template says how long a run of this harness may take, never how much
            // it may spend: the budget is a per-task figure, and a machine-wide one
            // would be either too small for the large tasks or no limit at all.
            tokens: None,
        }
    }
}

pub(crate) struct Outcome {
    pub(crate) ended: Ended,
    pub(crate) output: String,
    pub(crate) took: Duration,
    /// True when output was discarded past the cap.
    pub(crate) truncated: bool,
    /// Tokens the agent's own output reported, and `None` when it reported none.
    ///
    /// A report, not a measurement — see [`crate::usage`] for why nothing else could
    /// know this, why the two cases are kept apart rather than both being zero, and
    /// what unit the number is in.
    pub(crate) spent: Option<u64>,
    /// Context the run re-read from the cache. Reported, never budgeted: it is the
    /// same tokens once per turn, at a scale no budget is written in.
    pub(crate) replayed: Option<u64>,
}

impl Outcome {
    /// How the run ended, and — when it failed and left an explanation — why.
    ///
    /// This is the line that goes on the record, and the reason it exists is that the
    /// old one said `exit 1`. That is a fact about a process and tells whoever tries
    /// again exactly nothing: it is the same nothing as `killed by a signal`, so an
    /// agent that gave up, a harness that crashed on a bad config and a machine with no
    /// credential on it all left the same mark. The sentence that told them apart was
    /// written by the harness, captured here, printed once to a terminal — and then
    /// dropped, while the durable copy, the one a retry reads out of its envelope and
    /// the one an operator reads from somewhere else entirely, kept the exit code
    /// alone. `exit 1 — Error: invalid x-api-key` is a cause, and it is the difference
    /// between a retry that fixes something and a retry that burns the budget again.
    ///
    /// Only for a run that failed. A clean run's last line is a warning or a progress
    /// note, and hanging it off `exit 0` would put noise on every record that worked. A
    /// killed run keeps its words: what the harness was saying when the clock ran out is
    /// the best evidence anyone has about where it got stuck.
    pub(crate) fn cause(&self) -> String {
        match self.last_words() {
            Some(words) if !self.ended.ok() => format!("{} — {words}", self.ended.describe()),
            _ => self.ended.describe(),
        }
    }

    /// The last thing the harness said in its own words.
    ///
    /// Three rules, and each of them is about not quoting something that would mislead:
    ///
    /// - **Nothing from a run that overflowed.** The buffer keeps the *first*
    ///   [`OUTPUT_CAP`] and discards what comes after, so a flooded run's final lines
    ///   are not in it — the end of the string is the middle of the run. Quoting that as
    ///   the reason it failed would be an invention, and an invention on the record is
    ///   worse than a bare exit code. The count survives a flood because the meter reads
    ///   the stream as it passes; this reads the buffer afterwards, and says so.
    /// - **Nothing that is the harness's own protocol.** A metered agent narrates itself
    ///   in JSON on stdout, mixed into the same buffer as its errors, and 200 characters
    ///   of a `result` object explains nothing to anybody. Recognised by its first
    ///   character and skipped — this reads none of it and only declines to quote it.
    /// - **Nothing from far back.** Twenty lines, so the answer is the run's ending
    ///   rather than whatever the last plain sentence anywhere in it happened to be.
    ///
    /// What is left is the last plain line the run printed, on either stream: a tool's
    /// `Error:`, a shell's `not found`, the exception a traceback ends on. A harness
    /// whose stack frames come last gives up a little to that, and no rule short of
    /// parsing somebody else's output format does better.
    fn last_words(&self) -> Option<String> {
        if self.truncated {
            return None;
        }
        self.output
            .lines()
            .rev()
            .take(LAST_WORDS_SEARCH)
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with(['{', '[']))
            .map(|l| clip(l, LAST_WORDS_CAP))
    }
}

/// The argv this template will actually run, with `{{prompt}}` filled in.
///
/// Exposed so the Broker can be asked about the real command line before anything
/// starts — an argv check after the fact would be worthless.
/// The post's grant, in the form a coding CLI accepts as its own allow-list.
///
/// The two vocabularies line up almost exactly: a `run` grant is already a glob
/// matched against a command line, which is what `Bash(...)` takes. So the authority
/// wecode records and the authority the harness enforces come from one declaration
/// instead of two that can disagree.
///
/// This is enforcement moving from post-hoc to intercepted. wecode still checks the
/// diff afterwards — a harness is not a sandbox, and one that ignored the flag would
/// still be caught — but a command outside the grant is now refused before it runs
/// rather than noticed after.
///
/// File tools are all-or-nothing here: the harness cannot express "write only
/// `src/**`", so a role with any write scope gets the editing tools and the diff check
/// remains what holds it to the declared paths. A role with none gets neither.
#[must_use]
pub(crate) fn allowed_tools(grant: &wecode_gov::Grant) -> String {
    let mut out: Vec<String> = grant.run.iter().map(|g| format!("Bash({g})")).collect();
    if !grant.read.is_empty() {
        out.extend(["Read", "Glob", "Grep"].map(str::to_string));
    }
    if !grant.write.is_empty() {
        out.extend(["Edit", "Write"].map(str::to_string));
    }
    // Comma-separated: a run glob contains spaces, and space separation would split
    // `cargo *` into two tools, one of which is `*`.
    out.join(",")
}

/// `model` is the one the seat's level resolved to, and `None` leaves the harness to
/// its own default — see [`wecode_org::Company::model_for`].
///
/// It is appended rather than substituted into a placeholder, and the two halves travel
/// together: an operator who had written `--model {{model}}` in `args` would, on a seat
/// with no level, be launching a flag with nothing behind it.
pub(crate) fn argv(
    t: &AgentTemplate,
    prompt: &str,
    tools: &str,
    model: Option<&str>,
) -> Vec<String> {
    let mut out = vec![t.command.clone()];
    out.extend(
        t.args
            .iter()
            .map(|a| a.replace("{{prompt}}", prompt).replace("{{tools}}", tools)),
    );
    if let Some(m) = model {
        out.push(t.model_flag.clone());
        out.push(m.to_string());
    }
    out
}

/// Runs the agent to completion, or kills it.
///
/// `env` is what the project shares between its worktrees — see [`crate::cache`]. It is
/// set from values wecode already holds rather than read out of the ambient
/// environment, so it adds directories without adding a way for the shell's secrets to
/// arrive by another door.
pub(crate) fn run(
    t: &AgentTemplate,
    prompt: &str,
    tools: &str,
    model: Option<&str>,
    cwd: &Path,
    env: &[(String, std::path::PathBuf)],
    limits: Limits,
) -> std::io::Result<Outcome> {
    let args: Vec<String> = argv(t, prompt, tools, model).into_iter().skip(1).collect();

    let mut cmd = Command::new(&t.command);
    cmd.args(&args)
        .current_dir(cwd)
        // Built, not inherited: the allowlist is the whole environment.
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 0 means "a new group led by the child", so one signal reaches its children.
        .process_group(0);
    for key in &t.env_allowlist {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    // After the allowlist, and that ordering is the decision: the project said where
    // this repository's build output goes, and an inherited `CARGO_TARGET_DIR` naming
    // the operator's own checkout would otherwise win — putting the agent's build in
    // the one directory a worktree run must not touch.
    for (key, dir) in env {
        cmd.env(key, dir);
    }

    let started = Instant::now();
    let mut child = cmd.spawn()?;
    let pid = child.id();

    let buf = Arc::new(Mutex::new(String::new()));
    let truncated = Arc::new(Mutex::new(false));
    // Shared by both streams: a harness free to write its usage report to either one
    // should be counted the same way whichever it picks.
    let meter = Arc::new(Mutex::new(Meter::for_protocol(&t.protocol)));
    let (tick_tx, tick_rx) = channel::<()>();

    let mut readers = Vec::new();
    if let Some(o) = child.stdout.take() {
        readers.push(reader(o, &buf, &truncated, &meter, tick_tx.clone()));
    }
    if let Some(e) = child.stderr.take() {
        readers.push(reader(e, &buf, &truncated, &meter, tick_tx.clone()));
    }
    drop(tick_tx);

    let ended = supervise(&mut child, pid, started, limits, &tick_rx, &meter);

    // However it ended, nothing the agent spawned outlives it. A backgrounded child
    // holds the pipe open, and the reader joins below would then block on a process
    // the supervisor has already reported as finished — for as long as it cared to
    // run. Reaping the group is what makes the join bounded.
    reap_group(pid);
    for r in readers {
        let _ = r.join();
    }

    // The readers have joined, so nothing else holds this lock. A poisoned one means
    // a reader panicked mid-line, and the count it had reached is still the best
    // evidence there is. Taken once: the two figures are one report read two ways,
    // and locking twice invites them to come from different states of it.
    let metered = meter.lock().unwrap_or_else(|e| e.into_inner());

    Ok(Outcome {
        ended,
        output: buf.lock().map(|b| b.clone()).unwrap_or_default(),
        took: started.elapsed(),
        truncated: *truncated.lock().unwrap_or_else(|e| e.into_inner()),
        spent: metered.tokens(),
        replayed: metered.replayed(),
    })
}

/// Drains one stream into the shared buffer, pinging `tick` on every line so the
/// supervisor can tell working from hung.
fn reader<R: Read + Send + 'static>(
    stream: R,
    buf: &Arc<Mutex<String>>,
    truncated: &Arc<Mutex<bool>>,
    meter: &Arc<Mutex<Meter>>,
    tick: std::sync::mpsc::Sender<()>,
) -> thread::JoinHandle<()> {
    let buf = Arc::clone(buf);
    let truncated = Arc::clone(truncated);
    let meter = Arc::clone(meter);
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            // Ping first: a line that overflows the cap is still evidence of life.
            let _ = tick.send(());
            // Metered before the cap is consulted, and deliberately: the line that
            // states what the run cost is the last one, which is precisely the line
            // a full buffer discards.
            if let Ok(mut m) = meter.lock() {
                m.line(&line);
            }
            if let Ok(mut b) = buf.lock() {
                if b.len() + line.len() < OUTPUT_CAP {
                    b.push_str(&line);
                    b.push('\n');
                } else if let Ok(mut t) = truncated.lock() {
                    *t = true;
                }
            }
        }
    })
}

/// The head of a line, with an ellipsis when there was more of it.
///
/// By characters rather than bytes: a harness may complain in any language, and a cut
/// through the middle of one is a panic in the supervisor over a detail of somebody
/// else's error message.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

/// Polls until the child finishes or overruns.
///
/// `meter` is the same one the readers are filling, read here rather than after the
/// fact: a spend figure that only exists once the process is gone can describe an
/// overrun but cannot stop one. The count arrives a turn at a time, so this stops a
/// run shortly *after* it crosses its budget rather than at the token that crosses it
/// — which is the difference between a task that spends 1.1× what it was given and one
/// that spends ten times it.
fn supervise(
    child: &mut Child,
    pid: u32,
    started: Instant,
    limits: Limits,
    tick: &Receiver<()>,
    meter: &Arc<Mutex<Meter>>,
) -> Ended {
    let mut last_output = Instant::now();
    loop {
        // Drain every ping; any of them means output arrived. `Disconnected` ends
        // the drain too — both readers are gone, so no more will come.
        while let Ok(()) = tick.try_recv() {
            last_output = Instant::now();
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                return match status.code() {
                    Some(c) => Ended::Exited(c),
                    // No code means a signal — distinct from any exit value, since a
                    // killed agent has not decided anything.
                    None => Ended::Signalled,
                };
            }
            Ok(None) => {}
            Err(_) => return Ended::Signalled,
        }

        if limits.wall.is_some_and(|w| started.elapsed() > w) {
            kill_group(pid, child);
            return Ended::Wall;
        }
        if limits.idle.is_some_and(|i| last_output.elapsed() > i) {
            kill_group(pid, child);
            return Ended::Idle;
        }
        // After `try_wait`, and that ordering is the decision: a run whose last line was
        // its own total has already finished, and reporting it as killed would turn
        // every overspend into a cancellation. What is left to stop here is a run still
        // going after it has spent past its budget.
        if limits.tokens.is_some_and(|cap| spent_past(meter, cap)) {
            kill_group(pid, child);
            return Ended::Tokens;
        }
        thread::sleep(POLL);
    }
}

/// Whether the run has reported spending more than `cap`.
///
/// False whenever there is no number: an agent whose protocol nothing here can read
/// reports nothing, and a budget checked against a count nobody has would kill every
/// run under an unmetered harness or none of them, depending on which way the guess
/// went. Silence is not evidence of an overrun.
///
/// A blocked lock is a reader mid-line, and waiting for it here would stall the
/// supervisor's whole loop — including the clock. The count is polled ten times a
/// second, so a contended read simply asks again.
fn spent_past(meter: &Arc<Mutex<Meter>>, cap: u64) -> bool {
    match meter.try_lock() {
        Ok(m) => m.tokens().is_some_and(|spent| spent > cap),
        Err(_) => false,
    }
}

/// Signals a whole process group.
///
/// Through `kill(1)` rather than libc, because the workspace forbids `unsafe` and a
/// negative pid — the group — is not something `Child::kill` can express. Failure is
/// ignored: an empty group is the normal case and not an error worth reporting.
fn signal_group(pid: u32, sig: &str) {
    let _ = Command::new("kill")
        .args([sig, &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Asks the group to stop, then insists.
fn kill_group(pid: u32, child: &mut Child) {
    signal_group(pid, "-TERM");
    for _ in 0..20 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    signal_group(pid, "-KILL");
    let _ = child.wait();
}

/// Clears out anything left in the group once the agent itself has gone.
fn reap_group(pid: u32) {
    signal_group(pid, "-TERM");
    thread::sleep(Duration::from_millis(50));
    signal_group(pid, "-KILL");
}

/// The cached context a run re-read, said beside what it spent.
///
/// Not added to it: those tokens are counted when they are written, and a long
/// conversation replays them once per turn — the figure runs to millions where the
/// spend runs to thousands, which is why a budget is not written in it. Saying it
/// here is what keeps that decision from hiding real money, since cache reads are
/// billed, at a tenth of the rate. Silent when there were none, so a short run's
/// line stays a short line.
fn replay(o: &Outcome) -> String {
    match o.replayed {
        Some(n) if n > 0 => format!(" (+{n} re-read from cache, not budgeted)"),
        _ => String::new(),
    }
}

/// The clock the run was held to, and whose clock it was.
///
/// Beside `took`, because the two numbers only mean anything together: a run that ended
/// at 60s under a 60s wall was killed, and one that ended at 60s under half an hour
/// finished. Without the second figure "killed — wall limit" sends the operator to
/// `company.toml` to find out which limit, and half the time the answer is the task's own
/// budget rather than anything in that file.
///
/// So the source is named, not just the number. A task's wall and a harness's wall are
/// two declarations in two files with two owners, and "give it longer" means editing a
/// different one depending on which of them bit. Silent when the run was held to nothing
/// at all, which is what an unlimited configuration deserves to look like.
///
/// The token cap is named on the same line and for the same reason. It reads beside the
/// spend two lines down, so "killed — token budget" can be checked against the figure
/// that killed it without opening the plan.
fn held_to(task: &Task, post: &Post, l: Limits) -> String {
    let mut parts = Vec::new();
    if let Some(wall) = l.wall {
        // The task's when it declared this figure — including when the template happens
        // to name the same one, since then it is both, and the task is the declaration
        // the operator has in front of them.
        let whose = if task.budget.wall_secs == Some(wall.as_secs()) {
            "this task's budget".to_string()
        } else {
            format!("the {} template", post.agent)
        };
        parts.push(format!("wall {}s ({whose})", wall.as_secs()));
    }
    if let Some(idle) = l.idle {
        parts.push(format!("idle {}s", idle.as_secs()));
    }
    // No source named: a token cap has only one, the task, since no template declares
    // one to be confused with.
    if let Some(tokens) = l.tokens {
        parts.push(format!("{tokens} tokens (this task's budget)"));
    }
    if parts.is_empty() {
        return String::new();
    }
    format!("  limit    {}\n", parts.join(", "))
}

/// What running the agent did. Facts only — the verdict comes from `verify`.
///
/// `model` is what the seat's level resolved to. Named on the line rather than left to
/// be inferred: it is the most expensive variable in a run, and a spend figure beside a
/// model nobody wrote down is a number with no unit.
///
/// `limits` is what the run was actually stopped by, passed in rather than read back off
/// the task or the template: it is composed from both, and a report that recomputed it
/// could disagree with the clock the process was held to.
#[must_use]
pub(crate) fn ran(
    task: &Task,
    post: &Post,
    model: Option<&str>,
    cwd: &std::path::Path,
    limits: Limits,
    o: &Outcome,
) -> String {
    let mut out = format!(
        "{} {}  {}\n  post     {} ({})\n  in       {}\n  took     {:.0}s\n{}  spent    {}\n  {}\n",
        kind_tag(task.kind),
        task.id,
        task.title,
        post.name,
        match (model, post.intelligence) {
            (Some(m), Some(i)) => format!("{}, {m} at {i}", post.agent),
            // A harness left to its own default. Said as such, because "claude" alone
            // reads as a complete answer to the question of what ran.
            _ => format!("{}, its own default model", post.agent),
        },
        cwd.display(),
        o.took.as_secs_f64(),
        held_to(task, post, limits),
        match o.spent {
            Some(n) => format!("{n} tokens, as the agent reported them{}", replay(o)),
            // Not "0": the agent's protocol says nothing wecode can read a count
            // out of, and a budget cannot be checked against a number nobody has.
            None => "unmetered — this agent reports no token usage".to_string(),
        },
        if o.ended.ok() {
            format!("✓ {}", o.ended.describe())
        } else {
            format!("✗ {}", o.ended.describe())
        }
    );
    if o.truncated {
        out.push_str("  output was capped\n");
    }
    // The tail, not the whole log: enough to see how it ended without burying the
    // verdict that follows.
    let tail: Vec<&str> = o.output.lines().rev().take(12).collect();
    if !tail.is_empty() {
        out.push_str("\nlast output\n");
        for line in tail.into_iter().rev() {
            out.push_str(&format!("  {}\n", truncate_cmd(line, 100)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::Budget;

    #[test]
    fn a_run_grant_becomes_the_harness_allow_list() {
        // The point of deriving it: one declaration, so what wecode records and what
        // the harness enforces cannot disagree.
        let mut g = wecode_gov::Grant::writer(&["src/**"]);
        g.run = vec!["cargo *".into(), "npm test*".into()];
        let tools = allowed_tools(&g);
        assert!(tools.contains("Bash(cargo *)"), "{tools}");
        assert!(tools.contains("Bash(npm test*)"), "{tools}");
        assert!(tools.contains("Edit"), "{tools}");
        // Comma, not space: `cargo *` would otherwise split into two tools.
        assert!(!tools.contains("Bash(cargo *) Bash"), "{tools}");
    }

    #[test]
    fn a_role_that_writes_nothing_is_given_no_editing_tools() {
        // The reviewer reads and reports. Handing it Edit would make the grant a
        // description rather than a limit.
        let g = wecode_gov::Grant::default().with_read(&["**"]);
        let tools = allowed_tools(&g);
        assert!(tools.contains("Read"), "{tools}");
        assert!(!tools.contains("Edit"), "{tools}");
        assert!(!tools.contains("Write"), "{tools}");
    }

    #[test]
    fn the_placeholder_is_substituted_into_the_launch_line() {
        let t = agent("--allowedTools {{tools}}", None, None);
        // `agent` builds `sh -c <script>`, so the placeholder is inside arg 2.
        assert_eq!(
            argv(&t, "p", "Bash(cargo *),Edit", None)[2],
            "--allowedTools Bash(cargo *),Edit"
        );
    }

    /// A stand-in agent. `sh` is the one interpreter guaranteed present, and using a
    /// real process is the whole point — a fake would test none of this.
    fn agent(script: &str, wall: Option<u64>, idle: Option<u64>) -> AgentTemplate {
        AgentTemplate {
            command: "sh".to_string(),
            protocol: String::new(),
            args: vec!["-c".to_string(), script.to_string()],
            env_allowlist: vec![],
            wall_secs: wall,
            idle_secs: idle,
            models: vec![],
            model_flag: "--model".to_string(),
        }
    }

    fn cwd() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn a_prompt_is_substituted_into_the_argv() {
        let t = agent("echo {{prompt}}", None, None);
        assert_eq!(
            argv(&t, "do the thing", "", None),
            vec!["sh", "-c", "echo do the thing"]
        );
    }

    #[test]
    fn a_resolved_model_reaches_the_launch_line_with_its_flag() {
        let mut t = agent("true", None, None);
        t.models = vec!["haiku".into(), "opus".into()];
        assert_eq!(
            argv(&t, "p", "", Some("opus")),
            vec!["sh", "-c", "true", "--model", "opus"]
        );
    }

    #[test]
    fn a_harness_that_spells_the_flag_differently_is_launched_its_way() {
        let mut t = agent("true", None, None);
        t.model_flag = "-m".to_string();
        assert_eq!(argv(&t, "p", "", Some("small"))[3..], ["-m", "small"]);
    }

    #[test]
    fn no_model_leaves_no_flag_behind() {
        // The reason the flag is a field rather than a `{{model}}` placeholder the
        // operator positions: a placeholder would leave `--model` standing alone here.
        let t = agent("true", None, None);
        assert_eq!(argv(&t, "p", "", None), vec!["sh", "-c", "true"]);
    }

    #[test]
    fn the_model_actually_reaches_the_process() {
        // `sh -c <script> --model opus` hands the two extra arguments to the script as
        // `$0` and `$1` — a stand-in for the flag pair a real harness parses.
        let t = agent("echo flag=[$0] model=[$1]", None, None);
        let o = run(&t, "", "", Some("opus"), &cwd(), &[], Limits::default()).unwrap();
        assert!(
            o.output.contains("flag=[--model] model=[opus]"),
            "{}",
            o.output
        );
    }

    #[test]
    fn output_is_captured_and_the_exit_code_kept() {
        let t = agent("echo hello; echo oops >&2; exit 3", None, None);
        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert_eq!(o.ended, Ended::Exited(3));
        assert!(!o.ended.ok());
        assert!(o.output.contains("hello"), "{}", o.output);
        assert!(o.output.contains("oops"), "stderr too: {}", o.output);
    }

    #[test]
    fn the_environment_is_built_from_the_allowlist_not_inherited() {
        // The control that keeps a coding CLI from reading every secret in the shell.
        // Uses variables that already exist rather than setting any: `set_var` is
        // unsafe in this edition, and the workspace forbids unsafe.
        let home = std::env::var("HOME").expect("HOME is set in this environment");
        assert!(!home.is_empty());

        let mut t = agent("echo path=[$PATH] home=[$HOME]", None, None);
        t.env_allowlist = vec!["PATH".to_string()];

        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert!(
            o.output.contains("path=[/"),
            "PATH should pass: {}",
            o.output
        );
        assert!(
            o.output.contains("home=[]"),
            "HOME is not on the allowlist and must not reach the agent: {}",
            o.output
        );
    }

    #[test]
    fn the_shared_build_cache_reaches_the_agent_without_being_on_the_allowlist() {
        // The allowlist is about what may be *inherited*; this value is not inherited
        // from anywhere, it is what the project's playbook said. Requiring it to be
        // listed twice would mean a company.toml edit for every project that wanted a
        // cache, which is the wrong file to be editing.
        let t = agent("echo target=[$CARGO_TARGET_DIR]", None, None);
        let env = [(
            "CARGO_TARGET_DIR".to_string(),
            std::path::PathBuf::from("/tmp/shared-target"),
        )];
        let o = run(&t, "", "", None, &cwd(), &env, Limits::default()).unwrap();
        assert!(
            o.output.contains("target=[/tmp/shared-target]"),
            "{}",
            o.output
        );
    }

    #[test]
    fn the_project_s_cache_outranks_an_inherited_value_of_the_same_name() {
        // Otherwise an allowlisted variable pointing at the operator's own checkout
        // wins, and a worktree run builds into the directory it must not touch. `HOME`
        // stands in for a cache variable here only because it is the one this process
        // is guaranteed to have inherited.
        let mut t = agent("echo home=[$HOME]", None, None);
        t.env_allowlist = vec!["HOME".to_string()];
        let env = [(
            "HOME".to_string(),
            std::path::PathBuf::from("/tmp/declared-wins"),
        )];
        let o = run(&t, "", "", None, &cwd(), &env, Limits::default()).unwrap();
        assert!(
            o.output.contains("home=[/tmp/declared-wins]"),
            "{}",
            o.output
        );
    }

    #[test]
    fn it_runs_in_the_directory_it_is_given() {
        let dir = std::env::temp_dir().join("wecode-spawn-cwd");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker"), "x").unwrap();

        let t = agent("test -f marker", None, None);
        assert!(
            run(&t, "", "", None, &dir, &[], Limits::default())
                .unwrap()
                .ended
                .ok()
        );
    }

    #[test]
    fn a_run_that_overruns_its_wall_limit_is_killed() {
        let t = agent("sleep 30", None, None);
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_millis(300)),
                idle: None,
                tokens: None,
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Wall);
        assert!(
            o.took < Duration::from_secs(10),
            "killed promptly: {:?}",
            o.took
        );
    }

    #[test]
    fn a_silent_run_is_killed_on_the_idle_limit() {
        // Distinct from wall: this one would finish well inside its total budget, it
        // has simply stopped doing anything.
        let t = agent("sleep 30", None, None);
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_secs(60)),
                idle: Some(Duration::from_millis(300)),
                tokens: None,
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Idle);
    }

    #[test]
    fn output_keeps_the_idle_timer_alive() {
        // The reason idle is measured from output rather than from start: a slow but
        // working agent must not be killed.
        let t = agent(
            "for i in 1 2 3 4 5 6; do echo tick; sleep 0.1; done",
            None,
            None,
        );
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_secs(30)),
                idle: Some(Duration::from_millis(400)),
                tokens: None,
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Exited(0), "steady output should survive");
    }

    #[test]
    fn children_die_with_their_parent() {
        // The reason for a process group. The shell exits immediately; its child holds
        // the pipe open, so without group signalling this hangs until the sleep ends.
        let t = agent("sleep 30 & exit 0", None, None);
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_secs(5)),
                idle: Some(Duration::from_millis(500)),
                tokens: None,
            },
        )
        .unwrap();
        assert!(
            o.took < Duration::from_secs(4),
            "an orphaned child kept it alive for {:?}",
            o.took
        );
    }

    #[test]
    fn a_flood_of_output_is_capped_rather_than_buffered_without_limit() {
        let t = agent(
            "i=0; while [ $i -lt 40000 ]; do echo aaaaaaaaaaaaaaaaaaaa; i=$((i+1)); done",
            None,
            None,
        );
        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert!(o.truncated, "should have hit the cap");
        assert!(o.output.len() <= OUTPUT_CAP, "{}", o.output.len());
        // The point of draining past the cap: the child still gets to finish.
        assert_eq!(o.ended, Ended::Exited(0));
    }

    #[test]
    fn a_failed_run_is_recorded_with_the_reason_it_gave_not_just_its_exit() {
        // The whole defect. `exit 1` is what a crashed harness, a refused agent and a
        // machine with no credential on it all look like from outside; the sentence
        // that tells them apart was captured here and thrown away, and the retry read
        // the exit code.
        let t = agent("echo 'Error: invalid x-api-key' >&2; exit 1", None, None);
        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert_eq!(o.cause(), "exit 1 — Error: invalid x-api-key");
    }

    #[test]
    fn a_run_that_ended_cleanly_is_not_annotated_with_its_last_line() {
        // A working run's last line is a warning or a progress note. Hung off `exit 0`
        // it would put a reason on every record that has none.
        let t = agent("echo 'warning: deprecated flag' >&2; exit 0", None, None);
        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert_eq!(o.cause(), "exit 0");
    }

    #[test]
    fn a_failure_that_said_nothing_is_still_recorded_by_how_it_ended() {
        // No invention when there is nothing to quote: the exit code alone is what
        // this run left behind, and it is the whole of what the record claims.
        let t = agent("exit 5", None, None);
        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert_eq!(o.cause(), "exit 5");
    }

    #[test]
    fn a_killed_run_says_what_it_was_saying_when_the_clock_ran_out() {
        // Not a reason it chose — it did not choose to stop — but the best evidence
        // anyone has about where it got stuck, and the operator reading this from
        // somewhere else has nothing better.
        let t = agent("echo 'resolving dependencies'; sleep 30", None, None);
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_millis(300)),
                idle: None,
                tokens: None,
            },
        )
        .unwrap();
        assert_eq!(o.cause(), "killed — wall limit — resolving dependencies");
    }

    #[test]
    fn the_harness_s_own_protocol_is_not_quoted_back_as_a_reason() {
        // A metered agent narrates itself in JSON on the same buffer its errors land
        // in, and it is usually the last thing said. Two hundred characters of a
        // `result` object explains nothing to anybody; the line above it does.
        let t = metered_agent(
            "echo 'Error: overloaded' >&2; sleep 0.2; \
             echo '{\"type\":\"result\",\"usage\":{\"input_tokens\":5,\"output_tokens\":5}}'; \
             exit 1",
        );
        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert_eq!(o.cause(), "exit 1 — Error: overloaded");
        // Skipped, not parsed: the count still comes from the meter reading the stream.
        assert_eq!(o.spent, Some(10));
    }

    #[test]
    fn a_run_that_overflowed_its_buffer_is_not_quoted_from_its_own_middle() {
        // The cap keeps the *first* 256 KB, so the end of a flooded buffer is the
        // middle of the run. The last line in it is not the last thing that happened,
        // and quoting it as the reason would be an invention on the record — which is
        // worse than the bare exit code this falls back to.
        let t = agent(
            "i=0; while [ $i -lt 40000 ]; do echo aaaaaaaaaaaaaaaaaaaa; i=$((i+1)); done; \
             echo 'Error: ran out of disk' >&2; exit 1",
            None,
            None,
        );
        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert!(o.truncated, "the cap should have been hit");
        assert_eq!(o.cause(), "exit 1");
    }

    #[test]
    fn a_long_complaint_is_clipped_rather_than_dropped() {
        // It shares a line with four other columns wherever a run is shown, and half
        // an explanation is worth more than none.
        let t = agent(
            "i=0; s=; while [ $i -lt 40 ]; do s=\"${s}0123456789\"; i=$((i+1)); done; \
             echo \"Error: $s\" >&2; exit 1",
            None,
            None,
        );
        let c = run(&t, "", "", None, &cwd(), &[], Limits::default())
            .unwrap()
            .cause();
        assert!(c.starts_with("exit 1 — Error: 0123456789"), "{c}");
        assert!(c.ends_with('…'), "{c}");
        assert!(c.chars().count() <= "exit 1 — ".chars().count() + LAST_WORDS_CAP);
    }

    /// The same stand-in, speaking a protocol whose usage lines wecode can read.
    fn metered_agent(script: &str) -> AgentTemplate {
        let mut t = agent(script, None, None);
        t.protocol = "claude-stream-json".to_string();
        t
    }

    #[test]
    fn what_the_agent_reported_spending_comes_back_with_its_exit() {
        let t = metered_agent(
            r#"echo '{"type":"result","usage":{"input_tokens":1200,"output_tokens":340}}'"#,
        );
        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert_eq!(o.spent, Some(1540));
    }

    #[test]
    fn an_agent_whose_protocol_says_nothing_is_unmetered_rather_than_free() {
        // Same output, template protocol left empty. Zero would be a claim; `None`
        // is the truth, and the board renders them differently.
        let t = agent(
            r#"echo '{"type":"result","usage":{"input_tokens":1200,"output_tokens":340}}'"#,
            None,
            None,
        );
        assert_eq!(
            run(&t, "", "", None, &cwd(), &[], Limits::default())
                .unwrap()
                .spent,
            None
        );
    }

    #[test]
    fn a_run_that_overflows_the_output_cap_still_accounts_for_itself() {
        // The reason metering happens in the reader: the total arrives on the last
        // line, and the last line of a flood is the one the cap throws away.
        let t = metered_agent(
            "i=0; while [ $i -lt 40000 ]; do echo aaaaaaaaaaaaaaaaaaaa; i=$((i+1)); done; \
             echo '{\"type\":\"result\",\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}'",
        );
        let o = run(&t, "", "", None, &cwd(), &[], Limits::default()).unwrap();
        assert!(o.truncated, "the cap should have been hit");
        assert!(
            !o.output.contains("input_tokens"),
            "the reporting line was dropped from the buffer, as intended"
        );
        assert_eq!(o.spent, Some(10), "and counted anyway");
    }

    #[test]
    fn a_killed_run_keeps_the_spend_it_had_already_reported() {
        // Overrunning does not refund anything. The tokens were burned before the
        // wall limit was reached, and the board has to show them.
        let t = metered_agent(
            "echo '{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":50,\
             \"output_tokens\":25}}}'; sleep 30",
        );
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_millis(300)),
                idle: None,
                tokens: None,
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Wall);
        assert_eq!(o.spent, Some(75));
    }

    #[test]
    fn limits_come_from_the_agent_template() {
        let t = agent("true", Some(120), Some(30));
        let l = Limits::from(&t);
        assert_eq!(l.wall, Some(Duration::from_secs(120)));
        assert_eq!(l.idle, Some(Duration::from_secs(30)));
        // And the spend does not: a template is a harness, and a budget is a task's.
        assert_eq!(l.tokens, None);
    }

    #[test]
    fn an_agent_that_spends_past_its_budget_is_stopped_where_it_is() {
        // The whole defect. A turn at a time is the finest grain a token count comes
        // in — nothing sits between the agent and the model — so the run is stopped
        // just after it crosses 100 rather than at the token that crossed it. What it
        // is not is a run that keeps going for another twenty turns.
        let t = metered_agent(
            "i=0; while [ $i -lt 20 ]; do echo '{\"type\":\"assistant\",\"message\":\
             {\"id\":\"msg_'$i'\",\"usage\":{\"input_tokens\":30,\"output_tokens\":10}}}'; \
             sleep 0.2; i=$((i+1)); done",
        );
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_secs(30)),
                idle: None,
                tokens: Some(100),
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Tokens);
        assert_eq!(o.ended.describe(), "killed — token budget");
        // A few turns, not twenty: stopped on the first count seen past the cap, and
        // the tokens already burned are still reported. Bounded rather than exact
        // because how many turns land inside one 100ms poll is the machine's business.
        let spent = o.spent.expect("the turns it did report");
        assert!((120..=400).contains(&spent), "{spent}");
    }

    #[test]
    fn a_run_that_stays_inside_its_budget_is_left_alone() {
        let t = metered_agent(
            r#"echo '{"type":"result","usage":{"input_tokens":60,"output_tokens":30}}'"#,
        );
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: None,
                idle: None,
                tokens: Some(100),
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Exited(0));
        assert_eq!(o.spent, Some(90));
    }

    #[test]
    fn a_turn_restated_across_its_blocks_is_not_a_budget_spent_four_times() {
        // The count the supervisor kills on has to be the count the ledger records,
        // and one turn announced once per content block used to be neither: summed
        // live it crossed a 100-token budget on its fourth line, while the run's own
        // total — the figure anyone reading afterwards would see — said 60. A kill
        // nothing that survived the run could account for.
        let t = metered_agent(
            "i=0; while [ $i -lt 4 ]; do echo '{\"type\":\"assistant\",\"message\":\
             {\"id\":\"msg_1\",\"usage\":{\"input_tokens\":30,\"output_tokens\":30}}}'; \
             sleep 0.2; i=$((i+1)); done; \
             echo '{\"type\":\"result\",\"usage\":{\"input_tokens\":30,\"output_tokens\":30}}'",
        );
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_secs(30)),
                idle: None,
                tokens: Some(100),
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Exited(0), "it never spent past 100");
        assert_eq!(o.spent, Some(60));
    }

    #[test]
    fn an_unmetered_agent_is_not_killed_for_a_count_nobody_has() {
        // Silence is not evidence of an overrun. This agent reports usage in a format
        // nothing here reads, and a budget guessed at from that is a kill nobody
        // could account for.
        let t = agent(
            r#"echo '{"type":"result","usage":{"input_tokens":9000}}'; sleep 0.5"#,
            None,
            None,
        );
        let o = run(
            &t,
            "",
            "",
            None,
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_secs(30)),
                idle: None,
                tokens: Some(10),
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Exited(0));
        assert_eq!(o.spent, None);
    }

    /// A finished run, so a test can vary the clock it was held to and nothing else.
    fn outcome() -> Outcome {
        Outcome {
            ended: Ended::Exited(0),
            output: String::new(),
            took: std::time::Duration::from_secs(12),
            truncated: false,
            spent: Some(90),
            replayed: None,
        }
    }

    fn seat() -> Post {
        Post {
            name: "impl".into(),
            role: "engineer".into(),
            agent: "claude-code".into(),
            intelligence: None,
        }
    }

    fn ran_under(wall: Option<u64>, idle: Option<u64>) -> String {
        held(wall, idle, None)
    }

    fn held(wall: Option<u64>, idle: Option<u64>, tokens: Option<u64>) -> String {
        // `cache` as the plan holds it: budgeted at 600s and 9000 tokens, which is what
        // the report has to name a source for.
        let task = Task::new("cache", "export", "add a response cache").budgeted(Budget {
            tokens: Some(9000),
            wall_secs: Some(600),
        });
        ran(
            &task,
            &seat(),
            None,
            std::path::Path::new("/run/cws/cache"),
            Limits {
                wall: wall.map(std::time::Duration::from_secs),
                idle: idle.map(std::time::Duration::from_secs),
                tokens,
            },
            &outcome(),
        )
    }

    #[test]
    fn a_run_says_which_clock_it_was_held_to_and_whose_it_was() {
        // `cache` is budgeted at 600s. Held to that figure, the report names the task —
        // because "killed — wall limit" otherwise sends the operator to company.toml to
        // find a limit that is not written there.
        let out = ran_under(Some(600), Some(300));
        assert!(
            out.contains("limit    wall 600s (this task's budget), idle 300s"),
            "{out}"
        );

        // Held to the harness's own instead: a different file, a different owner, and
        // the thing to edit if this run wants longer.
        let out = ran_under(Some(1800), Some(300));
        assert!(
            out.contains("limit    wall 1800s (the claude-code template)"),
            "{out}"
        );
    }

    #[test]
    fn the_token_cap_a_run_was_stopped_by_is_on_the_same_line() {
        // `cache` is budgeted at 9000 tokens, and that figure now ends runs rather than
        // only colouring rows afterwards. Printed beside the spend, so "killed — token
        // budget" can be read against the number that did it.
        let out = held(Some(600), Some(300), Some(9000));
        assert!(
            out.contains("limit    wall 600s (this task's budget), idle 300s, 9000 tokens"),
            "{out}"
        );

        // A cap and nothing else still prints, without a stray separator.
        let out = held(None, None, Some(9000));
        assert!(
            out.contains("limit    9000 tokens (this task's budget)\n"),
            "{out}"
        );
    }

    #[test]
    fn a_run_under_no_clock_at_all_says_nothing_about_one() {
        // An unlimited configuration should look unlimited, not like a limit nobody
        // filled in.
        let out = ran_under(None, None);
        assert!(!out.contains("limit"), "{out}");
        assert!(out.contains("took     12s"), "{out}");

        // And one half alone still prints, without a stray separator.
        let out = ran_under(None, Some(300));
        assert!(out.contains("limit    idle 300s\n"), "{out}");
    }
}
