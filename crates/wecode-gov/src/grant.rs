//! Capability grants, and the two operations that matter: narrowing on
//! delegation, and intersecting to an effective grant.

use std::collections::BTreeSet;

use crate::glob;

/// The two levels of work authority can be granted over.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum WorkKind {
    Project,
    Task,
}

impl WorkKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Task => "task",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "project" => Some(Self::Project),
            "task" => Some(Self::Task),
            _ => None,
        }
    }
}

/// Things a holder may approve.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum ActionKind {
    Merge,
    Admission,
    /// Signing off a proposal before anything is built on it.
    Design,
    BudgetIncrease,
    MeasureAmendment,
}

impl ActionKind {
    /// The name an operator types and the ledger stores. Lived in the old codec,
    /// which meant the CLI could name an approval the store did not recognise; it
    /// belongs next to the variants it names.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Admission => "admission",
            Self::Design => "design",
            Self::BudgetIncrease => "budget-increase",
            Self::MeasureAmendment => "measure-amendment",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "merge" => Self::Merge,
            "admission" => Self::Admission,
            "design" => Self::Design,
            "budget" | "budget-increase" => Self::BudgetIncrease,
            "measure" | "measure-amendment" => Self::MeasureAmendment,
            _ => return None,
        })
    }

    #[must_use]
    pub fn all() -> &'static [Self] {
        &[
            Self::Merge,
            Self::Admission,
            Self::Design,
            Self::BudgetIncrease,
            Self::MeasureAmendment,
        ]
    }
}

/// How far a post may see beyond its own envelope.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Debug)]
pub enum Introspect {
    /// Envelope only. The default: information access is authority.
    #[default]
    None,
    /// Own intent, its acceptance and its ancestors.
    Own,
    /// The whole tree.
    Tree,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Debug)]
pub enum Network {
    #[default]
    None,
    /// Only hosts named in the grant.
    Allowlist,
    Any,
}

/// What a unit, role or assignment permits.
///
/// A grant is an *evaluator*, not a set to be recombined: intersecting two grants
/// means "both must allow", which [`Effective`] expresses directly. Trying to
/// compute an intersected glob set instead would be both hard and wrong.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct Grant {
    pub read: Vec<String>,
    pub write: Vec<String>,
    /// Command patterns, matched against the joined argv.
    pub run: Vec<String>,
    pub network: Network,
    pub hosts: Vec<String>,
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
    pub merge_to: Vec<String>,
    pub approve: BTreeSet<ActionKind>,
    pub define: BTreeSet<WorkKind>,
    pub introspect: Introspect,
    pub staff: bool,
}

impl Grant {
    /// The widest possible grant. Held by the operator; almost never exercised —
    /// breadth of authority and frequency of action are inversely related.
    #[must_use]
    pub fn root() -> Self {
        Self {
            read: vec!["**".into()],
            write: vec!["**".into()],
            run: vec!["*".into()],
            network: Network::Any,
            hosts: Vec::new(),
            tokens: None,
            wall_secs: None,
            merge_to: vec!["**".into()],
            approve: [
                ActionKind::Merge,
                ActionKind::Admission,
                ActionKind::Design,
                ActionKind::BudgetIncrease,
                ActionKind::MeasureAmendment,
            ]
            .into(),
            define: [WorkKind::Project, WorkKind::Task].into(),
            introspect: Introspect::Tree,
            staff: true,
        }
    }

