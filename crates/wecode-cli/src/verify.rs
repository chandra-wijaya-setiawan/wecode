//! Judging finished work from what it actually did.
//!
//! Three questions, all answered without asking the agent:
//!
//! - **Did it stay in scope?** From the branch's own diff, not from a self-report — and
//!   from all of it, including the attempts already committed on it.
//! - **Did it do anything?** A task that declared a write scope and left no diff did not
//!   do its work. Acceptance cannot catch this and never could: the commands a task is
//!   held to are the repository's own, and they passed on the tree before it started, so
//!   a run that changed nothing came back green — see [`Changed::delivered_nothing`].
//! - **Did the documentation move with it?** A page declaring a `subject:` that stayed out
//!   of a diff touching one is refused beside a scope violation — [`wecode_core::docs`].
//! - **Does it pass?** By running the acceptance commands here, not by being told.
//!
//! That ordering is the design's own rule — the diff always wins. An agent's
//! `result.json` is useful for a summary and inadmissible as evidence, so nothing in
//! this module reads it.
//!
//! The first two are asked of work wecode dispatched and of nothing else. Where a person
//! did the work there is no worktree, no scope and no diff that is the task's own — see
//! [`Verdict::changed`] — and a verdict on one reports its acceptance alone.
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
//! credential is in this process and was never in that one.
//!
//! Post-hoc rather than intercepted, because wecode cannot hook another process's
//! writes. Confinement is the worktree; this is the check afterwards, which is why a
//! write outside scope is *sanctioned* — recoverable — rather than prevented, and
//! [`violations`] is where the recovering happens.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::process::Command;

use wecode_core::{Measure, Scope, Task, TaskId, TaskStatus, Tier, docs, tier_of};
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

/// The variable that asks for the live tier, and the value `1` asks with. [`Tier`] and
/// [`tier_of`] are in core, where the [`Measure::Command`] they read is defined.
const LIVE_ENV: &str = "WECODE_LIVE";

/// What a task's work touched, and the tree it touched it in.
///
/// The tree travels with the paths because the next question asked of them — which of
/// them the scope refuses — is also the last moment anything holds both halves at once.
/// A refusal that cannot name the tree it happened in can be recorded and nothing more;
/// one that can is a refusal the commit afterwards is able to honour.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub(crate) struct Changed {
    dir: PathBuf,
    paths: Vec<String>,
    /// What this task's steps delivered on the branch it owns.
    ///
    /// Kept apart from `paths` rather than folded into it, because these are not this
    /// task's writes to answer for in either direction. Not against its scope: a step
    /// declares its own, and charging a design step's `docs/**` to a parent scoped to
    /// `crates/**` would fail it for its children's licence. And not as its delivery
    /// either, which is why the render counts the two lists separately. What they settle
    /// is the one question an empty diff cannot: whether the work this task was owed is
    /// on the branch. It is, under their names.
    delegated: Vec<String>,
    /// Whether the scope this diff was judged against asked for any writes at all.
    ///
    /// Recorded by [`violations`], because that call is the only moment both halves are
    /// in one hand — the same reason `dir` travels here. A diff on its own cannot say
    /// whether being empty is a failure: for a spike, the one kind admitted without a
    /// write scope, an empty diff is the declared outcome. `false` until the scope has
    /// been consulted, so a verdict that skipped the scope half invents no finding out
    /// of the half that did run.
    owed: Cell<bool>,
    /// Documents this diff touched the subject of and left where they were. Read beside
    /// the diff rather than beside [`violations`] because the join needs both halves at
    /// once: the paths to match, and the tree holding the pages that declared them.
    stale: Vec<docs::Stale>,
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
    /// A main task with steps is that second case, and it is not a loophole but what
    /// decomposition *is*: its subtasks commit on the branch it owns, each judged against
    /// the scope it declared. Failing the parent for writing nothing of its own would
    /// fail it for the shape the playbook asked for, after every step had passed.
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
    /// What the work touched — or `None`, which is nobody having looked.
    ///
    /// Not `Changed::default()`: an empty path list is exactly what *we read the diff
    /// and the work is missing* looks like, and that reading is the sharpest finding
    /// this module has. wecode judges the diff of work it dispatched and of nothing
    /// else, so a verdict on a person's task never opens git — and must not be able to
    /// answer `len()`, `is_empty()` or `delivered_nothing()` about a question nobody put.
    pub(crate) changed: Option<Changed>,
    /// Changed paths the task's write scope does not cover.
    pub(crate) violations: Vec<String>,
    pub(crate) checks: Vec<Check>,
    /// Acceptance measures that no command can settle. Legal on a task the gate does
    /// not hold to executable acceptance, and never a pass: something *was* asked and
    /// nothing here can answer it.
    pub(crate) unjudgeable: Vec<String>,
    /// Live checks this verdict did not run, as they would have been run.
    ///
    /// Kept rather than dropped, which is the whole of why the tier is a list and not an
    /// `if`. A check nobody asked for neither failed nor passed, and leaving it out
    /// silently would make the offline tier look like all the task was held to.
    pub(crate) deferred: Vec<String>,
}

