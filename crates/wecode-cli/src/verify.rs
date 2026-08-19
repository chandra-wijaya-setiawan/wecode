//! Judging finished work from what it actually did.
//!
//! Three questions, all answered without asking the agent:
//!
//! - **Did it stay in scope?** From the branch's own diff, not from a self-report — and
//!   from all of it, including the attempts already committed on it.
//! - **Did it do anything?** A task that declared a write scope and left no diff did not
//!   do its work. Acceptance cannot catch this and never could: the commands a task is
//!   held to are the repository's own, and they passed on the tree before it started.
//!   An agent that ran out of budget, gave up, or reported success it had not earned
//!   therefore came back green — a run that changed nothing was judged as one that
//!   delivered, and passing is what merges. A main task with steps beneath it is the
//!   one shape where an empty diff of its own is the plan working: its subtasks share
//!   the tree it owns and commit on its branch, so the work it is owed is standing
//!   there under their names rather than missing.
//! - **Does it pass?** By running the acceptance commands here, not by being told.
//!
//! That ordering is the design's own rule — the diff always wins. An agent's
//! `result.json` is useful for a summary and inadmissible as evidence, so nothing in
//! this module reads it.
//!
//! Acceptance comes in two tiers and the second is not run unless somebody asks. Most
//! of it is what a checkout can answer alone: a suite, a linter, a script over the
//! tree. Some of what a task is owed cannot be — whether the bucket exists, whether the
//! queue drains — and a check for that needs live infrastructure and a credential to
//! reach it. A command marked `live:` is the second tier: deferred by default, run when
//! the person judging asks for it in that one invocation. See [`Tier`].
//!
//! Which is how a task does real work against cloud resources with no agent ever
//! holding a key. The tiers split *who runs what*: everything here runs after the agent
//! has exited, in wecode's process, under the operator's own environment — while the
//! agent was spawned into one built from an allowlist ([`crate::spawn::run`]). The
//! credential is in this process and was never in that one. The agent is told the check
//! exists, since the marker travels in the command text the envelope prints, and being
//! told is all it gets.
//!
//! Post-hoc rather than intercepted, because wecode cannot hook another process's
//! writes. Confinement is the worktree; this is the check afterwards. It is why a
//! write outside scope is *sanctioned* — recoverable — rather than prevented.
//!
//! Recovered here, and not only recorded. The write has already happened by the time
//! anything looks, but nothing has *landed*: wecode decides what the attempt commits,
//! and a refused path is left out of it. That is the half of enforcement that is not
//! too late, and without it a denial was a sentence in the ledger about a file already
//! sitting on the branch.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::process::Command;

use wecode_core::{Measure, Scope, Task, TaskId, TaskStatus};
use wecode_gov::glob;

use crate::git;
use crate::render::{kind_tag, truncate_cmd};

/// One acceptance command, run.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Check {
    /// The command as it was run, tier marker stripped: the marker is wecode's word
    /// about the check and never part of what `sh` was given, and this is the line the
    /// ledger records as the argv and a failure reason quotes.
    pub(crate) cmd: String,
    /// `None` when the command could not be started at all.
    pub(crate) status: Option<i32>,
    pub(crate) expected: i32,
    /// Whether this belongs to the live tier — see [`Tier`]. It changes nothing about
    /// the verdict a check earns; it is here so the render can say which of them
    /// touched something outside the checkout.
    pub(crate) live: bool,
}

/// `sh` reports a command it could not find this way. Worth separating: the check
/// did not run, so calling it a failure blames the work for a broken environment.
const NOT_FOUND: i32 = 127;

impl Check {
    pub(crate) fn passed(&self) -> bool {
        self.status == Some(self.expected)
    }

    /// Whether the command could not be found. Never a verdict about the work.
    pub(crate) fn missing(&self) -> bool {
        self.status == Some(NOT_FOUND) && self.expected != NOT_FOUND
    }

    pub(crate) fn describe(&self) -> String {
        match self.status {
            Some(c) if c == self.expected => format!("exit {c}"),
            Some(c) if self.missing() => format!("exit {c} — command not found"),
            Some(c) => format!("exit {c}, wanted {}", self.expected),
            None => "did not start".to_string(),
        }
    }
}

/// What an acceptance command marked as needing live infrastructure starts with.
///
/// On the command line because there is nowhere else: a [`Measure::Command`] is a line
/// and an expected status, in the plan and in the store both. Read case-insensitively
/// for one reason — a marker that failed to match leaves the check in the *first* tier,
/// where it runs on every verdict, against the real bucket, unasked.
const LIVE_MARK: &str = "live:";

/// The variable that asks for the live tier, and the value `1` asks with.
const LIVE_ENV: &str = "WECODE_LIVE";

/// Which tier of acceptance a verdict is being asked for.
///
/// The request is per invocation and read from the environment — the same door
/// `WECODE_CONFIG` and `WECODE_AGENT` come through — and that is the property worth
/// having rather than a convenience. A tier written into the plan, the task or the
/// playbook would be a standing instruction: every judgement the board loop makes from
/// then on would reach for real infrastructure, days after the person who wrote it
/// stopped watching. In the environment of one command it cannot outlive the command.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum Tier {
    /// Everything a checkout can answer on its own, and nothing else. The default, and
    /// what every unattended verdict is made of.
    #[default]
    Offline,
    /// The offline tier and the live one together. Only ever by request.
    Live,
}

impl Tier {
    /// What this invocation was asked for.
    fn requested() -> Self {
        Self::asked_by(std::env::var(LIVE_ENV).ok().as_deref())
    }

    /// Whether a value of [`LIVE_ENV`] is a request. Off unless something affirmative
    /// is set: someone who exported the variable to turn the tier *off* said the more
    /// deliberate of the two things, and reading the mere presence of the name as
    /// consent would do the opposite of what they wrote.
    fn asked_by(v: Option<&str>) -> Self {
        let Some(v) = v.map(str::trim) else {
            return Self::Offline;
        };
        if ["", "0", "false", "no", "off"]
            .iter()
            .any(|off| v.eq_ignore_ascii_case(off))
        {
            Self::Offline
        } else {
            Self::Live
        }
    }

    /// Whether a check of this kind runs under this tier.
    fn runs(self, live: bool) -> bool {
        !live || self == Self::Live
    }
}

/// Splits the tier marker off an acceptance command: whether it is live, and the line
/// to actually run.
///
/// A marker with nothing behind it is not a marker. `live:` alone is an operator error,
/// and handing it to `sh` unchanged returns it as a command that was not found —
/// visibly broken where they wrote it. Read as a tier it would be a check that runs the
/// empty string, which exits 0: a pass earned by asking nothing, which is the one
/// outcome this module refuses everywhere else.
fn tier_of(cmd: &str) -> (bool, &str) {
    let line = cmd.trim_start();
    let Some(mark) = line.get(..LIVE_MARK.len()) else {
        return (false, cmd);
    };
    let rest = line[LIVE_MARK.len()..].trim_start();
    if mark.eq_ignore_ascii_case(LIVE_MARK) && !rest.is_empty() {
        (true, rest)
    } else {
        (false, cmd)
    }
}

