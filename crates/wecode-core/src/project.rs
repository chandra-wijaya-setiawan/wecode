//! Projects: the unit of work a company pursues.
//!
//! A project owns exactly one repository, carries its own objective, and holds the
//! budget and measures that say when it is done. What used to be a separate `Vision`
//! and `Goal` are now attributes — the company has a vision, a project has an
//! objective — because neither was ever executable and both cost a level of tree.

use crate::common::{Budget, Measure, ProjectStatus};
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
    pub status: ProjectStatus,
    /// Whether the operator has filed this away. Orthogonal to `status`: a project
    /// can be `done` and still on the board, or `active` and hidden while parked.
    ///
    /// Display only. Archiving must never change what work is dispatchable — hiding
    /// a project to tidy the board is not a decision to stop it.
    pub archived: bool,
}

impl Project {
    /// Argument order follows the field order — `objective` then `repo`. It used
    /// to be the other way round, which reads as a plausible call either way and
    /// so silently swapped the two on a mistake.
    pub fn new(
        id: impl Into<ProjectId>,
        objective: impl Into<String>,
        repo: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            objective: objective.into(),
            repo: repo.into(),
            measures: Vec::new(),
            budget: Budget::default(),
            status: ProjectStatus::Draft,
            archived: false,
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

    /// Whether the cockpit should show this. A method rather than reading the field,
    /// so the rule has one home if it ever grows past the flag.
    #[must_use]
    pub fn is_visible(&self) -> bool {
        !self.archived
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
        let p = Project::new("caching", "add response caching", "wecode");
        assert_eq!(p.status, ProjectStatus::Draft);
        assert!(p.measures.is_empty());
        assert!(!p.budget.is_set());
        assert!(!p.has_executable_measure());
    }

    #[test]
    fn builders_compose() {
        let p = Project::new("caching", "add response caching", "wecode")
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
        let p = Project::new("x", "be excellent", "r").measured(Measure::Judged {
            note: "operator decides".into(),
        });
        assert!(!p.has_executable_measure());
    }
}