impl Verdict {
    /// Checks that could not run at all. An environment problem, reported apart from the
    /// verdict so a missing toolchain never reads as failing work.
    pub(crate) fn unrunnable(&self) -> Vec<&Check> {
        self.checks.iter().filter(|c| c.missing()).collect()
    }

    /// Documents this verdict's diff left behind — see [`wecode_core::docs`].
    ///
    /// A finding beside [`Verdict::violations`] and unlike one in what follows it: a bad
    /// write stands in the tree to be held back, so it earns a [`git::refuse`] note; an
    /// absence has nothing to sanction. It is recorded, and that is all a record needs.
    pub(crate) fn stale(&self) -> &[docs::Stale] {
        self.changed.as_ref().map_or(&[], |c| &c.stale[..])
    }

    /// Everything that had to hold, including the one an agent can satisfy by doing
    /// nothing at all.
    ///
    /// A task that declared a write scope and produced no diff fails here whatever its
    /// acceptance says, and green acceptance beside an empty diff is exactly what a run
    /// that did nothing looks like — the quietest way for work to be marked delivered,
    /// and `passed` is what sends a branch to `needs-approval` and from there to a merge.
    ///
    /// A deferred live check is not counted against the work, because nothing asked it.
    /// The alternative reads well and is unusable: a task carrying one could then pass
    /// only where the credentials for it are. A pass here is therefore *passed what was
    /// asked*, and since that changes with the invocation, [`verdict`] says which was
    /// asked. Passing nothing is not among them: an empty check list is not a pass for
    /// anyone, and what follows on a task nobody dispatched is [`Outcome`]'s.
    pub(crate) fn passed(&self) -> bool {
        self.violations.is_empty()
            && self.stale().is_empty()
            && self.unjudgeable.is_empty()
            && !self.changed.as_ref().is_some_and(Changed::delivered_nothing)
            && !self.checks.is_empty()
            && self.checks.iter().all(Check::passed)
    }

    /// What this verdict concluded about `task` — see [`Outcome`].
    pub(crate) fn outcome(&self, task: &Task) -> Outcome {
        let asked = !(self.checks.is_empty()
            && self.deferred.is_empty()
            && self.unjudgeable.is_empty());
        if self.passed() {
            Outcome::Passed
        } else if asked || task.is_dispatched() {
            Outcome::Failed
        } else {
            Outcome::NothingAsked
        }
    }
}

/// What a verdict concluded, in three outcomes rather than two.
///
/// A pass and a failure do not cover a verdict with no content in it. A task wecode
/// did not dispatch is admitted with no acceptance and has no diff of its own, so
/// nothing was asked and nothing answered. The same emptiness on a dispatched task is
/// a fault: an agent ran, and if nothing can say whether it worked, that is a finding.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Outcome {
    /// Something was asked and all of it passed.
    Passed,
    /// Something was asked and some of it did not pass.
    Failed,
    /// No check, no deferred check, no unjudgeable measure — and no diff wecode may
    /// judge. Only a signature can report this one done.
    NothingAsked,
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
/// changed nothing, with the out-of-scope file still standing on the branch. The retry
/// did not overturn the finding; it stopped looking. Acceptance never had this problem:
/// it runs against the worktree, which carries the committed work either way.
///
/// Attempts are picked out by subject rather than taken wholesale. A subtask shares its
/// parent's branch and its siblings' attempts are in the same log, each already judged
/// against its own scope; and the base carries the predecessor work this task was cut
/// from, which is not this task's to answer for.
///
/// The steps of a task that owns the tree are read too, into a second list — see
/// [`Changed::delegated`] and [`a_step_here`]. Never joined to this task's diff; it only
/// answers whether a parent's empty diff means the work is missing or means it is theirs.
///
/// The window is [`git::attempts_on`]'s — the newest twenty commits wecode made here —
/// the same history `wecode show` and the handoff already read, so widening it belongs
/// there rather than in one caller's copy of the question.
///
/// This is the reading, never the decision to read: **wecode judges the diff of work it
/// dispatched, and of nothing else**, and whether that holds is the caller's to ask —
/// which is why what comes back fills [`Verdict::changed`] whole. A verdict that never
/// called this keeps the `None` it was born with, and no path here returns one.
pub(crate) fn changed(dir: &Path, id: &TaskId) -> Result<Option<Changed>, git::GitError> {
    let mut all = git::changed_files(dir)?;
    let mut delegated = Vec::new();
    let mine = format!("{id}: attempt");
    let owns = owns_the_tree(dir, id);
    let mut frozen = None;
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
            // Newest first, so the first of its own is where this run's diff stops.
            frozen.get_or_insert(sha);
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
    // This task's diff only: a step was judged against its own scope, page included, and
    // charging a parent for its children's coupling is the same error as `delegated`.
    // Both halves at one revision — the run's own last attempt, or the tree it is still
    // standing in when it has not committed one yet.
    let stale = docs::stale(
        &governing(dir, frozen.as_deref().unwrap_or("HEAD")),
        &all,
        &glob::any_matches,
    );
    Ok(Some(Changed {
        dir: dir.to_path_buf(),
        paths: all,
        delegated,
        owed: Cell::new(false),
        stale,
    }))
}

