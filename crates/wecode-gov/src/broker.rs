//! The Broker: one chokepoint that authorises every consequential action, and the
//! ledger that records what it decided and under whose authority.

use std::fmt;

use crate::glob;
use crate::grant::{ActionKind, Effective, Introspect, WorkKind};

/// Something a post wants to do.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Action {
    Read { path: String },
    Write { path: String },
    Run { argv: Vec<String> },
    Network { host: String },
    Spend { tokens: u64, wall_secs: u64 },
    Merge { branch: String },
    Approve { kind: ActionKind },
    Define { kind: WorkKind },
    Introspect { level: Introspect },
    Staff,
}

impl Action {
    /// Whether a violation must be made impossible, or may be allowed to happen
    /// and then sanctioned. Split by **reversibility**, not severity.
    #[must_use]
    pub fn control_mode(&self) -> ControlMode {
        match self {
            // No "afterwards" to sanction in.
            Self::Merge { .. }
            | Self::Run { .. }
            | Self::Network { .. }
            | Self::Spend { .. }
            | Self::Approve { .. }
            | Self::Define { .. }
            | Self::Staff => ControlMode::Regimented,
            // Recoverable inside a worktree, and the attempt is diagnostic.
            Self::Read { .. } | Self::Write { .. } | Self::Introspect { .. } => {
                ControlMode::Sanctioned
            }
        }
    }

    fn argv_line(&self) -> String {
        match self {
            Self::Run { argv } => argv.join(" "),
            _ => String::new(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ControlMode {
    /// Blocked before it happens.
    Regimented,
    /// Detected, recorded, penalised. The attempt itself is information.
    Sanctioned,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum DenyReason {
    OutsideWriteScope {
        path: String,
    },
    OutsideReadScope {
        path: String,
    },
    CommandNotPermitted {
        argv: String,
    },
    NetworkNotPermitted {
        host: String,
    },
    BranchNotPermitted {
        branch: String,
    },
    TokenBudgetExhausted {
        cap: u64,
        would_be: u64,
    },
    WallBudgetExhausted {
        cap: u64,
        would_be: u64,
    },
    CapabilityMissing {
        what: &'static str,
    },
    /// A charter invariant. Always raises an alarm — intermediate levels may be
    /// the thing that misconfigured the grant.
    InvariantViolated {
        invariant: String,
    },
}

impl fmt::Display for DenyReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutsideWriteScope { path } => write!(f, "write outside scope: {path}"),
            Self::OutsideReadScope { path } => write!(f, "read outside scope: {path}"),
            Self::CommandNotPermitted { argv } => write!(f, "command not permitted: {argv}"),
            Self::NetworkNotPermitted { host } => write!(f, "network not permitted: {host}"),
            Self::BranchNotPermitted { branch } => write!(f, "merge not permitted: {branch}"),
            Self::TokenBudgetExhausted { cap, would_be } => {
                write!(f, "token budget exhausted: {would_be} would exceed {cap}")
            }
            Self::WallBudgetExhausted { cap, would_be } => {
                write!(f, "wall budget exhausted: {would_be}s would exceed {cap}s")
            }
            Self::CapabilityMissing { what } => write!(f, "capability missing: {what}"),
            Self::InvariantViolated { invariant } => write!(f, "invariant violated: {invariant}"),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Decision {
    Allow,
    Deny {
        reason: DenyReason,
        mode: ControlMode,
        alarm: bool,
    },
    RequireApproval {
        by: ActionKind,
    },
}

impl Decision {
    #[must_use]
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow)
    }

    #[must_use]
    pub fn raises_alarm(&self) -> bool {
        matches!(self, Self::Deny { alarm: true, .. })
    }
}

/// Hard limits that no grant may override.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Invariant {
    NeverTouch(Vec<String>),
    NeverRun(Vec<String>),
    MaxTokens(u64),
    MaxWallSecs(u64),
    /// Merging these branches always needs a holder's signature.
    ApprovalToMerge(Vec<String>),
}

/// A unit's identity: purpose plus the limits that outrank every grant beneath it.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct Charter {
    pub invariants: Vec<Invariant>,
}

impl Charter {
    #[must_use]
    pub fn with(invariants: Vec<Invariant>) -> Self {
        Self { invariants }
    }
}

/// Consumed budget for one session.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct Spend {
    pub tokens: u64,
    pub wall_secs: u64,
}

