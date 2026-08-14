//! Minting and reading short numbers.
//!
//! The store is where numbers come from because it is the only thing that can keep a
//! sequence unique across processes — `wecode loop` dispatching in one terminal and
//! `wecode task add` typed in another must not both be handed `#12`. SQLite's
//! `AUTOINCREMENT` is that guarantee, and it is also the guarantee that a number is
//! never *re*-used; see the table's comment in [`crate::schema`].
//!
//! Nothing here decides what a number means. [`wecode_core::short`] holds that.

use rusqlite::{OptionalExtension, params};
use wecode_core::Number;

use crate::{Store, StoreError};

/// Which level a number names. The two share one sequence, so this is what a row says
/// about itself rather than which counter it came from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Level {
    Project,
    Task,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Task => "task",
        }
    }
}

impl Store {
    /// The number for a project or task id, minted on first ask and stable thereafter.
    ///
    /// Read before written on purpose. `INSERT ... ON CONFLICT DO NOTHING` would be one
    /// statement and would burn a sequence value on every conflict — and `save_task`
    /// runs on every status change, so a task that ran three attempts would push the
    /// next new task's number into the hundreds. Numbers exist to be short.
    pub fn number_of(&self, level: Level, id: &str) -> Result<Number, StoreError> {
        if let Some(n) = self.number_if_any(level, id)? {
            return Ok(n);
        }
        self.conn().execute(
            "INSERT INTO short_numbers (kind, id) VALUES (?1, ?2)",
            params![level.as_str(), id],
        )?;
        number_from_db(self.conn().last_insert_rowid())
    }

    /// The number this id already has, if it has one. Mints nothing.
    pub fn number_if_any(&self, level: Level, id: &str) -> Result<Option<Number>, StoreError> {
        let found: Option<i64> = self
            .conn()
            .query_row(
                "SELECT n FROM short_numbers WHERE kind = ?1 AND id = ?2",
                params![level.as_str(), id],
                |r| r.get(0),
            )
            .optional()?;
        found.map(number_from_db).transpose()
    }

    /// Every number at one level, paired with the id it names.
    ///
    /// Read in one query rather than one per row: `load_plan` needs the whole mapping,
    /// and asking per task made the plan load scale with the plan.
    pub fn numbers(&self, level: Level) -> Result<Vec<(String, Number)>, StoreError> {
        let mut stmt = self
            .conn()
            .prepare("SELECT id, n FROM short_numbers WHERE kind = ?1 ORDER BY n")?;
        let rows: Vec<(String, i64)> = stmt
            .query_map([level.as_str()], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        rows.into_iter()
            .map(|(id, n)| Ok((id, number_from_db(n)?)))
            .collect()
    }
}

/// A rowid on its way out. `AUTOINCREMENT` stops at `i64::MAX` and a `u32` is nine
/// figures short of that, so this is reachable in principle and refused rather than
/// truncated — a number silently wrapping would name the wrong task, which is the one
/// failure this whole feature cannot have.
fn number_from_db(n: i64) -> Result<Number, StoreError> {
    u32::try_from(n)
        .map(Number::new)
        .map_err(|_| StoreError::Corrupt {
            what: "short number",
            value: n.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Project, Task};

    fn store() -> Store {
        let s = Store::in_memory().unwrap();
        s.save_project(&Project::new("caching", "cut p99", "wecode"))
            .unwrap();
        s
    }

    #[test]
    fn a_number_is_minted_once_and_then_stable() {
        let s = store();
        let first = s.number_of(Level::Task, "layer").unwrap();
        // Asking again — which every `save_task` does — must not move it.
        assert_eq!(s.number_of(Level::Task, "layer").unwrap(), first);
        assert_eq!(s.number_if_any(Level::Task, "layer").unwrap(), Some(first));
    }

    #[test]
    fn asking_does_not_mint() {
        let s = store();
        assert_eq!(s.number_if_any(Level::Task, "ghost").unwrap(), None);
        // Still unminted, so the next real task gets the low number rather than the
        // one a probe consumed.
        assert_eq!(s.number_of(Level::Task, "layer").unwrap().get(), 2);
    }

    #[test]
    fn projects_and_tasks_share_one_sequence() {
        // The point of sharing it: a number names one thing, so `wecode show 2` is not
        // ambiguous between the second project and the second task.
        let s = store();
        let p = s.number_if_any(Level::Project, "caching").unwrap().unwrap();
        let t = s.number_of(Level::Task, "layer").unwrap();
        assert_ne!(p, t);
        assert_eq!((p.get(), t.get()), (1, 2));
    }

    #[test]
    fn a_deleted_task_does_not_hand_its_number_on() {
        // The reason for AUTOINCREMENT. A number in a notification has to keep meaning
        // what it meant when the notification was sent, even if the task it named has
        // been removed since.
        let s = store();
        s.save_task(&Task::new("layer", "caching", "x")).unwrap();
        s.save_task(&Task::new("keys", "caching", "x")).unwrap();
        let keys = s.number_if_any(Level::Task, "keys").unwrap().unwrap();

        s.delete_task(&"keys".into()).unwrap();
        s.save_task(&Task::new("bench", "caching", "x")).unwrap();
        let bench = s.number_if_any(Level::Task, "bench").unwrap().unwrap();
        assert_ne!(bench, keys, "the number must not be recycled");
        assert!(bench.get() > keys.get());
    }

    #[test]
    fn saving_a_project_or_task_mints_its_number() {
        let s = store();
        s.save_task(&Task::new("layer", "caching", "x")).unwrap();
        assert_eq!(
            s.numbers(Level::Project).unwrap(),
            vec![("caching".to_string(), Number::new(1))]
        );
        assert_eq!(
            s.numbers(Level::Task).unwrap(),
            vec![("layer".to_string(), Number::new(2))]
        );
    }

    #[test]
    fn a_rowid_too_large_for_a_number_is_corruption_rather_than_a_wrap() {
        let e = number_from_db(i64::from(u32::MAX) + 1).unwrap_err();
        assert!(matches!(e, StoreError::Corrupt { what, .. } if what == "short number"));
    }
}