/// What a task's work touched, and the tree it touched it in.
///
/// The tree travels with the paths because the next question asked of them — which of
/// them the scope refuses — is also the last moment anything holds both halves at once.
/// A refusal that cannot name the tree it happened in can be recorded and nothing more;
/// one that can is a refusal the commit afterwards is able to honour. Returning bare
/// strings is what made the finding un-actable, and the finding was already true.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub(crate) struct Changed {
    dir: PathBuf,
    paths: Vec<String>,
    /// What this task's steps delivered on the branch it owns.
    ///
    /// Kept apart from `paths` rather than folded into it, because these are not this
    /// task's writes to answer for in either direction. Not against its scope: a step
    /// declares its own, and a design step writing `docs/**` beneath a parent scoped to
    /// `crates/**` is the template doing exactly what it says — charging it here would
    /// fail the parent for its children's licence. And not as its delivery either,
    /// which is why the two lists are counted separately in the render.
    ///
    /// What they do settle is the one question an empty diff cannot answer on its own:
    /// whether the work this task was owed is on the branch. It is, under their names.
    delegated: Vec<String>,
    /// Whether the scope this diff was judged against asked for any writes at all.
    ///
    /// Recorded by [`violations`], because that call is the only moment both halves are
    /// in one hand — the same reason `dir` travels here. A diff on its own cannot say
    /// whether being empty is a failure: for a spike, which is the one kind admitted
    /// without a write scope, an empty diff is the declared outcome; for every other
    /// kind it is the work not done.
    ///
    /// `false` until the scope has been consulted, so a diff nobody checked a scope
    /// against makes no claim about what was owed. That is the honest default rather
    /// than a lenient one: such a verdict has already skipped the scope half entirely,
    /// and inventing a second finding out of the half that did not run would be worse.
    owed: Cell<bool>,
}

impl Changed {
    pub(crate) fn paths(&self) -> &[String] {
        &self.paths
    }

    pub(crate) fn len(&self) -> usize {
        self.paths.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    /// What this task's steps put on its branch — see [`Changed::delegated`].
    pub(crate) fn delegated(&self) -> &[String] {
        &self.delegated
    }

    /// The task said it would change something and nothing was done about it.
    ///
    /// Not the same question as `is_empty`, and the difference is the whole of it: an
    /// empty diff is a verdict about the work only once something is known to have been
    /// expected of it — and only once nothing else was answering for it.
    ///
    /// A main task with steps is that second case, and it is not a loophole. It is what
    /// decomposition *is*: the plan counts leaves, one worktree is cut per main task,
    /// and its subtasks commit their work on its branch. A parent that wrote nothing of
    /// its own has not gone quiet — its steps did the writing, each judged against the
    /// scope it declared as it finished. Failing the parent for that fails it for the
    /// shape the playbook asked for, and it fails at the end, after every step has
    /// already passed and the only thing left was to land them.
    pub(crate) fn delivered_nothing(&self) -> bool {
        self.owed.get() && self.paths.is_empty() && self.delegated.is_empty()
    }
}

impl<'a> IntoIterator for &'a Changed {
    type Item = &'a String;
    type IntoIter = std::slice::Iter<'a, String>;

    fn into_iter(self) -> Self::IntoIter {
        self.paths.iter()
    }
}

/// Everything observed about one finished task.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub(crate) struct Verdict {
    pub(crate) changed: Changed,
    /// Changed paths the task's write scope does not cover.
    pub(crate) violations: Vec<String>,
    pub(crate) checks: Vec<Check>,
    /// Acceptance measures that no command can settle. A task cannot carry one — the
    /// admission gate refuses `Judged` on a task — so this stays empty in practice
    /// and exists so the count is never silently wrong.
    pub(crate) unjudgeable: Vec<String>,
    /// Live checks this verdict did not run, as they would have been run.
    ///
    /// Kept rather than dropped, which is the whole of why the tier is a list and not
    /// an `if`. A check nobody asked for neither failed nor passed — it is a question
    /// this verdict did not put, and leaving it out silently would make the offline
    /// tier look like the whole of what the task was held to.
    pub(crate) deferred: Vec<String>,
}

impl Verdict {
    /// Checks that could not run at all. An environment problem, reported apart from
    /// the verdict so a missing toolchain never reads as failing work.
    pub(crate) fn unrunnable(&self) -> Vec<&Check> {
        self.checks.iter().filter(|c| c.missing()).collect()
    }

    /// Everything that had to hold, including the one an agent can satisfy by doing
    /// nothing at all.
    ///
    /// A task that declared a write scope and produced no diff fails here whatever its
    /// acceptance says, and the acceptance saying so is the point: those commands are
    /// the repository's own and were green before the run started, so a green board
    /// beside an empty diff was the *expected* reading of a run that did nothing. It is
    /// the quietest way for work to be marked delivered — quieter than a failing check,
    /// which at least says something is wrong — and `passed` is what sends a branch to
    /// `needs-approval` and from there to a merge.
    ///
    /// A deferred live check is not counted against the work, because nothing asked it.
    /// The alternative reads well and is unusable: a task carrying one could then pass
    /// only where the credentials for it are, and the tier would be a way of writing
    /// acceptance that can only fail. A pass here is therefore *passed what was asked*,
    /// and since that changes with the invocation, [`verdict`] says which was asked
    /// rather than leaving the reader to assume the larger one.
    pub(crate) fn passed(&self) -> bool {
        self.violations.is_empty()
            && self.unjudgeable.is_empty()
            && !self.changed.delivered_nothing()
            && !self.checks.is_empty()
            && self.checks.iter().all(Check::passed)
    }
}

/// The worker-writable area. The task envelope instructs the agent to write its
/// result here, so counting it as a scope violation would fail every task for doing
/// exactly what it was told.
fn is_worker_area(path: &str) -> bool {
    path.starts_with(wecode_core::WORKER_DIR)
}

/// Every path this task's work touched in `dir`, committed attempts included.
///
/// Not the uncommitted diff alone, which is what this used to be and what left a hole
/// exactly one retry wide. wecode commits each attempt, pass or fail, and a retry opens
/// with `git reset --hard`: by the time a second attempt is judged, the first one's
/// writes are *behind* `HEAD`, where `git diff HEAD` cannot see them. So an attempt that
/// added nothing was judged against an empty diff — and an empty diff violates no scope.
/// A first attempt rejected for writing outside its scope passed on the retry that
/// changed nothing, with the out-of-scope file still standing on the branch, on its way
/// to a merge. The retry did not overturn the finding; it stopped looking.
///
/// The acceptance commands never had this problem — they run against the worktree, which
/// carries the committed work whether or not anything is uncommitted. It was only the
/// half of the verdict that reads the diff that could be emptied out this way, which is
/// why the failure is quiet: a passing check beside a blank diff reads as a clean run.
///
/// Attempts are picked out by subject rather than taken wholesale. A subtask shares its
/// parent's branch and its siblings' attempts are in the same log, each already judged
/// against its own scope; and the base carries the predecessor work this task was cut
/// from, which is not this task's to answer for.
///
/// The steps of a task that owns the tree are read too, into a second list — see
/// [`Changed::delegated`] and [`a_step_here`]. Not this task's diff, and it never joins
/// it; it is only the answer to whether a parent's own empty diff means the work is
/// missing or means the work is theirs.
///
/// The window is [`git::attempts_on`]'s — the newest twenty commits wecode made here —
/// so a branch carrying more than that behind the current attempt is read from the last
/// twenty. That is the same history `wecode show` and the handoff already read, and
/// widening it belongs there rather than in one caller's copy of the question.
pub(crate) fn changed(dir: &Path, id: &TaskId) -> Result<Changed, git::GitError> {
    let mut all = git::changed_files(dir)?;
    let mut delegated = Vec::new();
    let mine = format!("{id}: attempt");
    let owns = owns_the_tree(dir, id);
    for (sha, subject) in git::attempts_on(dir)? {
        let ours = subject.starts_with(&mine);
        // Its own attempts are its own diff first, whatever else is true of the
        // branch: no task is one of its own steps.
        let theirs = !ours && owns && a_step_here(dir, &subject);
        if !ours && !theirs {
            continue;
        }
        // The file list is the whole of what a scope check wants. The diff body is
        // the handoff's business, so it is asked for at zero bytes and dropped.
        let (files, _) = git::commit_summary(dir, &sha, 0)?;
        if theirs {
            delegated.extend(files);
        } else {
            all.extend(files);
        }
    }
    all.sort();
    all.dedup();
    delegated.sort();
    delegated.dedup();
    // A file a step delivered and this task then edited is this task's own work, and
    // saying so twice would report one path as both.
    delegated.retain(|p| !all.contains(p));
    Ok(Changed {
        dir: dir.to_path_buf(),
        paths: all,
        delegated,
        owed: Cell::new(false),
    })
}