/// Every document that might govern something, as the run's diff left it — read at `at`
/// rather than off the disk, which is the whole of this function's job.
///
/// The changed half of the join is frozen: [`changed`] rebuilds it out of the run's own
/// attempt commits, so it says the same thing an hour later or a week later. A document
/// half read live off the branch does not. A `subject:` widened after the run refuses it
/// for coupling it never created — the one thing the diff form was chosen to make
/// impossible — and one narrowed after it quietly excuses one. Both halves come from a
/// single revision, or the verdict is a fact about when somebody asked.
///
/// A page the run itself wrote needs no special case: it is in the diff, and a document
/// in the diff is exempt whatever it declares.
///
/// The reading is here because core opens none — it parses text and joins two path lists,
/// and a document is this repository's file. Through `git` directly rather than
/// [`crate::git`]: a blob at a revision is this one call's need, and the tree it wants is
/// not the tree on disk that every other reader there means.
fn governing(dir: &Path, at: &str) -> Vec<docs::Doc> {
    let read = |args: &[&str]| {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
        (out.status.success()).then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    };
    read(&["ls-tree", "-r", "--name-only", at])
        .unwrap_or_default()
        .lines()
        .filter(|p| p.ends_with(".md"))
        .filter_map(|p| Some(docs::parse(p, &read(&["show", &format!("{at}:{p}")])?)))
        .collect()
}

/// Whether the tree this verdict is standing in is the one this task owns.
///
/// A main task's worktree is named after it — [`crate::work::worktree_for`] — and its
/// subtasks share it rather than opening a second checkout. So the directory name
/// answers, from inside a verdict, the question the plan would otherwise have to be
/// opened for: *am I the top of this tree, or one of the steps in it?* Only the top is
/// answered for by the attempts around it; a sibling's work excuses nothing.
///
/// It follows that a step which is itself a parent is still judged on its own diff: from
/// in here its children and its siblings are the same shape, and the relation telling
/// them apart is in the plan rather than in the tree.
fn owns_the_tree(dir: &Path, id: &TaskId) -> bool {
    dir.file_name().and_then(|n| n.to_str()) == Some(id.as_str())
}

