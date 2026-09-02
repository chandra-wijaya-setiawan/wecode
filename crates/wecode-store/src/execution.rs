//! Reading and writing one run of one task.
//!
//! A row is opened when the process starts and closed when it ends. If wecode dies in
//! between, the row is left saying `working` with a pid — which is the recovery
//! information wanted, not a bug to tidy away.
//!
//! …and one row that was never a process. Work wecode did not dispatch still costs
//! money — a task handed out by `wecode start` and worked in somebody's own session, a
//! console step done by hand — and until it can be written down here, the task it was
//! for reads as free. [`Store::record_execution`] writes that attempt, and
//! [`Execution::attested_by`] is what keeps it from being mistaken for a metered one.

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
    /// Tokens the agent reported for this attempt, and `None` when its output said
    /// nothing wecode could read.
    ///
    /// Unlike `wall_secs`, which is timed here, this is the harness's own account of
    /// itself — there is no other source for it, since wecode does not sit between
    /// the agent and the model. The ledger row for the same run records that
    /// provenance; this column is the number, kept beside the attempt it belongs to.
    pub spent_tokens: Option<u64>,
    /// Context the run re-read out of the cache, on the same terms as `spent_tokens`:
    /// `None` said nothing wecode could read, `Some(0)` re-read nothing.
    ///
    /// Kept apart from the spend rather than added to it. These tokens were counted
    /// on the turn that wrote them, and a long conversation replays them once per
    /// turn — a figure in the millions where the spend is in the thousands, which is
    /// why no budget is written in it. Recorded all the same, because cache reads are
    /// billed: the run line printed this figure and then threw it away, so a task
    /// that cost real money in replay left no trace of it anywhere.
    pub replayed_tokens: Option<u64>,
    /// Who stated these figures, and `None` when wecode ran the process itself.
    ///
    /// The `None` is a claim, not a gap: this attempt was started here, timed here, and
    /// its tokens read out of its own output. A name means none of that happened —
    /// nobody was watching, and what the row holds is one person's account of what the
    /// work cost. Both are worth keeping and neither may read as the other, which is
    /// the whole of what this column does.
    pub attested_by: Option<String>,
    pub detail: String,
}

/// One open row, as the loop's sweep reads it: which run, whose it is, and when its
/// supervisor was last heard from.
///
/// Narrower than [`Execution`] on purpose. The sweep's whole question is *is anybody
/// still watching this*, which the beat answers; the rest is what closing the row
/// needs — the task to hand back, the attempt to check it is still the latest, and
/// the worktree to leave standing on the record.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct OpenRun {
    pub exec: i64,
    pub task: String,
    pub attempt: i64,
    pub started: u64,
    /// The second the supervisor last said it was still executing. `None` is a row
    /// opened by a wecode that does not beat, and reads as `started`: the row's claim
    /// is dated from the last evidence anyone actually holds.
    pub beat: Option<u64>,
    pub worktree: Option<String>,
}

/// A cost stated after the fact, for work no dispatch metered.
///
/// One argument rather than four, for the reason [`Spend`] is one rather than two: the
/// figures only mean anything with the attestor beside them. A `record_execution` that
/// took the spend and left the name to a later call could write the row without one,
/// and a row without one says wecode measured this.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Attested {
    /// The person answerable for the figures — the human in the seat, or the seat.
    pub by: String,
    /// How long the work took, as stated. `None` where only the tokens are known,
    /// which is the commoner half to be able to answer.
    pub wall_secs: Option<u64>,
    pub spend: Spend,
    /// What the work was, in the attestor's words. The one line on this row that no
    /// exit code wrote.
    pub detail: String,
}