/// One post working on one intent, with a subset of its roles activated.
///
/// `occupant` is the agent that acted; `human` is the person in the same seat, when
/// there is one. Both are recorded flatly, with no implied direction between them —
/// the human is not the agent's owner, and the agent is not merely the human's tool.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Session {
    pub id: String,
    pub post: String,
    pub occupant: String,
    pub human: Option<String>,
    /// What the action is for. Both may be set: a task always belongs to a
    /// project, and the ledger is queried by either.
    pub project: Option<String>,
    pub task: Option<String>,
    pub effective: Effective,
    pub spent: Spend,
}

impl Session {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        post: impl Into<String>,
        occupant: impl Into<String>,
        effective: Effective,
    ) -> Self {
        Self {
            id: id.into(),
            post: post.into(),
            occupant: occupant.into(),
            human: None,
            project: None,
            task: None,
            effective,
            spent: Spend::default(),
        }
    }

    /// Names the work this session is acting on.
    #[must_use]
    pub fn on(mut self, project: Option<String>, task: Option<String>) -> Self {
        self.project = project;
        self.task = task;
        self
    }

    /// Names the human in this seat alongside the agent.
    #[must_use]
    pub fn with_human(mut self, human: Option<String>) -> Self {
        self.human = human;
        self
    }
}

/// Provenance. A harness's own account of what it did is useful for debugging and
/// inadmissible as evidence, so the distinction is recorded at write time.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    /// We decided it.
    Broker,
    /// We observed it: exit code, diff, spend.
    Supervisor,
    /// The agent said so.
    Harness,
}

/// One line of the audit ledger.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Record {
    pub seq: u64,
    pub session: String,
    pub post: String,
    pub occupant: String,
    pub human: Option<String>,
    pub project: Option<String>,
    pub task: Option<String>,
    pub action: Action,
    pub decision: Decision,
    pub source: Source,
}

/// Authorises actions and records every decision.
///
/// Holds the ledger in memory; persistence belongs to the store crate. Keeping it
/// here would make authorisation depend on I/O, and authorisation must be a pure
/// function of its inputs.
#[derive(Clone, Default, Debug)]
pub struct Broker {
    charter: Charter,
    ledger: Vec<Record>,
    seq: u64,
}

impl Broker {
    #[must_use]
    pub fn new(charter: Charter) -> Self {
        Self {
            charter,
            ledger: Vec::new(),
            seq: 0,
        }
    }

    /// Decides, records, and returns. There is no path that decides without
    /// recording.
    pub fn authorize(&mut self, session: &Session, action: &Action) -> Decision {
        let decision = self.decide(session, action);
        self.seq += 1;
        self.ledger.push(Record {
            seq: self.seq,
            session: session.id.clone(),
            post: session.post.clone(),
            occupant: session.occupant.clone(),
            human: session.human.clone(),
            project: session.project.clone(),
            task: session.task.clone(),
            action: action.clone(),
            decision: decision.clone(),
            source: Source::Broker,
        });
        decision
    }