/// Whether the tree this verdict is standing in is the one this task owns.
///
/// A main task's worktree is named after it — [`crate::work::worktree_for`] — and its
/// subtasks share it rather than opening a second checkout. So the directory name
/// answers, from inside a verdict, the question the plan would otherwise have to be
/// opened for: *am I the top of this tree, or one of the steps in it?* Only the top is
/// answered for by the attempts around it. A step's neighbours in the log are its
/// siblings, and a sibling's work excuses nothing — that task owes its own diff.
///
/// It follows that a step which is itself a parent is still judged on its own diff:
/// from in here its children and its siblings are the same shape, and the relation that
/// tells them apart is in the plan. The tree's owner is the one this can settle without
/// it, and it is the one that reaches a merge.
fn owns_the_tree(dir: &Path, id: &TaskId) -> bool {
    dir.file_name().and_then(|n| n.to_str()) == Some(id.as_str())
}

/// Whether this attempt belongs to a task working *inside* this tree rather than to one
/// the tree was cut from.
///
/// A subtask has no branch of its own — that is the rule `merge` is built on — so a
/// wecode attempt with no `wecode/<id>` standing behind it was committed here, by a step
/// sharing this worktree. Asked of the branch and not of the id, because a step is named
/// by whoever created it: `--expand` spells one `<parent>-<step>` and `task add --parent`
/// takes any id at all, and a naming convention is not a relation.
///
/// The branch is also what keeps the base out, which is the half that has to be right.
/// A branch cut from a predecessor's, or from an integration branch carrying merges,
/// brings that work's attempts into this log with exactly the shape of a step's — and
/// every task that owned a tree has a `wecode/<id>` that outlives it, kept deliberately
/// through teardown and through the merge. That branch is what says the commits came
/// from behind this task rather than from below it.
fn a_step_here(dir: &Path, subject: &str) -> bool {
    match subject.split_once(": attempt") {
        Some((id, _)) => !git::branch_exists(dir, &crate::work::branch_for(&TaskId::new(id))),
        None => false,
    }
}

/// Changed paths the scope does not permit — named, and kept out of the commit.
///
/// An empty write scope means the task claimed it would change nothing, so *any*
/// change is a violation — not a free pass. A spike is the kind that legitimately
/// has no scope, and a spike that edited files did something it did not declare.
///
/// The mirror of that reading is recorded here rather than returned: a scope that
/// *does* name paths is a task claiming it will change something, and a diff judged
/// against one is owed a change. Not a violation — nothing was written where it was
/// forbidden — so it does not belong in this list, which is the governance channel and
/// files each entry against the task as a refused write. It belongs on the diff, where
/// [`Verdict::passed`] reads it, and this is the one call that can put it there.
///
/// Naming a refused write and stopping it from landing are one act, which is why they
/// are one function. Sanctioned means *recoverable*, and until now nothing recovered:
/// wecode commits every attempt, pass or fail, so the file the verdict had just refused
/// went onto the branch in the same breath — and a branch that carries it is a branch
/// that merges it, since a later attempt can pass while the refused write sits behind
/// `HEAD` in an attempt commit nobody re-reads. The record said no and the repository
/// said yes. [`git::refuse`] is the note that settles it, left for the commit that
/// follows this verdict; the writes themselves stay in the tree, where the next verdict
/// can still see them and the retry's reset is what clears them.
///
/// Only in a worktree wecode made — the same line `commit_attempt` draws, and for the
/// same reason. A task the playbook gave no worktree is judged in the operator's own
/// checkout, where wecode commits nothing and therefore has nothing to hold back.
///
/// A note that cannot be written changes nothing about the verdict, which is why the
/// failure is dropped rather than raised: the refusal has already been recorded against
/// the task by the time anything is committed, and the ledger is the half that must not
/// be lost.
pub(crate) fn violations(changed: &Changed, scope: &Scope) -> Vec<String> {
    changed.owed.set(!scope.write.is_empty());
    let refused: Vec<String> = changed
        .paths()
        .iter()
        .filter(|p| !is_worker_area(p) && !glob::any_matches(&scope.write, p))
        .cloned()
        .collect();
    if commits_here(&changed.dir) {
        let _ = git::refuse(&changed.dir, &refused);
    }
    refused
}

/// Whether wecode is the one that commits in this tree.
///
/// The same line `commit_attempt` draws, named rather than repeated as a path test: a
/// verdict holds back only what it would otherwise have committed itself.
fn commits_here(dir: &Path) -> bool {
    dir.starts_with(crate::work::run_root())
}

/// Runs the acceptance commands in `dir`.
///
/// Through `sh -c`, because acceptance is written as a shell line — `cargo clippy
/// --all-targets -- -D warnings` is not an argv this could split correctly.
///
/// `env` is the project's shared build cache — see [`crate::cache`]. Acceptance is the
/// second cold build a worktree pays for and usually the larger one: the agent may
/// have run `cargo check`, this runs the suite. Setting it on the agent alone would
/// have shared half a cache.
///
/// Unlike a spawned agent's, this environment is inherited: these commands are the
/// operator's own, run by wecode, and they need the toolchain the operator has. The
/// declared variables are laid over it, so a project's answer for this repository beats
/// whatever the shell was carrying.
/// The tier is whatever this invocation was asked for — [`Tier::requested`].
pub(crate) fn run_acceptance(
    dir: &Path,
    measures: &[Measure],
    env: &[(String, std::path::PathBuf)],
) -> Verdict {
    run_tier(dir, measures, env, Tier::requested())
}

/// The same, with the tier named by the caller rather than read off the environment.
///
/// Split out because a tier read from the ambient environment is one a test cannot set:
/// `set_var` is unsafe, this workspace forbids unsafe outright, and a variable one test
/// exports is one every other test in the process now runs under. The decision lives
/// one function up, where a `--live` flag would set it too.
pub(crate) fn run_tier(
    dir: &Path,
    measures: &[Measure],
    env: &[(String, std::path::PathBuf)],
    tier: Tier,
) -> Verdict {
    let mut v = Verdict::default();
    for m in measures {
        match m {
            Measure::Command { cmd, expect_status } => {
                let (live, line) = tier_of(cmd);
                // Not run, and said so. The command is never started, which is the
                // point of the tier: nothing reaches the infrastructure it names.
                if !tier.runs(live) {
                    v.deferred.push(line.to_string());
                    continue;
                }
                let status = Command::new("sh")
                    .arg("-c")
                    .arg(line)
                    .current_dir(dir)
                    .envs(env.iter().map(|(k, v)| (k, v)))
                    .status()
                    .ok()
                    .and_then(|s| s.code());
                v.checks.push(Check {
                    cmd: line.to_string(),
                    status,
                    expected: *expect_status,
                    live,
                });
            }
            // Nothing here can settle these. Naming them beats counting a task as
            // passed on the strength of the measures that happened to be runnable.
            other => v.unjudgeable.push(other.describe()),
        }
    }
    v
}

