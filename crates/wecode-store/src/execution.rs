//! Reading and writing one run of one task.
//!
//! A row is opened when the process starts and closed when it ends. If wecode dies in
//! between, the row is left saying `working` with a pid — which is the recovery
//! information wanted, not a bug to tidy away.

use rusqlite::params;
use wecode_core::{ExecutionStatus, TaskId};

use crate::{Store, StoreError, now_secs};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Execution {
    pub id: i64,
    pub task: String,
    pub session: String,
    /// 1, 2, 3 on retry.
    pub attempt: i64,
    pub status: ExecutionStatus,
    pub worktree: Option<String>,
    pub pid: Option<i64>,
    pub started: u64,
    pub ended: Option<u64>,
    pub wall_secs: Option<u64>,
    pub detail: String,
}

impl Store {
    /// Opens a row for a run about to start, and returns its id.
    pub fn start_execution(
        &self,
        task: &TaskId,
        session: &str,
        worktree: Option<&str>,
        pid: Option<u32>,
    ) -> Result<i64, StoreError> {
        let attempt = self.next_attempt(task)?;
        let c = self.conn();
        c.execute(
            "INSERT INTO task_executions
                (task_id, session_id, attempt, status, worktree, pid, started)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                task.as_str(),
                session,
                attempt,
                ExecutionStatus::Working.as_str(),
                worktree,
                pid.map(i64::from),
                crate::int::to_db(now_secs()),
            ],
        )?;
        Ok(c.last_insert_rowid())
    }

    /// Closes a row with what happened.
    pub fn finish_execution(
        &self,
        id: i64,
        status: ExecutionStatus,
        detail: &str,
    ) -> Result<(), StoreError> {
        let started: i64 = self.conn().query_row(
            "SELECT started FROM task_executions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let ended = crate::int::to_db(now_secs());
        self.conn().execute(
            "UPDATE task_executions
                SET status = ?2, ended = ?3, wall_secs = ?4, detail = ?5
              WHERE id = ?1",
            params![id, status.as_str(), ended, ended - started, detail],
        )?;
        Ok(())
    }

    /// Which try the next run would be. Attempts are per task and start at 1.
    pub fn next_attempt(&self, task: &TaskId) -> Result<i64, StoreError> {
        let n: i64 = self.conn().query_row(
            "SELECT coalesce(max(attempt), 0) FROM task_executions WHERE task_id = ?1",
            params![task.as_str()],
            |r| r.get(0),
        )?;
        Ok(n + 1)
    }

    /// Every run of a task, oldest first.
    pub fn executions(&self, task: &TaskId) -> Result<Vec<Execution>, StoreError> {
        let c = self.conn();
        let mut stmt = c.prepare(
            "SELECT id, task_id, session_id, attempt, status, worktree, pid,
                    started, ended, wall_secs, detail
               FROM task_executions WHERE task_id = ?1 ORDER BY attempt",
        )?;
        let rows = stmt.query_map(params![task.as_str()], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<i64>>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, Option<i64>>(8)?,
                r.get::<_, Option<i64>>(9)?,
                r.get::<_, String>(10)?,
            ))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (id, task, session, attempt, status, worktree, pid, started, ended, wall, detail) =
                row?;
            out.push(Execution {
                id,
                task,
                session,
                attempt,
                status: ExecutionStatus::parse(&status).ok_or_else(|| StoreError::Corrupt {
                    what: "execution status",
                    value: status.clone(),
                })?,
                worktree,
                pid,
                started: crate::int::from_db(started, "execution start")?,
                ended: crate::int::opt_from_db(ended, "execution end")?,
                wall_secs: crate::int::opt_from_db(wall, "execution wall")?,
                detail,
            });
        }
        Ok(out)
    }

    /// Rows still claiming to be running. After a crash these are stale, and only a
    /// person can say whether the work survived.
    pub fn unfinished_executions(&self) -> Result<Vec<Execution>, StoreError> {
        let c = self.conn();
        let mut stmt = c.prepare(
            "SELECT DISTINCT task_id FROM task_executions WHERE ended IS NULL ORDER BY task_id",
        )?;
        let tasks: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);

        let mut out = Vec::new();
        for t in tasks {
            out.extend(
                self.executions(&TaskId::new(&t))?
                    .into_iter()
                    .filter(|e| e.ended.is_none()),
            );
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Measure, Project, Scope, Task};

    fn store() -> Store {
        let s = Store::in_memory().unwrap();
        s.save_project(&Project::new("p", "an objective sentence", "repo"))
            .unwrap();
        s.save_task(
            &Task::new("t", "p", "do something specific")
                .accepting(Measure::Command {
                    cmd: "true".into(),
                    expect_status: 0,
                })
                .scoped(Scope::write(&["a/**"]))
                .budgeted(Budget {
                    tokens: Some(1),
                    wall_secs: Some(1),
                }),
        )
        .unwrap();
        s
    }

    #[test]
    fn a_run_is_opened_working_and_closed_with_its_verdict() {
        let s = store();
        let id = s
            .start_execution(&TaskId::new("t"), "s-1", Some("/wt/t"), Some(4242))
            .unwrap();

        let open = &s.executions(&TaskId::new("t")).unwrap()[0];
        assert_eq!(open.status, ExecutionStatus::Working);
        assert_eq!(open.attempt, 1);
        assert_eq!(open.pid, Some(4242));
        assert_eq!(open.worktree.as_deref(), Some("/wt/t"));
        assert!(open.ended.is_none());

        s.finish_execution(id, ExecutionStatus::Completed, "exit 0")
            .unwrap();
        let done = &s.executions(&TaskId::new("t")).unwrap()[0];
        assert_eq!(done.status, ExecutionStatus::Completed);
        assert!(done.ended.is_some());
        assert!(done.wall_secs.is_some());
        assert_eq!(done.detail, "exit 0");
    }

    #[test]
    fn attempts_number_upward_per_task() {
        let s = store();
        assert_eq!(s.next_attempt(&TaskId::new("t")).unwrap(), 1);
        let a = s
            .start_execution(&TaskId::new("t"), "s", None, None)
            .unwrap();
        s.finish_execution(a, ExecutionStatus::Failed, "exit 1")
            .unwrap();
        assert_eq!(s.next_attempt(&TaskId::new("t")).unwrap(), 2);

        s.start_execution(&TaskId::new("t"), "s", None, None)
            .unwrap();
        let all = s.executions(&TaskId::new("t")).unwrap();
        assert_eq!(all.len(), 2, "the failed attempt is kept, not replaced");
        assert_eq!(all[0].attempt, 1);
        assert_eq!(all[1].attempt, 2);
    }

    #[test]
    fn a_row_left_working_is_findable_after_a_crash() {
        // wecode dying mid-run leaves this behind on purpose: the pid and the worktree
        // are what a person needs to work out whether anything survived.
        let s = store();
        s.start_execution(&TaskId::new("t"), "s", Some("/wt/t"), Some(99))
            .unwrap();
        let stale = s.unfinished_executions().unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].status, ExecutionStatus::Working);
        assert_eq!(stale[0].pid, Some(99));
    }

    #[test]
    fn a_finished_run_is_not_reported_as_stale() {
        let s = store();
        let id = s
            .start_execution(&TaskId::new("t"), "s", None, None)
            .unwrap();
        s.finish_execution(id, ExecutionStatus::Canceled, "wall limit")
            .unwrap();
        assert!(s.unfinished_executions().unwrap().is_empty());
    }

    #[test]
    fn deleting_a_task_takes_its_executions_with_it() {
        let s = store();
        s.start_execution(&TaskId::new("t"), "s", None, None)
            .unwrap();
        s.conn()
            .execute("DELETE FROM tasks WHERE id = 't'", [])
            .unwrap();
        assert!(s.executions(&TaskId::new("t")).unwrap().is_empty());
    }
}
