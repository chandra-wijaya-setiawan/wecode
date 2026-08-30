//! Value types shared by projects and tasks.

/// Where a running task may write its own scratch — the result file, notes, anything
/// task-local.
///
/// Not a resource tasks compete for: each runs in its own worktree, and the envelope
/// tells every one of them to write here. It is therefore exempt from all three scope
/// checks — coverage at assignment, overlap at admission, and the diff at verify — and
/// they have to agree or declaring it passes one and fails another.
pub const WORKER_DIR: &str = ".wecode/run";

/// How we know something is done. Ordered by trustworthiness: a command either
/// exits zero or it does not; a judgement is an opinion.
#[derive(Clone, PartialEq, Debug)]
pub enum Measure {
    Command {
        cmd: String,
        expect_status: i32,
    },
    Metric {
        name: String,
        target: f64,
        cmp: Cmp,
    },
    Deliverable {
        path: String,
    },
    /// Human-judged. Legal on a project's objective, never on a task.
    Judged {
        note: String,
    },
}

impl Measure {
    /// Whether this can be evaluated without asking anyone.
    #[must_use]
    pub fn is_executable(&self) -> bool {
        !matches!(self, Self::Judged { .. })
    }

    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::Command { cmd, expect_status } => format!("`{cmd}` exits {expect_status}"),
            Self::Metric { name, target, cmp } => format!("{name} {} {target}", cmp.symbol()),
            Self::Deliverable { path } => format!("file exists: {path}"),
            Self::Judged { note } => format!("judged: {note}"),
        }
    }
}

/// What an acceptance command marked as needing live infrastructure starts with.
///
/// On the command line because there is nowhere else: a [`Measure::Command`] is a line
/// and an expected status, in the plan and in the store both. Read case-insensitively for
/// one reason — a marker that failed to match leaves the check in the *first* tier, where
/// it runs against the real bucket on every verdict, unasked.
const LIVE_MARK: &str = "live:";

/// Which tier of acceptance a verdict is being asked for.
///
/// Here rather than beside the code that runs a check, because the tier is a property of
/// the [`Measure::Command`] line this crate defines: the marker is part of that line's
/// grammar. Who asks for the tier, and through which door, is the caller's — see
/// [`Tier::asked_by`].
///
/// The request is per invocation and read from the environment — the same door
/// `WECODE_CONFIG` and `WECODE_AGENT` come through — and that is the property worth
/// having rather than a convenience. A tier written into the plan would be a standing
/// instruction: every judgement the board loop made from then on would reach for real
/// infrastructure, days after the person who wrote it stopped watching. In the
/// environment of one command it cannot outlive the command.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Tier {
    /// Everything a checkout can answer on its own, and nothing else. The default, and
    /// what every unattended verdict is made of.
    #[default]
    Offline,
    /// The offline tier and the live one together. Only ever by request.
    Live,
}

impl Tier {
    /// Whether a value the caller read is a request. Off unless something affirmative
    /// is set: someone who exported the variable to turn the tier *off* said the more
    /// deliberate of the two things, and reading the mere presence of the name as
    /// consent would do the opposite of what they wrote.
    #[must_use]
    pub fn asked_by(v: Option<&str>) -> Self {
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
    #[must_use]
    pub fn runs(self, live: bool) -> bool {
        !live || self == Self::Live
    }
}

/// Splits the tier marker off an acceptance command: whether it is live, and the line
/// to actually run.
///
/// A marker with nothing behind it is not a marker. Read as a tier, `live:` alone would
/// be a check that runs the empty string and exits 0 — a pass earned by asking nothing.
/// Handed to `sh` unchanged it is a command not found, visibly broken where it was
/// written.
#[must_use]
pub fn tier_of(cmd: &str) -> (bool, &str) {
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cmp {
    Lt,
    Lte,
    Gt,
    Gte,
    Eq,
}

impl Cmp {
    #[must_use]
    pub fn symbol(self) -> &'static str {
        match self {
            Self::Lt => "<",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::Eq => "==",
        }
    }
}

/// Paths a piece of work may read and write. Write globs are the enforced guardrail.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct Scope {
    pub read: Vec<String>,
    pub write: Vec<String>,
}

