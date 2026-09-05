//! The run journal: what a step is about to do, written down before it does it.
//!
//! One row per step whose effect reaches outside this database — a worktree cut, an
//! agent spawned, a commit made. The row is opened before the step and settled after
//! it, so a row still open is a step nobody can account for. That is the whole of the
//! recovery information: a restart reads the open rows and settles them, rather than
//! inferring what happened from the wreckage.
//!
//! Not the ledger. `audit_log` is evidence and append-only because of that; these rows
//! are machinery, written to be overwritten, and half of them are questions rather than
//! facts. Not columns on `task_executions` either — the first step of a run happens
//! before that row exists.
//!
//! Nothing here decides anything. Whether the process named by a row is still alive is
//! a question for the caller, which is the only side that can read `/proc`.

use rusqlite::params;
use wecode_core::{TaskId, TaskStatus};

use crate::{Store, StoreError, now_secs};

/// The steps of a run that can be in doubt.
///
/// A fixed enumeration, parsed rather than read as free text, so an unrecognised value
/// is corruption the caller hears about instead of a row silently skipped by whatever
/// was going to act on it. A step is a thing a person would name when asked what the
/// run was doing: there should be four or five in a run, not forty.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Step {
    /// Cutting or resetting the worktree.
    Prepare,
    /// Starting the agent.
    Spawn,
    /// Committing what the attempt produced.
    Commit,
    /// Judging it.
    Verdict,
    /// Settling somebody else's open rows. Journalled like any other step, because it
    /// changes the world too and can itself be interrupted.
    Reclaim,
}

impl Step {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::Spawn => "spawn",
            Self::Commit => "commit",
            Self::Verdict => "verdict",
            Self::Reclaim => "reclaim",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "prepare" => Self::Prepare,
            "spawn" => Self::Spawn,
            "commit" => Self::Commit,
            "verdict" => Self::Verdict,
            "reclaim" => Self::Reclaim,
            _ => return None,
        })
    }
}

/// How a step in doubt can be resolved after the fact.
///
/// An intent is only worth writing if the step it names can be settled by somebody who
/// was not there, so every step declares which of the three it is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Resolve {
    /// Doing it again is a no-op or an overwrite.
    Redo,
    /// The world can be asked whether it happened.
    Verify,
    /// Neither, and a second one costs real money. Settled as
    /// [`Settled::Abandoned`] and left as an operator's question.
    Refuse,
}

impl Resolve {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Redo => "redo",
            Self::Verify => "verify",
            Self::Refuse => "refuse",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "redo" => Self::Redo,
            "verify" => Self::Verify,
            "refuse" => Self::Refuse,
            _ => return None,
        })
    }
}

/// What became of a step that was in doubt.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Settled {
    /// It happened, and stands.
    Done,
    /// It happened and has been undone, or it never happened at all.
    Undone,
    /// Nobody can say, and nobody may guess.
    Abandoned,
}

impl Settled {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Undone => "undone",
            Self::Abandoned => "abandoned",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "done" => Self::Done,
            "undone" => Self::Undone,
            "abandoned" => Self::Abandoned,
            _ => return None,
        })
    }
}

/// A process, named precisely enough to prove later whether it is still there.
///
/// Three facts rather than a pid, because pids are reused: the machine, the boot it
/// started in, and the moment it started. A different boot id settles the question
/// without reading anything else. `boot` and `start` are empty and 0 on a host that
/// cannot answer — see the CLI's identity reader for what that costs.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Owner {
    pub host: String,
    pub boot: String,
    pub pid: i64,
    pub start: i64,
}

/// What a step is about to do, as it is written down beforehand.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Intent {
    pub task: String,
    /// `None` before the execution row exists, which is every `prepare`.
    pub exec: Option<i64>,
    pub step: Step,
    pub resolve: Resolve,
    /// What the step acts on: the worktree, the launch line, the branch.
    pub target: String,
    /// Laid into the child's environment, so an orphan whose pid was never recorded is
    /// still findable.
    pub token: String,
    /// The wecode process writing this.
    pub owner: Owner,
    /// The status the dispatch took the task from, on the row that took it.
    ///
    /// Not in the design's sketch of this table, and added because [`Settled::Undone`]
    /// is otherwise a promise nothing can keep: handing the task back needs the status
    /// it was handed *from*, and the claim that recorded it died with the process. The
    /// alternative was reclaim guessing `ready`, which is wrong for every task an
    /// operator started by hand.
    pub prior: Option<TaskStatus>,
}