/// What verification observed, and what it concluded.
///
/// `owner` is the task whose worktree and branch this one worked in — itself, unless
/// it is a subtask. A pass means different things to the two, and the difference is
/// the one thing a reader cannot get from the status word alone: a main task that
/// passed is waiting to be landed, a step of one has already put its commits where
/// they land from.
///
/// The tier is the second thing the status word cannot carry, and it is said here for
/// the same reason: `passed` is now `passed what was asked`, and which of the two tiers
/// was asked is a property of the invocation rather than of the task.
#[must_use]
pub(crate) fn verdict(
    task: &Task,
    owner: &TaskId,
    dir: &std::path::Path,
    v: &Verdict,
    next: TaskStatus,
) -> String {
    let mut out = format!(
        "{} {}  {}\n  in       {}\n",
        kind_tag(task.kind),
        task.id,
        task.title,
        dir.display()
    );

    out.push_str(&format!(
        "\ndiff — {} file{}\n",
        v.changed.len(),
        if v.changed.len() == 1 { "" } else { "s" }
    ));
    if v.changed.is_empty() {
        // Not neutral: a task that declared a write scope and changed nothing did
        // not do its work, whatever its acceptance says. Said twice on purpose —
        // here as the diff, and below as the verdict it now carries.
        //
        // Unless its steps did the writing, which is the one reading of an empty diff
        // that is not a finding — and the reader has to be told which of the two they
        // are looking at before they reach the verdict.
        out.push_str(if v.changed.delegated().is_empty() {
            "  nothing changed\n"
        } else {
            "  nothing of its own — its steps did the writing\n"
        });
    }
    for path in &v.changed {
        let bad = v.violations.contains(path);
        out.push_str(&format!(
            "  {} {}{}\n",
            if bad { "✗" } else { "✓" },
            path,
            if bad { "   outside scope" } else { "" }
        ));
    }

    let steps = v.changed.delegated();
    if !steps.is_empty() {
        // Listed apart from the diff and marked apart from it, because neither tick
        // above would be true of these: they are not this task's writes, and this
        // task's scope is not what they were held to.
        out.push_str(&format!(
            "\nits steps — {} file{} already on this branch\n",
            steps.len(),
            if steps.len() == 1 { "" } else { "s" }
        ));
        for path in steps {
            out.push_str(&format!("  · {path}\n"));
        }
    }

    if !v.checks.is_empty() {
        out.push_str("\nacceptance\n");
        for c in &v.checks {
            out.push_str(&format!(
                "  {} {:<44} {}{}\n",
                if c.passed() { "✓" } else { "✗" },
                truncate_cmd(&c.cmd, 44),
                c.describe(),
                // A green line that reached real infrastructure and a green line that
                // read a file are worth different amounts, and only one of them is
                // reproducible by whoever reads this next.
                if c.live { "   live" } else { "" }
            ));
        }
    }
    for u in &v.unjudgeable {
        out.push_str(&format!("  ? {u}   no command can settle this\n"));
    }

    if !v.deferred.is_empty() {
        // Where the missing checks would have been, so nobody counts the acceptance
        // block above and concludes it was all of them.
        out.push_str(&format!(
            "\nlive — {} check{} not run\n",
            v.deferred.len(),
            if v.deferred.len() == 1 { "" } else { "s" }
        ));
        for cmd in &v.deferred {
            out.push_str(&format!("  · {}\n", truncate_cmd(cmd, 44)));
        }
        out.push_str(&format!(
            "  a live check reaches infrastructure a checkout has not got, so none was asked\n\
             \x20 {LIVE_ENV}=1 wecode verify {}   asks for the tier, on your own credentials\n",
            task.id
        ));
    }

    out.push('\n');
    if v.passed() {
        out.push_str("  ✓ passed\n");
        if !v.deferred.is_empty() {
            // The tick above is about to be read as the whole verdict, because that is
            // what it has always meant. It now means *what was asked*, and the reader
            // has no way of knowing which invocation this was.
            let n = v.deferred.len();
            out.push_str(&format!(
                "    the offline tier only — {n} live check{} {} not asked for\n",
                if n == 1 { "" } else { "s" },
                if n == 1 { "was" } else { "were" }
            ));
        }
        // Three things a pass can mean, and the status word distinguishes only two of
        // them. Said here because the next command differs in each case, and the
        // wrong guess is expensive: `merge` on a step is refused, and waiting for a
        // signature on one that will never be asked for is worse.
        match next {
            TaskStatus::NeedsApproval if task.kind.needs_a_signature() => out.push_str(
                "    passing is not approval — a holder signs it before anything builds on it\n",
            ),
            TaskStatus::NeedsApproval => out.push_str(&format!(
                "    the branch is not merged — wecode merge {} lands it\n",
                task.id
            )),
            _ if owner != &task.id => out.push_str(&format!(
                "    its commits are on {owner}'s branch — that task is what lands them\n"
            )),
            _ => {}
        }
    } else {
        if v.changed.delivered_nothing() {
            // The green checks above are about to be read as a pass by whoever is
            // scanning, so this says which way they point: they ran against a tree the
            // task never touched, and they would have passed before it started.
            out.push_str(
                "  ✗ nothing changed — this task declared a write scope and produced no diff\n\
                 \x20   the acceptance above ran against a tree the work never touched\n",
            );
        }
        if !v.violations.is_empty() {
            out.push_str(&format!(
                "  ✗ {} write{} outside scope — recorded against this task\n",
                v.violations.len(),
                if v.violations.len() == 1 { "" } else { "s" }
            ));
        }
        let missing = v.unrunnable();
        let failed = v
            .checks
            .iter()
            .filter(|c| !c.passed() && !c.missing())
            .count();
        if failed > 0 {
            out.push_str(&format!("  ✗ {failed} acceptance check(s) failed\n"));
        }
        if !missing.is_empty() {
            // Not a verdict about the work — say so, or a missing toolchain reads as
            // a broken change.
            out.push_str(&format!(
                "  ⚠ {} check(s) could not run — the command was not found.\n\
                 \x20   wecode runs acceptance through `sh -c` with its own environment;\n\
                 \x20   this is a PATH problem, not a verdict on the work.\n",
                missing.len()
            ));
        }
        if v.checks.is_empty() && v.violations.is_empty() && !v.changed.delivered_nothing() {
            // A task whose acceptance is entirely live has the same empty check list as
            // one with no acceptance at all, and they are not the same failure: the
            // first was given something to be held to and nobody asked it. Sending that
            // reader off to look for a missing measure would be the wrong turn.
            out.push_str(if v.deferred.is_empty() {
                "  ✗ nothing to judge by\n"
            } else {
                "  ✗ nothing to judge by — every check this task has is live, \
                 and none was asked for\n"
            });
        }
    }
    out.push_str(&format!("  {}\n", next.as_str()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::Cmp;

    fn scope(globs: &[&str]) -> Scope {
        Scope::write(globs)
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    /// A diff read from nowhere. The scope half of a verdict is a question about names,
    /// so most of these tests have no tree to point at — and one that is not under the
    /// run root is one wecode never commits in, which is exactly the guard.
    fn touched(list: &[&str]) -> Changed {
        Changed {
            dir: PathBuf::new(),
            paths: paths(list),
            delegated: Vec::new(),
            owed: Cell::new(false),
        }
    }

    /// A verdict assembled the way the `verify` command assembles one: acceptance, then
    /// the diff, then the scope read against it. The order is the caller's and it is
    /// part of the answer — the scope is what tells an empty diff whether being empty
    /// is the declared outcome or the work not done.
    fn judged(measures: &[Measure], changed: Changed, scope: &Scope) -> Verdict {
        let mut v = ran(&std::env::temp_dir(), measures);
        v.changed = changed;
        v.violations = violations(&v.changed, scope);
        v
    }

    /// Acceptance with no shared cache — what a project that declares none gets.
    ///
    /// The tier is named rather than left to [`Tier::requested`], so a `WECODE_LIVE`
    /// exported in whatever shell runs the suite cannot decide what these tests are
    /// asserting about.
    fn ran(dir: &Path, measures: &[Measure]) -> Verdict {
        run_tier(dir, measures, &[], Tier::Offline)
    }

    /// The same, with the second tier asked for.
    fn ran_live(dir: &Path, measures: &[Measure]) -> Verdict {
        run_tier(dir, measures, &[], Tier::Live)
    }

    fn cmd(line: &str) -> Measure {
        Measure::Command {
            cmd: line.to_string(),
            expect_status: 0,
        }
    }

    /// A real repository, standing where a task's worktree would. git is a subprocess,
    /// so faking it would test nothing — least of all the part that only shows up once
    /// a commit is between the work and `HEAD`.
    fn worktree(name: &str) -> std::path::PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-verify-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        init(&dir)
    }

    /// The tree wecode cuts for a main task: a directory named after the task that owns
    /// it, which is how `work::worktree_for` names one and how a verdict standing in it
    /// knows whether the attempts around it are its steps' or the base's.
    fn owned_worktree(name: &str, owner: &str) -> std::path::PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let org = Path::new(&base).join(format!("wecode-verify-{name}"));
        let _ = std::fs::remove_dir_all(&org);
        init(&org.join(owner))
    }

    fn init(dir: &Path) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        git_here(dir, &["init", "-q", "-b", "main"]);
        git_here(dir, &["config", "user.email", "operator@localhost"]);
        git_here(dir, &["config", "user.name", "operator"]);
        // Base history, by a hand other than wecode's: what the branch was cut from is
        // never the task's answer to give.
        write(dir, "README.md", "the project\n");
        git_here(dir, &["add", "-A"]);
        git_here(dir, &["commit", "-qm", "the base this branch was cut from"]);
        dir.to_path_buf()
    }

    fn git_here(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    /// The branch a task that owned a tree leaves behind it. Kept after a merge and
    /// after teardown, which is what makes its absence mean *this task never had one*.
    fn branch_of(dir: &Path, id: &str) {
        git_here(dir, &["branch", &crate::work::branch_for(&TaskId::new(id))]);
    }

    fn write(dir: &Path, path: &str, body: &str) {
        let full = dir.join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, body).unwrap();
    }

    /// One finished attempt, committed exactly as `run` commits one.
    fn attempt(dir: &Path, id: &str, n: u32, files: &[(&str, &str)]) {
        for (path, body) in files {
            write(dir, path, body);
        }
        git::commit_all(dir, &format!("{id}: attempt {n}\n\nexit 0"))
            .unwrap()
            .expect("the attempt changed something");
    }

    /// The retry itself: wecode resets the tree before handing it to the next agent.
    fn retry(dir: &Path) {
        git::reset_hard(dir).unwrap();
    }

    #[test]
    fn a_retry_that_added_nothing_is_still_judged_on_what_the_branch_carries() {
        // The whole point. Attempt 1 wrote outside its scope and was rejected for it;
        // attempt 2 did nothing at all. Reading only the working tree, the second
        // verdict saw an empty diff, found no violation in it, and passed work whose
        // out-of-scope file was still sitting on the branch waiting to be merged.
        let dir = worktree("retry-adds-nothing");
        attempt(
            &dir,
            "t1",
            1,
            &[("src/a.rs", "fn a() {}\n"), ("Cargo.toml", "[package]\n")],
        );
        retry(&dir);

        let changed = changed(&dir, &TaskId::new("t1")).unwrap();
        assert_eq!(changed.paths(), ["Cargo.toml", "src/a.rs"]);
        assert_eq!(
            violations(&changed, &scope(&["src/**"])),
            vec!["Cargo.toml".to_string()]
        );
    }

    #[test]
    fn the_work_a_retry_did_add_joins_the_work_it_inherited() {
        // Both halves, once, in one list: the retry's own uncommitted writes and the
        // attempt underneath them. A file touched by both is one path, not two.
        let dir = worktree("retry-adds-more");
        attempt(
            &dir,
            "t1",
            1,
            &[("src/a.rs", "fn a() {}\n"), ("docs/note.md", "why\n")],
        );
        retry(&dir);
        // One file the retry rewrote, one it added, and one it left exactly as the
        // attempt underneath it wrote it.
        write(&dir, "src/a.rs", "fn a() { todo!() }\n");
        write(&dir, "src/b.rs", "fn b() {}\n");

        assert_eq!(
            changed(&dir, &TaskId::new("t1")).unwrap().paths(),
            ["docs/note.md", "src/a.rs", "src/b.rs"]
        );
    }

    #[test]
    fn a_siblings_attempts_on_a_shared_branch_are_not_this_tasks_to_answer_for() {
        // A subtask works in its parent's tree, so the log carries its siblings'
        // attempts. Each was judged against its own scope, and charging them here would
        // fail every step after the first for work that was already accepted.
        let dir = worktree("shared-branch");
        attempt(&dir, "step-one", 1, &[("docs/one.md", "one\n")]);
        attempt(&dir, "step-two", 1, &[("src/two.rs", "fn two() {}\n")]);
        retry(&dir);

        assert_eq!(
            changed(&dir, &TaskId::new("step-two")).unwrap().paths(),
            ["src/two.rs"]
        );
        assert!(
            violations(
                &changed(&dir, &TaskId::new("step-two")).unwrap(),
                &scope(&["src/**"])
            )
            .is_empty()
        );
    }

    #[test]
    fn work_that_came_with_the_base_is_not_this_tasks_work() {
        // A branch cut from a predecessor's carries that predecessor's commits. They
        // are not in this diff, and a task is not asked to declare a scope covering the
        // ground it was handed.
        let dir = worktree("base-history");
        let changed = changed(&dir, &TaskId::new("t1")).unwrap();
        assert!(changed.is_empty(), "{changed:?}");
    }

    #[test]
    fn a_first_attempt_is_read_exactly_as_before() {
        // Judging happens before the commit, so on the first run there is nothing
        // behind HEAD and this is the plain working-tree diff it has always been.
        let dir = worktree("first-attempt");
        write(&dir, "src/a.rs", "fn a() {}\n");
        assert_eq!(
            changed(&dir, &TaskId::new("t1")).unwrap().paths(),
            git::changed_files(&dir).unwrap()
        );
    }

    #[test]
    fn only_a_tree_wecode_commits_in_is_held_back() {
        // Which trees those are, stated once. The worktrees wecode cuts live under the
        // run root and nothing else does — a repository the operator keeps anywhere
        // else is theirs, and wecode neither commits there nor withholds anything.
        let ours = crate::work::run_root().join("an-org").join("t1");
        assert!(commits_here(&ours));
        assert!(!commits_here(&std::env::temp_dir().join("their-checkout")));
        assert!(!commits_here(Path::new("")));
    }

    #[test]
    fn a_verdict_in_the_operators_own_checkout_holds_nothing_back() {
        // The line `commit_attempt` draws, seen from this side. A task the playbook
        // gave no worktree is judged where the operator is standing, and wecode commits
        // nothing there — so there is nothing to hold back, and a note left in their
        // repository would be one nothing ever reads.
        let dir = worktree("no-worktree");
        write(&dir, "src/a.rs", "fn a() {}\n");
        write(&dir, "Cargo.toml", "[package]\n");

        let c = changed(&dir, &TaskId::new("t1")).unwrap();
        assert_eq!(violations(&c, &scope(&["src/**"])), ["Cargo.toml"]);

        let sha = git::commit_all(&dir, "t1: attempt 1").unwrap().unwrap();
        let (files, _) = git::commit_summary(&dir, &sha, 0).unwrap();
        assert_eq!(files, ["Cargo.toml", "src/a.rs"], "nothing was withheld");
    }

    #[test]
    fn a_change_inside_the_declared_scope_is_clean() {
        let v = violations(
            &touched(&["crates/wecode-cli/src/main.rs"]),
            &scope(&["crates/wecode-cli/src/**"]),
        );
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn a_change_outside_the_declared_scope_is_named() {
        // The exact case this module exists for: a task scoped to the cli crate that
        // quietly edited core.
        let v = violations(
            &touched(&[
                "crates/wecode-cli/src/render.rs",
                "crates/wecode-core/src/plan.rs",
            ]),
            &scope(&["crates/wecode-cli/**"]),
        );
        assert_eq!(v, vec!["crates/wecode-core/src/plan.rs".to_string()]);
    }

    #[test]
    fn an_empty_scope_permits_nothing_rather_than_everything() {
        // A spike declares no write scope. One that edited files did something it
        // never said it would, so the fail-closed reading is the correct one.
        let v = violations(&touched(&["src/a.rs"]), &Scope::default());
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn the_workers_own_result_file_is_not_a_violation() {
        // The envelope tells the agent to write .wecode/run/result.json. Counting that
        // against it would fail every task for following instructions.
        let v = violations(
            &touched(&[".wecode/run/result.json", "src/a.rs"]),
            &scope(&["src/**"]),
        );
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn the_playbook_itself_is_still_guarded() {
        // Only the run directory is exempt. A task quietly rewriting the guidance it
        // was given is exactly what the split of .wecode/ exists to prevent.
        let v = violations(&touched(&[".wecode/playbook.toml"]), &scope(&["src/**"]));
        assert_eq!(v, vec![".wecode/playbook.toml".to_string()]);
    }

    #[test]
    fn touching_nothing_is_always_in_scope() {
        assert!(violations(&touched(&[]), &Scope::default()).is_empty());
    }

    #[test]
    fn a_passing_command_is_recorded_with_its_code() {
        let dir = std::env::temp_dir();
        let v = ran(
            &dir,
            &[Measure::Command {
                cmd: "true".into(),
                expect_status: 0,
            }],
        );
        assert!(v.passed());
        assert_eq!(v.checks[0].status, Some(0));
        assert_eq!(v.checks[0].describe(), "exit 0");
    }

    #[test]
    fn a_failing_command_fails_the_verdict_and_says_what_it_wanted() {
        let dir = std::env::temp_dir();
        let v = ran(
            &dir,
            &[
                Measure::Command {
                    cmd: "true".into(),
                    expect_status: 0,
                },
                Measure::Command {
                    cmd: "exit 3".into(),
                    expect_status: 0,
                },
            ],
        );
        assert!(!v.passed());
        assert!(
            v.checks[1].describe().contains("wanted 0"),
            "{:?}",
            v.checks[1]
        );
    }

    #[test]
    fn a_command_runs_in_the_directory_it_is_given() {
        // Acceptance must judge the worktree, not wherever wecode happens to be.
        let dir = std::env::temp_dir().join("wecode-verify-cwd");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker"), "x").unwrap();

        let v = ran(
            &dir,
            &[Measure::Command {
                cmd: "test -f marker".into(),
                expect_status: 0,
            }],
        );
        assert!(v.passed(), "{:?}", v.checks);
    }

    #[test]
    fn the_shared_build_cache_is_set_on_the_acceptance_commands_too() {
        // Acceptance is the second cold build a worktree pays for, and usually the
        // larger one: the agent may have run `cargo check`, this runs the suite.
        let v = run_tier(
            &std::env::temp_dir(),
            &[cmd("test \"$CARGO_TARGET_DIR\" = /tmp/shared-target")],
            &[(
                "CARGO_TARGET_DIR".to_string(),
                std::path::PathBuf::from("/tmp/shared-target"),
            )],
            Tier::Offline,
        );
        assert!(v.passed(), "{:?}", v.checks);
    }

    #[test]
    fn acceptance_still_inherits_the_environment_it_needs_to_run_at_all() {
        // Unlike a spawned agent's, this environment is not built from an allowlist:
        // the commands are the operator's own, and one without `PATH` could not find
        // the toolchain it is supposed to be judging with.
        let v = run_tier(
            &std::env::temp_dir(),
            &[cmd("test -n \"$PATH\"")],
            &[(
                "CARGO_TARGET_DIR".to_string(),
                std::path::PathBuf::from("/tmp/shared-target"),
            )],
            Tier::Offline,
        );
        assert!(v.passed(), "{:?}", v.checks);
    }

    #[test]
    fn a_measure_no_command_can_settle_blocks_the_verdict() {
        let dir = std::env::temp_dir();
        let v = ran(
            &dir,
            &[Measure::Metric {
                name: "p99".into(),
                target: 500.0,
                cmp: Cmp::Lt,
            }],
        );
        assert!(!v.passed(), "an unjudgeable measure is not a pass");
        assert_eq!(v.unjudgeable.len(), 1);
    }

    #[test]
    fn a_missing_command_is_reported_as_missing_not_as_a_failure() {
        // 127 from `sh` means the toolchain is absent, not that the work is wrong.
        let v = ran(
            &std::env::temp_dir(),
            &[Measure::Command {
                cmd: "definitely-not-a-real-binary-xyz".into(),
                expect_status: 0,
            }],
        );
        assert!(!v.passed());
        assert_eq!(v.unrunnable().len(), 1);
        assert!(
            v.checks[0].describe().contains("not found"),
            "{:?}",
            v.checks[0]
        );
    }

    #[test]
    fn a_check_that_wants_127_is_not_mistaken_for_a_missing_command() {
        let v = ran(
            &std::env::temp_dir(),
            &[Measure::Command {
                cmd: "exit 127".into(),
                expect_status: 127,
            }],
        );
        assert!(v.passed());
        assert!(v.unrunnable().is_empty());
    }

    // ------------------------------------------------- what it actually did ------

    #[test]
    fn a_run_that_changed_nothing_does_not_pass_on_its_acceptance_alone() {
        // The whole point. Acceptance is the repository's own suite, so it was green
        // before the agent started and is green after one that did nothing — an agent
        // that ran out of budget, or gave up, or reported a success it never earned,
        // came back with a clean board and an empty diff and was sent to the signature
        // queue as delivered work.
        let v = judged(&[cmd("true")], touched(&[]), &scope(&["src/**"]));

        assert!(v.checks.iter().all(Check::passed), "{:?}", v.checks);
        assert!(v.violations.is_empty(), "nothing was written anywhere");
        assert!(!v.passed(), "an empty diff is not a delivery");
    }

    #[test]
    fn an_agent_that_touched_a_real_worktree_and_left_it_alone_is_caught_the_same_way() {
        // The same finding read off git rather than off a fabricated diff, and in the
        // order the `verify` command assembles it: acceptance first, then the diff,
        // then the scope. The acceptance here is one that genuinely passes on an
        // untouched tree — `test -f README.md` — because that is the shape of the real
        // failure. A repository's own suite is green before its agents start.
        let dir = worktree("did-nothing");
        let mut v = ran(&dir, &[cmd("test -f README.md")]);
        v.changed = changed(&dir, &TaskId::new("t1")).unwrap();
        v.violations = violations(&v.changed, &scope(&["src/**"]));

        assert!(v.checks[0].passed(), "{:?}", v.checks);
        assert!(v.changed.is_empty(), "{:?}", v.changed);
        assert!(
            !v.passed(),
            "green checks over an untouched tree are not a delivery"
        );
    }

    #[test]
    fn the_same_task_passes_once_it_has_actually_changed_something() {
        // The other half, or the check above would be satisfied by never passing.
        let v = judged(&[cmd("true")], touched(&["src/a.rs"]), &scope(&["src/**"]));
        assert!(v.passed(), "{v:?}");
    }

    #[test]
    fn a_spike_that_declared_no_writes_is_not_failed_for_changing_nothing() {
        // A spike is time-boxed investigation: it is the one kind admitted without a
        // write scope, because what it owes is an answer rather than a diff. Reading
        // every empty diff as a failure would make it the one kind that can never pass
        // — any change is already a violation, so both outcomes would be red.
        let v = judged(&[cmd("true")], touched(&[]), &Scope::default());
        assert!(v.passed(), "{v:?}");
    }

    #[test]
    fn work_the_scope_refused_still_counts_as_having_been_done() {
        // Two findings, not one: the task changed something and it changed the wrong
        // thing. Folding them together would report a scope violation as an idle run.
        let v = judged(
            &[cmd("true")],
            touched(&["Cargo.toml"]),
            &scope(&["src/**"]),
        );
        assert!(!v.passed());
        assert!(!v.changed.delivered_nothing(), "it did write something");
        assert_eq!(v.violations, ["Cargo.toml"]);
    }

    #[test]
    fn a_diff_no_scope_was_read_against_makes_no_claim_about_what_was_owed() {
        // `owed` is recorded by the scope check, so until that has run nothing knows a
        // change was expected. Such a verdict has already skipped the scope half — the
        // honest answer is silence here rather than a second finding invented out of a
        // question nobody asked.
        assert!(!touched(&[]).delivered_nothing());
    }

    #[test]
    fn the_verdict_says_which_way_the_green_checks_point() {
        // A passing check beside an empty diff is the reading this exists to correct,
        // and the operator sees the render before they see the status word.
        let task = Task::new("t1", "caching", "trim the cache").scoped(scope(&["src/**"]));
        let v = judged(&[cmd("true")], touched(&[]), &task.scope);
        let out = verdict(
            &task,
            &task.id,
            Path::new("/tmp/t1"),
            &v,
            TaskStatus::Failed,
        );

        assert!(out.contains("nothing changed"), "{out}");
        assert!(out.contains("produced no diff"), "{out}");
        assert!(!out.contains("✓ passed"), "{out}");
        // Not this: there were checks and they ran. Saying both would send the reader
        // looking for a missing acceptance command that is right there above it.
        assert!(!out.contains("nothing to judge by"), "{out}");
    }

    // --------------------------------------------- work that belongs to steps ------

    #[test]
    fn a_parent_is_not_failed_for_work_that_belongs_to_its_steps() {
        // The shape the playbook asks for, failed at the last moment for having it. A
        // main task with steps owns the worktree and the branch; the steps commit their
        // work there and each is judged as it finishes. The parent then writes nothing
        // of its own — correctly, there is nothing left of its work to do — and the
        // empty-diff rule read that as an agent that gave up. It failed after every
        // step had passed, on the one task that can land them.
        let dir = owned_worktree("parent-steps", "t");
        attempt(&dir, "t-one", 1, &[("src/one.rs", "fn one() {}\n")]);
        attempt(&dir, "t-two", 1, &[("src/two.rs", "fn two() {}\n")]);
        // The reset before the parent's own run, which is what leaves its diff empty.
        retry(&dir);

        let mut v = ran(&dir, &[cmd("test -f README.md")]);
        v.changed = changed(&dir, &TaskId::new("t")).unwrap();
        v.violations = violations(&v.changed, &scope(&["src/**"]));

        assert!(v.changed.is_empty(), "none of it is the parent's: {v:?}");
        assert_eq!(v.changed.delegated(), ["src/one.rs", "src/two.rs"]);
        assert!(!v.changed.delivered_nothing(), "{v:?}");
        assert!(v.passed(), "{v:?}");
    }

    #[test]
    fn a_step_writing_where_its_parent_may_not_is_not_the_parents_violation() {
        // Why the steps' work is held apart from the diff rather than folded into it. A
        // step declares its own scope — a design step writes `docs/**` beneath a parent
        // scoped to `src/**`, which is the template doing exactly what it says — so
        // counting those paths as the parent's would fail it for its children's licence
        // and record refused writes against a task that made none.
        let dir = owned_worktree("step-scope", "t");
        attempt(&dir, "t-design", 1, &[("docs/design/t.md", "the decision\n")]);
        retry(&dir);

        let c = changed(&dir, &TaskId::new("t")).unwrap();
        assert!(violations(&c, &scope(&["src/**"])).is_empty(), "{c:?}");
        assert!(!c.delivered_nothing(), "{c:?}");
    }

    #[test]
    fn a_parent_whose_steps_have_not_written_anything_yet_still_fails() {
        // The other half: nothing beneath it either. An empty branch is the failure the
        // rule exists for whatever the task's shape is, and a parent is not exempt by
        // being one — it is excused by work standing on its branch, and there is none.
        let dir = owned_worktree("parent-empty", "t");
        let c = changed(&dir, &TaskId::new("t")).unwrap();
        violations(&c, &scope(&["src/**"]));
        assert!(c.delegated().is_empty(), "{c:?}");
        assert!(c.delivered_nothing(), "{c:?}");
    }

    #[test]
    fn work_the_branch_was_cut_from_is_not_a_parents_steps() {
        // The case that decides how a step is recognised. A branch cut from a
        // predecessor's — or from an integration branch carrying merges — brings that
        // work's attempts into this log looking exactly like a step's. What separates
        // them is that a task which owned a tree leaves a `wecode/<id>` behind it and a
        // subtask never had one, so the base cannot excuse a task that did nothing.
        let dir = owned_worktree("base-attempts", "t");
        attempt(&dir, "pred", 1, &[("src/p.rs", "fn p() {}\n")]);
        branch_of(&dir, "pred");
        retry(&dir);

        let c = changed(&dir, &TaskId::new("t")).unwrap();
        assert!(c.is_empty(), "{c:?}");
        assert!(c.delegated().is_empty(), "the predecessor's, not a step's");
        violations(&c, &scope(&["src/**"]));
        assert!(c.delivered_nothing(), "{c:?}");
    }

    #[test]
    fn a_step_is_not_excused_by_what_its_siblings_delivered() {
        // Only the task the tree is named after is answered for by the attempts around
        // it. A step's neighbours in the log are its siblings, already judged on their
        // own scopes, and a task that owes a diff is not relieved of it by standing
        // next to one.
        let dir = owned_worktree("sibling-empty", "t");
        attempt(&dir, "t-one", 1, &[("src/one.rs", "fn one() {}\n")]);
        retry(&dir);

        let c = changed(&dir, &TaskId::new("t-two")).unwrap();
        assert!(c.delegated().is_empty(), "{c:?}");
        violations(&c, &scope(&["src/**"]));
        assert!(c.delivered_nothing(), "{c:?}");
    }

    #[test]
    fn the_verdict_names_the_work_its_steps_left_on_the_branch() {
        // The reader reaches the diff before the verdict, and "0 files / nothing
        // changed" over a passing parent is the sentence they would have to reconcile
        // on their own. What the branch carries is said where the missing diff would
        // have been read.
        let dir = owned_worktree("parent-render", "t");
        attempt(&dir, "t-one", 1, &[("src/one.rs", "fn one() {}\n")]);
        retry(&dir);

        let task = Task::new("t", "caching", "the cache layer").scoped(scope(&["src/**"]));
        let mut v = ran(&dir, &[cmd("true")]);
        v.changed = changed(&dir, &TaskId::new("t")).unwrap();
        v.violations = violations(&v.changed, &task.scope);
        let out = verdict(&task, &task.id, &dir, &v, TaskStatus::NeedsApproval);

        assert!(out.contains("its steps did the writing"), "{out}");
        assert!(out.contains("· src/one.rs"), "{out}");
        assert!(!out.contains("nothing changed"), "{out}");
        assert!(out.contains("✓ passed"), "{out}");
    }

    #[test]
    fn a_task_with_no_acceptance_never_passes() {
        // Vacuously-true verification is worse than none: it would mark work done on
        // the strength of having asked nothing.
        let v = ran(&std::env::temp_dir(), &[]);
        assert!(!v.passed());
    }

    // ------------------------------------------------------- the second tier ------

    /// A live measure, written the way a project writes one.
    fn live(line: &str) -> Measure {
        Measure::Command {
            cmd: format!("live: {line}"),
            expect_status: 0,
        }
    }

    /// An empty directory to run acceptance in. Side effects are how these tests tell
    /// *did not run* from *ran and passed*: a command never started leaves no file
    /// behind, where asserting on the verdict alone would pass just as well against a
    /// tier that quietly ran everything and reported half of it.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wecode-tier-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_live_check_is_not_started_at_all_unless_it_was_asked_for() {
        // The whole point of the tier, and the only assertion that can carry it: not
        // that the check was reported as skipped, but that nothing ran. A live check
        // reaches real infrastructure with the credentials of whoever is judging, and
        // every unattended verdict — a board tick's, a retry's — is one nobody asked.
        let dir = scratch("not-asked");
        let v = ran(&dir, &[cmd("true"), live("touch it-ran")]);

        assert!(!dir.join("it-ran").exists(), "the live check was started");
        assert_eq!(v.checks.len(), 1, "{:?}", v.checks);
        assert_eq!(v.deferred, ["touch it-ran"]);
    }

    #[test]
    fn asking_for_it_runs_it() {
        // The other half, or the tier would be a way of writing acceptance that never
        // runs — which is indistinguishable from not writing it.
        let dir = scratch("asked");
        let v = ran_live(&dir, &[cmd("true"), live("touch it-ran")]);

        assert!(dir.join("it-ran").exists(), "{:?}", v.checks);
        assert!(v.deferred.is_empty(), "{:?}", v.deferred);
        assert_eq!(v.checks.len(), 2);
        assert!(v.checks[1].live);
    }

    #[test]
    fn the_marker_is_never_part_of_what_the_shell_is_given() {
        // `sh -c "live: test -f marker"` is a command not found, so this passing is the
        // proof that the marker was taken off first — and `cmd` holds the line that
        // actually ran, which is what the ledger records and what a failure quotes.
        let dir = scratch("stripped");
        std::fs::write(dir.join("marker"), "x").unwrap();
        let v = ran_live(&dir, &[live("test -f marker")]);

        assert!(v.passed(), "{:?}", v.checks);
        assert_eq!(v.checks[0].cmd, "test -f marker");
    }

    #[test]
    fn the_marker_is_read_however_it_was_spelled() {
        // Leniency in the direction that is cheap to be wrong in: a marker that failed
        // to match leaves the check in the first tier, where it runs on every verdict,
        // against the real thing. `Live:` is a typo; running it is not a consequence
        // anyone signed up for.
        let dir = scratch("spelling");
        let v = ran(
            &dir,
            &[
                Measure::Command {
                    cmd: "LIVE: touch upper".into(),
                    expect_status: 0,
                },
                Measure::Command {
                    cmd: "  live:   touch spaced".into(),
                    expect_status: 0,
                },
            ],
        );

        assert!(!dir.join("upper").exists() && !dir.join("spaced").exists());
        assert_eq!(v.deferred, ["touch upper", "touch spaced"]);
    }

    #[test]
    fn a_marker_with_nothing_behind_it_is_not_a_marker() {
        // `live:` alone would otherwise be a check that runs the empty string, which
        // exits 0 — a pass earned by asking nothing, in the one module that exists to
        // refuse those. Handed to `sh` unchanged it comes back as 127, visibly broken
        // where the operator wrote it.
        assert_eq!(tier_of("live:"), (false, "live:"));
        assert_eq!(tier_of("live:   "), (false, "live:   "));

        let v = ran(
            &std::env::temp_dir(),
            &[Measure::Command {
                cmd: "live:".into(),
                expect_status: 0,
            }],
        );
        assert!(!v.passed());
        assert!(v.deferred.is_empty(), "not deferred — it is malformed");
        assert_eq!(v.unrunnable().len(), 1);
    }

    #[test]
    fn only_an_affirmative_value_asks_for_the_tier() {
        // A variable exported to turn the tier off is the more deliberate of the two
        // things a person can write, and reading the mere presence of the name as
        // consent would do the opposite of what they wrote.
        assert_eq!(Tier::asked_by(None), Tier::Offline);
        for off in ["", "  ", "0", "false", "FALSE", "no", "off"] {
            assert_eq!(Tier::asked_by(Some(off)), Tier::Offline, "{off:?}");
        }
        for on in ["1", "yes", "true", "please"] {
            assert_eq!(Tier::asked_by(Some(on)), Tier::Live, "{on:?}");
        }
    }

    #[test]
    fn a_deferred_check_is_not_counted_against_the_work() {
        // The reading that fails closed is unusable: a task carrying a live check would
        // then pass only where the credentials for it are. Acceptance that can only
        // fail is acceptance nobody writes.
        let dir = scratch("not-against");
        let mut v = ran(&dir, &[cmd("true"), live("aws s3 ls s3://nope")]);
        v.changed = touched(&["src/a.rs"]);
        v.violations = violations(&v.changed, &scope(&["src/**"]));

        assert_eq!(v.deferred.len(), 1);
        assert!(v.passed(), "{v:?}");
    }

    #[test]
    fn a_live_check_that_ran_and_failed_fails_like_any_other() {
        // Once it has been asked, it is a check. The tier decides whether the question
        // is put, never what the answer counts for.
        let v = ran_live(&scratch("live-red"), &[cmd("true"), live("exit 3")]);
        assert!(!v.passed());
        assert!(v.checks[1].describe().contains("wanted 0"), "{:?}", v.checks);
    }

    #[test]
    fn a_task_whose_every_check_is_live_does_not_pass_by_default() {
        // And is not told it has no acceptance. The two have the same empty check list
        // and are not the same failure: one was never given anything to be held to, the
        // other was and nobody asked it.
        let task = Task::new("t1", "cloud", "the bucket").scoped(scope(&["src/**"]));
        let dir = scratch("all-live");
        let mut v = ran(&dir, &[live("aws s3api head-bucket --bucket b")]);
        v.changed = touched(&["src/a.rs"]);
        v.violations = violations(&v.changed, &task.scope);
        let out = verdict(&task, &task.id, &dir, &v, TaskStatus::Failed);

        assert!(!v.passed(), "{v:?}");
        assert!(out.contains("every check this task has is live"), "{out}");
    }

    #[test]
    fn the_verdict_says_which_tier_the_tick_was_earned_against() {
        // `✓ passed` has meant one thing for as long as there was one tier, and now
        // means *passed what was asked*. Which was asked is a property of the
        // invocation rather than of the task, so the reader cannot recover it from
        // anything else on the page.
        let task = Task::new("t1", "cloud", "the bucket").scoped(scope(&["src/**"]));
        let dir = scratch("render-deferred");
        let mut v = ran(&dir, &[cmd("true"), live("bash scripts/smoke-cloud.sh")]);
        v.changed = touched(&["src/a.rs"]);
        v.violations = violations(&v.changed, &task.scope);
        let out = verdict(&task, &task.id, &dir, &v, TaskStatus::NeedsApproval);

        assert!(out.contains("✓ passed"), "{out}");
        assert!(out.contains("the offline tier only"), "{out}");
        assert!(out.contains("live — 1 check not run"), "{out}");
        assert!(out.contains("· bash scripts/smoke-cloud.sh"), "{out}");
        // The way back to the answer, in the invocation that would get it.
        assert!(out.contains("WECODE_LIVE=1 wecode verify t1"), "{out}");
    }

    #[test]
    fn a_check_that_reached_the_real_thing_is_marked_as_one() {
        // Two green lines are worth different amounts, and only one of them is
        // reproducible by whoever reads the verdict next.
        let task = Task::new("t1", "cloud", "the bucket").scoped(scope(&["src/**"]));
        let dir = scratch("render-live");
        let mut v = ran_live(&dir, &[cmd("true"), live("true")]);
        v.changed = touched(&["src/a.rs"]);
        v.violations = violations(&v.changed, &task.scope);
        let out = verdict(&task, &task.id, &dir, &v, TaskStatus::NeedsApproval);

        assert_eq!(out.matches("   live").count(), 1, "{out}");
        assert!(!out.contains("the offline tier only"), "{out}");
        assert!(!out.contains("not run"), "{out}");
    }
}