impl Scope {
    #[must_use]
    pub fn write(globs: &[&str]) -> Self {
        Self {
            read: Vec::new(),
            write: globs.iter().map(|g| (*g).to_string()).collect(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.read.is_empty() && self.write.is_empty()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct Budget {
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
}

impl Budget {
    #[must_use]
    pub fn is_set(&self) -> bool {
        self.tokens.is_some() || self.wall_secs.is_some()
    }
}

/// A project's life. A project never runs — its tasks do — so it has no
/// `Running` or `Verifying`.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum ProjectStatus {
    #[default]
    Draft,
    Active,
    Done,
    Dropped,
}

impl ProjectStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Active => "active",
            Self::Done => "done",
            Self::Dropped => "dropped",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "draft" => Self::Draft,
            "active" => Self::Active,
            "done" => Self::Done,
            "dropped" => Self::Dropped,
            _ => return None,
        })
    }

    #[must_use]
    pub fn is_closed(self) -> bool {
        matches!(self, Self::Done | Self::Dropped)
    }

    /// Every status, in lifecycle order. Exists so an error message can list them
    /// without a second hand-maintained copy drifting out of sync.
    #[must_use]
    pub fn all() -> &'static [Self] {
        &[Self::Draft, Self::Active, Self::Done, Self::Dropped]
    }

    /// The glyph the board and the tree show.
    ///
    /// Lives here rather than in the renderers: the same four-arm match was
    /// hand-copied into render.rs, board.rs and tui.rs, so a new variant would have
    /// had to be remembered three times.
    #[must_use]
    pub fn mark(self) -> char {
        match self {
            Self::Draft => '·',
            Self::Active => '>',
            Self::Done => '✓',
            Self::Dropped => '-',
        }
    }
}

/// A task's life, shaped so the scheduler can drive it with one query.
///
/// `Waiting` and `Ready` differ only by whether prerequisites are finished, and the
/// scheduler is the single writer that promotes one to the other on each tick. That
/// makes the stored value a cache with exactly one author: a missed scan delays a
/// promotion, it cannot lose one.
///
/// There is deliberately no `Blocked`. Waiting on a task, waiting on a signature and
/// waiting on an answer are three different situations, resolved by three different
/// people.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum TaskStatus {
    /// Has defects; not workable.
    #[default]
    Draft,
    /// Admitted, but some prerequisite is unfinished.
    Waiting,
    /// Admitted and unblocked — the scheduler's queue.
    Ready,
    /// An execution is in flight.
    Running,
    /// The agent finished; acceptance and scope checks are running.
    Verifying,
    /// A capability holder must sign — a merge, a budget increase.
    NeedsApproval,
    /// A human must answer the agent.
    NeedsInput,
    /// Attempted, retries exhausted. A person decides what happens next.
    Failed,
    Done,
    Dropped,
}

