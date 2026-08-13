//! Which worktrees wecode made.
//!
//! Deliberately not derived. wecode can always compute where a tree *would* be — the
//! path is a pure function of the owning task — but the question that broke us runs the
//! other way: git reports a directory, and no computed path can say whether wecode is
//! what put it there. Another tool keeping its own worktrees in the same repository is
//! indistinguishable from a tree of ours whose task is gone, unless creating one was
//! written down at the time.
//!
//! [`crate::Execution::worktree`] is not this. That says *which tree did this attempt
//! run in*, and only `run` opens an execution row — a tree made by `wecode start` would
//! still be invisible. What goes unrecorded is an event, not an association.

use rusqlite::{OptionalExtension, params};
use wecode_core::TaskId;

use crate::{Store, StoreError, now_secs};

/// One worktree wecode created.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Worktree {
    /// Where it is, spelled the way git reports it — this is what a listing matches
    /// against.
    pub path: String,
    /// The `[[repos]]` name it was cut from. The repo is the unit here, not the
    /// project: several projects share one repository and its worktrees.
    pub repo: String,
    pub branch: String,
    /// The main task the tree belongs to. Subtasks share it and record nothing of
    /// their own, because they own nothing of their own.
    pub task: String,
    pub created: u64,
    /// When wecode tore it down. `None` while it stands.
    pub removed: Option<u64>,
}

impl Store {
    /// Writes down a worktree wecode has just made.
    ///
    /// Idempotent for a tree that is already standing for the same task: `wecode start`
    /// on an existing directory resets it rather than creating it, and re-running that
    /// must not restate when the tree was made or pile up a row per attempt.
    ///
    /// A path whose last row is a tombstone gets a new row rather than a revival. The
    /// tree really is a new one, and the old fact is not edited away.
    pub fn record_worktree(
        &self,
        path: &str,
        repo: &str,
        branch: &str,
        task: &TaskId,
    ) -> Result<(), StoreError> {
        if let Some(live) = self.worktree_at(path)? {
            if live.task == task.as_str() && live.branch == branch && live.repo == repo {
                return Ok(());
            }
            // Standing, but for something else — whoever had it last was never torn
            // down. Closing that row rather than editing it keeps both facts, and is
            // what keeps at most one row live per path.
            self.forget_worktree(path)?;
        }
        self.conn().execute(
            "INSERT INTO worktrees (path, repo, branch, task_id, created)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                path,
                repo,
                branch,
                task.as_str(),
                crate::int::to_db(now_secs())
            ],
        )?;
        Ok(())
    }

    /// Marks the worktree at `path` torn down, and says whether one was standing.
    ///
    /// A tombstone rather than a delete, for the reason the audit ledger is never
    /// rewritten: *we made one here and tore it down* and *there was never one here*
    /// are different facts, and the second must not be able to impersonate the first.
    ///
    /// `false` means wecode had no tree recorded here — which is worth knowing, since
    /// it is the difference between removing our own and removing somebody else's.
    pub fn forget_worktree(&self, path: &str) -> Result<bool, StoreError> {
        let n = self.conn().execute(
            "UPDATE worktrees SET removed = ?2 WHERE path = ?1 AND removed IS NULL",
            params![path, crate::int::to_db(now_secs())],
        )?;
        Ok(n > 0)
    }

    /// The tree wecode has standing at `path`, if it made one.
    ///
    /// The *is this ours?* question, asked one path at a time. `None` covers both a
    /// stranger's directory and one of ours already torn down, because for the purpose
    /// of what stands there now they are the same answer.
    pub fn worktree_at(&self, path: &str) -> Result<Option<Worktree>, StoreError> {
        self.conn()
            .query_row(
                &format!("{SELECT} WHERE path = ?1 AND removed IS NULL"),
                params![path],
                read,
            )
            .optional()?
            .transpose()
    }

    /// Every worktree wecode has ever made, oldest first, tombstones included.
    ///
    /// One reader rather than a live one and a complete one. Which trees still stand is
    /// `removed.is_none()`, and a caller that wants only those can say so — a second
    /// method would be the same query with a guess about who wants which baked in.
    pub fn worktrees(&self) -> Result<Vec<Worktree>, StoreError> {
        let c = self.conn();
        // By `id` after `created`: two trees made in the same second still list in the
        // order they were made, which a second-resolution clock cannot say alone.
        let mut stmt = c.prepare(&format!("{SELECT} ORDER BY created, id"))?;
        let rows: Vec<Result<Worktree, StoreError>> =
            stmt.query_map([], read)?.collect::<rusqlite::Result<_>>()?;
        rows.into_iter().collect()
    }
}

const SELECT: &str = "SELECT path, repo, branch, task_id, created, removed FROM worktrees";