    /// Charter invariants are checked before grants, because a grant that permits
    /// an invariant violation is itself the bug.
    fn decide(&self, session: &Session, action: &Action) -> Decision {
        if let Some(reason) = self.invariant_violation(session, action) {
            return Decision::Deny {
                reason,
                mode: ControlMode::Regimented,
                alarm: true,
            };
        }
        if let Some(kind) = self.approval_required(action) {
            return Decision::RequireApproval { by: kind };
        }

        let g = &session.effective;
        let deny = |reason: DenyReason| Decision::Deny {
            reason,
            mode: action.control_mode(),
            alarm: false,
        };

        match action {
            Action::Read { path } => {
                if g.allows_read(path) {
                    Decision::Allow
                } else {
                    deny(DenyReason::OutsideReadScope { path: path.clone() })
                }
            }
            Action::Write { path } => {
                if g.allows_write(path) {
                    Decision::Allow
                } else {
                    deny(DenyReason::OutsideWriteScope { path: path.clone() })
                }
            }
            Action::Run { .. } => {
                let argv = action.argv_line();
                if g.allows_run(&argv) {
                    Decision::Allow
                } else {
                    deny(DenyReason::CommandNotPermitted { argv })
                }
            }
            Action::Network { host } => {
                if g.allows_host(host) {
                    Decision::Allow
                } else {
                    deny(DenyReason::NetworkNotPermitted { host: host.clone() })
                }
            }
            Action::Merge { branch } => {
                if g.allows_merge(branch) {
                    Decision::Allow
                } else {
                    deny(DenyReason::BranchNotPermitted {
                        branch: branch.clone(),
                    })
                }
            }
            Action::Spend { tokens, wall_secs } => self.check_spend(session, *tokens, *wall_secs),
            Action::Approve { kind } => {
                if g.allows_approve(*kind) {
                    Decision::Allow
                } else {
                    deny(DenyReason::CapabilityMissing { what: "approve" })
                }
            }
            Action::Define { kind } => {
                if g.allows_define(*kind) {
                    Decision::Allow
                } else {
                    deny(DenyReason::CapabilityMissing { what: "define" })
                }
            }
            Action::Introspect { level } => {
                if *level <= g.introspect() && g.introspect() != Introspect::None {
                    Decision::Allow
                } else {
                    deny(DenyReason::CapabilityMissing { what: "introspect" })
                }
            }
            Action::Staff => {
                if g.allows_staff() {
                    Decision::Allow
                } else {
                    deny(DenyReason::CapabilityMissing { what: "staff" })
                }
            }
        }
    }

    fn check_spend(&self, session: &Session, tokens: u64, wall_secs: u64) -> Decision {
        let next_tokens = session.spent.tokens.saturating_add(tokens);
        let next_wall = session.spent.wall_secs.saturating_add(wall_secs);

        if let Some(cap) = session.effective.token_cap()
            && next_tokens > cap
        {
            return Decision::Deny {
                reason: DenyReason::TokenBudgetExhausted {
                    cap,
                    would_be: next_tokens,
                },
                mode: ControlMode::Regimented,
                alarm: next_tokens > cap.saturating_mul(3) / 2,
            };
        }
        if let Some(cap) = session.effective.wall_cap()
            && next_wall > cap
        {
            return Decision::Deny {
                reason: DenyReason::WallBudgetExhausted {
                    cap,
                    would_be: next_wall,
                },
                mode: ControlMode::Regimented,
                alarm: false,
            };
        }
        Decision::Allow
    }

    fn invariant_violation(&self, session: &Session, action: &Action) -> Option<DenyReason> {
        for inv in &self.charter.invariants {
            match (inv, action) {
                (Invariant::NeverTouch(globs), Action::Write { path })
                    if glob::any_matches(globs, path) =>
                {
                    return Some(DenyReason::InvariantViolated {
                        invariant: format!("never_touch {path}"),
                    });
                }
                (Invariant::NeverRun(patterns), Action::Run { .. }) => {
                    let argv = action.argv_line();
                    if patterns.iter().any(|p| glob::wildcard(p, &argv)) {
                        return Some(DenyReason::InvariantViolated {
                            invariant: format!("never_run {argv}"),
                        });
                    }
                }
                (Invariant::MaxTokens(cap), Action::Spend { tokens, .. })
                    if session.spent.tokens.saturating_add(*tokens) > *cap =>
                {
                    return Some(DenyReason::InvariantViolated {
                        invariant: format!("max_tokens {cap}"),
                    });
                }
                (Invariant::MaxWallSecs(cap), Action::Spend { wall_secs, .. })
                    if session.spent.wall_secs.saturating_add(*wall_secs) > *cap =>
                {
                    return Some(DenyReason::InvariantViolated {
                        invariant: format!("max_wall_secs {cap}"),
                    });
                }
                _ => {}
            }
        }
        None
    }

    fn approval_required(&self, action: &Action) -> Option<ActionKind> {
        for inv in &self.charter.invariants {
            if let (Invariant::ApprovalToMerge(globs), Action::Merge { branch }) = (inv, action)
                && glob::any_matches(globs, branch)
            {
                return Some(ActionKind::Merge);
            }
        }
        None
    }

