//! The evaluation: invariants, then the signatures, then the grant.
//!
//! The order is the design. A charter invariant is checked before any grant, because a
//! grant that permits an invariant violation is itself the bug — see [`Broker::decide`].

use crate::glob;
use crate::grant::{ActionKind, Introspect};

use super::{Action, Broker, ControlMode, Decision, DenyReason, Invariant, Lifted, Session};

impl Broker {
    /// Charter invariants are checked before grants, because a grant that permits
    /// an invariant violation is itself the bug.
    pub(super) fn decide(&self, session: &Session, action: &Action) -> Decision {
        if let Some(reason) = self.invariant_violation(session, action) {
            return Decision::Deny {
                reason,
                mode: ControlMode::Regimented,
                alarm: true,
            };
        }
        if let Some(kind) = self.approval_required(session, action) {
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

    /// A signed [`Exception`] is consulted here and nowhere else, because this is the
    /// only place an invariant decides anything. It excuses the breach; it does not
    /// remove the invariant, which still binds every other task's sessions.
    fn invariant_violation(&self, session: &Session, action: &Action) -> Option<DenyReason> {
        for inv in &self.charter.invariants {
            match (inv, action) {
                (Invariant::NeverTouch(globs), Action::Write { path })
                    if glob::any_matches(globs, path)
                        && !self.excused(session, Lifted::Touch, path) =>
                {
                    return Some(DenyReason::InvariantViolated {
                        invariant: format!("never_touch {path}"),
                    });
                }
                (Invariant::NeverRun(patterns), Action::Run { .. }) => {
                    let argv = action.argv_line();
                    if patterns.iter().any(|p| glob::wildcard(p, &argv))
                        && !self.excused(session, Lifted::Run, &argv)
                    {
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

    /// Whether this action stops on a person, and which signature it stops on.
    ///
    /// A [`StandingOrder`] is consulted here and nowhere else, because this is the only
    /// place a signature is demanded. It does not remove the invariant: every merge the
    /// operator did not pre-authorise still stops here, and the seat still has to hold
    /// the branch either way.
    fn approval_required(&self, session: &Session, action: &Action) -> Option<ActionKind> {
        let Action::Merge { branch } = action else {
            return None;
        };
        self.charter
            .demands_signature_to_merge(session.project.as_deref(), branch)
            .then_some(ActionKind::Merge)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::fixture::{broker, confined, session};
    use crate::broker::{Charter, Spend};
    use crate::grant::{Effective, Grant, WorkKind};

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
}
