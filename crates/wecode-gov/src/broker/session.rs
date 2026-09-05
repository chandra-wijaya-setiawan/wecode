//! Who is acting, on what, and what they have spent.

use crate::grant::Effective;

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