    /// Records something we observed rather than decided.
    ///
    /// The decision passed in states what the observation means for *authority*, not
    /// how the work went. A diff outside scope is a denial the supervisor saw. A
    /// command that ran and exited wrong is an [`Decision::Allow`] whose target
    /// carries the exit code — running it was permitted, and failing is a verdict on
    /// the work, which the task's status already holds. Filing failures as denials
    /// would turn the denial channel into a list of red tests.
    pub fn observe(
        &mut self,
        session: &Session,
        action: Action,
        decision: Decision,
        source: Source,
    ) {
        self.seq += 1;
        self.ledger.push(Record {
            seq: self.seq,
            session: session.id.clone(),
            post: session.post.clone(),
            occupant: session.occupant.clone(),
            human: session.human.clone(),
            project: session.project.clone(),
            task: session.task.clone(),
            action,
            decision,
            source,
        });
    }

    #[must_use]
    pub fn ledger(&self) -> &[Record] {
        &self.ledger
    }

    /// Denied actions, for `wecode audit --denied`.
    pub fn denials(&self) -> impl Iterator<Item = &Record> {
        self.ledger.iter().filter(|r| {
            !r.decision.is_allowed() && !matches!(r.decision, Decision::RequireApproval { .. })
        })
    }

    /// Records that raised an alarm.
    pub fn alarms(&self) -> impl Iterator<Item = &Record> {
        self.ledger.iter().filter(|r| r.decision.raises_alarm())
    }

    /// Everything touching a path, regardless of which harness produced it.
    pub fn touching<'a>(&'a self, pattern: &'a str) -> impl Iterator<Item = &'a Record> {
        self.ledger.iter().filter(move |r| match &r.action {
            Action::Write { path } | Action::Read { path } => glob::matches(pattern, path),
            _ => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grant::Grant;

    fn session(effective: Effective) -> Session {
        Session::new("s1", "impl-api", "claude-code", effective)
            .on(Some("caching".into()), Some("cache-layer".into()))
    }

    fn confined() -> Session {
        session(Effective::of(vec![
            Grant::writer(&["crates/export/**"])
                .with_run(&["cargo *"])
                .with_spend(100_000, 1800),
        ]))
    }

    fn broker() -> Broker {
        Broker::new(Charter::with(vec![
            Invariant::NeverTouch(vec![".github/**".into(), "**/*.pem".into()]),
            Invariant::NeverRun(vec!["git push --force*".into(), "npm publish*".into()]),
            Invariant::ApprovalToMerge(vec!["main".into()]),
        ]))
    }

    #[test]
    fn allows_a_write_inside_scope() {
        let mut b = broker();
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Write {
                path: "crates/export/cache.rs".into(),
            },
        );
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn denies_a_write_outside_scope_as_sanctioned() {
        let mut b = broker();
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Write {
                path: "crates/auth/token.rs".into(),
            },
        );
        match d {
            Decision::Deny { mode, alarm, .. } => {
                assert_eq!(mode, ControlMode::Sanctioned, "scope creep is recoverable");
                assert!(!alarm);
            }
            other => panic!("expected deny, got {other:?}"),
        }
    }

    #[test]
    fn invariant_beats_a_grant_and_raises_an_alarm() {
        let mut b = broker();
        // A grant wide enough to permit it — the invariant must still win.
        let s = session(Effective::of(vec![Grant::root()]));
        let d = b.authorize(
            &s,
            &Action::Write {
                path: ".github/workflows/ci.yml".into(),
            },
        );
        assert!(d.raises_alarm(), "got {d:?}");
        match d {
            Decision::Deny { mode, .. } => assert_eq!(mode, ControlMode::Regimented),
            other => panic!("expected deny, got {other:?}"),
        }
        assert_eq!(b.alarms().count(), 1);
    }

    #[test]
    fn secrets_are_never_writable_even_at_root() {
        let mut b = broker();
        let s = session(Effective::of(vec![Grant::root()]));
        let d = b.authorize(
            &s,
            &Action::Write {
                path: "deploy/key.pem".into(),
            },
        );
        assert!(d.raises_alarm());
    }

    #[test]
    fn permitted_command_runs() {
        let mut b = broker();
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Run {
                argv: vec!["cargo".into(), "test".into(), "--workspace".into()],
            },
        );
        assert_eq!(d, Decision::Allow);
    }

    #[test]
    fn unpermitted_command_is_regimented() {
        let mut b = broker();
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Run {
                argv: vec!["curl".into(), "evil.sh".into()],
            },
        );
        match d {
            Decision::Deny { mode, alarm, .. } => {
                assert_eq!(mode, ControlMode::Regimented);
                assert!(!alarm);
            }
            other => panic!("expected deny, got {other:?}"),
        }
    }

