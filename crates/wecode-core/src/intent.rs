//! The intent ontology: one recursive node whose `kind` gates its grammar.

use serde::{Deserialize, Serialize};

use crate::id::IntentId;

/// Where an intent sits between "why we exist" and "run this command".
///
/// Borrowed from HTN planning: compound kinds cannot execute and must decompose;
/// only [`IntentKind::Task`] is primitive.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentKind {
    Vision,
    Goal,
    Project,
    Task,
}

impl IntentKind {
    /// Directly executable by one post. Only tasks are.
    #[must_use]
    pub fn is_primitive(self) -> bool {
        matches!(self, Self::Task)
    }

    /// May be handed to a unit. A goal is reached by satisfying children.
    #[must_use]
    pub fn is_assignable(self) -> bool {
        matches!(self, Self::Project | Self::Task)
    }

    /// Kinds that may legally be this kind's parent.
    #[must_use]
    pub fn valid_parents(self) -> &'static [IntentKind] {
        match self {
            Self::Vision => &[],
            Self::Goal => &[Self::Vision, Self::Goal],
            Self::Project => &[Self::Goal, Self::Project],
            Self::Task => &[Self::Project, Self::Task],
        }
    }

    /// Whether at least one measure that is not `Proxy` is required.
    #[must_use]
    pub fn requires_executable_measure(self) -> bool {
        matches!(self, Self::Goal | Self::Project | Self::Task)
    }

    /// Whether a write scope must be declared.
    #[must_use]
    pub fn requires_scope(self) -> bool {
        self.is_assignable()
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vision => "vision",
            Self::Goal => "goal",
            Self::Project => "project",
            Self::Task => "task",
        }
    }
}

/// Time horizon. Ordered so a child's horizon may never exceed its parent's.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Horizon {
    Now,
    Week,
    Month,
    Quarter,
    Year,
    Indefinite,
}

/// Which sphere of life an intent belongs to. Orthogonal to the tree, so a
/// personal goal can be a root without registering as organisational drift.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sphere {
    Org,
    Unit(String),
    Personal,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Polarity {
    Positive,
    Negative,
}

/// Why an intent legitimately has no parent.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandaloneReason {
    Maintenance,
    Urgent,
    Exploration,
    Personal,
}

/// How an intent serves its parent.
///
/// `Requires`/`Alternative` are KAOS AND/OR refinement; `Contributes` is GRL's
/// contribution link with polarity.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Link {
    Contributes { rationale: String, polarity: Polarity },
    /// AND: the parent needs every such child.
    Requires,
    /// OR: any one such child satisfies the parent.
    Alternative,
    /// Deliberately unaligned, with a stated reason.
    Standalone { reason: StandaloneReason },
    /// Drift: arrived without triage. A defect, not a normal state.
    Unlinked,
}

impl Link {
    /// Whether this link implies a parent must be present.
    #[must_use]
    pub fn needs_parent(&self) -> bool {
        matches!(self, Self::Contributes { .. } | Self::Requires | Self::Alternative)
    }

    #[must_use]
    pub fn is_unlinked(&self) -> bool {
        matches!(self, Self::Unlinked)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cmp {
    Lt,
    Lte,
    Gt,
    Gte,
    Eq,
}

/// How we know an intent is progressing. Ordered by trustworthiness: a command
/// either exits zero or it does not; a judgement is an opinion.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Measure {
    Command { cmd: String, expect_status: i32 },
    Metric { name: String, target: f64, cmp: Cmp },
    Deliverable { path: String },
    /// Derived from children rather than measured here.
    Rollup,
    /// Human-judged. Legal only on a vision.
    Proxy { note: String },
}

impl Measure {
    /// Whether this measure can be evaluated without asking anyone.
    #[must_use]
    pub fn is_executable(&self) -> bool {
        matches!(self, Self::Command { .. } | Self::Metric { .. } | Self::Deliverable { .. })
    }
}

/// Paths an intent may read and write. Write globs are the enforced guardrail.
#[derive(Clone, PartialEq, Eq, Default, Debug, Serialize, Deserialize)]
pub struct Scope {
    #[serde(default)]
    pub read: Vec<String>,
    #[serde(default)]
    pub write: Vec<String>,
}

impl Scope {
    #[must_use]
    pub fn write(globs: &[&str]) -> Self {
        Self { read: Vec::new(), write: globs.iter().map(|g| (*g).to_string()).collect() }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.read.is_empty() && self.write.is_empty()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug, Serialize, Deserialize)]
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

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    Draft,
    Active,
    Blocked,
    Done,
    Dropped,
}

