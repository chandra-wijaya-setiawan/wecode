//! Projects: the unit of work a company pursues.
//!
//! A project owns exactly one repository, carries its own objective, and holds the
//! budget and measures that say when it is done. What used to be a separate `Vision`
//! and `Goal` are now attributes — the company has a vision, a project has an
//! objective — because neither was ever executable and both cost a level of tree.

use crate::common::{Budget, Measure, Status};
use crate::id::ProjectId;

#[derive(Clone, PartialEq, Debug)]
pub struct Project {
    pub id: ProjectId,
    /// What this project is trying to achieve. One sentence.
    pub objective: String,
    /// The repository this project works in, by the name the company registers it
    /// under. Exactly one: a project that spans two codebases is two projects.
    pub repo: String,
    /// How we know the project succeeded.
    pub measures: Vec<Measure>,
    pub budget: Budget,
    pub status: Status,
}

impl Project {
    pub fn new(
        id: impl Into<ProjectId>,
        repo: impl Into<String>,
        objective: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            objective: objective.into(),
            repo: repo.into(),
            measures: Vec::new(),
            budget: Budget::default(),
            status: Status::Draft,
        }
    }

    #[must_use]
    pub fn measured(mut self, m: Measure) -> Self {
        self.measures.push(m);
        self
    }

    #[must_use]
    pub fn budgeted(mut self, b: Budget) -> Self {
        self.budget = b;
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
    use crate::common::Cmp;

    #[test]
    fn a_project_starts_as_a_draft_with_nothing_assumed() {
        let p = Project::new("caching", "wecode", "add response caching");
        assert_eq!(p.status, Status::Draft);
        assert!(p.measures.is_empty());
        assert!(!p.budget.is_set());
        assert!(!p.has_executable_measure());
    }

    #[test]
    fn builders_compose() {
        let p = Project::new("caching", "wecode", "add response caching")
            .measured(Measure::Metric {
                name: "p99_ms".into(),
                target: 500.0,
                cmp: Cmp::Lt,
            })
            .budgeted(Budget {
                tokens: Some(200_000),
                wall_secs: Some(1800),
            });
        assert!(p.has_executable_measure());
        assert_eq!(p.budget.tokens, Some(200_000));
        assert_eq!(p.repo, "wecode");
    }

    #[test]
    fn a_judged_objective_is_not_executable() {
        let p = Project::new("x", "r", "be excellent").measured(Measure::Judged {
            note: "operator decides".into(),
        });
        assert!(!p.has_executable_measure());
    }
}