    #[test]
    fn forbidden_command_raises_an_alarm() {
        let mut b = broker();
        let s = session(Effective::of(vec![Grant::root()]));
        let d = b.authorize(
            &s,
            &Action::Run {
                argv: vec!["git".into(), "push".into(), "--force".into()],
            },
        );
        assert!(d.raises_alarm(), "got {d:?}");
    }

    #[test]
    fn spend_within_cap_is_allowed() {
        let mut b = broker();
        let s = confined();
        assert_eq!(
            b.authorize(
                &s,
                &Action::Spend {
                    tokens: 50_000,
                    wall_secs: 300
                }
            ),
            Decision::Allow
        );
    }

    #[test]
    fn spend_over_cap_is_denied() {
        let mut b = broker();
        let mut s = confined();
        s.spent = Spend {
            tokens: 90_000,
            wall_secs: 0,
        };
        let d = b.authorize(
            &s,
            &Action::Spend {
                tokens: 20_000,
                wall_secs: 0,
            },
        );
        assert!(matches!(
            d,
            Decision::Deny {
                reason: DenyReason::TokenBudgetExhausted { .. },
                ..
            }
        ));
    }

    #[test]
    fn spend_far_over_cap_raises_an_alarm() {
        let mut b = Broker::new(Charter::default());
        let mut s = confined();
        s.spent = Spend {
            tokens: 100_000,
            wall_secs: 0,
        };
        // 260k against a 100k cap is past 150%, so the allocator itself is suspect.
        let d = b.authorize(
            &s,
            &Action::Spend {
                tokens: 60_000,
                wall_secs: 0,
            },
        );
        assert!(d.raises_alarm(), "got {d:?}");
    }

    #[test]
    fn merging_a_protected_branch_needs_approval() {
        let mut b = broker();
        let s = session(Effective::of(vec![Grant::root()]));
        assert_eq!(
            b.authorize(
                &s,
                &Action::Merge {
                    branch: "main".into()
                }
            ),
            Decision::RequireApproval {
                by: ActionKind::Merge
            }
        );
    }

    #[test]
    fn merging_an_unprotected_branch_is_allowed_with_the_capability() {
        let mut b = broker();
        let s = session(Effective::of(vec![Grant::root()]));
        assert_eq!(
            b.authorize(
                &s,
                &Action::Merge {
                    branch: "wecode/run-1".into()
                }
            ),
            Decision::Allow
        );
    }

    #[test]
    fn a_post_without_merge_capability_cannot_merge() {
        let mut b = Broker::new(Charter::default());
        let s = confined(); // merge_to is empty
        let d = b.authorize(
            &s,
            &Action::Merge {
                branch: "topic".into(),
            },
        );
        assert!(matches!(
            d,
            Decision::Deny {
                reason: DenyReason::BranchNotPermitted { .. },
                ..
            }
        ));
    }

    #[test]
    fn introspection_is_denied_by_default() {
        let mut b = Broker::new(Charter::default());
        let s = confined();
        let d = b.authorize(
            &s,
            &Action::Introspect {
                level: Introspect::Own,
            },
        );
        assert!(matches!(
            d,
            Decision::Deny {
                reason: DenyReason::CapabilityMissing { what: "introspect" },
                ..
            }
        ));
    }

    #[test]
    fn introspection_is_capped_at_the_granted_level() {
        let mut b = Broker::new(Charter::default());
        let s = session(Effective::of(vec![
            Grant::writer(&["src/**"]).with_introspect(Introspect::Own),
        ]));
        assert_eq!(
            b.authorize(
                &s,
                &Action::Introspect {
                    level: Introspect::Own
                }
            ),
            Decision::Allow
        );
        assert!(
            !b.authorize(
                &s,
                &Action::Introspect {
                    level: Introspect::Tree
                }
            )
            .is_allowed()
        );
    }

