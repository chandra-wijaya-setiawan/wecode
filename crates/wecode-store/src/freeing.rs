//! Freeing the id of a dropped task, so a plan can be corrected after it has run.
//!
//! [`Store::delete_task`] erases a task that never ran, and `dropped` records that one
//! which did is abandoned. Between the two sits the commonest correction there is: a
//! task that was mis-scoped, dispatched, came back with nothing, and now has to be
//! written again under the name the rest of the plan already refers to. The ways
//! through were a second id nobody wanted — `layer-2` — or a deletion the store
//! refuses.
//!
//! What is freed is the **id and nothing else**. The short number stays attached to it,
//! because `short_numbers` has no foreign key on purpose, so a task re-added under a
//! freed id answers to the number it always did; the ledger keeps every row ever
//! written against it; a torn-down worktree keeps its tombstone. Those rows now sit
//! beside a *different* task's, which is exactly why an id is freed only when nothing
//! was consequent on it. [`Residue`] is that list, and it is a list of refusals rather
//! than of warnings for the same reason.
//!
//! The one question the database cannot answer is whether a branch has commits on it.
//! That is git's, and a caller holding the repository can ask it; what is checked here
//! is everything the store itself knows.

use std::fmt;

use rusqlite::{OptionalExtension, params};
use wecode_core::{ExecutionStatus, TaskId, TaskStatus};

use crate::{Execution, Store, StoreError};

/// What holds an id, and so what freeing it would erase.
///
/// One variant per rule, rather than a bool with a message: the caller has to name the
/// remedy, and *a supervisor is watching attempt 2* and *a worktree still stands* are
/// answered in different places. The wording here is the fact only — which verb fixes
/// it is the command layer's to know, and a store that spelled `wecode` would be
/// stating policy it does not own.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Residue {
    /// No decision has been recorded. Freeing an id is a correction to a judgement
    /// already on the board, and there is nothing here to correct: the task may still
    /// be dispatched, and an id taken out from under a queued task is work lost rather
    /// than a plan mended.
    NotDropped(TaskStatus),
    /// An attempt is still open — some wecode claims to be watching a process right
    /// now. Deleting the row would leave that process writing on behalf of a task
    /// nothing names.
    Running { attempt: i64 },
    /// The ledger holds a merge for this task that the Broker did not refuse: its work
    /// landed on a branch, whatever its status says now.
    Merged { branch: String },
    /// An attempt finished with a result. `completed` delivered one, and `rejected` is
    /// a result that was declined — the work exists either way.
    Produced {
        attempt: i64,
        status: ExecutionStatus,
    },
    /// Somebody stated what an attempt cost. A figure a person wrote down is the only
    /// account of work wecode never metered, and erasing it to reuse a name spends
    /// their statement on a typo.
    Attested { attempt: i64, by: String },
    /// An attempt reported burning tokens. The id is cheap and the money is not: the
    /// execution row is the only place that count is kept, so the board would report
    /// the spend as never having happened.
    ///
    /// A count of `None` does not hold the id. It means nothing could be read out of
    /// that agent's output, which is most of them — refusing on an absence would refuse
    /// every real run and leave the feature unreachable.
    Spent { attempt: i64, tokens: u64 },
    /// A worktree still stands for it. The next task under this id would be cut at the
    /// same path and inherit the abandoned run's mess.
    Tree { path: String },
    /// Something is part of it. `tasks.parent_id` is `ON DELETE SET NULL`, so freeing
    /// the id would quietly re-root the subtask at the top of the plan.
    Parent { subtask: String },
    /// Something comes after it. That edge is `ON DELETE CASCADE`, so freeing the id
    /// would drop a prerequisite from a task that is waiting on it and no row would
    /// say a dependency had ever been stated.
    Awaited { by: String },
}

impl Residue {
    /// Which reason is reported when several hold at once, lowest first.
    ///
    /// Ordered by how much the reader has to know rather than by how the checks run: a
    /// live process outranks a standing directory, because acting on the directory
    /// while the run continues makes things worse. A total order also keeps the message
    /// stable — the same database has to give the same refusal twice.
    fn rank(&self) -> u8 {
        match self {
            Self::NotDropped(_) => 0,
            Self::Running { .. } => 1,
            Self::Merged { .. } => 2,
            Self::Produced { .. } => 3,
            Self::Attested { .. } => 4,
            Self::Spent { .. } => 5,
            Self::Tree { .. } => 6,
            Self::Parent { .. } => 7,
            Self::Awaited { .. } => 8,
        }
    }
}

