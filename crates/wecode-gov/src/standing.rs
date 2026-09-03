//! Standing orders: what the operator authorised before there was a task to sign for.
//!
//! [`Invariant::ApprovalToMerge`] demands a holder's signature per merge, and that is
//! right for the branch nobody lands on twice a day. It is wrong for the branch somebody
//! lands on twice a day: the signature stops being a decision and becomes a keystroke,
//! and a keystroke is not authority. The operator who types it every time is not
//! governing the merge, they are the merge.
//!
//! So the other way to say yes. A standing order is the same permission given once, in
//! `company.toml`, under conditions the Broker can check — and it is given *in the open*,
//! in a file that arrives in a diff, rather than on a signature nobody reviews. That
//! distinction is the whole of why this is not an [`Exception`](crate::broker::Exception):
//! an exception is one task's carve-out on one holder's signature, and
//! [`Lifted`](crate::broker::Lifted) deliberately refuses to reach the merge invariant,
//! because lifting it *on a signature* would launder away the very signature it exists to
//! demand. Amending what the charter demands is an amendment, and an amendment is
//! hand-edited config.
//!
//! What a standing order is not is a grant. The seat still has to hold `merge_to` for the
//! branch: this settles whether a *person* has to be asked, never whether the seat may
//! act. Two locks, and this opens one of them.
//!
//! [`Invariant::ApprovalToMerge`]: crate::broker::Invariant::ApprovalToMerge

use crate::glob;

/// One merge the operator pre-authorised, by condition.
///
/// The conditions are only ever things authorisation already knows — the branch being
/// landed on and the project the work belongs to. Nothing about the diff: the Broker
/// decides as a pure function of its inputs, and a size or a file list would make the
/// answer depend on reading a repository.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StandingOrder {
    to: String,
    projects: Vec<String>,
}

impl StandingOrder {
    /// A standing order over every project's merges into `to`, which is a glob.
    #[must_use]
    pub fn to_merge(to: impl Into<String>) -> Self {
        Self {
            to: to.into(),
            projects: Vec::new(),
        }
    }

    /// Narrows it to the named projects. An empty list leaves it open to all of them.
    #[must_use]
    pub fn for_projects(mut self, projects: &[String]) -> Self {
        self.projects = projects.to_vec();
        self
    }

    /// The branch glob it was written about.
    #[must_use]
    pub fn branch(&self) -> &str {
        &self.to
    }

    /// The projects it is confined to, empty for all of them.
    #[must_use]
    pub fn projects(&self) -> &[String] {
        &self.projects
    }

    /// Whether this covers landing `project`'s work on `branch`.
    ///
    /// A confined order and a session naming no project is *not* covered. The condition
    /// is the whole of what makes a standing order narrower than deleting the invariant,
    /// so an order whose condition cannot be evaluated has to fall back to the signature
    /// rather than to itself.
    pub(crate) fn covers(&self, project: Option<&str>, branch: &str) -> bool {
        glob::matches(&self.to, branch)
            && (self.projects.is_empty()
                || project.is_some_and(|p| self.projects.iter().any(|q| q == p)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::{Action, Broker, Charter, Decision, DenyReason, Invariant, Session};
    use crate::grant::{ActionKind, Effective, Grant};

    fn projects(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_string()).collect()
    }

    #[test]
    fn an_open_order_covers_every_project_and_only_its_own_branches() {
        let o = StandingOrder::to_merge("release/*");
        assert!(o.covers(Some("docs"), "release/2026-09"));
        assert!(o.covers(None, "release/2026-09"));
        assert!(!o.covers(Some("docs"), "master"));
        // One segment, as `*` means everywhere else in this language.
        assert!(!o.covers(Some("docs"), "release/hotfix/2026-09"));
    }

    #[test]
    fn a_confined_order_covers_the_projects_it_names_and_no_others() {
        let o = StandingOrder::to_merge("master").for_projects(&projects(&["docs", "site"]));
        assert!(o.covers(Some("docs"), "master"));
        assert!(o.covers(Some("site"), "master"));
        assert!(!o.covers(Some("payments"), "master"));
    }

    #[test]
    fn a_condition_that_cannot_be_evaluated_is_not_met() {
        // The defect this shape exists to prevent: an order written about one project
        // covering a merge that never said which project it was for.
        let o = StandingOrder::to_merge("master").for_projects(&projects(&["docs"]));
        assert!(!o.covers(None, "master"));
    }

    // --------------------------------------------- what the Broker does with one ------

    /// Two protected branches, and a standing order over one of them.
    fn pre_authorising(confined_to: &[&str]) -> Broker {
        Broker::new(
            Charter::with(vec![Invariant::ApprovalToMerge(vec![
                "main".into(),
                "release/**".into(),
            ])])
            .pre_authorising(vec![
                StandingOrder::to_merge("main").for_projects(&projects(confined_to)),
            ]),
        )
    }

    fn merging(branch: &str) -> Action {
        Action::Merge {
            branch: branch.into(),
        }
    }

    /// A session on `caching`, holding everything, so only the charter can stop it.
    fn on_caching(effective: Effective) -> Session {
        Session::new("s1", "chief", "claude-code", effective).on(Some("caching".into()), None)
    }

    #[test]
    fn a_standing_order_lands_a_protected_merge_with_no_signature() {
        // The whole feature: the invariant still protects `main`, and this merge does not
        // stop on a person, because the operator already said yes to merges of its shape.
        let mut b = pre_authorising(&["caching"]);
        let s = on_caching(Effective::of(vec![Grant::root()]));
        assert_eq!(b.authorize(&s, &merging("main")), Decision::Allow);
    }

    #[test]
    fn a_standing_order_covers_only_the_condition_it_names() {
        // Two ways past it, both closed: another project's merge onto the branch the
        // order names, and this project's merge onto a branch it never mentioned.
        let s = on_caching(Effective::of(vec![Grant::root()]));
        let wants = Decision::RequireApproval {
            by: ActionKind::Merge,
        };
        assert_eq!(
            pre_authorising(&["payments"]).authorize(&s, &merging("main")),
            wants
        );
        assert_eq!(
            pre_authorising(&["caching"]).authorize(&s, &merging("release/2026-09")),
            wants,
            "release/** is protected and no order reaches it"
        );
    }

    #[test]
    fn a_standing_order_is_not_a_grant() {
        // It settles whether a person has to be asked, never whether the seat may act. A
        // pre-authorised branch the seat does not hold is refused as it always was — and
        // refused rather than gated, because no signature would help.
        let s = on_caching(Effective::of(vec![Grant::writer(&["src/**"])]));
        let d = pre_authorising(&["caching"]).authorize(&s, &merging("main"));
        assert!(
            matches!(
                d,
                Decision::Deny {
                    reason: DenyReason::BranchNotPermitted { .. },
                    ..
                }
            ),
            "got {d:?}"
        );
    }
}