    #[test]
    fn a_post_cannot_define_measures() {
        let mut b = Broker::new(Charter::default());
        let s = confined();
        // The executor-never-defines rule, enforced rather than requested.
        let d = b.authorize(
            &s,
            &Action::Define {
                kind: WorkKind::Task,
            },
        );
        assert!(matches!(
            d,
            Decision::Deny {
                reason: DenyReason::CapabilityMissing { what: "define" },
                ..
            }
        ));
    }

    #[test]
    fn every_decision_is_recorded_with_its_authority() {
        let mut b = broker();
        let s = confined();
        b.authorize(
            &s,
            &Action::Write {
                path: "crates/export/a.rs".into(),
            },
        );
        b.authorize(
            &s,
            &Action::Write {
                path: "secrets/x.pem".into(),
            },
        );
        assert_eq!(b.ledger().len(), 2);
        assert_eq!(b.ledger()[0].seq, 1);
        assert_eq!(b.ledger()[1].seq, 2);
        assert_eq!(b.ledger()[0].post, "impl-api");
        assert_eq!(b.ledger()[0].occupant, "claude-code");
        assert_eq!(b.denials().count(), 1);
    }

    #[test]
    fn observed_facts_are_marked_by_source() {
        let mut b = Broker::new(Charter::default());
        let s = confined();
        b.observe(
            &s,
            Action::Write {
                path: "crates/export/a.rs".into(),
            },
            Decision::Allow,
            Source::Supervisor,
        );
        b.observe(
            &s,
            Action::Run {
                argv: vec!["cargo".into()],
            },
            Decision::Allow,
            Source::Harness,
        );
        let sources: Vec<_> = b.ledger().iter().map(|r| r.source).collect();
        assert_eq!(sources, vec![Source::Supervisor, Source::Harness]);
    }

    #[test]
    fn an_observed_violation_is_a_denial_the_supervisor_saw() {
        // A write outside scope found in the diff is not a decision we made — it
        // already happened. It still has to reach the ledger as a denial, or the
        // post-hoc check has nowhere to report.
        let mut b = Broker::new(Charter::default());
        let s = confined();
        b.observe(
            &s,
            Action::Write {
                path: "somewhere/else.rs".into(),
            },
            Decision::Deny {
                reason: DenyReason::OutsideWriteScope {
                    path: "somewhere/else.rs".into(),
                },
                mode: ControlMode::Sanctioned,
                alarm: false,
            },
            Source::Supervisor,
        );
        assert_eq!(b.denials().count(), 1);
        assert_eq!(b.ledger()[0].source, Source::Supervisor);
    }

    #[test]
    fn an_observed_failure_is_not_a_denial() {
        // The counterpart to the violation above. An acceptance command that ran and
        // exited wrong breached no authority — the supervisor ran it itself. It
        // reaches the ledger allowed, with the exit code on the line, so the denial
        // channel stays about authority rather than filling with red tests.
        let mut b = Broker::new(Charter::default());
        let s = confined();
        b.observe(
            &s,
            Action::Run {
                argv: vec!["cargo test — exit 101, wanted 0".into()],
            },
            Decision::Allow,
            Source::Supervisor,
        );
        assert_eq!(b.denials().count(), 0);
        assert_eq!(b.ledger().len(), 1, "the failure is still on the record");
    }

    #[test]
    fn ledger_answers_cross_harness_path_questions() {
        let mut b = Broker::new(Charter::default());
        let a = Session::new(
            "s1",
            "impl",
            "claude-code",
            Effective::of(vec![Grant::root()]),
        );
        let c = Session::new("s2", "test", "codex", Effective::of(vec![Grant::root()]));
        b.authorize(
            &a,
            &Action::Write {
                path: "crates/auth/token.rs".into(),
            },
        );
        b.authorize(
            &c,
            &Action::Write {
                path: "crates/auth/tests.rs".into(),
            },
        );
        b.authorize(
            &c,
            &Action::Write {
                path: "docs/readme.md".into(),
            },
        );

        let touched: Vec<_> = b
            .touching("crates/auth/**")
            .map(|r| r.occupant.as_str())
            .collect();
        assert_eq!(touched, vec!["claude-code", "codex"]);
    }
}