/// One row, with the integer columns checked on the way out.
///
/// The `StoreError` is returned inside the row rather than raised, because rusqlite's
/// closure owes it a `rusqlite::Error` and flattening afterwards keeps the reason
/// `Corrupt` carries.
fn read(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Worktree, StoreError>> {
    let created: i64 = r.get(4)?;
    let removed: Option<i64> = r.get(5)?;
    Ok((|| {
        Ok(Worktree {
            path: r.get(0)?,
            repo: r.get(1)?,
            branch: r.get(2)?,
            task: r.get(3)?,
            created: crate::int::from_db(created, "worktree creation")?,
            removed: crate::int::opt_from_db(removed, "worktree removal")?,
        })
    })())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Measure, Project, Task};

    fn store() -> Store {
        let s = Store::in_memory().unwrap();
        s.save_project(&Project::new("p", "an objective sentence", "repo"))
            .unwrap();
        for id in ["t", "other"] {
            s.save_task(
                &Task::new(id, "p", "do something specific").accepting(Measure::Command {
                    cmd: "true".into(),
                    expect_status: 0,
                }),
            )
            .unwrap();
        }
        s
    }

    fn record(s: &Store, path: &str, task: &str) {
        s.record_worktree(
            path,
            "wecode",
            &format!("wecode/{task}"),
            &TaskId::new(task),
        )
        .unwrap();
    }

    #[test]
    fn a_tree_wecode_made_is_recognised_and_a_strangers_is_not() {
        // The fault this table exists for: another tool's worktree in the same
        // repository must read as *not ours*, not as one of ours we lost track of.
        let s = store();
        record(&s, "/run/cws/t", "t");

        let ours = s.worktree_at("/run/cws/t").unwrap().expect("ours");
        assert_eq!(ours.task, "t");
        assert_eq!(ours.branch, "wecode/t");
        assert_eq!(ours.repo, "wecode");
        assert!(ours.removed.is_none());
        assert!(s.worktree_at("/somewhere/treehouse/1").unwrap().is_none());
    }

    #[test]
    fn recording_the_same_tree_again_neither_duplicates_it_nor_restates_its_age() {
        // `wecode start` on an existing directory resets rather than creates. Every
        // retry runs through here.
        let s = store();
        record(&s, "/run/cws/t", "t");
        let first = s.worktree_at("/run/cws/t").unwrap().unwrap();
        record(&s, "/run/cws/t", "t");

        assert_eq!(s.worktrees().unwrap().len(), 1);
        assert_eq!(s.worktree_at("/run/cws/t").unwrap().unwrap(), first);
    }

    #[test]
    fn a_removed_tree_stops_standing_but_is_not_forgotten() {
        let s = store();
        record(&s, "/run/cws/t", "t");
        assert!(s.forget_worktree("/run/cws/t").unwrap());

        assert!(s.worktree_at("/run/cws/t").unwrap().is_none());

        let all = s.worktrees().unwrap();
        assert_eq!(all.len(), 1, "the tombstone is the record that we made one");
        assert!(all[0].removed.is_some());
    }

    #[test]
    fn removing_a_tree_wecode_never_made_says_so_rather_than_pretending() {
        let s = store();
        assert!(!s.forget_worktree("/somewhere/else").unwrap());
        assert!(s.worktrees().unwrap().is_empty());
    }

    #[test]
    fn removing_twice_marks_it_once() {
        let s = store();
        record(&s, "/run/cws/t", "t");
        assert!(s.forget_worktree("/run/cws/t").unwrap());
        assert!(!s.forget_worktree("/run/cws/t").unwrap());
        assert_eq!(s.worktrees().unwrap().len(), 1);
    }

    #[test]
    fn a_path_can_be_used_again_without_erasing_what_stood_there() {
        // What slot reuse needs: the same directory serves a second task later, and
        // both facts survive. A path used as a primary key could not hold them.
        let s = store();
        record(&s, "/run/cws/1", "t");
        s.forget_worktree("/run/cws/1").unwrap();
        record(&s, "/run/cws/1", "other");

        let all = s.worktrees().unwrap();
        assert_eq!(all.len(), 2, "both stints are on the record: {all:?}");
        assert_eq!(
            s.worktree_at("/run/cws/1").unwrap().unwrap().task,
            "other",
            "one tree stands there, and it is the later one"
        );
    }

    #[test]
    fn a_path_handed_to_another_task_without_a_teardown_closes_the_old_row() {
        // Should not happen: today the path is derived from the task. If it ever does,
        // one live row per path is the invariant a listing depends on.
        let s = store();
        record(&s, "/run/cws/1", "t");
        record(&s, "/run/cws/1", "other");

        let all = s.worktrees().unwrap();
        assert_eq!(all.len(), 2);
        assert!(all[0].removed.is_some(), "the displaced row was closed");
        assert_eq!(s.worktree_at("/run/cws/1").unwrap().unwrap().task, "other");
    }

    #[test]
    fn a_tree_outlives_the_task_it_was_made_for() {
        // The reason `task_id` carries no foreign key. Deleting the task does not
        // delete the directory, and a row that cascaded away would turn wecode's own
        // tree back into the stranger this table exists to tell it apart from.
        let s = store();
        record(&s, "/run/cws/t", "t");
        s.conn()
            .execute("DELETE FROM tasks WHERE id = 't'", [])
            .unwrap();

        let ours = s.worktree_at("/run/cws/t").unwrap().expect("still ours");
        assert_eq!(ours.task, "t", "who it was for is still on the row");
    }

    #[test]
    fn trees_list_in_the_order_they_were_made() {
        let s = store();
        record(&s, "/run/cws/t", "t");
        record(&s, "/run/cws/other", "other");
        let paths: Vec<String> = s.worktrees().unwrap().into_iter().map(|w| w.path).collect();
        assert_eq!(paths, vec!["/run/cws/t", "/run/cws/other"]);
    }

    #[test]
    fn a_negative_timestamp_is_corruption_rather_than_an_enormous_age() {
        let s = store();
        record(&s, "/run/cws/t", "t");
        s.conn()
            .execute("UPDATE worktrees SET created = -1", [])
            .unwrap();
        assert!(matches!(
            s.worktrees().unwrap_err(),
            StoreError::Corrupt { what, .. } if what == "worktree creation"
        ));
    }
}