impl TaskStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Waiting => "waiting",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::Verifying => "verifying",
            Self::NeedsApproval => "needs-approval",
            Self::NeedsInput => "needs-input",
            Self::Failed => "failed",
            Self::Done => "done",
            Self::Dropped => "dropped",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "draft" => Self::Draft,
            "waiting" => Self::Waiting,
            "ready" => Self::Ready,
            "running" => Self::Running,
            "verifying" => Self::Verifying,
            "needs-approval" => Self::NeedsApproval,
            "needs-input" => Self::NeedsInput,
            "failed" => Self::Failed,
            "done" => Self::Done,
            "dropped" => Self::Dropped,
            _ => return None,
        })
    }

    #[must_use]
    pub fn is_done(self) -> bool {
        matches!(self, Self::Done)
    }

    /// Finished with, either way. Closed tasks are ignored by the scheduler and by
    /// scope-conflict checks.
    #[must_use]
    pub fn is_closed(self) -> bool {
        matches!(self, Self::Done | Self::Dropped)
    }

    /// Whether the scheduler may consider promoting or dispatching this.
    #[must_use]
    pub fn is_schedulable(self) -> bool {
        matches!(self, Self::Waiting | Self::Ready)
    }

    /// Whether a person has to act before anything else can happen. Drives the
    /// board's "needs you" column.
    #[must_use]
    pub fn needs_a_human(self) -> bool {
        matches!(self, Self::NeedsApproval | Self::NeedsInput | Self::Failed)
    }

    /// Whether, as a prerequisite, this status is a dead end: nothing in the
    /// normal course of events will make it `Done`, so work waiting on it cannot
    /// advance on its own.
    ///
    /// Deliberately narrower than `needs_a_human`. `NeedsApproval` and
    /// `NeedsInput` are a signature or an answer away from finishing — the design
    /// gate *relies* on work queuing behind an unsigned design — and `Draft` is
    /// planning still in progress. `Failed` has exhausted its attempts and
    /// `Dropped` is closed for good; only those two leave a dependent with
    /// nothing to wait for.
    #[must_use]
    pub fn is_dead_end(self) -> bool {
        matches!(self, Self::Failed | Self::Dropped)
    }

    /// Every status, in lifecycle order. Exists so an error message can list them
    /// without a second hand-maintained copy drifting out of sync.
    #[must_use]
    pub fn all() -> &'static [Self] {
        &[
            Self::Draft,
            Self::Waiting,
            Self::Ready,
            Self::Running,
            Self::Verifying,
            Self::NeedsApproval,
            Self::NeedsInput,
            Self::Failed,
            Self::Done,
            Self::Dropped,
        ]
    }

    #[must_use]
    pub fn mark(self) -> char {
        match self {
            Self::Draft => '·',
            Self::Waiting => '⋯',
            Self::Ready => '○',
            Self::Running => '>',
            Self::Verifying => '?',
            Self::NeedsApproval => '!',
            Self::NeedsInput => '!',
            Self::Failed => 'x',
            Self::Done => '✓',
            Self::Dropped => '-',
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_affirmative_value_asks_for_the_live_tier() {
        // A variable exported to turn the tier off is the more deliberate of the two
        // things a person can write, and reading the name's presence as consent would do
        // the opposite of what they wrote.
        assert_eq!(Tier::asked_by(None), Tier::Offline);
        for off in ["", "  ", "0", "false", "FALSE", "no", "off"] {
            assert_eq!(Tier::asked_by(Some(off)), Tier::Offline, "{off:?}");
        }
        for on in ["1", "yes", "true", "please"] {
            assert_eq!(Tier::asked_by(Some(on)), Tier::Live, "{on:?}");
        }
    }

    #[test]
    fn a_marker_with_nothing_behind_it_is_not_a_marker() {
        // `live:` alone read as a tier would be a check that runs the empty string and
        // exits 0 — a pass earned by asking nothing. Left on the line it reaches `sh` as
        // a command not found, visibly broken where the operator wrote it.
        assert_eq!(tier_of("live:"), (false, "live:"));
        assert_eq!(tier_of("live:   "), (false, "live:   "));
        assert_eq!(tier_of("LIVE:  aws s3 ls"), (true, "aws s3 ls"));
        assert_eq!(tier_of("cargo test"), (false, "cargo test"));
    }

    #[test]
    fn every_project_status_round_trips_and_has_a_distinct_mark() {
        let mut marks = Vec::new();
        for s in ProjectStatus::all() {
            assert_eq!(ProjectStatus::parse(s.as_str()), Some(*s));
            marks.push(s.mark());
        }
        assert_eq!(marks.len(), 4);
        marks.sort_unstable();
        marks.dedup();
        assert_eq!(marks.len(), 4, "two statuses share a glyph");
    }

    #[test]
    fn only_judged_measures_need_a_person() {
        assert!(
            !Measure::Judged {
                note: "looks right".into()
            }
            .is_executable()
        );
        assert!(
            Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 0
            }
            .is_executable()
        );
        assert!(
            Measure::Metric {
                name: "p99".into(),
                target: 500.0,
                cmp: Cmp::Lt
            }
            .is_executable()
        );
    }

    #[test]
    fn measures_describe_themselves_for_the_terminal() {
        let m = Measure::Metric {
            name: "p99_ms".into(),
            target: 500.0,
            cmp: Cmp::Lt,
        };
        assert_eq!(m.describe(), "p99_ms < 500");
    }

    #[test]
    fn closed_covers_dropped_as_well_as_done() {
        assert!(TaskStatus::Done.is_done());
        assert!(!TaskStatus::Dropped.is_done());
        assert!(TaskStatus::Dropped.is_closed());
        assert!(!TaskStatus::Running.is_closed());
    }

    #[test]
    fn every_status_round_trips_through_its_name() {
        for s in [
            TaskStatus::Draft,
            TaskStatus::Waiting,
            TaskStatus::Ready,
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
            TaskStatus::NeedsInput,
            TaskStatus::Failed,
            TaskStatus::Done,
            TaskStatus::Dropped,
        ] {
            assert_eq!(TaskStatus::parse(s.as_str()), Some(s), "{s:?}");
        }
        for s in [
            ProjectStatus::Draft,
            ProjectStatus::Active,
            ProjectStatus::Done,
            ProjectStatus::Dropped,
        ] {
            assert_eq!(ProjectStatus::parse(s.as_str()), Some(s), "{s:?}");
        }
    }

    #[test]
    fn only_waiting_and_ready_are_schedulable() {
        assert!(TaskStatus::Waiting.is_schedulable());
        assert!(TaskStatus::Ready.is_schedulable());
        for s in [
            TaskStatus::Draft,
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::Done,
        ] {
            assert!(!s.is_schedulable(), "{s:?} must not be picked up");
        }
    }

    #[test]
    fn the_three_states_that_need_a_person_are_distinguished() {
        // No single "blocked": waiting on a signature, on an answer, and on a
        // decision after failure are different situations.
        for s in [
            TaskStatus::NeedsApproval,
            TaskStatus::NeedsInput,
            TaskStatus::Failed,
        ] {
            assert!(s.needs_a_human(), "{s:?}");
        }
        for s in [TaskStatus::Waiting, TaskStatus::Ready, TaskStatus::Running] {
            assert!(!s.needs_a_human(), "{s:?} resolves without a person");
        }
    }

    #[test]
    fn only_failed_and_dropped_are_dead_ends_for_a_dependent() {
        for s in [TaskStatus::Failed, TaskStatus::Dropped] {
            assert!(s.is_dead_end(), "{s:?} will never finish unaided");
        }
        // A signature or an answer away from done is the flow working, not a
        // dead end — flagging those would turn every design gate amber.
        for s in [
            TaskStatus::Draft,
            TaskStatus::Waiting,
            TaskStatus::Ready,
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::NeedsApproval,
            TaskStatus::NeedsInput,
            TaskStatus::Done,
        ] {
            assert!(!s.is_dead_end(), "{s:?} still has a way to finish");
        }
    }
}