    #[must_use]
    pub fn writer(paths: &[&str]) -> Self {
        Self {
            write: paths.iter().map(|p| (*p).to_string()).collect(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn with_read(mut self, paths: &[&str]) -> Self {
        self.read = paths.iter().map(|p| (*p).to_string()).collect();
        self
    }

    #[must_use]
    pub fn with_run(mut self, patterns: &[&str]) -> Self {
        self.run = patterns.iter().map(|p| (*p).to_string()).collect();
        self
    }

    #[must_use]
    pub fn with_spend(mut self, tokens: u64, wall_secs: u64) -> Self {
        self.tokens = Some(tokens);
        self.wall_secs = Some(wall_secs);
        self
    }

    #[must_use]
    pub fn with_approve(mut self, kinds: &[ActionKind]) -> Self {
        self.approve = kinds.iter().copied().collect();
        self
    }

    #[must_use]
    pub fn with_introspect(mut self, level: Introspect) -> Self {
        self.introspect = level;
        self
    }

    pub fn allows_write(&self, path: &str) -> bool {
        glob::any_matches(&self.write, path)
    }

    pub fn allows_read(&self, path: &str) -> bool {
        // Anything writable is implicitly readable.
        glob::any_matches(&self.read, path) || self.allows_write(path)
    }

    pub fn allows_run(&self, argv: &str) -> bool {
        self.run.iter().any(|p| glob::wildcard(p, argv))
    }

    pub fn allows_merge(&self, branch: &str) -> bool {
        glob::any_matches(&self.merge_to, branch)
    }

    pub fn allows_host(&self, host: &str) -> bool {
        match self.network {
            Network::None => false,
            Network::Any => true,
            Network::Allowlist => self.hosts.iter().any(|h| glob::wildcard(h, host)),
        }
    }

    /// Whether this grant is no wider than `parent` — the delegation rule.
    ///
    /// Both RBAC's no-escalation constraint and VSM variety attenuation, which turn
    /// out to be the same rule seen from two theories.
    #[must_use]
    pub fn narrows(&self, parent: &Self) -> bool {
        fn paths_within(child: &[String], parent: &[String]) -> bool {
            child
                .iter()
                .all(|c| parent.iter().any(|p| glob::covers(p, c)))
        }
        fn cap_within(child: Option<u64>, parent: Option<u64>) -> bool {
            match (child, parent) {
                (_, None) => true,        // parent is unlimited
                (None, Some(_)) => false, // child would be unlimited
                (Some(c), Some(p)) => c <= p,
            }
        }

        paths_within(&self.read, &parent.read)
            && paths_within(&self.write, &parent.write)
            && paths_within(&self.merge_to, &parent.merge_to)
            && self
                .run
                .iter()
                .all(|c| parent.run.iter().any(|p| glob::wildcard(p, c) || p == c))
            && self.network <= parent.network
            && cap_within(self.tokens, parent.tokens)
            && cap_within(self.wall_secs, parent.wall_secs)
            && self.approve.is_subset(&parent.approve)
            && self.define.is_subset(&parent.define)
            && self.introspect <= parent.introspect
            && (!self.staff || parent.staff)
    }

    /// Delegates `requested` downward, refusing anything wider than self.
    pub fn delegate(&self, requested: &Self) -> Result<Self, Escalation> {
        if requested.narrows(self) {
            Ok(requested.clone())
        } else {
            Err(Escalation)
        }
    }
}

/// A delegation that would have widened authority.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Escalation;

impl std::fmt::Display for Escalation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("delegation would widen authority")
    }
}

impl std::error::Error for Escalation {}

/// The intersection of every grant bearing on one session: unit, role, assignment.
///
/// An action is permitted only if *every* member permits it. Never a union.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct Effective {
    grants: Vec<Grant>,
}

impl Effective {
    #[must_use]
    pub fn of(grants: Vec<Grant>) -> Self {
        Self { grants }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.grants.is_empty()
    }

    /// An empty intersection permits nothing, which is the safe default.
    fn all(&self, f: impl Fn(&Grant) -> bool) -> bool {
        !self.grants.is_empty() && self.grants.iter().all(f)
    }

    pub fn allows_write(&self, path: &str) -> bool {
        self.all(|g| g.allows_write(path))
    }

    pub fn allows_read(&self, path: &str) -> bool {
        self.all(|g| g.allows_read(path))
    }

    pub fn allows_run(&self, argv: &str) -> bool {
        self.all(|g| g.allows_run(argv))
    }

    pub fn allows_merge(&self, branch: &str) -> bool {
        self.all(|g| g.allows_merge(branch))
    }

    pub fn allows_host(&self, host: &str) -> bool {
        self.all(|g| g.allows_host(host))
    }

    pub fn allows_approve(&self, kind: ActionKind) -> bool {
        self.all(|g| g.approve.contains(&kind))
    }

    pub fn allows_define(&self, kind: WorkKind) -> bool {
        self.all(|g| g.define.contains(&kind))
    }

    pub fn allows_staff(&self) -> bool {
        self.all(|g| g.staff)
    }

    #[must_use]
    pub fn introspect(&self) -> Introspect {
        self.grants
            .iter()
            .map(|g| g.introspect)
            .min()
            .unwrap_or_default()
    }

    /// The tightest cap across all grants.
    #[must_use]
    pub fn token_cap(&self) -> Option<u64> {
        self.grants.iter().filter_map(|g| g.tokens).min()
    }