impl fmt::Display for Residue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotDropped(s) => write!(f, "it is `{}`, not `dropped`", s.as_str()),
            Self::Running { attempt } => write!(f, "attempt {attempt} is still open"),
            Self::Merged { branch } => write!(f, "its work landed on `{branch}`"),
            Self::Produced { attempt, status } => {
                write!(f, "attempt {attempt} {}", status.as_str())
            }
            Self::Attested { attempt, by } => {
                write!(f, "{by} stated what attempt {attempt} cost")
            }
            Self::Spent { attempt, tokens } => {
                write!(f, "attempt {attempt} spent {tokens} tokens")
            }
            Self::Tree { path } => write!(f, "a worktree still stands at {path}"),
            Self::Parent { subtask } => write!(f, "{subtask} is part of it"),
            Self::Awaited { by } => write!(f, "{by} comes after it"),
        }
    }
}

/// What came of asking for an id back.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Freed {
    /// The id is available again, and `attempts` empty runs went with it. The count is
    /// reported because those rows are gone: a caller that says nothing about them has
    /// told the operator less than happened.
    Id { attempts: usize },
    /// Nothing was freed, and this is what held it.
    Nothing(Residue),
}

impl Store {
    /// What holds this id, or `None` when it is free to take back.
    ///
    /// The dry half of [`Self::free_task_id`], for a caller that has to explain before
    /// it acts. An id no task holds has no residue: nothing is being asked about a
    /// task, so there is nothing to report — and the caller resolved a task before
    /// reaching here anyway.
    pub fn residue_of(&self, id: &TaskId) -> Result<Option<Residue>, StoreError> {
        let stored: Option<String> = self
            .conn()
            .query_row(
                "SELECT status FROM tasks WHERE id = ?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(stored) = stored else {
            return Ok(None);
        };
        let status = TaskStatus::parse(&stored).ok_or_else(|| StoreError::Corrupt {
            what: "task status",
            value: stored.clone(),
        })?;
        if status != TaskStatus::Dropped {
            return Ok(Some(Residue::NotDropped(status)));
        }

        let mut held: Vec<Residue> = self
            .executions(id)?
            .iter()
            .filter_map(left_behind)
            .collect();
        if let Some(branch) = self.merge_on_record(id)? {
            held.push(Residue::Merged { branch });
        }
        if let Some(tree) = self.worktree_of(id)? {
            held.push(Residue::Tree { path: tree.path });
        }
        if let Some(subtask) = self.first_row("SELECT id FROM tasks WHERE parent_id = ?1", id)? {
            held.push(Residue::Parent { subtask });
        }
        if let Some(by) = self.first_row(
            "SELECT task_id FROM task_depends_on WHERE prerequisite_id = ?1",
            id,
        )? {
            held.push(Residue::Awaited { by });
        }
        Ok(held.into_iter().min_by_key(Residue::rank))
    }

    /// Hands a dropped task's id back to the plan, with its empty attempts.
    ///
    /// One call rather than a check the caller follows with a delete, so the rules and
    /// the erasure cannot disagree about what the database held. The window between the
    /// two statements is left unguarded, and this is why: nothing dispatches a `dropped`
    /// task, so the only write that could land inside it is a cost somebody types by
    /// hand in the same second — and the store has no transaction anywhere else either,
    /// which is a thing to change deliberately rather than in passing here.
    ///
    /// An id nothing holds reports itself freed, and that is not a lie about work: it
    /// says the id is available, which is what was asked. It also makes a second call
    /// after a successful one read as agreement rather than as a new failure.
    pub fn free_task_id(&self, id: &TaskId) -> Result<Freed, StoreError> {
        if let Some(r) = self.residue_of(id)? {
            return Ok(Freed::Nothing(r));
        }
        let attempts = self.executions(id)?.len();
        // The attempt rows go with it: `task_executions.task_id` cascades, which is
        // safe here and only here, because every rule above exists to establish that
        // those rows record nothing.
        self.delete_task(id)?;
        Ok(Freed::Id { attempts })
    }

    /// The branch a merge for this task named, if the ledger holds one the Broker did
    /// not refuse.
    ///
    /// `deny` and `alarm` are the refusals, so anything else is a merge that was
    /// authorised — including `approval`, which is what a merge signed beforehand
    /// records. Reading only `allow` would miss every merge onto a protected branch,
    /// which is to say the ones that mattered most.
    fn merge_on_record(&self, id: &TaskId) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT target FROM audit_log
                  WHERE task_id = ?1 AND action = 'merge'
                    AND outcome NOT IN ('deny', 'alarm')
                  ORDER BY seq LIMIT 1",
                [id.as_str()],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// The first id `sql` finds for this task, in id order. Two of the rules are the
    /// same question asked of a different column, and naming a row is all either needs.
    fn first_row(&self, sql: &str, id: &TaskId) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                &format!("{sql} ORDER BY 1 LIMIT 1"),
                params![id.as_str()],
                |r| r.get(0),
            )
            .optional()?)
    }
}