/// Whether this attempt belongs to a task working *inside* this tree rather than to one
/// the tree was cut from.
///
/// A subtask has no branch of its own — that is the rule `merge` is built on — so a
/// wecode attempt with no `wecode/<id>` standing behind it was committed here, by a step
/// sharing this worktree. Asked of the branch and not of the id, because a step is named
/// by whoever created it and a naming convention is not a relation.
///
/// The branch is also what keeps the base out, which is the half that has to be right. A
/// branch cut from a predecessor's brings that work's attempts into this log with exactly
/// the shape of a step's — and every task that owned a tree has a `wecode/<id>` outliving
/// it, saying the commits came from behind this task rather than below it.
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
/// The mirror of that reading is recorded here rather than returned: a scope that *does*
/// name paths is a task claiming it will change something, and a diff judged against one
/// is owed a change. Not a violation — nothing was written where it was forbidden — so it
/// does not belong in this list, which is the governance channel. It belongs on the diff,
/// where [`Verdict::passed`] reads it, and this is the one call that can put it there.
///
/// Naming a refused write and stopping it from landing are one act, which is why they
/// are one function. Sanctioned means *recoverable*, and until now nothing recovered:
/// wecode commits every attempt, pass or fail, so the file the verdict had just refused
/// went onto the branch in the same breath, and a later attempt can pass while it sits
/// behind `HEAD` in a commit nobody re-reads. [`git::refuse`] is the note that settles
/// it, left for the commit that follows this verdict; the writes stay in the tree, where
/// the retry's reset is what clears them.
///
/// Only in a worktree wecode made — the same line `commit_attempt` draws. A task judged
/// in the operator's own checkout has nothing held back, because wecode commits nothing
/// there, and a note that cannot be written changes nothing about the verdict. The
/// refusal is already in the ledger, which is the half that must not be lost.
pub(crate) fn violations(changed: &Option<Changed>, scope: &Scope) -> Vec<String> {
    // A diff nobody read is a scope question nobody put, and the `Option` is what makes
    // that unarguable: there is no path list to charge against a scope, so no refusal
    // reaches the ledger and no note is left in a tree. The empty list this returns is
    // a silence rather than a clean report, and [`verdict`] is where it is said aloud.
    let Some(changed) = changed else {
        return Vec::new();
    };
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
/// second cold build a worktree pays for and usually the larger one, so setting it on
/// the agent alone would have shared half a cache.
///
/// Unlike a spawned agent's, this environment is inherited: these commands are the
/// operator's own and need the toolchain the operator has. The declared variables are
/// laid over it, so a project's answer beats whatever the shell was carrying. The tier
/// is whatever this invocation asked for — [`LIVE_ENV`].
pub(crate) fn run_acceptance(
    dir: &Path,
    measures: &[Measure],
    env: &[(String, std::path::PathBuf)],
) -> Verdict {
    let asked = Tier::asked_by(std::env::var(LIVE_ENV).ok().as_deref());
    run_tier(dir, measures, env, asked)
}

/// The same, with the tier named by the caller rather than read off the environment.
///
/// Split out because a tier read from the ambient environment is one a test cannot set:
/// `set_var` is unsafe, this workspace forbids unsafe outright, and a variable one test
/// exports is one every other test in the process runs under. The decision lives one
/// function up, where a `--live` flag would set it too.
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

/// The plural `s`, for the counts this render prints five of.
fn s(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// What verification observed, and what it concluded.
///
/// `owner` is the task whose worktree and branch this one worked in — itself, unless it
/// is a subtask. A pass means different things to the two, and the status word carries
/// neither: a main task that passed is waiting to be landed, a step of one has already
/// put its commits where they land from.
///
/// The tier is the second thing the status word cannot carry: `passed` is now *passed
/// what was asked*, and which tier was asked is a property of the invocation.
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

    if let Some(c) = &v.changed {
        out.push_str(&format!("\ndiff — {} file{}\n", c.len(), s(c.len())));
        if c.is_empty() {
            // Not neutral: a task that declared a write scope and changed nothing did not
            // do its work — unless its steps did the writing, which is the one reading of
            // an empty diff that is not a finding.
            out.push_str(if c.delegated().is_empty() {
                "  nothing changed\n"
            } else {
                "  nothing of its own — its steps did the writing\n"
            });
        }
        for path in c {
            let bad = v.violations.contains(path);
            out.push_str(&format!(
                "  {} {}{}\n",
                if bad { "✗" } else { "✓" },
                path,
                if bad { "   outside scope" } else { "" }
            ));
        }
        let steps = c.delegated();
        if !steps.is_empty() {
            // Apart from the diff and marked apart from it: they are not this task's
            // writes, and this task's scope is not what they were held to.
            let n = steps.len();
            out.push_str(&format!("\nits steps — {n} file{} already on this branch\n", s(n)));
            for path in steps {
                out.push_str(&format!("  · {path}\n"));
            }
        }
    } else {
        // Never `0 files`: that beside a green check is the precise misreading
        // [`Verdict::passed`] was built to prevent, and would manufacture the finding out
        // of nothing. This says *no diff is its own*, not *wecode declined to look*.
        out.push_str(
            "\ndiff — not judged\n  \
             nothing was dispatched for this task, so no diff is its own\n",
        );
    }

    if !v.checks.is_empty() {
        out.push_str("\nacceptance\n");
        for c in &v.checks {
            out.push_str(&format!(
                "  {} {:<44} {}{}\n",
                if c.passed() { "✓" } else { "✗" },
                truncate_cmd(&c.cmd, 44),
                c.describe(),
                // A green line that reached real infrastructure and one that read a file
                // are worth different amounts, and only one is reproducible by the reader.
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
        let n = v.deferred.len();
        out.push_str(&format!("\nlive — {n} check{} not run\n", s(n)));
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
    let idle = v.changed.as_ref().is_some_and(Changed::delivered_nothing);
    match v.outcome(task) {
        Outcome::Passed => {
            // A tick on work nobody dispatched is the probes agreeing about the world,
            // which is not the same claim as work having been delivered.
            out.push_str(if task.is_dispatched() {
                "  ✓ passed\n"
            } else {
                "  ✓ its checks pass\n"
            });
            if !v.deferred.is_empty() {
                // The tick above is about to be read as the whole verdict, which is what
                // it has always meant. It now means *what was asked*.
                let n = v.deferred.len();
                let was = if n == 1 { "was" } else { "were" };
                out.push_str(&format!(
                    "    the offline tier only — {n} live check{} {was} not asked for\n",
                    s(n)
                ));
            }
            // Three things a pass can mean, and the status word distinguishes two. Said
            // here because the next command differs in each case, and the wrong guess is
            // expensive: `merge` on a step is refused, and waiting for a signature that
            // will never be asked for is worse.
            match next {
                // Ahead of the status, because a task nobody dispatched has no branch to
                // land and no status this verdict may move.
                _ if !task.is_dispatched() => out.push_str(
                    "    nothing here reports the work done — a signature does, \
                     and only a person has one\n",
                ),
                TaskStatus::NeedsApproval if task.needs_a_signature() => out.push_str(
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
        }
        // Not a failure, and the asymmetry is the point: a dispatch was owed evidence and
        // a person's task never was. Its acceptance is optional and its diff is not
        // wecode's to read, so a verdict on one can be empty of content with nothing
        // wrong — the signature is what reports it.
        Outcome::NothingAsked => out.push_str(
            "  · nothing asked — no check to run, and no diff of its own to read\n\
             \x20   a signature is what reports this one done\n",
        ),
        Outcome::Failed => {
            if idle {
                // The green checks above are about to be read as a pass, so this says
                // which way they point: they ran against a tree the work never touched.
                out.push_str(
                    "  ✗ nothing changed — this task declared a write scope and produced no diff\n\
                     \x20   the acceptance above ran against a tree the work never touched\n",
                );
            }
            let n = v.violations.len();
            if n > 0 {
                out.push_str(&format!(
                    "  ✗ {n} write{} outside scope — recorded against this task\n",
                    s(n)
                ));
            }
            for st in v.stale() {
                // Both halves: the page, and the change that asked for it — *edit the
                // page* is not actionable without knowing which change implicated it.
                out.push_str(&format!("  ✗ {} did not move with {}\n", st.doc, st.because));
            }
            if !v.stale().is_empty() {
                out.push_str("\x20   edit it, or narrow its subject: — there is no waiver\n");
            }
            let missing = v.unrunnable();
            let failed = v.checks.iter().filter(|c| !c.passed() && !c.missing()).count();
            if failed > 0 {
                out.push_str(&format!("  ✗ {failed} acceptance check(s) failed\n"));
            }
            if !missing.is_empty() {
                // Not a verdict about the work — say so, or a missing toolchain reads
                // as a broken change.
                out.push_str(&format!(
                    "  ⚠ {} check(s) could not run — the command was not found.\n\
                     \x20   wecode runs acceptance through `sh -c` with its own environment;\n\
                     \x20   this is a PATH problem, not a verdict on the work.\n",
                    missing.len()
                ));
            }
            if v.checks.is_empty() && v.violations.is_empty() && !idle {
                // A task whose acceptance is entirely live has the same empty check list
                // as one with no acceptance at all, and they are not the same failure:
                // the first was given something to be held to and nobody asked it.
                out.push_str(if v.deferred.is_empty() {
                    "  ✗ nothing to judge by\n"
                } else {
                    "  ✗ nothing to judge by — every check this task has is live, \
                     and none was asked for\n"
                });
            }
        }
    }
    // The verdict reports; the caller transitions. `unchanged` is what says this one did
    // not — and a verdict safe to run before the work or after is the only kind worth
    // pointing at a probe.
    out.push_str(&format!(
        "  {}{}\n",
        next.as_str(),
        if next == task.status { "   unchanged" } else { "" }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Cmp, task::Doer};

    fn scope(globs: &[&str]) -> Scope {
        Scope::write(globs)
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    /// A diff read from nowhere, and read: the `Some` is a verdict that put the
    /// question. The scope half is a question about names, so most of these tests have
    /// no tree to point at — and one that is not under the run root is one wecode never
    /// commits in, which is exactly the guard.
    fn touched(list: &[&str]) -> Option<Changed> {
        Some(Changed {
            dir: PathBuf::new(),
            paths: paths(list),
            delegated: Vec::new(),
            owed: Cell::new(false),
            stale: Vec::new(),
        })
    }

    /// The diff of a real tree, as `judge` reads one.
    fn read(dir: &Path, id: &str) -> Option<Changed> {
        changed(dir, &TaskId::new(id)).unwrap()
    }

    /// The same, for the tests that go on to ask the diff itself something.
    fn seen(dir: &Path, id: &str) -> Changed {
        read(dir, id).expect("the diff was read")
    }

    /// A verdict assembled the way the `verify` command assembles one: acceptance, then
    /// the diff, then the scope read against it. The order is part of the answer — the
    /// scope is what tells an empty diff whether it is the declared outcome.
    fn judged(measures: &[Measure], changed: Option<Changed>, scope: &Scope) -> Verdict {
        let mut v = ran(&std::env::temp_dir(), measures);
        v.changed = changed;
        v.violations = violations(&v.changed, scope);
        v
    }

    /// Acceptance with no shared cache — what a project that declares none gets. The
    /// tier is named rather than read off [`LIVE_ENV`], so a `WECODE_LIVE` in
    /// whatever shell runs the suite cannot decide what these tests assert.
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

    /// A real repository, standing where a task's worktree would. git is a subprocess, so
    /// faking it would test nothing — least of all the part that only shows up once a
    /// commit is between the work and `HEAD`.
    fn worktree(name: &str) -> std::path::PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-verify-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        init(&dir)
    }

    /// The tree wecode cuts for a main task: a directory named after the task that owns
    /// it, which is how `work::worktree_for` names one and how [`owns_the_tree`] answers.
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
        // attempt 2 did nothing at all. Reading only the working tree, the second verdict
        // passed work whose out-of-scope file was still sitting on the branch.
        let dir = worktree("retry-adds-nothing");
        attempt(
            &dir,
            "t1",
            1,
            &[("src/a.rs", "fn a() {}\n"), ("Cargo.toml", "[package]\n")],
        );
        retry(&dir);

        let c = read(&dir, "t1");
        assert_eq!(seen(&dir, "t1").paths(), ["Cargo.toml", "src/a.rs"]);
        assert_eq!(violations(&c, &scope(&["src/**"])), ["Cargo.toml"]);
    }

    #[test]
    fn the_work_a_retry_did_add_joins_the_work_it_inherited() {
        // Both halves in one list: the retry's own uncommitted writes and the attempt
        // underneath them, with a file touched by both counted once.
        let dir = worktree("retry-adds-more");
        attempt(
            &dir,
            "t1",
            1,
            &[("src/a.rs", "fn a() {}\n"), ("docs/note.md", "why\n")],
        );
        retry(&dir);
        // One file the retry rewrote, one it added, one it left as the attempt wrote it.
        write(&dir, "src/a.rs", "fn a() { todo!() }\n");
        write(&dir, "src/b.rs", "fn b() {}\n");

        let want = ["docs/note.md", "src/a.rs", "src/b.rs"];
        assert_eq!(seen(&dir, "t1").paths(), want);
    }

    #[test]
    fn a_siblings_attempts_on_a_shared_branch_are_not_this_tasks_to_answer_for() {
        // A subtask works in its parent's tree, so the log carries its siblings' attempts.
        // Each was judged against its own scope; charging them here would fail every step
        // after the first for work that was already accepted.
        let dir = worktree("shared-branch");
        attempt(&dir, "step-one", 1, &[("docs/one.md", "one\n")]);
        attempt(&dir, "step-two", 1, &[("src/two.rs", "fn two() {}\n")]);
        retry(&dir);

        assert_eq!(seen(&dir, "step-two").paths(), ["src/two.rs"]);
        let v = violations(&read(&dir, "step-two"), &scope(&["src/**"]));
        assert!(v.is_empty(), "{v:?}");
    }

    #[test]
    fn work_that_came_with_the_base_is_not_this_tasks_work() {
        // A branch cut from a predecessor's carries that predecessor's commits, and a
        // task is not asked to declare a scope covering the ground it was handed.
        let dir = worktree("base-history");
        let c = seen(&dir, "t1");
        assert!(c.is_empty(), "{c:?}");
    }

    #[test]
    fn a_first_attempt_is_read_exactly_as_before() {
        // Judging happens before the commit, so on the first run there is nothing behind
        // HEAD and this is the plain working-tree diff it has always been.
        let dir = worktree("first-attempt");
        write(&dir, "src/a.rs", "fn a() {}\n");
        let plain = git::changed_files(&dir).unwrap();
        assert_eq!(seen(&dir, "t1").paths(), plain);
    }

    #[test]
    fn only_a_tree_wecode_commits_in_is_held_back() {
        // Which trees those are, stated once. The worktrees wecode cuts live under the
        // run root and nothing else does; a repository the operator keeps elsewhere is
        // theirs, and wecode neither commits there nor withholds anything.
        let ours = crate::work::run_root().join("an-org").join("t1");
        assert!(commits_here(&ours));
        assert!(!commits_here(&std::env::temp_dir().join("their-checkout")));
        assert!(!commits_here(Path::new("")));
    }

    #[test]
    fn a_verdict_in_the_operators_own_checkout_holds_nothing_back() {
        // The line `commit_attempt` draws, seen from this side. A task the playbook gave
        // no worktree is judged where the operator is standing, and wecode commits
        // nothing there — so there is nothing to hold back.
        let dir = worktree("no-worktree");
        write(&dir, "src/a.rs", "fn a() {}\n");
        write(&dir, "Cargo.toml", "[package]\n");

        let c = read(&dir, "t1");
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
        // A spike declares no write scope, and one that edited files did something it
        // never said it would: the fail-closed reading is the correct one.
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
    fn acceptance_runs_in_the_operators_environment_with_the_projects_cache_over_it() {
        // Both halves of one environment. The cache is set here too because acceptance
        // is the second cold build a worktree pays for and usually the larger one; and
        // unlike a spawned agent's, the rest is inherited rather than built from an
        // allowlist — a command without `PATH` could not find the toolchain it judges
        // with.
        let v = run_tier(
            &std::env::temp_dir(),
            &[
                cmd("test \"$CARGO_TARGET_DIR\" = /tmp/shared-target"),
                cmd("test -n \"$PATH\""),
            ],
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
        // before the agent started and is green after one that did nothing: a clean
        // board over an empty diff, sent to the signature queue as delivered work.
        let v = judged(&[cmd("true")], touched(&[]), &scope(&["src/**"]));

        assert!(v.checks.iter().all(Check::passed), "{:?}", v.checks);
        assert!(v.violations.is_empty(), "nothing was written anywhere");
        assert!(!v.passed(), "an empty diff is not a delivery");
    }

    #[test]
    fn an_agent_that_touched_a_real_worktree_and_left_it_alone_is_caught_the_same_way() {
        // The same finding read off git rather than a fabricated diff. The acceptance
        // here genuinely passes on an untouched tree, which is the shape of the real
        // failure: a repository's own suite is green before its agents start.
        let dir = worktree("did-nothing");
        let mut v = ran(&dir, &[cmd("test -f README.md")]);
        v.changed = changed(&dir, &TaskId::new("t1")).unwrap();
        v.violations = violations(&v.changed, &scope(&["src/**"]));

        assert!(v.checks[0].passed(), "{:?}", v.checks);
        assert!(seen(&dir, "t1").is_empty(), "{:?}", v.changed);
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
        // A spike is the one kind admitted without a write scope, because what it owes is
        // an answer rather than a diff. Reading every empty diff as a failure would make
        // it the one kind that can never pass: any change is already a violation.
        let v = judged(&[cmd("true")], touched(&[]), &Scope::default());
        assert!(v.passed(), "{v:?}");
    }

    #[test]
    fn work_the_scope_refused_still_counts_as_having_been_done() {
        // Two findings, not one: the task changed something and it changed the wrong
        // thing. Folding them together would report a scope violation as an idle run.
        let v = judged(&[cmd("true")], touched(&["Cargo.toml"]), &scope(&["src/**"]));
        assert!(!v.passed());
        let c = v.changed.as_ref().unwrap();
        assert!(!c.delivered_nothing(), "it did write something");
        assert_eq!(v.violations, ["Cargo.toml"]);
    }

    #[test]
    fn a_diff_no_scope_was_read_against_makes_no_claim_about_what_was_owed() {
        // `owed` is recorded by the scope check, so until that has run nothing knows a
        // change was expected. The honest answer is silence rather than a finding
        // invented out of a question nobody asked.
        assert!(!touched(&[]).unwrap().delivered_nothing());
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

    #[test]
    fn a_verdict_on_work_nobody_dispatched_reads_no_diff_and_moves_nothing() {
        // Every half at once. No diff is this task's own, so none is read and none is
        // reported as `0 files`; nothing was asked, which here is not a failure; and the
        // status goes back as it came, which is what makes a probe safe to run early.
        let task = Task::new("t1", "fares", "mint the token").done_by(Doer::Person);
        let dir = std::env::temp_dir();
        let out = verdict(&task, &task.id, &dir, &ran(&dir, &[]), task.status);

        assert!(out.contains("diff — not judged"), "{out}");
        assert!(out.contains("· nothing asked"), "{out}");
        assert!(out.contains("   unchanged"), "{out}");
        assert!(!out.contains("0 files"), "{out}");

        // A probe passing is the probes agreeing about the world, not the work done.
        let out = verdict(&task, &task.id, &dir, &ran(&dir, &[cmd("true")]), task.status);
        assert!(out.contains("✓ its checks pass"), "{out}");
        assert!(out.contains("a signature does"), "{out}");
    }

    // --------------------------------------------- work that belongs to steps ------

    #[test]
    fn a_parent_is_not_failed_for_work_that_belongs_to_its_steps() {
        // The shape the playbook asks for, failed at the last moment for having it. The
        // steps commit on the branch their parent owns, so the parent correctly writes
        // nothing of its own — and the empty-diff rule read that as an agent giving up.
        let dir = owned_worktree("parent-steps", "t");
        attempt(&dir, "t-one", 1, &[("src/one.rs", "fn one() {}\n")]);
        attempt(&dir, "t-two", 1, &[("src/two.rs", "fn two() {}\n")]);
        // The reset before the parent's own run, which is what leaves its diff empty.
        retry(&dir);

        let mut v = ran(&dir, &[cmd("test -f README.md")]);
        v.changed = read(&dir, "t");
        v.violations = violations(&v.changed, &scope(&["src/**"]));

        let c = v.changed.as_ref().unwrap();
        assert!(c.is_empty(), "none of it is the parent's: {c:?}");
        assert_eq!(c.delegated(), ["src/one.rs", "src/two.rs"]);
        assert!(!c.delivered_nothing(), "{c:?}");
        assert!(v.passed(), "{v:?}");
    }

    #[test]
    fn a_step_writing_where_its_parent_may_not_is_not_the_parents_violation() {
        // Why the steps' work is held apart from the diff rather than folded into it. A
        // step declares its own scope, so counting its paths as the parent's would fail
        // the parent for its children's licence and record refused writes against a
        // task that made none.
        let dir = owned_worktree("step-scope", "t");
        attempt(&dir, "t-design", 1, &[("docs/design/t.md", "the decision\n")]);
        retry(&dir);

        let c = read(&dir, "t");
        assert!(violations(&c, &scope(&["src/**"])).is_empty(), "{c:?}");
        assert!(!c.unwrap().delivered_nothing());
    }

    #[test]
    fn a_parent_whose_steps_have_not_written_anything_yet_still_fails() {
        // The other half: nothing beneath it either. An empty branch is the failure the
        // rule exists for whatever the task's shape is, and a parent is not exempt by
        // being one — it is excused by work standing on its branch, and there is none.
        let dir = owned_worktree("parent-empty", "t");
        let c = read(&dir, "t");
        violations(&c, &scope(&["src/**"]));
        let c = c.unwrap();
        assert!(c.delegated().is_empty(), "{c:?}");
        assert!(c.delivered_nothing(), "{c:?}");
    }

    #[test]
    fn work_the_branch_was_cut_from_is_not_a_parents_steps() {
        // The case that decides how a step is recognised. A branch cut from a
        // predecessor's brings that work's attempts into this log looking exactly like a
        // step's, and what separates them is the `wecode/<id>` a task that owned a tree
        // leaves behind: the base cannot excuse a task that did nothing.
        let dir = owned_worktree("base-attempts", "t");
        attempt(&dir, "pred", 1, &[("src/p.rs", "fn p() {}\n")]);
        branch_of(&dir, "pred");
        retry(&dir);

        let c = read(&dir, "t");
        violations(&c, &scope(&["src/**"]));
        let c = c.unwrap();
        assert!(c.is_empty(), "{c:?}");
        assert!(c.delegated().is_empty(), "the predecessor's, not a step's");
        assert!(c.delivered_nothing(), "{c:?}");
    }

    #[test]
    fn a_step_is_not_excused_by_what_its_siblings_delivered() {
        // Only the task the tree is named after is answered for by the attempts around
        // it. A step's neighbours are its siblings, already judged on their own scopes,
        // and a task that owes a diff is not relieved of it by standing next to one.
        let dir = owned_worktree("sibling-empty", "t");
        attempt(&dir, "t-one", 1, &[("src/one.rs", "fn one() {}\n")]);
        retry(&dir);

        let c = read(&dir, "t-two");
        violations(&c, &scope(&["src/**"]));
        let c = c.unwrap();
        assert!(c.delegated().is_empty(), "{c:?}");
        assert!(c.delivered_nothing(), "{c:?}");
    }

    #[test]
    fn the_verdict_names_the_work_its_steps_left_on_the_branch() {
        // The reader reaches the diff before the verdict, and "0 files / nothing changed"
        // over a passing parent is a sentence they would have to reconcile on their own.
        let dir = owned_worktree("parent-render", "t");
        attempt(&dir, "t-one", 1, &[("src/one.rs", "fn one() {}\n")]);
        retry(&dir);

        let task = Task::new("t", "caching", "the cache layer").scoped(scope(&["src/**"]));
        let mut v = ran(&dir, &[cmd("true")]);
        v.changed = read(&dir, "t");
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
    /// *did not run* from *ran and passed*: asserting on the verdict alone would pass
    /// just as well against a tier that quietly ran everything and reported half of it.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wecode-tier-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_live_check_is_not_started_at_all_unless_it_was_asked_for() {
        // The whole point of the tier, and the only assertion that can carry it: not that
        // the check was reported as skipped, but that nothing ran. A live check reaches
        // real infrastructure with the credentials of whoever is judging.
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
        // Leniency in the direction that is cheap to be wrong in: a marker that failed to
        // match leaves the check in the first tier, where it runs against the real thing
        // on every verdict. `Live:` is a typo, not consent.
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
        // `live:` alone would otherwise be a check that runs the empty string, which exits
        // 0 — a pass earned by asking nothing. Handed to `sh` unchanged it comes back as
        // 127, visibly broken where the operator wrote it. What `tier_of` makes of the
        // line is core's to assert; what a verdict makes of it is this.
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
    fn a_deferred_check_is_not_counted_against_the_work() {
        // The reading that fails closed is unusable: a task carrying a live check would
        // then pass only where the credentials for it are, and acceptance that can only
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
        // `✓ passed` now means *passed what was asked*, and which was asked is a property
        // of the invocation — not recoverable from anything else on the page.
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

    // The doc gate's own tests are in `tests/cli.rs`. They moved there when [`governing`]
    // started reading a revision rather than the disk: what the gate now claims is that
    // the verdict does not move when the tree does, and only the whole command run twice
    // over one real branch can say whether that holds.
}