/// One node of the intent tree, at any level.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Intent {
    pub id: IntentId,
    pub kind: IntentKind,
    /// One imperative sentence naming a single outcome.
    pub statement: String,
    pub parent: Option<IntentId>,
    pub link: Link,
    pub sphere: Sphere,
    pub horizon: Horizon,
    /// Relative priority among siblings.
    pub weight: f32,
    #[serde(default)]
    pub measures: Vec<Measure>,
    #[serde(default)]
    pub scope: Scope,
    #[serde(default)]
    pub budget: Budget,
    #[serde(default)]
    pub status: Status,
}

impl Intent {
    /// A minimal intent: unlinked, org sphere, no measures. Use the builder
    /// methods to fill it in — admission will report whatever is still missing.
    pub fn new(id: impl Into<IntentId>, kind: IntentKind, statement: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind,
            statement: statement.into(),
            parent: None,
            link: Link::Unlinked,
            sphere: Sphere::Org,
            horizon: match kind {
                IntentKind::Vision => Horizon::Indefinite,
                IntentKind::Goal => Horizon::Quarter,
                IntentKind::Project => Horizon::Month,
                IntentKind::Task => Horizon::Week,
            },
            weight: 1.0,
            measures: Vec::new(),
            scope: Scope::default(),
            budget: Budget::default(),
            status: Status::Draft,
        }
    }

    #[must_use]
    pub fn under(mut self, parent: impl Into<IntentId>, link: Link) -> Self {
        self.parent = Some(parent.into());
        self.link = link;
        self
    }

    #[must_use]
    pub fn standalone(mut self, reason: StandaloneReason) -> Self {
        self.parent = None;
        self.link = Link::Standalone { reason };
        self
    }

    #[must_use]
    pub fn measured(mut self, measure: Measure) -> Self {
        self.measures.push(measure);
        self
    }

    #[must_use]
    pub fn scoped(mut self, scope: Scope) -> Self {
        self.scope = scope;
        self
    }

    #[must_use]
    pub fn budgeted(mut self, budget: Budget) -> Self {
        self.budget = budget;
        self
    }

    #[must_use]
    pub fn horizon(mut self, horizon: Horizon) -> Self {
        self.horizon = horizon;
        self
    }

    #[must_use]
    pub fn sphere(mut self, sphere: Sphere) -> Self {
        self.sphere = sphere;
        self
    }

    #[must_use]
    pub fn has_executable_measure(&self) -> bool {
        self.measures.iter().any(Measure::is_executable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tasks_are_primitive() {
        assert!(IntentKind::Task.is_primitive());
        for k in [IntentKind::Vision, IntentKind::Goal, IntentKind::Project] {
            assert!(!k.is_primitive(), "{k:?} must decompose");
        }
    }

    #[test]
    fn goals_are_not_assignable() {
        assert!(!IntentKind::Goal.is_assignable());
        assert!(!IntentKind::Vision.is_assignable());
        assert!(IntentKind::Project.is_assignable());
        assert!(IntentKind::Task.is_assignable());
    }

    #[test]
    fn vision_admits_no_parent_kind() {
        assert!(IntentKind::Vision.valid_parents().is_empty());
        assert!(IntentKind::Task.valid_parents().contains(&IntentKind::Project));
        assert!(!IntentKind::Task.valid_parents().contains(&IntentKind::Goal));
    }

    #[test]
    fn horizon_orders_shortest_first() {
        assert!(Horizon::Now < Horizon::Week);
        assert!(Horizon::Week < Horizon::Quarter);
        assert!(Horizon::Year < Horizon::Indefinite);
    }

    #[test]
    fn proxy_and_rollup_are_not_executable() {
        assert!(!Measure::Proxy { note: "vibes".into() }.is_executable());
        assert!(!Measure::Rollup.is_executable());
        assert!(Measure::Command { cmd: "cargo test".into(), expect_status: 0 }.is_executable());
    }

    #[test]
    fn standalone_clears_parent() {
        let i = Intent::new("chore", IntentKind::Task, "bump deps")
            .under("proj", Link::Requires)
            .standalone(StandaloneReason::Maintenance);
        assert!(i.parent.is_none());
        assert!(!i.link.needs_parent());
    }

    #[test]
    fn round_trips_through_json() {
        let i = Intent::new("t", IntentKind::Task, "write tests")
            .under("p", Link::Requires)
            .measured(Measure::Command { cmd: "cargo test".into(), expect_status: 0 })
            .scoped(Scope::write(&["tests/**"]));
        let json = serde_json::to_string(&i).unwrap();
        assert_eq!(serde_json::from_str::<Intent>(&json).unwrap(), i);
    }
}