impl Intent {
    /// A step about to happen, as the four fields every step has.
    ///
    /// The two optional halves are set by the steps that have one, so a call site
    /// spells out only what it knows — and a `prepare`, which has neither, reads as the
    /// step with nothing to add rather than as two `None`s somebody may have got the
    /// wrong way round.
    #[must_use]
    pub fn new(task: &TaskId, step: Step, resolve: Resolve, target: &str, token: &str) -> Self {
        Self {
            task: task.to_string(),
            exec: None,
            step,
            resolve,
            target: target.to_string(),
            token: token.to_string(),
            owner: Owner {
                host: String::new(),
                boot: String::new(),
                pid: 0,
                start: 0,
            },
            prior: None,
        }
    }

    /// Whose it is. Separate from [`Self::new`] because only the CLI can read `/proc`,
    /// and this crate must not pretend to know.
    #[must_use]
    pub fn owned_by(mut self, owner: Owner) -> Self {
        self.owner = owner;
        self
    }

    /// The run this step belongs to, for the steps that happen after its row exists.
    #[must_use]
    pub fn of_run(mut self, exec: i64) -> Self {
        self.exec = Some(exec);
        self
    }

    /// The status the dispatch took the task from, on the one step that took it.
    #[must_use]
    pub fn taking(mut self, prior: TaskStatus) -> Self {
        self.prior = Some(prior);
        self
    }
}

/// A row read back, with what was learned after it was opened.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Doubt {
    pub id: i64,
    pub intent: Intent,
    /// The agent's pid — equal to its process-group id — and start time, written the
    /// moment the child existed. `None` on a row whose step spawned nothing, and on a
    /// spawn that died in the window before the number could be written.
    pub child: Option<Owner>,
    pub opened: u64,
}