/// What a run reported spending, in the two units a harness reports.
///
/// One argument rather than two `Option<u64>` side by side. They are the same type
/// and mean opposite things — one is checked against a budget, the other is
/// deliberately not — so a swapped pair would compile, and file a conversation's
/// replay as the spend that turns a board red.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Spend {
    /// Tokens the run added: prompt, cache writes, and everything produced. The unit
    /// `tasks.budget_tokens` is written in.
    pub tokens: Option<u64>,
    /// Context re-read from the cache, which is the same context again rather than
    /// more of it.
    pub replayed: Option<u64>,
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
        // `beat` opens equal to `started`, so an open row is never without one: the
        // insert itself is the supervisor's first report of being here.
        c.execute(
            "INSERT INTO task_executions
                (task_id, session_id, attempt, status, worktree, pid, started, beat)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
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

    /// Closes a row with what happened, and what it cost.
    ///
    /// Either half of `spend` is `None` when the agent reported no count, which is not
    /// the same as reporting none: an unmetered agent leaves the columns NULL rather
    /// than claiming to have run for free, or to have re-read nothing.
    pub fn finish_execution(
        &self,
        id: i64,
        status: ExecutionStatus,
        detail: &str,
        spend: Spend,
    ) -> Result<(), StoreError> {
        let started: i64 = self.conn().query_row(
            "SELECT started FROM task_executions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let ended = crate::int::to_db(now_secs());
        self.conn().execute(
            "UPDATE task_executions
                SET status = ?2, ended = ?3, wall_secs = ?4, spent_tokens = ?5,
                    replayed_tokens = ?6, detail = ?7
              WHERE id = ?1",
            params![
                id,
                status.as_str(),
                ended,
                ended - started,
                crate::int::opt_to_db(spend.tokens),
                crate::int::opt_to_db(spend.replayed),
                detail
            ],
        )?;
        Ok(())
    }

    /// Stamps a run's row: its supervisor was still executing at this second.
    ///
    /// Only while the row is open. A closed row's beat is history, and a late stamp
    /// from a thread that outlived its run must not rewrite it. Waits briefly on a
    /// locked database rather than erroring: the caller is a background thread whose
    /// single failure is absorbed anyway, and waiting is how it avoids missing a beat
    /// to a longer write happening beside it.
    pub fn beat(&self, id: i64) -> Result<(), StoreError> {
        self.conn().busy_timeout(std::time::Duration::from_secs(5))?;
        self.conn().execute(
            "UPDATE task_executions SET beat = ?2 WHERE id = ?1 AND ended IS NULL",
            params![id, crate::int::to_db(now_secs())],
        )?;
        Ok(())
    }

    /// The rows still claiming a supervisor: open and `working`, with their beats.
    ///
    /// What the loop's sweep reads. A row [`Store::record_execution`] filed never
    /// appears — it is closed at insert, and there was never a process behind it to
    /// have stopped watching.
    pub fn open_runs(&self) -> Result<Vec<OpenRun>, StoreError> {
        let c = self.conn();
        let mut stmt = c.prepare(
            "SELECT id, task_id, attempt, started, beat, worktree
               FROM task_executions
              WHERE ended IS NULL AND status = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![ExecutionStatus::Working.as_str()], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (exec, task, attempt, started, beat, worktree) = row?;
            out.push(OpenRun {
                exec,
                task,
                attempt,
                started: crate::int::from_db(started, "execution start")?,
                beat: crate::int::opt_from_db(beat, "execution beat")?,
                worktree,
            });
        }
        Ok(out)
    }

    /// Closes a row at a stated instant rather than at now.
    ///
    /// For the verdict written over an *absence*: the sweep closing a run whose
    /// supervisor went silent ends it at the last beat, because the silence after it
    /// was not watched work and `wall_secs` has to keep meaning what it means on every
    /// other row. The spend columns are left as they stand — NULL, on the rule they
    /// already carry: nothing read a count out of that run, and 0 would claim it ran
    /// for free.
    pub fn close_execution_at(
        &self,
        id: i64,
        status: ExecutionStatus,
        detail: &str,
        ended: u64,
    ) -> Result<(), StoreError> {
        let started: i64 = self.conn().query_row(
            "SELECT started FROM task_executions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let started = crate::int::from_db(started, "execution start")?;
        self.conn().execute(
            "UPDATE task_executions
                SET status = ?2, ended = ?3, wall_secs = ?4, detail = ?5
              WHERE id = ?1",
            params![
                id,
                status.as_str(),
                crate::int::to_db(ended),
                crate::int::to_db(ended.saturating_sub(started)),
                detail
            ],
        )?;
        Ok(())
    }

    /// Backdates a run, for tests that need staleness without sleeping — what
    /// [`Store::backdate_session`] is to sessions.
    #[doc(hidden)]
    pub fn backdate_run(
        &self,
        id: i64,
        started: u64,
        beat: Option<u64>,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE task_executions SET started = ?2, beat = ?3 WHERE id = ?1",
            params![id, crate::int::to_db(started), crate::int::opt_to_db(beat)],
        )?;
        Ok(())
    }

    /// Files what work nobody dispatched cost, as its own attempt.
    ///
    /// Opened and closed in one write, because there was never a process to be between
    /// the two: this row is a record of something that already happened, not a run to
    /// be supervised. `worktree` and `pid` stay NULL for the same reason — there is
    /// nothing here for a crash recovery to point at.
    ///
    /// **Its own attempt**, never an amendment to one. Adding a stated figure to a
    /// metered row would leave a number that is half measured and half claimed, with no
    /// way left to say which half; adding it to the task's total is what was wanted, and
    /// a row of its own does that while keeping every other row exactly as honest as it
    /// was. It follows that two people attesting the same work file two costs, and that
    /// is the correct arithmetic: nothing here can tell it was the same work.
    ///
    /// `completed`, because that is what the row *has* to say among the eight states —
    /// the work happened and it is over. It says nothing about whether the work was any
    /// good: a cost record makes no claim about the result, and the task's own status
    /// is where the verdict lives.
    pub fn record_execution(
        &self,
        task: &TaskId,
        session: &str,
        what: &Attested,
    ) -> Result<i64, StoreError> {
        let attempt = self.next_attempt(task)?;
        // The stated duration laid against the moment it was written down. Every reader
        // of this table subtracts `started` from `ended` and expects `wall_secs`, so a
        // row that put both stamps at now would answer *seven thousand seconds, in no
        // time at all*. What is invented is when the work happened, which nothing here
        // was ever in a position to observe; what is preserved is how long it took,
        // which is the figure somebody actually stated.
        let ended = now_secs();
        let started = ended.saturating_sub(what.wall_secs.unwrap_or(0));
        let c = self.conn();
        c.execute(
            "INSERT INTO task_executions
                (task_id, session_id, attempt, status, started, ended, wall_secs,
                 spent_tokens, replayed_tokens, attested_by, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                task.as_str(),
                session,
                attempt,
                ExecutionStatus::Completed.as_str(),
                crate::int::to_db(started),
                crate::int::to_db(ended),
                crate::int::opt_to_db(what.wall_secs),
                crate::int::opt_to_db(what.spend.tokens),
                crate::int::opt_to_db(what.spend.replayed),
                what.by,
                what.detail,
            ],
        )?;
        Ok(c.last_insert_rowid())
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
                    started, ended, wall_secs, spent_tokens, replayed_tokens,
                    attested_by, detail
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
                r.get::<_, Option<i64>>(10)?,
                r.get::<_, Option<i64>>(11)?,
                r.get::<_, Option<String>>(12)?,
                r.get::<_, String>(13)?,
            ))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                task,
                session,
                attempt,
                status,
                worktree,
                pid,
                started,
                ended,
                wall,
                spent,
                replayed,
                attested_by,
                detail,
            ) = row?;
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
                spent_tokens: crate::int::opt_from_db(spent, "execution spend")?,
                replayed_tokens: crate::int::opt_from_db(replayed, "execution replay")?,
                attested_by,
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
        assert_eq!(open.spent_tokens, None, "nothing spent before it ran");
        assert_eq!(open.replayed_tokens, None, "and nothing re-read");

        s.finish_execution(
            id,
            ExecutionStatus::Completed,
            "exit 0",
            Spend {
                tokens: Some(1540),
                replayed: Some(500_000),
            },
        )
        .unwrap();
        let done = &s.executions(&TaskId::new("t")).unwrap()[0];
        assert_eq!(done.status, ExecutionStatus::Completed);
        assert!(done.ended.is_some());
        assert!(done.wall_secs.is_some());
        assert_eq!(done.spent_tokens, Some(1540));
        assert_eq!(done.replayed_tokens, Some(500_000));
        assert_eq!(done.detail, "exit 0");
    }

    #[test]
    fn what_a_run_re_read_is_recorded_beside_what_it_spent_and_not_inside_it() {
        // The two figures are different units and one of them is what a budget is
        // checked against. A conversation that replays half a million tokens of its
        // own context while adding ninety is a cheap run, and the row has to be able
        // to say both things at once — otherwise the choice is a red board or a lost
        // number, which is the choice this column removes.
        let s = store();
        let id = s
            .start_execution(&TaskId::new("t"), "s-1", None, None)
            .unwrap();
        s.finish_execution(
            id,
            ExecutionStatus::Completed,
            "exit 0",
            Spend {
                tokens: Some(90),
                replayed: Some(500_000),
            },
        )
        .unwrap();

        let run = &s.executions(&TaskId::new("t")).unwrap()[0];
        assert_eq!(run.spent_tokens, Some(90), "the budgeted unit is untouched");
        assert_eq!(run.replayed_tokens, Some(500_000));
    }

    #[test]
    fn re_reading_nothing_and_reporting_nothing_are_told_apart() {
        // The same distinction `spent_tokens` keeps, for the same reason: a harness
        // wecode cannot read leaves this NULL, and a run on a cold cache reports 0.
        // Collapsing them would make every unmetered agent look like a first turn.
        let s = store();
        let quiet = s
            .start_execution(&TaskId::new("t"), "s-1", None, None)
            .unwrap();
        s.finish_execution(quiet, ExecutionStatus::Completed, "exit 0", Spend::default())
            .unwrap();
        let cold = s
            .start_execution(&TaskId::new("t"), "s-1", None, None)
            .unwrap();
        s.finish_execution(
            cold,
            ExecutionStatus::Completed,
            "exit 0",
            Spend {
                tokens: Some(90),
                replayed: Some(0),
            },
        )
        .unwrap();

        let runs = s.executions(&TaskId::new("t")).unwrap();
        assert_eq!(runs[0].replayed_tokens, None);
        assert_eq!(runs[1].replayed_tokens, Some(0));
    }

    #[test]
    fn an_unmetered_agent_leaves_the_count_absent_rather_than_zero() {
        // A protocol wecode cannot read a usage line out of has not told us the run
        // was free. Writing 0 would put that claim in the database.
        let s = store();
        let id = s
            .start_execution(&TaskId::new("t"), "s-1", None, None)
            .unwrap();
        s.finish_execution(id, ExecutionStatus::Completed, "exit 0", Spend::default())
            .unwrap();
        assert_eq!(
            s.executions(&TaskId::new("t")).unwrap()[0].spent_tokens,
            None
        );

        // And a run that really did report zero says so, distinctly.
        let second = s
            .start_execution(&TaskId::new("t"), "s-1", None, None)
            .unwrap();
        s.finish_execution(
            second,
            ExecutionStatus::Completed,
            "exit 0",
            Spend {
                tokens: Some(0),
                replayed: Some(0),
            },
        )
        .unwrap();
        assert_eq!(
            s.executions(&TaskId::new("t")).unwrap()[1].spent_tokens,
            Some(0)
        );
    }

    #[test]
    fn a_cost_nobody_measured_lands_as_its_own_attempt_and_names_who_said_so() {
        // The gap this closes: a task handed out by `wecode start` and worked in
        // somebody's own session spends real money and leaves no row, so the board
        // reports it as free. What is written down is the figure and its author, and
        // the two travel together — a number here with nobody's name on it would read
        // as one wecode metered.
        let s = store();
        let metered = s
            .start_execution(&TaskId::new("t"), "s-1", Some("/wt/t"), Some(7))
            .unwrap();
        s.finish_execution(
            metered,
            ExecutionStatus::Completed,
            "exit 0",
            Spend {
                tokens: Some(1540),
                replayed: Some(4000),
            },
        )
        .unwrap();

        s.record_execution(
            &TaskId::new("t"),
            "s-2",
            &Attested {
                by: "cws".into(),
                wall_secs: Some(7200),
                spend: Spend {
                    tokens: Some(90_000),
                    replayed: None,
                },
                detail: "worked it in my own session".into(),
            },
        )
        .unwrap();

        let runs = s.executions(&TaskId::new("t")).unwrap();
        assert_eq!(runs.len(), 2, "a record of its own, not an amendment");
        assert_eq!(runs[0].attested_by, None, "wecode ran that one");
        assert_eq!(runs[0].spent_tokens, Some(1540), "and it is untouched");

        let stated = &runs[1];
        assert_eq!(stated.attempt, 2);
        assert_eq!(stated.attested_by.as_deref(), Some("cws"));
        assert_eq!(stated.spent_tokens, Some(90_000));
        assert_eq!(stated.replayed_tokens, None, "nothing was said about it");
        assert_eq!(stated.status, ExecutionStatus::Completed);
        assert_eq!(stated.detail, "worked it in my own session");
        assert_eq!(
            (stated.worktree.as_deref(), stated.pid),
            (None, None),
            "there was no process here to point at"
        );
    }

    #[test]
    fn the_wall_a_cost_states_is_the_wall_the_row_reads_back() {
        // Every reader of this table subtracts `started` from `ended` and expects the
        // wall. Stamping both at now would file seven thousand seconds of work as
        // having taken no time, which is the one figure an attestation actually knows.
        let s = store();
        s.record_execution(
            &TaskId::new("t"),
            "s",
            &Attested {
                by: "cws".into(),
                wall_secs: Some(7200),
                spend: Spend::default(),
                detail: String::new(),
            },
        )
        .unwrap();
        let r = &s.executions(&TaskId::new("t")).unwrap()[0];
        assert_eq!(r.wall_secs, Some(7200));
        assert_eq!(r.ended.unwrap() - r.started, 7200);
    }

    #[test]
    fn a_cost_that_states_only_tokens_leaves_the_wall_absent_rather_than_zero() {
        // The `spent_tokens` rule, applied to the column beside it: *I know what it
        // cost and not how long it took* is a real answer, and `0s` is a different one.
        let s = store();
        s.record_execution(
            &TaskId::new("t"),
            "s",
            &Attested {
                by: "cws".into(),
                wall_secs: None,
                spend: Spend {
                    tokens: Some(90_000),
                    replayed: None,
                },
                detail: String::new(),
            },
        )
        .unwrap();
        let r = &s.executions(&TaskId::new("t")).unwrap()[0];
        assert_eq!(r.wall_secs, None);
        assert!(r.ended.is_some(), "and it is not an unfinished run");
    }

    #[test]
    fn a_cost_recorded_while_a_run_is_open_does_not_disturb_it() {
        // The person attesting is usually not the supervisor, so the two can arrive in
        // either order. The open row keeps its attempt and its `working`; the record
        // takes the next number.
        let s = store();
        s.start_execution(&TaskId::new("t"), "s-1", None, Some(99))
            .unwrap();
        s.record_execution(
            &TaskId::new("t"),
            "s-2",
            &Attested {
                by: "cws".into(),
                wall_secs: None,
                spend: Spend {
                    tokens: Some(10),
                    replayed: None,
                },
                detail: String::new(),
            },
        )
        .unwrap();

        let stale = s.unfinished_executions().unwrap();
        assert_eq!(stale.len(), 1, "only the run is unfinished");
        assert_eq!(stale[0].attempt, 1);
        assert_eq!(s.next_attempt(&TaskId::new("t")).unwrap(), 3);
    }

    #[test]
    fn attempts_number_upward_per_task() {
        let s = store();
        assert_eq!(s.next_attempt(&TaskId::new("t")).unwrap(), 1);
        let a = s
            .start_execution(&TaskId::new("t"), "s", None, None)
            .unwrap();
        s.finish_execution(
            a,
            ExecutionStatus::Failed,
            "exit 1",
            Spend {
                tokens: Some(90),
                replayed: Some(4000),
            },
        )
        .unwrap();
        assert_eq!(s.next_attempt(&TaskId::new("t")).unwrap(), 2);

        s.start_execution(&TaskId::new("t"), "s", None, None)
            .unwrap();
        let all = s.executions(&TaskId::new("t")).unwrap();
        assert_eq!(all.len(), 2, "the failed attempt is kept, not replaced");
        assert_eq!(all[0].attempt, 1);
        assert_eq!(all[1].attempt, 2);
        // Failing is not free. What the first try burned stays on its own row, so a
        // task's cost is the sum of its attempts rather than only the one that worked.
        assert_eq!(all[0].spent_tokens, Some(90));
        assert_eq!(all[0].replayed_tokens, Some(4000), "and what it re-read");
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
        s.finish_execution(
            id,
            ExecutionStatus::Canceled,
            "wall limit",
            Spend {
                tokens: Some(400),
                replayed: None,
            },
        )
        .unwrap();
        assert!(s.unfinished_executions().unwrap().is_empty());
    }

    #[test]
    fn an_open_row_is_never_without_a_beat() {
        // The insert is the supervisor's first report of being here: a row whose beat
        // was NULL for its first thirty seconds would read as pre-beat history and be
        // dated from `started` anyway, so the column says that outright.
        let s = store();
        let id = s
            .start_execution(&TaskId::new("t"), "s", Some("/wt/t"), None)
            .unwrap();
        let runs = s.open_runs().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].exec, id);
        assert_eq!(runs[0].beat, Some(runs[0].started));
        assert_eq!(runs[0].task, "t");
        assert_eq!(runs[0].worktree.as_deref(), Some("/wt/t"));
    }

    #[test]
    fn a_beat_stamps_an_open_row_and_never_a_closed_one() {
        let s = store();
        let id = s
            .start_execution(&TaskId::new("t"), "s", None, None)
            .unwrap();
        s.backdate_run(id, 100, Some(100)).unwrap();
        s.beat(id).unwrap();
        let stamped = s.open_runs().unwrap()[0].beat.unwrap();
        assert!(stamped > 100, "beaten past the backdated stamp");

        // Closed, the row is history: a late stamp from a thread that outlived its
        // run changes nothing and reports nothing.
        s.finish_execution(id, ExecutionStatus::Completed, "exit 0", Spend::default())
            .unwrap();
        s.beat(id).unwrap();
        let kept: Option<i64> = s
            .conn()
            .query_row(
                "SELECT beat FROM task_executions WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, Some(i64::try_from(stamped).unwrap()));
    }

    #[test]
    fn a_run_closed_at_its_last_beat_records_no_silence_as_work() {
        // `ended` is the last beat, not the moment of the sweep — otherwise the row
        // files as elapsed work a silence nobody was watching, and `wall_secs` stops
        // meaning what it means on every other row.
        let s = store();
        let id = s
            .start_execution(&TaskId::new("t"), "s", Some("/wt/t"), None)
            .unwrap();
        s.backdate_run(id, 100, Some(160)).unwrap();
        s.close_execution_at(id, ExecutionStatus::Canceled, "supervisor silent", 160)
            .unwrap();

        let run = &s.executions(&TaskId::new("t")).unwrap()[0];
        assert_eq!(run.status, ExecutionStatus::Canceled);
        assert_eq!(run.ended, Some(160));
        assert_eq!(run.wall_secs, Some(60));
        assert_eq!(run.detail, "supervisor silent");
        assert_eq!(run.spent_tokens, None, "nothing read a count out of it");
        assert_eq!(run.replayed_tokens, None);
        assert!(s.open_runs().unwrap().is_empty(), "no longer anyone's claim");
    }

    #[test]
    fn a_supervisor_returning_after_the_sweep_outranks_it() {
        // The sweep acted on an absence of evidence; a supervisor that finishes has
        // some, so its verdict overwrites the provisional one — both the status and
        // the figures.
        let s = store();
        let id = s
            .start_execution(&TaskId::new("t"), "s", None, None)
            .unwrap();
        s.close_execution_at(id, ExecutionStatus::Canceled, "supervisor silent", 160)
            .unwrap();
        s.finish_execution(
            id,
            ExecutionStatus::Completed,
            "exit 0",
            Spend {
                tokens: Some(90),
                replayed: None,
            },
        )
        .unwrap();

        let run = &s.executions(&TaskId::new("t")).unwrap()[0];
        assert_eq!(run.status, ExecutionStatus::Completed);
        assert_eq!(run.detail, "exit 0");
        assert_eq!(run.spent_tokens, Some(90));
    }

    #[test]
    fn a_cost_stated_after_the_fact_is_never_an_open_run() {
        // Closed at insert: there was never a process behind it, so there is nobody
        // whose silence a sweep could be reading.
        let s = store();
        s.record_execution(
            &TaskId::new("t"),
            "s",
            &Attested {
                by: "cws".into(),
                wall_secs: Some(60),
                spend: Spend::default(),
                detail: String::new(),
            },
        )
        .unwrap();
        assert!(s.open_runs().unwrap().is_empty());
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