    #[must_use]
    pub fn wall_cap(&self) -> Option<u64> {
        self.grants.iter().filter_map(|g| g.wall_secs).min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_allows_everything() {
        let g = Grant::root();
        assert!(g.allows_write("infra/prod/main.tf"));
        assert!(g.allows_run("rm -rf /"));
        assert!(g.allows_merge("main"));
        assert!(g.allows_host("example.com"));
    }

    #[test]
    fn writer_is_confined_to_its_paths() {
        let g = Grant::writer(&["crates/export/**"]);
        assert!(g.allows_write("crates/export/cache.rs"));
        assert!(!g.allows_write("crates/auth/token.rs"));
        assert!(!g.allows_write("Cargo.lock"));
    }

    #[test]
    fn writable_implies_readable() {
        let g = Grant::writer(&["src/**"]);
        assert!(g.allows_read("src/lib.rs"));
        assert!(!g.allows_read("secrets/key.pem"));
    }

    #[test]
    fn network_is_denied_by_default() {
        let g = Grant::writer(&["src/**"]);
        assert!(!g.allows_host("crates.io"));
    }

    #[test]
    fn network_allowlist_is_honoured() {
        let mut g = Grant::writer(&["src/**"]);
        g.network = Network::Allowlist;
        g.hosts = vec!["*.crates.io".into()];
        assert!(g.allows_host("static.crates.io"));
        assert!(!g.allows_host("evil.example.com"));
    }

    #[test]
    fn narrowing_is_accepted() {
        let parent = Grant::writer(&["crates/**"]).with_spend(200_000, 1800);
        let child = Grant::writer(&["crates/export/**"]).with_spend(50_000, 600);
        assert!(child.narrows(&parent));
        assert!(parent.delegate(&child).is_ok());
    }

    #[test]
    fn widening_paths_is_refused() {
        let parent = Grant::writer(&["crates/export/**"]);
        let child = Grant::writer(&["crates/**"]);
        assert!(!child.narrows(&parent));
        assert_eq!(parent.delegate(&child), Err(Escalation));
    }

    #[test]
    fn raising_a_cap_is_refused() {
        let parent = Grant::writer(&["src/**"]).with_spend(1000, 60);
        let child = Grant::writer(&["src/**"]).with_spend(5000, 60);
        assert!(!child.narrows(&parent));
    }

    #[test]
    fn removing_a_cap_is_refused() {
        let parent = Grant::writer(&["src/**"]).with_spend(1000, 60);
        let child = Grant::writer(&["src/**"]); // tokens: None == unlimited
        assert!(!child.narrows(&parent));
    }

    #[test]
    fn granting_an_unheld_approval_is_refused() {
        let parent = Grant::writer(&["src/**"]);
        let child = Grant::writer(&["src/**"]).with_approve(&[ActionKind::Merge]);
        assert!(!child.narrows(&parent));
    }

    #[test]
    fn widening_introspection_is_refused() {
        let parent = Grant::writer(&["src/**"]).with_introspect(Introspect::Own);
        let ok = Grant::writer(&["src/**"]).with_introspect(Introspect::None);
        let bad = Grant::writer(&["src/**"]).with_introspect(Introspect::Tree);
        assert!(ok.narrows(&parent));
        assert!(!bad.narrows(&parent));
    }

    #[test]
    fn claiming_staff_without_holding_it_is_refused() {
        let parent = Grant::writer(&["src/**"]);
        let mut child = Grant::writer(&["src/**"]);
        child.staff = true;
        assert!(!child.narrows(&parent));
    }

    #[test]
    fn effective_is_an_intersection_not_a_union() {
        let unit = Grant::writer(&["crates/**"]);
        let project = Grant::writer(&["crates/export/**"]);
        let e = Effective::of(vec![unit, project]);
        assert!(e.allows_write("crates/export/cache.rs"));
        // Permitted by the unit grant alone, but not by the project grant.
        assert!(!e.allows_write("crates/auth/token.rs"));
    }

    #[test]
    fn empty_effective_permits_nothing() {
        let e = Effective::default();
        assert!(e.is_empty());
        assert!(!e.allows_write("anything"));
        assert!(!e.allows_run("true"));
        assert!(!e.allows_staff());
    }

    #[test]
    fn effective_takes_the_tightest_cap() {
        let a = Grant::writer(&["src/**"]).with_spend(200_000, 1800);
        let b = Grant::writer(&["src/**"]).with_spend(50_000, 600);
        let e = Effective::of(vec![a, b]);
        assert_eq!(e.token_cap(), Some(50_000));
        assert_eq!(e.wall_cap(), Some(600));
    }

    #[test]
    fn effective_takes_the_narrowest_introspection() {
        let a = Grant::writer(&["src/**"]).with_introspect(Introspect::Tree);
        let b = Grant::writer(&["src/**"]).with_introspect(Introspect::None);
        assert_eq!(Effective::of(vec![a, b]).introspect(), Introspect::None);
    }
}