/// What one attempt leaves behind, at its worst. Returned in rank order within the
/// attempt, so a run that both produced and spent reports the result rather than the
/// bill — with one deliberate departure, noted where it is made: an attested row's
/// `completed` is not a result, though across attempts a measured one still outranks
/// an attestation.
fn left_behind(run: &Execution) -> Option<Residue> {
    if run.ended.is_none() {
        return Some(Residue::Running {
            attempt: run.attempt,
        });
    }
    // Before the status, and only on this row. `record_execution` files every attested
    // attempt as `completed` — the work happened and it is over — which is explicitly
    // no claim about a result, so reading it as one here would report somebody's
    // account of a cost as a diff they delivered.
    if let Some(by) = &run.attested_by {
        return Some(Residue::Attested {
            attempt: run.attempt,
            by: by.clone(),
        });
    }
    if matches!(
        run.status,
        ExecutionStatus::Completed | ExecutionStatus::Rejected
    ) {
        return Some(Residue::Produced {
            attempt: run.attempt,
            status: run.status,
        });
    }
    match run.spent_tokens {
        Some(tokens) if tokens > 0 => Some(Residue::Spent {
            attempt: run.attempt,
            tokens,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{Attested, Spend};
    use crate::short::Level;
    use wecode_core::{Project, Task};
    use wecode_gov::{Action, ActionKind, ControlMode, Decision, DenyReason, Record, Source};

    fn store() -> Store {
        let s = Store::in_memory().unwrap();
        s.save_project(&Project::new("p", "an objective sentence", "repo"))
            .unwrap();
        s
    }

    /// A task that ran, produced nothing anybody kept, and has been given up on.
    fn dropped(s: &Store, id: &str) -> TaskId {
        s.save_task(&Task::new(id, "p", "do something specific"))
            .unwrap();
        s.set_task_status(&TaskId::new(id), TaskStatus::Dropped)
            .unwrap();
        TaskId::new(id)
    }

    fn failed_run(s: &Store, id: &TaskId, spend: Spend) {
        let run = s.start_execution(id, "s-1", None, None).unwrap();
        s.finish_execution(run, ExecutionStatus::Failed, "exit 1", spend)
            .unwrap();
    }

    #[test]
    fn a_dropped_task_whose_run_produced_nothing_gives_its_id_back() {
        // The whole point: the plan is corrected under the name everything else in it
        // already refers to, rather than gaining a `layer-2` nobody wanted.
        let s = store();
        let id = dropped(&s, "layer");
        failed_run(&s, &id, Spend::default());

        assert_eq!(s.residue_of(&id).unwrap(), None);
        assert_eq!(s.free_task_id(&id).unwrap(), Freed::Id { attempts: 1 });
        assert!(s.executions(&id).unwrap().is_empty(), "and its empty runs");

        s.save_task(&Task::new("layer", "p", "do it properly this time"))
            .unwrap();
        let again = s.load_plan().unwrap();
        assert_eq!(again.tasks().count(), 1);
        assert_eq!(again.task(&id).unwrap().title, "do it properly this time");
    }

    #[test]
    fn an_id_is_not_freed_until_the_decision_is_recorded() {
        // `dropped` is the judgement, and this operation only carries out a judgement
        // already made. Without it the task is still dispatchable, and taking its name
        // away is losing queued work rather than mending a plan.
        let s = store();
        s.save_task(&Task::new("layer", "p", "do something specific"))
            .unwrap();
        let id = TaskId::new("layer");
        let held = s.residue_of(&id).unwrap().unwrap();
        assert_eq!(held, Residue::NotDropped(TaskStatus::Draft));
        assert_eq!(held.to_string(), "it is `draft`, not `dropped`");
        assert_eq!(s.free_task_id(&id).unwrap(), Freed::Nothing(held));
        assert_eq!(s.load_plan().unwrap().tasks().count(), 1, "still there");
    }

    #[test]
    fn an_open_attempt_holds_the_id() {
        // A row with no `ended` is a claim that some wecode is watching a process. Its
        // task disappearing underneath it leaves that process working for nobody.
        let s = store();
        let id = dropped(&s, "layer");
        s.start_execution(&id, "s-1", Some("/wt/layer"), Some(99))
            .unwrap();
        assert_eq!(
            s.residue_of(&id).unwrap(),
            Some(Residue::Running { attempt: 1 })
        );
    }

    #[test]
    fn an_attempt_that_finished_with_a_result_holds_it() {
        let s = store();
        let id = dropped(&s, "layer");
        let run = s.start_execution(&id, "s-1", None, None).unwrap();
        s.finish_execution(
            run,
            ExecutionStatus::Rejected,
            "out of scope",
            Spend::default(),
        )
        .unwrap();
        // `rejected` as much as `completed`: the work exists, and we declined it.
        assert_eq!(
            s.residue_of(&id).unwrap(),
            Some(Residue::Produced {
                attempt: 1,
                status: ExecutionStatus::Rejected
            })
        );
    }

    #[test]
    fn what_a_run_cost_is_not_erased_to_free_a_name() {
        // The execution row is the only place the count is kept, so deleting it would
        // report money that was spent as never having been.
        let s = store();
        let id = dropped(&s, "layer");
        failed_run(
            &s,
            &id,
            Spend {
                tokens: Some(90),
                replayed: Some(4000),
            },
        );
        let held = s.residue_of(&id).unwrap().unwrap();
        assert_eq!(
            held,
            Residue::Spent {
                attempt: 1,
                tokens: 90
            }
        );
        assert_eq!(held.to_string(), "attempt 1 spent 90 tokens");
    }

    #[test]
    fn a_run_that_reported_no_count_at_all_does_not_hold_it() {
        // NULL is *nothing could be read out of that agent*, which is most agents.
        // Refusing on it would refuse every real run, and 0 is a run that really did
        // report burning nothing.
        let s = store();
        let id = dropped(&s, "quiet");
        failed_run(&s, &id, Spend::default());
        failed_run(
            &s,
            &id,
            Spend {
                tokens: Some(0),
                replayed: Some(0),
            },
        );
        assert_eq!(s.residue_of(&id).unwrap(), None);
        assert_eq!(s.free_task_id(&id).unwrap(), Freed::Id { attempts: 2 });
    }

    #[test]
    fn a_cost_somebody_stated_holds_it_even_with_no_figure_on_it() {
        // An attestation is a person's account of work wecode never metered. There is
        // no second source for it, so it is not a row a name can be worth.
        let s = store();
        let id = dropped(&s, "layer");
        s.record_execution(
            &id,
            "s-1",
            &Attested {
                by: "cws".into(),
                wall_secs: Some(7200),
                spend: Spend::default(),
                detail: "worked it in my own session".into(),
            },
        )
        .unwrap();
        let held = s.residue_of(&id).unwrap().unwrap();
        assert_eq!(
            held,
            Residue::Attested {
                attempt: 1,
                by: "cws".into()
            }
        );
        assert_eq!(held.to_string(), "cws stated what attempt 1 cost");
    }

    #[test]
    fn a_tree_still_standing_holds_it_until_it_is_torn_down() {
        // The next task under this id is cut at the same path, and would start in the
        // abandoned run's working directory.
        let s = store();
        let id = dropped(&s, "layer");
        s.record_worktree("/wt/layer", "repo", "wecode/layer", &id)
            .unwrap();
        assert_eq!(
            s.residue_of(&id).unwrap(),
            Some(Residue::Tree {
                path: "/wt/layer".into()
            })
        );

        // The tombstone stays behind and does not hold it: what stands there now is
        // the question, and nothing does.
        s.forget_worktree("/wt/layer").unwrap();
        assert_eq!(s.residue_of(&id).unwrap(), None);
        assert!(matches!(
            s.free_task_id(&id).unwrap(),
            Freed::Id { attempts: 0 }
        ));
        assert_eq!(
            s.worktrees().unwrap().len(),
            1,
            "and is still on the record"
        );
    }

    #[test]
    fn work_that_landed_holds_it_whatever_the_status_says_now() {
        // A merge signed beforehand records `approval`, not `allow`. Reading only
        // `allow` would miss every merge onto a protected branch — the ones that
        // matter most.
        let s = store();
        let id = dropped(&s, "layer");
        s.append_records(&[Record {
            seq: 1,
            session: "s-1".into(),
            post: "impl".into(),
            occupant: "claude-code".into(),
            human: None,
            project: Some("p".into()),
            task: Some("layer".into()),
            action: Action::Merge {
                branch: "main".into(),
            },
            decision: Decision::RequireApproval {
                by: ActionKind::Merge,
            },
            source: Source::Broker,
        }])
        .unwrap();
        assert_eq!(
            s.residue_of(&id).unwrap(),
            Some(Residue::Merged {
                branch: "main".into()
            })
        );
    }

    #[test]
    fn a_merge_the_broker_refused_does_not_hold_it() {
        let s = store();
        let id = dropped(&s, "layer");
        s.append_records(&[Record {
            seq: 1,
            session: "s-1".into(),
            post: "impl".into(),
            occupant: "claude-code".into(),
            human: None,
            project: Some("p".into()),
            task: Some("layer".into()),
            action: Action::Merge {
                branch: "main".into(),
            },
            decision: Decision::Deny {
                reason: DenyReason::BranchNotPermitted {
                    branch: "main".into(),
                },
                mode: ControlMode::Regimented,
                alarm: false,
            },
            source: Source::Broker,
        }])
        .unwrap();
        assert_eq!(s.residue_of(&id).unwrap(), None, "nothing landed");
    }

    #[test]
    fn a_relation_pointing_at_it_holds_it_rather_than_being_cut() {
        // `parent_id` is SET NULL and the dependency edge cascades, so both of these
        // would go quietly: a subtask re-rooted at the top of the plan, a dependent
        // whose prerequisite was never stated. Refusing names them so the operator
        // decides the order.
        let s = store();
        let id = dropped(&s, "layer");
        s.save_task(&Task::new("bench", "p", "measure it").under("layer"))
            .unwrap();
        assert_eq!(
            s.residue_of(&id).unwrap(),
            Some(Residue::Parent {
                subtask: "bench".into()
            })
        );

        s.set_task_shape(&TaskId::new("bench"), None, &["layer".into()])
            .unwrap();
        assert_eq!(
            s.residue_of(&id).unwrap(),
            Some(Residue::Awaited { by: "bench".into() })
        );
    }

    #[test]
    fn the_reason_reported_is_the_one_the_reader_has_to_act_on_first() {
        // Several rules can hold at once, and the message has to be the same twice for
        // the same database. Acting on the directory while the run continues makes
        // things worse, so the live process is what is named.
        let s = store();
        let id = dropped(&s, "layer");
        s.record_worktree("/wt/layer", "repo", "wecode/layer", &id)
            .unwrap();
        failed_run(
            &s,
            &id,
            Spend {
                tokens: Some(90),
                replayed: None,
            },
        );
        s.start_execution(&id, "s-2", Some("/wt/layer"), Some(99))
            .unwrap();
        assert_eq!(
            s.residue_of(&id).unwrap(),
            Some(Residue::Running { attempt: 2 })
        );
    }

    #[test]
    fn the_number_and_the_ledger_follow_the_id_rather_than_the_task() {
        // Both are deliberate, and both are why the rules above are strict. The number
        // names the id permanently (`short_numbers` has no foreign key), so the
        // corrected task answers to the number the notifications already used; the
        // ledger keeps what the removed task did, because rewriting history to hide a
        // mistake is the one thing an audit log must never do.
        let s = store();
        let id = dropped(&s, "layer");
        let before = s.number_if_any(Level::Task, "layer").unwrap().unwrap();
        s.append_records(&[Record {
            seq: 1,
            session: "s-1".into(),
            post: "impl".into(),
            occupant: "claude-code".into(),
            human: None,
            project: Some("p".into()),
            task: Some("layer".into()),
            action: Action::Read {
                path: "src/lib.rs".into(),
            },
            decision: Decision::Allow,
            source: Source::Broker,
        }])
        .unwrap();

        assert_eq!(s.free_task_id(&id).unwrap(), Freed::Id { attempts: 0 });
        s.save_task(&Task::new("layer", "p", "do it properly this time"))
            .unwrap();
        assert_eq!(s.number_of(Level::Task, "layer").unwrap(), before);
        assert_eq!(
            s.audit(&crate::AuditQuery {
                task: Some("layer".into()),
                ..Default::default()
            })
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn an_id_nothing_holds_is_reported_free() {
        // Idempotence, and honesty about what was asked: *is this name available* has
        // one answer here, and a second call after a successful one is agreement rather
        // than a new failure.
        let s = store();
        let ghost = TaskId::new("ghost");
        assert_eq!(s.residue_of(&ghost).unwrap(), None);
        assert_eq!(s.free_task_id(&ghost).unwrap(), Freed::Id { attempts: 0 });
    }
}
