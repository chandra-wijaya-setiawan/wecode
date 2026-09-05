//! The `projects` row: written, filed away, and asked about.
//!
//! A project is declared once and then barely moves, so the writes here are the whole
//! row or a single flag — there is nothing in between to protect, which is what makes
//! this the short module and `task` the long one.

use rusqlite::{OptionalExtension, params};
use wecode_core::{Project, ProjectId, ProjectStatus};

use crate::plan::measure::MeasureTable;
use crate::short::Level;
use crate::{Store, StoreError};

impl Store {
    /// Inserts or replaces a project and its measures.
    pub fn save_project(&self, p: &Project) -> Result<(), StoreError> {
        let c = self.conn();
        c.execute(
            "INSERT INTO projects
                (id, repo, objective, status, budget_tokens, budget_wall, archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                repo = ?2, objective = ?3, status = ?4,
                budget_tokens = ?5, budget_wall = ?6, archived = ?7",
            params![
                p.id.as_str(),
                p.repo,
                p.objective,
                p.status.as_str(),
                crate::int::opt_to_db(p.budget.tokens),
                crate::int::opt_to_db(p.budget.wall_secs),
                i64::from(p.archived),
            ],
        )?;
        self.replace_measures(&MeasureTable::Project, p.id.as_str(), &p.measures)?;
        // After the row, so nothing carries a number for a project that failed to save,
        // and unconditionally, so a project created before this existed acquires one the
        // next time anything touches it. `p.number` is ignored: numbers are the store's
        // to hand out, and honouring a caller's would let two projects claim one.
        self.number_of(Level::Project, p.id.as_str())?;
        Ok(())
    }

    /// Files a project away, or brings it back. Separate from status on purpose:
    /// this changes what the operator sees, never what is dispatchable.
    pub fn set_project_archived(&self, id: &ProjectId, archived: bool) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE projects SET archived = ?2 WHERE id = ?1",
            params![id.as_str(), i64::from(archived)],
        )?;
        Ok(())
    }

    pub fn set_project_status(
        &self,
        id: &ProjectId,
        status: ProjectStatus,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE projects SET status = ?2 WHERE id = ?1",
            params![id.as_str(), status.as_str()],
        )?;
        Ok(())
    }

    /// Whether a project id is taken. Cheaper than loading the whole plan.
    pub fn project_exists(&self, id: &ProjectId) -> Result<bool, StoreError> {
        let found: Option<i64> = self
            .conn()
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [id.as_str()], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(found.is_some())
    }
}

#[cfg(test)]
mod tests {
    use wecode_core::{Number, ProjectStatus};

    use crate::plan::fixtures::{project, store};

    #[test]
    fn a_project_round_trips_with_its_measures_and_a_number() {
        let s = store();
        let p = project();
        s.save_project(&p).unwrap();

        let loaded = s.load_plan().unwrap();
        // Everything as written, plus the number saving minted for it — the caller
        // passed `None` and the store is what decides. That is the only field a save
        // adds rather than records.
        let mut expected = p.clone();
        expected.number = Some(Number::new(1));
        assert_eq!(loaded.project(&"caching".into()), Some(&expected));
        assert_eq!(loaded.project_ref("1").map(|x| &x.id), Some(&p.id));
    }

    #[test]
    fn archived_survives_a_round_trip_and_is_independent_of_status() {
        // The two properties must not be inferred from each other: a done project can
        // stay on the board, and an active one can be filed away.
        let s = store();
        let mut p = project();
        p.archived = true;
        p.status = ProjectStatus::Active;
        s.save_project(&p).unwrap();

        let loaded = s.load_plan().unwrap();
        let got = loaded.project(&"caching".into()).unwrap();
        assert!(got.archived);
        assert_eq!(got.status, ProjectStatus::Active);
        assert!(!got.is_visible());
    }

    #[test]
    fn archiving_is_reversible_without_touching_status() {
        let s = store();
        let mut p = project();
        p.status = ProjectStatus::Done;
        s.save_project(&p).unwrap();

        s.set_project_archived(&"caching".into(), true).unwrap();
        let after = s.load_plan().unwrap();
        let got = after.project(&"caching".into()).unwrap();
        assert!(got.archived);
        assert_eq!(got.status, ProjectStatus::Done, "status untouched");

        s.set_project_archived(&"caching".into(), false).unwrap();
        let back = s.load_plan().unwrap();
        assert!(!back.project(&"caching".into()).unwrap().archived);
    }

    #[test]
    fn a_new_project_is_visible() {
        let s = store();
        s.save_project(&project()).unwrap();
        let loaded = s.load_plan().unwrap();
        assert!(loaded.project(&"caching".into()).unwrap().is_visible());
    }

    #[test]
    fn project_exists_avoids_loading_everything() {
        let s = store();
        assert!(!s.project_exists(&"caching".into()).unwrap());
        s.save_project(&project()).unwrap();
        assert!(s.project_exists(&"caching".into()).unwrap());
    }
}