impl Store {
    /// Writes a step's intent, and answers with the row to settle it by.
    ///
    /// Committed before the caller does anything, which is the whole point: the row has
    /// to survive the step failing to.
    pub fn open_intent(&self, i: &Intent) -> Result<i64, StoreError> {
        let c = self.conn();
        c.execute(
            "INSERT INTO run_journal
                (task_id, exec_id, step, resolve, target, token, host, boot,
                 owner_pid, owner_start, prior, opened)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                i.task,
                i.exec,
                i.step.as_str(),
                i.resolve.as_str(),
                i.target,
                i.token,
                i.owner.host,
                i.owner.boot,
                i.owner.pid,
                i.owner.start,
                i.prior.map(TaskStatus::as_str),
                crate::int::to_db(now_secs()),
            ],
        )?;
        Ok(c.last_insert_rowid())
    }

    /// Records the child a step just created, as soon as it exists.
    pub fn note_child(&self, id: i64, child: &Owner) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE run_journal SET child_pid = ?2, child_start = ?3 WHERE id = ?1",
            params![id, child.pid, child.start],
        )?;
        Ok(())
    }

    /// Settles a step, unless somebody already did.
    ///
    /// `WHERE settled IS NULL` is what makes a second reclaim write nothing: the row is
    /// the record of a question, and the first answer to it is the answer.
    pub fn settle(&self, id: i64, outcome: Settled) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE run_journal SET settled = ?2, outcome = ?3
              WHERE id = ?1 AND settled IS NULL",
            params![id, crate::int::to_db(now_secs()), outcome.as_str()],
        )?;
        Ok(())
    }

    /// Every step still in doubt, oldest first.
    pub fn unsettled(&self) -> Result<Vec<Doubt>, StoreError> {
        let c = self.conn();
        let mut stmt = c.prepare(
            "SELECT id, task_id, exec_id, step, resolve, target, token, host, boot,
                    owner_pid, owner_start, child_pid, child_start, prior, opened
               FROM run_journal WHERE settled IS NULL ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Raw {
                id: r.get(0)?,
                task: r.get(1)?,
                exec: r.get(2)?,
                step: r.get(3)?,
                resolve: r.get(4)?,
                target: r.get(5)?,
                token: r.get(6)?,
                host: r.get(7)?,
                boot: r.get(8)?,
                owner_pid: r.get(9)?,
                owner_start: r.get(10)?,
                child_pid: r.get(11)?,
                child_start: r.get(12)?,
                prior: r.get(13)?,
                opened: crate::int::from_row(r.get(14)?, 14)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(Raw::into_doubt)
            .collect()
    }

    /// Every step of one task, settled or not, oldest first — what `wecode show`
    /// renders and what a test asserts on.
    pub fn journal_of(&self, task: &TaskId) -> Result<Vec<(Doubt, Option<Settled>)>, StoreError> {
        let c = self.conn();
        let mut stmt = c.prepare(
            "SELECT id, task_id, exec_id, step, resolve, target, token, host, boot,
                    owner_pid, owner_start, child_pid, child_start, prior, opened, outcome
               FROM run_journal WHERE task_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![task.as_str()], |r| {
            Ok((
                Raw {
                    id: r.get(0)?,
                    task: r.get(1)?,
                    exec: r.get(2)?,
                    step: r.get(3)?,
                    resolve: r.get(4)?,
                    target: r.get(5)?,
                    token: r.get(6)?,
                    host: r.get(7)?,
                    boot: r.get(8)?,
                    owner_pid: r.get(9)?,
                    owner_start: r.get(10)?,
                    child_pid: r.get(11)?,
                    child_start: r.get(12)?,
                    prior: r.get(13)?,
                    opened: crate::int::from_row(r.get(14)?, 14)?,
                },
                r.get::<_, Option<String>>(15)?,
            ))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (raw, outcome) = row?;
            let settled = match outcome {
                Some(s) => Some(Settled::parse(&s).ok_or(StoreError::Corrupt {
                    what: "journal outcome",
                    value: s,
                })?),
                None => None,
            };
            out.push((raw.into_doubt()?, settled));
        }
        Ok(out)
    }
}

/// One row as SQLite hands it over, before the strings are held to the enumerations.
///
/// A named struct rather than a fifteen-wide tuple: the columns are read in two places
/// and a transposed pair of `TEXT`s would compile in both.
struct Raw {
    id: i64,
    task: String,
    exec: Option<i64>,
    step: String,
    resolve: String,
    target: String,
    token: String,
    host: String,
    boot: String,
    owner_pid: i64,
    owner_start: i64,
    child_pid: Option<i64>,
    child_start: Option<i64>,
    prior: Option<String>,
    opened: u64,
}

impl Raw {
    fn into_doubt(self) -> Result<Doubt, StoreError> {
        let prior = match self.prior {
            Some(p) => Some(TaskStatus::parse(&p).ok_or(StoreError::Corrupt {
                what: "journal prior status",
                value: p,
            })?),
            None => None,
        };
        Ok(Doubt {
            id: self.id,
            intent: Intent {
                task: self.task,
                exec: self.exec,
                step: Step::parse(&self.step).ok_or(StoreError::Corrupt {
                    what: "journal step",
                    value: self.step.clone(),
                })?,
                resolve: Resolve::parse(&self.resolve).ok_or(StoreError::Corrupt {
                    what: "journal resolve class",
                    value: self.resolve.clone(),
                })?,
                target: self.target,
                token: self.token,
                owner: Owner {
                    host: self.host.clone(),
                    boot: self.boot.clone(),
                    pid: self.owner_pid,
                    start: self.owner_start,
                },
                prior,
            },
            // Both halves or neither: a pid without a start time is a number that
            // cannot be proved to belong to anything.
            child: self.child_pid.zip(self.child_start).map(|(pid, start)| Owner {
                host: self.host,
                boot: self.boot,
                pid,
                start,
            }),
            opened: self.opened,
        })
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

    fn me() -> Owner {
        Owner {
            host: "box".into(),
            boot: "b-1".into(),
            pid: 4242,
            start: 99_000,
        }
    }

    fn intent(step: Step, resolve: Resolve) -> Intent {
        Intent {
            task: "t".into(),
            exec: None,
            step,
            resolve,
            target: "/wt/t".into(),
            token: "tok-1".into(),
            owner: me(),
            prior: None,
        }
    }

    #[test]
    fn a_step_in_doubt_carries_who_owned_it_and_what_it_was_doing() {
        let s = store();
        s.open_intent(&intent(Step::Prepare, Resolve::Redo)).unwrap();

        let open = s.unsettled().unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].intent.step, Step::Prepare);
        assert_eq!(open[0].intent.resolve, Resolve::Redo);
        assert_eq!(open[0].intent.owner, me());
        assert_eq!(open[0].intent.target, "/wt/t");
        assert_eq!(open[0].child, None, "prepare spawns nothing");
    }

    #[test]
    fn a_settled_step_is_no_longer_in_doubt() {
        let s = store();
        let id = s.open_intent(&intent(Step::Commit, Resolve::Verify)).unwrap();
        s.settle(id, Settled::Done).unwrap();
        assert!(s.unsettled().unwrap().is_empty());
        assert_eq!(s.journal_of(&TaskId::new("t")).unwrap()[0].1, Some(Settled::Done));
    }

    #[test]
    fn the_first_answer_to_a_question_is_the_answer() {
        // What makes a second reclaim write nothing. Settling twice would let a later
        // pass overwrite the outcome the pass that actually did the work recorded.
        let s = store();
        let id = s.open_intent(&intent(Step::Spawn, Resolve::Verify)).unwrap();
        s.settle(id, Settled::Undone).unwrap();
        s.settle(id, Settled::Done).unwrap();
        assert_eq!(
            s.journal_of(&TaskId::new("t")).unwrap()[0].1,
            Some(Settled::Undone)
        );
    }

    #[test]
    fn the_child_is_recorded_the_moment_it_exists() {
        let s = store();
        let id = s.open_intent(&intent(Step::Spawn, Resolve::Verify)).unwrap();
        let child = Owner {
            host: "box".into(),
            boot: "b-1".into(),
            pid: 5150,
            start: 99_500,
        };
        s.note_child(id, &child).unwrap();
        assert_eq!(s.unsettled().unwrap()[0].child, Some(child));
    }

    #[test]
    fn the_status_a_dispatch_took_the_task_from_survives_the_dispatch() {
        // The reason for the column: handing the task back needs the status it was
        // handed from, and the claim holding that in memory died with the process.
        let s = store();
        let mut i = intent(Step::Prepare, Resolve::Redo);
        i.prior = Some(TaskStatus::Ready);
        s.open_intent(&i).unwrap();
        assert_eq!(s.unsettled().unwrap()[0].intent.prior, Some(TaskStatus::Ready));
    }

    #[test]
    fn a_step_the_schema_allows_and_the_domain_does_not_is_corruption() {
        // Parsed rather than read as free text: a row nothing recognises must be heard
        // about, not silently skipped by whatever was going to settle it.
        let s = store();
        s.open_intent(&intent(Step::Verdict, Resolve::Verify)).unwrap();
        s.conn()
            .execute("UPDATE run_journal SET step = 'sideways'", [])
            .unwrap();
        assert!(matches!(
            s.unsettled().unwrap_err(),
            StoreError::Corrupt { what, .. } if what == "journal step"
        ));
    }

    #[test]
    fn a_journal_row_outlives_the_task_it_names() {
        // No foreign key, like `worktrees`, and for the same reason: the row is what
        // says a process was left holding something, and deleting the task does not
        // stop the process.
        let s = store();
        s.open_intent(&intent(Step::Spawn, Resolve::Verify)).unwrap();
        s.conn()
            .execute("DELETE FROM tasks WHERE id = 't'", [])
            .unwrap();
        assert_eq!(s.unsettled().unwrap().len(), 1);
    }
}
