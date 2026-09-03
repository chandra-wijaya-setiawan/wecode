//! Reading and writing the plan.
//!
//! The database is the storage; [`wecode_core::Plan`] is the in-memory shape with
//! the structural rules. Loading builds a `Plan` and inserts through its own
//! validation, so a database that somehow held a cycle would be caught on read
//! rather than propagating.

use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, params};
use wecode_core::task::Doer;
use wecode_core::{
    Budget, Cmp, Measure, Number, Plan, Project, ProjectId, ProjectStatus, Scope, Task, TaskId,
    TaskKind, TaskStatus,
};

use crate::short::Level;
use crate::{Store, StoreError};

/// Which table a measure came from, so one pair of helpers serves both.
enum MeasureTable {
    Project,
    Task,
}

impl MeasureTable {
    fn name(&self) -> &'static str {
        match self {
            Self::Project => "project_measures",
            Self::Task => "task_acceptance",
        }
    }

    fn owner(&self) -> &'static str {
        match self {
            Self::Project => "project_id",
            Self::Task => "task_id",
        }
    }
}

fn cmp_str(c: Cmp) -> &'static str {
    match c {
        Cmp::Lt => "lt",
        Cmp::Lte => "lte",
        Cmp::Gt => "gt",
        Cmp::Gte => "gte",
        Cmp::Eq => "eq",
    }
}

fn cmp_parse(s: &str) -> Option<Cmp> {
    Some(match s {
        "lt" => Cmp::Lt,
        "lte" => Cmp::Lte,
        "gt" => Cmp::Gt,
        "gte" => Cmp::Gte,
        "eq" => Cmp::Eq,
        _ => return None,
    })
}

/// The design a story governs, as the store holds it.
///
/// A digest, and never the prose. ADR-0005 settled it for decisions — "the table is the
/// index, `docs/adr/*.md` is the text" — and a design has more riding on it: argued at
/// length, reviewed as a diff, signed once. What is left for the database is the join
/// nothing else can make: *which* document this story was built on.
///
/// So there is no `designs` table. Every field is folded out of rows the plan already
/// has, except [`Design::digest`], which is deliberately not a column — a stored checksum
/// stops being true the next time somebody saves the file, with nothing in it to say so.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Design {
    /// The design task that decided it.
    pub task: TaskId,
    /// Where its document sits, repo-relative — the task's own write scope where it
    /// named a file, the convention where it named none.
    pub document: String,
    /// Whether the decision has been signed. A design is the one kind that is not
    /// finished when it passes, so this is `done` and nothing weaker.
    pub decided: bool,
    /// A checksum of what the document said, and `None` until somebody opens it: the
    /// store reads no files. [`Design::read`] is what fills it.
    pub digest: Option<String>,
}

/// FNV-1a, 64-bit — offset basis and prime.
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

impl Design {
    /// This digest with the document read: a checksum of what it says today.
    #[must_use]
    pub fn read(mut self, text: &str) -> Self {
        self.digest = Some(Self::checksum(text));
        self
    }

    /// Whether `text` is still the document this digest was taken of.
    ///
    /// `false` for a digest nobody filled, which is the honest answer rather than a
    /// missing case: reading *unchanged* out of *unrecorded* is how a drift check comes
    /// to certify drift.
    #[must_use]
    pub fn unchanged(&self, text: &str) -> bool {
        self.digest.as_deref() == Some(Self::checksum(text).as_str())
    }

    /// A checksum over a document's words.
    ///
    /// Whitespace is not content: the words are taken in order and everything between
    /// them collapses, so re-wrapping a paragraph leaves the digest where it was.
    /// `scripts/design-check.sh` normalises the same way, and for the same reason — two
    /// documents differing only in how they were wrapped are one document.
    ///
    /// FNV-1a, which tells documents apart and does not withstand somebody who wants two
    /// to collide. Nothing here is a signature: that is the ledger row, and a digest that
    /// stopped matching is the reason to go and read it.
    #[must_use]
    pub fn checksum(text: &str) -> String {
        let mut h = FNV_OFFSET;
        for byte in text
            .split_whitespace()
            .flat_map(|w| w.bytes().chain(Some(b' ')))
        {
            h ^= u64::from(byte);
            h = h.wrapping_mul(FNV_PRIME);
        }
        format!("{h:016x}")
    }
}

impl Store {
    /// Rebuilds the whole plan.
    pub fn load_plan(&self) -> Result<Plan, StoreError> {
        let mut plan = Plan::new();

        // Both mappings up front, so every project and task is numbered by the time
        // anything reads the plan. A view or a resolver that had to reach back to the
        // store for a number would be a second source for it.
        let project_numbers: BTreeMap<String, Number> =
            self.numbers(Level::Project)?.into_iter().collect();
        let task_numbers: BTreeMap<String, Number> =
            self.numbers(Level::Task)?.into_iter().collect();

        let mut stmt = self.conn().prepare(
            "SELECT id, repo, objective, status, budget_tokens, budget_wall, archived
             FROM projects ORDER BY id",
        )?;
        type ProjectRow = (
            String,
            String,
            String,
            String,
            Option<i64>,
            Option<i64>,
            i64,
        );
        let rows: Vec<ProjectRow> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;

        for (id, repo, objective, status, tokens, wall, archived) in rows {
            let mut p = Project::new(ProjectId::new(&id), objective, repo);
            p.number = project_numbers.get(&id).copied();
            p.status = ProjectStatus::parse(&status).ok_or_else(|| StoreError::Corrupt {
                what: "project status",
                value: status.clone(),
            })?;
            p.budget = Budget {
                tokens: crate::int::opt_from_db(tokens, "budget tokens")?,
                wall_secs: crate::int::opt_from_db(wall, "budget wall")?,
            };
            p.archived = archived != 0;
            p.measures = self.measures(&MeasureTable::Project, &id)?;
            plan.add_project(p).map_err(structural)?;
        }

        // Row order carries nothing. `Plan` checks both relations on insert, and both
        // are attached after every task is in — an id order that puts each parent
        // first does not exist once a hierarchy is more than one level deep.
        let mut deferred_parents: Vec<(TaskId, TaskId)> = Vec::new();
        let mut stmt = self.conn().prepare(
            "SELECT id, project_id, kind, doer, title, parent_id, status, assignee,
                    budget_tokens, budget_wall, archived, requirement_id
             FROM tasks ORDER BY id",
        )?;
        type Row = (
            String,
            String,
            String,
            String,
            String,
            Option<String>,
            String,
            Option<String>,
            Option<i64>,
            Option<i64>,
            i64,
            Option<String>,
        );
        let rows: Vec<Row> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                    r.get(11)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;

        for (
            id,
            project,
            kind,
            doer,
            title,
            parent,
            status,
            assignee,
            tokens,
            wall,
            archived,
            requirement,
        ) in rows
        {
            let mut t = Task::new(TaskId::new(&id), ProjectId::new(&project), title);
            t.number = task_numbers.get(&id).copied();
            t.kind = TaskKind::parse(&kind).ok_or_else(|| StoreError::Corrupt {
                what: "task kind",
                value: kind.clone(),
            })?;
            // Parsed as strictly as the kind above it, and here that strictness is not
            // merely consistency: the word this build cannot read might be the one that
            // says *not an agent*, so falling back to the column's default would
            // dispatch precisely the work the row was written to keep an agent off.
            // Failing the whole load is the loud version of the same answer.
            t.doer = Doer::parse(&doer).ok_or_else(|| StoreError::Corrupt {
                what: "task doer",
                value: doer.clone(),
            })?;
            t.status = TaskStatus::parse(&status).ok_or_else(|| StoreError::Corrupt {
                what: "task status",
                value: status.clone(),
            })?;
            t.parent = parent.map(TaskId::new);
            t.assignee = assignee;
            t.budget = Budget {
                tokens: crate::int::opt_from_db(tokens, "budget tokens")?,
                wall_secs: crate::int::opt_from_db(wall, "budget wall")?,
            };
            t.archived = archived != 0;
            // Unparsed, unlike the kind and the doer above: a handle is a string all the
            // way down, and there is no set of them this build could check it against
            // without loading the ledger for every task in the plan. What refuses an
            // unknown handle is the gate at `task add`, before the row exists.
            t.requirement = requirement;
            t.acceptance = self.measures(&MeasureTable::Task, &id)?;
            t.scope = self.scope(&id)?;
            // Parents last, for the same reason dependencies are: a child may sort
            // before its parent (`req-rows` before `requirements-table`) and a
            // grandchild always can, and inserting one first aborted the whole load —
            // every read failed until the row was repaired by hand (1 Sep 2026).
            let parent = t.parent.take();
            plan.add_task(t).map_err(structural)?;
            if let Some(p) = parent {
                deferred_parents.push((TaskId::new(id.clone()), p));
            }
        }

        for (child, parent) in deferred_parents {
            let mut t = plan.task(&child).cloned().ok_or_else(|| {
                structural(wecode_core::PlanError::NoSuchTask(child.clone()))
            })?;
            t.parent = Some(parent);
            plan.update_task(t).map_err(structural)?;
        }

        // Dependencies last: both endpoints must already be present.
        let mut stmt = self
            .conn()
            .prepare("SELECT task_id, prerequisite_id FROM task_depends_on ORDER BY task_id")?;
        let edges: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;

        for (task, prereq) in edges {
            let id = TaskId::new(&task);
            let Some(existing) = plan.task(&id) else {
                continue;
            };
            let mut updated = existing.clone();
            updated.depends_on.push(TaskId::new(&prereq));
            plan.update_task(updated).map_err(structural)?;
        }
        Ok(plan)
    }

    fn measures(&self, table: &MeasureTable, owner: &str) -> Result<Vec<Measure>, StoreError> {
        let sql = format!(
            "SELECT kind, cmd, expect_status, name, target, cmp, path, note
             FROM {} WHERE {} = ?1 ORDER BY seq",
            table.name(),
            table.owner()
        );
        let mut stmt = self.conn().prepare(&sql)?;
        type Row = (
            String,
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<f64>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let rows: Vec<Row> = stmt
            .query_map([owner], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;

        rows.into_iter()
            .map(
                |(kind, cmd, status, name, target, cmp, path, note)| match kind.as_str() {
                    "command" => Ok(Measure::Command {
                        cmd: cmd.unwrap_or_default(),
                        expect_status: i32::try_from(status.unwrap_or(0)).map_err(|_| {
                            StoreError::Corrupt {
                                what: "expected exit status",
                                value: status.unwrap_or(0).to_string(),
                            }
                        })?,
                    }),
                    "metric" => Ok(Measure::Metric {
                        name: name.unwrap_or_default(),
                        target: target.unwrap_or(0.0),
                        cmp: cmp.as_deref().and_then(cmp_parse).unwrap_or(Cmp::Eq),
                    }),
                    "deliverable" => Ok(Measure::Deliverable {
                        path: path.unwrap_or_default(),
                    }),
                    "judged" => Ok(Measure::Judged {
                        note: note.unwrap_or_default(),
                    }),
                    other => Err(StoreError::Corrupt {
                        what: "measure kind",
                        value: other.to_string(),
                    }),
                },
            )
            .collect()
    }

    fn scope(&self, task: &str) -> Result<Scope, StoreError> {
        let mut stmt = self
            .conn()
            .prepare("SELECT access, glob FROM task_scopes WHERE task_id = ?1 ORDER BY glob")?;
        let rows: Vec<(String, String)> = stmt
            .query_map([task], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;

        let mut scope = Scope::default();
        for (access, glob) in rows {
            match access.as_str() {
                "read" => scope.read.push(glob),
                "write" => scope.write.push(glob),
                other => {
                    return Err(StoreError::Corrupt {
                        what: "scope access",
                        value: other.to_string(),
                    });
                }
            }
        }
        Ok(scope)
    }

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

    /// Inserts or replaces a task, its acceptance, scope and dependencies.
    pub fn save_task(&self, t: &Task) -> Result<(), StoreError> {
        let c = self.conn();
        c.execute(
            "INSERT INTO tasks (id, project_id, kind, doer, title, parent_id, status, assignee,
                                budget_tokens, budget_wall, archived, requirement_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                project_id = ?2, kind = ?3, doer = ?4, title = ?5, parent_id = ?6,
                status = ?7, assignee = ?8, budget_tokens = ?9, budget_wall = ?10,
                archived = ?11, requirement_id = ?12",
            params![
                t.id.as_str(),
                t.project.as_str(),
                t.kind.as_str(),
                t.doer.as_str(),
                t.title,
                t.parent.as_ref().map(TaskId::as_str),
                t.status.as_str(),
                t.assignee,
                crate::int::opt_to_db(t.budget.tokens),
                crate::int::opt_to_db(t.budget.wall_secs),
                i64::from(t.archived),
                t.requirement,
            ],
        )?;
        self.replace_measures(&MeasureTable::Task, t.id.as_str(), &t.acceptance)?;

        c.execute(
            "DELETE FROM task_scopes WHERE task_id = ?1",
            [t.id.as_str()],
        )?;
        for (access, globs) in [("read", &t.scope.read), ("write", &t.scope.write)] {
            for glob in globs {
                c.execute(
                    "INSERT INTO task_scopes (task_id, access, glob) VALUES (?1, ?2, ?3)",
                    params![t.id.as_str(), access, glob],
                )?;
            }
        }

        c.execute(
            "DELETE FROM task_depends_on WHERE task_id = ?1",
            [t.id.as_str()],
        )?;
        for dep in &t.depends_on {
            c.execute(
                "INSERT INTO task_depends_on (task_id, prerequisite_id) VALUES (?1, ?2)",
                params![t.id.as_str(), dep.as_str()],
            )?;
        }
        // The one place a task can be created, so the one place a number has to be
        // minted. See `save_project` for why `t.number` is not consulted.
        self.number_of(Level::Task, t.id.as_str())?;
        Ok(())
    }

    fn replace_measures(
        &self,
        table: &MeasureTable,
        owner: &str,
        measures: &[Measure],
    ) -> Result<(), StoreError> {
        let c = self.conn();
        c.execute(
            &format!("DELETE FROM {} WHERE {} = ?1", table.name(), table.owner()),
            [owner],
        )?;
        let sql = format!(
            "INSERT INTO {} ({}, seq, kind, cmd, expect_status, name, target, cmp, path, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            table.name(),
            table.owner()
        );
        for (seq, m) in measures.iter().enumerate() {
            let seq = i64::try_from(seq).unwrap_or(i64::MAX);
            match m {
                Measure::Command { cmd, expect_status } => c.execute(
                    &sql,
                    params![
                        owner,
                        seq,
                        "command",
                        cmd,
                        i64::from(*expect_status),
                        None::<String>,
                        None::<f64>,
                        None::<String>,
                        None::<String>,
                        None::<String>
                    ],
                )?,
                Measure::Metric { name, target, cmp } => c.execute(
                    &sql,
                    params![
                        owner,
                        seq,
                        "metric",
                        None::<String>,
                        None::<i64>,
                        name,
                        target,
                        cmp_str(*cmp),
                        None::<String>,
                        None::<String>
                    ],
                )?,
                Measure::Deliverable { path } => c.execute(
                    &sql,
                    params![
                        owner,
                        seq,
                        "deliverable",
                        None::<String>,
                        None::<i64>,
                        None::<String>,
                        None::<f64>,
                        None::<String>,
                        path,
                        None::<String>
                    ],
                )?,
                Measure::Judged { note } => c.execute(
                    &sql,
                    params![
                        owner,
                        seq,
                        "judged",
                        None::<String>,
                        None::<i64>,
                        None::<String>,
                        None::<f64>,
                        None::<String>,
                        None::<String>,
                        note
                    ],
                )?,
            };
        }
        Ok(())
    }

    /// Sets a task's status without rewriting the rest of it.
    pub fn set_task_status(&self, id: &TaskId, status: TaskStatus) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE tasks SET status = ?2 WHERE id = ?1",
            params![id.as_str(), status.as_str()],
        )?;
        Ok(())
    }

    /// Sets a task's budget without rewriting the rest of it.
    ///
    /// Two columns rather than a whole [`Self::save_task`], for the reason
    /// [`Self::set_task_status`] is also narrow: a save replaces acceptance, scope and
    /// dependencies from whatever the caller happened to be holding. Acceptance is
    /// frozen once a task has been dispatched, and a command that amends a budget must
    /// not be able to move it — not even by writing back a plan read a moment earlier.
    pub fn set_task_budget(&self, id: &TaskId, budget: Budget) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE tasks SET budget_tokens = ?2, budget_wall = ?3 WHERE id = ?1",
            params![
                id.as_str(),
                crate::int::opt_to_db(budget.tokens),
                crate::int::opt_to_db(budget.wall_secs),
            ],
        )?;
        Ok(())
    }

    /// What whoever does this task is told to do, and `None` when nothing was written.
    ///
    /// Read on its own rather than as a field of [`Self::load_plan`], and the reason is
    /// who asks. The plan is loaded on every tick, by the board, by the cockpit, by
    /// every command that resolves a short number — none of which show a runbook, and
    /// all of which would carry every one of them in memory to do it. Two things read
    /// this: the command that prints a task in full, and the notification that hands a
    /// person their instructions. Both hold one task and ask about it.
    ///
    /// `None` is also what a task that does not exist reads as. The caller that needs to
    /// tell those apart is asking the plan, which knows; nothing that has instructions
    /// to show is better off for a second way to hear that the id was a typo.
    pub fn task_steps(&self, id: &TaskId) -> Result<Option<String>, StoreError> {
        let steps: Option<Option<String>> = self
            .conn()
            .query_row("SELECT steps FROM tasks WHERE id = ?1", [id.as_str()], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(steps.flatten())
    }

    /// Records what whoever does this task is told to do. Blank erases it.
    ///
    /// One column rather than a whole [`Self::save_task`], for the reason
    /// [`Self::set_task_budget`] is narrow: a save replaces acceptance, scope and
    /// dependencies out of whatever the caller was holding, and acceptance is frozen
    /// once a task has been dispatched. Writing a task's instructions must not be able
    /// to move what it is judged by.
    ///
    /// It is also the only way the column can be written at all: the domain's [`Task`]
    /// has no field for this, and deliberately — a document is not something the
    /// scheduler, the admission gate or the overlap check has any use for, and putting
    /// it on the type every one of them passes around would mean carrying it through all
    /// of them to be read in two places.
    ///
    /// Blank collapses to `NULL` so the column has one spelling for nothing. A steps
    /// document of whitespace is not a briefing, and a caller that wants the absence
    /// back — an operator who wrote the wrong file — has one way to say so.
    pub fn set_task_steps(&self, id: &TaskId, steps: &str) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE tasks SET steps = ?2 WHERE id = ?1",
            params![id.as_str(), (!steps.trim().is_empty()).then_some(steps)],
        )?;
        Ok(())
    }

    /// The obligation one task is an attempt at, and `None` when it names none.
    ///
    /// The read half of [`Self::set_task_requirement`], on [`Self::task_steps`]'s terms:
    /// a caller holding one task id and asking one question about it should not have to
    /// rebuild the plan to hear the answer. Everything that wants this beside a whole
    /// plan already has it — [`Task::requirement`] is loaded with the rest of the row.
    ///
    /// `None` is also what a task that does not exist reads as, again as `task_steps` is.
    pub fn requirement_of(&self, id: &TaskId) -> Result<Option<String>, StoreError> {
        let found: Option<Option<String>> = self
            .conn()
            .query_row(
                "SELECT requirement_id FROM tasks WHERE id = ?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        Ok(found.flatten())
    }

    /// Records that this task is an attempt at that obligation. Blank erases it.
    ///
    /// One column rather than a whole [`Self::save_task`], on [`Self::set_task_budget`]'s
    /// rule: a task claims an obligation at the moment it is created, and a save would
    /// carry the caller's whole idea of the task back into the database beside it —
    /// including acceptance, which is frozen once a task has been dispatched.
    ///
    /// The handle is not checked here, and that is where the check belongs rather than a
    /// gap in it. A handle nothing stated is a typo in a command, so it is refused at the
    /// gate, before the task exists; by the time anything reaches this, the alternative
    /// to writing the column would be a saved task and a silent refusal to link it.
    pub fn set_task_requirement(&self, id: &TaskId, requirement: &str) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE tasks SET requirement_id = ?2 WHERE id = ?1",
            params![
                id.as_str(),
                (!requirement.trim().is_empty()).then_some(requirement)
            ],
        )?;
        Ok(())
    }

    /// The digest of the design this story governs, and `None` when no design stands
    /// behind it.
    ///
    /// *Governs* is the admission gate's own relation read from the story's end: a design
    /// **inside** it, which is what `task add <story>-design --parent <story>` makes, or
    /// one it comes **after**, which is the shape an expansion takes. Both, and
    /// transitively — a chain of steps built on one design is ordinary and only the first
    /// link names the design directly, so `wecode_core::admission` walks these same two
    /// edges in the other direction.
    ///
    /// One query rather than a walk in the caller, for [`Self::set_task_archived`]'s
    /// reason and with its termination: `UNION` and not `UNION ALL`, because `Plan`
    /// refuses a loop but anyone can open wecode.db with the sqlite3 CLI. A story holding
    /// two is answered with its own step first and then by id — deterministic rather than
    /// meaningful, since two designs behind one story is a story decomposed twice.
    pub fn design_of(&self, story: &TaskId) -> Result<Option<Design>, StoreError> {
        let found: Option<(String, String)> = self
            .conn()
            .query_row(
                "WITH RECURSIVE edge(above, below) AS (
                     SELECT parent_id, id FROM tasks WHERE parent_id IS NOT NULL
                     UNION ALL
                     SELECT task_id, prerequisite_id FROM task_depends_on
                 ),
                 governed(id) AS (
                     SELECT ?1
                     UNION
                     SELECT edge.below FROM edge JOIN governed ON edge.above = governed.id
                 )
                 SELECT t.id, t.status FROM tasks t JOIN governed ON t.id = governed.id
                 WHERE t.kind = ?2
                 ORDER BY (t.parent_id IS NOT ?1), t.id LIMIT 1",
                params![story.as_str(), TaskKind::Design.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((task, status)) = found else {
            return Ok(None);
        };
        let status = TaskStatus::parse(&status).ok_or_else(|| StoreError::Corrupt {
            what: "task status",
            value: status.clone(),
        })?;
        Ok(Some(Design {
            document: self.design_document(&task)?,
            task: TaskId::new(task),
            decided: status.is_done(),
            // Never here. The reader that wants a checksum is the one holding the file.
            digest: None,
        }))
    }

    /// Where a design task wrote, according to the task itself.
    ///
    /// Its declared write scope, because that is the one place a task states where it
    /// wrote, and globs are dropped: `docs/**` names a directory rather than a document.
    /// The fallback is the convention `playbook init` writes and the merge report lands
    /// beside. Both halves are the CLI's `handoff` rule, which asks the same question
    /// where the filesystem is.
    fn design_document(&self, task: &str) -> Result<String, StoreError> {
        Ok(self
            .scope(task)?
            .write
            .into_iter()
            .find(|w| w.ends_with(".md") && !w.contains(['*', '?', '[']))
            .unwrap_or_else(|| format!("docs/wecode/{task}/design.md")))
    }

    /// Sets where a task sits — what it is part of, and what it comes after — without
    /// rewriting the rest of it.
    ///
    /// Narrow for the reason [`Self::set_task_budget`] is narrow, and for a sharper
    /// version of it: the task being moved has usually run, and a [`Self::save_task`]
    /// would carry the caller's whole idea of the task back into the database beside
    /// the two relations. Acceptance is frozen once a task has been dispatched, so a
    /// command that reshapes a plan must not be able to move it — not even by writing
    /// back a plan it read a moment earlier.
    ///
    /// The dependency rows are replaced rather than merged: the caller passes the list
    /// it wants, which is the only way to say that a prerequisite has gone away.
    pub fn set_task_shape(
        &self,
        id: &TaskId,
        parent: Option<&TaskId>,
        after: &[TaskId],
    ) -> Result<(), StoreError> {
        let c = self.conn();
        c.execute(
            "UPDATE tasks SET parent_id = ?2 WHERE id = ?1",
            params![id.as_str(), parent.map(TaskId::as_str)],
        )?;
        c.execute(
            "DELETE FROM task_depends_on WHERE task_id = ?1",
            [id.as_str()],
        )?;
        for dep in after {
            c.execute(
                "INSERT INTO task_depends_on (task_id, prerequisite_id) VALUES (?1, ?2)",
                params![id.as_str(), dep.as_str()],
            )?;
        }
        Ok(())
    }

    /// Erases a task and everything hanging off it.
    ///
    /// Only ever for a task that never ran — the caller checks that, because the
    /// reason is a policy one and belongs where the policy is stated. Deleting a task
    /// with executions would orphan rows that record real work.
    ///
    /// The audit ledger is deliberately untouched: it records that the task was
    /// created and then removed, and rewriting history to hide a mistake is the one
    /// thing an audit log must never do.
    pub fn delete_task(&self, id: &TaskId) -> Result<(), StoreError> {
        let c = self.conn();
        for sql in [
            "DELETE FROM task_scopes WHERE task_id = ?1",
            "DELETE FROM task_depends_on WHERE task_id = ?1",
            "DELETE FROM task_acceptance WHERE task_id = ?1",
            "DELETE FROM tasks WHERE id = ?1",
        ] {
            c.execute(sql, [id.as_str()])?;
        }
        Ok(())
    }

    /// Files a task away with everything that is part of it, or brings the group back.
    /// Returns the ids whose flag actually changed, in id order.
    ///
    /// The cascade is one query rather than a walk in the caller, so no subtask can be
    /// left behind by a plan that was read a moment earlier — the same reason
    /// `delete_task` does its own clearing up. It follows `parent_id` only: hiding
    /// everything that merely comes *after* this task is a different claim, and one
    /// nobody asked for.
    ///
    /// `UNION`, not `UNION ALL`. `Plan` refuses a parent loop, but `foreign_keys` is
    /// per-connection and anyone can open wecode.db with the sqlite3 CLI, so a loop is
    /// reachable — and the difference between the two keywords there is termination.
    pub fn set_task_archived(
        &self,
        id: &TaskId,
        archived: bool,
    ) -> Result<Vec<TaskId>, StoreError> {
        let c = self.conn();
        let mut stmt = c.prepare(
            "WITH RECURSIVE part_of(id) AS (
                 SELECT id FROM tasks WHERE id = ?1
                 UNION
                 SELECT t.id FROM tasks t JOIN part_of ON t.parent_id = part_of.id
             )
             SELECT t.id FROM tasks t JOIN part_of ON t.id = part_of.id
             WHERE t.archived <> ?2 ORDER BY t.id",
        )?;
        let changed: Vec<TaskId> = stmt
            .query_map(params![id.as_str(), i64::from(archived)], |r| {
                r.get::<_, String>(0).map(TaskId::new)
            })?
            .collect::<rusqlite::Result<_>>()?;

        for t in &changed {
            c.execute(
                "UPDATE tasks SET archived = ?2 WHERE id = ?1",
                params![t.as_str(), i64::from(archived)],
            )?;
        }
        Ok(changed)
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

/// Structural failures on read mean the database disagrees with the domain rules.
fn structural(e: wecode_core::PlanError) -> StoreError {
    StoreError::Corrupt {
        what: "plan structure",
        value: e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::in_memory().unwrap()
    }

    fn project() -> Project {
        Project::new("caching", "add response caching", "wecode")
            .measured(Measure::Metric {
                name: "p99_ms".into(),
                target: 500.0,
                cmp: Cmp::Lt,
            })
            .budgeted(Budget {
                tokens: Some(200_000),
                wall_secs: Some(1800),
            })
    }

    fn task(id: &str) -> Task {
        Task::new(id, "caching", format!("do {id}"))
            .accepting(Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 0,
            })
            .scoped(Scope::write(&["crates/export/**"]))
            .budgeted(Budget {
                tokens: Some(1000),
                wall_secs: Some(60),
            })
    }

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
    fn a_task_round_trips_with_acceptance_scope_and_a_number() {
        let s = store();
        s.save_project(&project()).unwrap();
        let t = task("cache-layer");
        s.save_task(&t).unwrap();

        let loaded = s.load_plan().unwrap();
        // 2, not 1: the sequence spans both levels and the project took the first.
        let mut expected = t.clone();
        expected.number = Some(Number::new(2));
        assert_eq!(loaded.task(&"cache-layer".into()), Some(&expected));
        assert_eq!(loaded.task_ref("2").map(|x| &x.id), Some(&t.id));

        // Saving again — which every status change does — must not renumber it.
        s.save_task(&t).unwrap();
        assert_eq!(
            s.load_plan().unwrap().task(&"cache-layer".into()),
            Some(&expected)
        );
    }

    #[test]
    fn a_budget_moves_without_disturbing_anything_else_about_the_task() {
        // The whole reason this is not a `save_task`: the task it amends has usually
        // run, and acceptance is frozen at dispatch. A save would carry the caller's
        // whole idea of the task back into the database beside the two figures.
        let s = store();
        s.save_project(&project()).unwrap();
        let t = task("layer").after("keys");
        s.save_task(&task("keys")).unwrap();
        s.save_task(&t).unwrap();
        s.set_task_status(&"layer".into(), TaskStatus::Failed)
            .unwrap();

        s.set_task_budget(
            &"layer".into(),
            Budget {
                tokens: Some(400_000),
                wall_secs: Some(900),
            },
        )
        .unwrap();

        let back = s.load_plan().unwrap().task(&"layer".into()).unwrap().clone();
        assert_eq!(back.budget.tokens, Some(400_000));
        assert_eq!(back.budget.wall_secs, Some(900));
        assert_eq!(back.acceptance, t.acceptance, "acceptance is frozen");
        assert_eq!(back.scope, t.scope);
        assert_eq!(back.depends_on, vec![TaskId::new("keys")]);
        assert_eq!(back.status, TaskStatus::Failed, "status untouched");
        assert_eq!(back.number, Some(Number::new(3)), "not renumbered");
    }

    #[test]
    fn a_move_disturbs_nothing_else_about_the_task() {
        // The same reason `set_task_budget` is not a save: by the time a plan is
        // reshaped the task has usually run, and acceptance is frozen at dispatch.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("sprint")).unwrap();
        s.save_task(&task("keys")).unwrap();
        let t = task("layer").after("keys");
        s.save_task(&t).unwrap();
        s.set_task_status(&"layer".into(), TaskStatus::Failed)
            .unwrap();

        s.set_task_shape(&"layer".into(), Some(&"sprint".into()), &[])
            .unwrap();

        let back = s
            .load_plan()
            .unwrap()
            .task(&"layer".into())
            .unwrap()
            .clone();
        assert_eq!(back.parent, Some(TaskId::new("sprint")));
        assert!(back.depends_on.is_empty(), "the stale edge is gone");
        assert_eq!(back.acceptance, t.acceptance, "acceptance is frozen");
        assert_eq!(back.scope, t.scope);
        assert_eq!(back.budget, t.budget);
        assert_eq!(back.status, TaskStatus::Failed, "status untouched");
        assert_eq!(back.number, Some(Number::new(4)), "not renumbered");
    }

    #[test]
    fn a_move_out_of_a_group_and_a_new_ordering_both_persist() {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("sprint")).unwrap();
        s.save_task(&task("first")).unwrap();
        s.save_task(&task("layer").under("sprint")).unwrap();

        s.set_task_shape(&"layer".into(), None, &[TaskId::new("first")])
            .unwrap();
        let plan = s.load_plan().unwrap();
        let back = plan.task(&"layer".into()).unwrap();
        assert!(back.parent.is_none(), "lifted out of the group");
        assert_eq!(back.depends_on, vec![TaskId::new("first")]);
        assert_eq!(plan.dependents(&"first".into()).count(), 1);
    }

    #[test]
    fn filing_a_task_away_takes_everything_that_is_part_of_it() {
        // The whole point of the cascade: an expansion is one piece of work and several
        // rows, so filing the parent and leaving the children clears the heading and
        // none of the clutter.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();
        s.save_task(&task("keys").under("layer")).unwrap();
        s.save_task(&task("salt").under("keys")).unwrap();
        // A sibling of the group, to prove the cascade stops where the hierarchy does.
        s.save_task(&task("bench").after("layer")).unwrap();

        let changed = s.set_task_archived(&"layer".into(), true).unwrap();
        assert_eq!(
            changed,
            vec![
                TaskId::new("keys"),
                TaskId::new("layer"),
                TaskId::new("salt")
            ],
            "the group, however deep, and only the group"
        );

        let plan = s.load_plan().unwrap();
        for id in ["layer", "keys", "salt"] {
            assert!(!plan.task(&id.into()).unwrap().is_visible(), "{id}");
        }
        assert!(
            plan.task(&"bench".into()).unwrap().is_visible(),
            "a dependent is not part of the task it waits on"
        );
    }

    #[test]
    fn filing_is_reversible_and_says_when_there_was_nothing_to_do() {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();
        s.save_task(&task("keys").under("layer")).unwrap();

        assert_eq!(s.set_task_archived(&"layer".into(), true).unwrap().len(), 2);
        // Idempotent, and distinguishably so: an empty list is how the caller knows to
        // say "already filed away" rather than reporting work it did not do.
        assert!(
            s.set_task_archived(&"layer".into(), true)
                .unwrap()
                .is_empty()
        );

        assert_eq!(
            s.set_task_archived(&"layer".into(), false).unwrap().len(),
            2
        );
        let plan = s.load_plan().unwrap();
        assert!(plan.task(&"layer".into()).unwrap().is_visible());
        assert!(plan.task(&"keys".into()).unwrap().is_visible());
    }

    #[test]
    fn filing_a_subtask_leaves_its_parent_on_the_board() {
        // Filing reaches down, never up: a finished step of a live feature can be put
        // away without the feature going with it.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();
        s.save_task(&task("keys").under("layer")).unwrap();

        assert_eq!(
            s.set_task_archived(&"keys".into(), true).unwrap(),
            vec![TaskId::new("keys")]
        );
        let plan = s.load_plan().unwrap();
        assert!(plan.task(&"layer".into()).unwrap().is_visible());
        assert!(!plan.task(&"keys".into()).unwrap().is_visible());
    }

    #[test]
    fn filing_survives_a_round_trip_and_leaves_status_alone() {
        // The two properties are independent in both directions, as on a project.
        let s = store();
        s.save_project(&project()).unwrap();
        let mut t = task("layer");
        t.archived = true;
        t.status = TaskStatus::Ready;
        s.save_task(&t).unwrap();

        let got = s
            .load_plan()
            .unwrap()
            .task(&"layer".into())
            .unwrap()
            .clone();
        assert!(got.archived);
        assert_eq!(got.status, TaskStatus::Ready, "status untouched");

        // And a later save — which every status change is — does not un-file it.
        s.set_task_status(&"layer".into(), TaskStatus::Done)
            .unwrap();
        assert!(
            s.load_plan()
                .unwrap()
                .task(&"layer".into())
                .unwrap()
                .archived
        );
    }

    #[test]
    fn every_measure_variant_survives_the_round_trip() {
        let s = store();
        let p = Project::new("p", "objective", "wecode")
            .measured(Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 1,
            })
            .measured(Measure::Metric {
                name: "uptime".into(),
                target: 99.9,
                cmp: Cmp::Gte,
            })
            .measured(Measure::Deliverable {
                path: "docs/**".into(),
            })
            .measured(Measure::Judged {
                note: "operator decides".into(),
            });
        s.save_project(&p).unwrap();
        let mut expected = p.clone();
        expected.number = Some(Number::new(1));
        assert_eq!(s.load_plan().unwrap().project(&"p".into()), Some(&expected));
    }

    #[test]
    fn measure_order_is_preserved() {
        let s = store();
        let p = Project::new("p", "objective", "wecode")
            .measured(Measure::Deliverable { path: "a".into() })
            .measured(Measure::Deliverable { path: "b".into() })
            .measured(Measure::Deliverable { path: "c".into() });
        s.save_project(&p).unwrap();
        let back = s.load_plan().unwrap().project(&"p".into()).unwrap().clone();
        assert_eq!(back.measures, p.measures, "seq must keep author order");
    }

    #[test]
    fn hierarchy_and_dependencies_both_survive() {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();
        s.save_task(&task("struct").under("layer")).unwrap();
        s.save_task(&task("tests").after("layer")).unwrap();

        let plan = s.load_plan().unwrap();
        assert_eq!(
            plan.task(&"struct".into())
                .unwrap()
                .parent
                .as_ref()
                .map(TaskId::as_str),
            Some("layer")
        );
        assert_eq!(
            plan.task(&"tests".into()).unwrap().depends_on,
            vec![TaskId::new("layer")]
        );
        // The relations stay independent through storage.
        assert!(plan.task(&"struct".into()).unwrap().depends_on.is_empty());
        assert!(plan.task(&"tests".into()).unwrap().parent.is_none());
    }

    #[test]
    fn a_group_loads_however_deep_it_is_and_however_its_ids_sort() {
        // `bench` is two levels down and sorts first, so no id order puts its parent
        // before it — the 1 Sep repair's case, a level deeper than what found it.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();
        s.save_task(&task("keys").under("layer")).unwrap();
        s.save_task(&task("bench").under("keys")).unwrap();
        let plan = s.load_plan().unwrap();
        for (child, parent) in [("bench", "keys"), ("keys", "layer")] {
            let got = &plan.task(&child.into()).unwrap().parent;
            assert_eq!(got.as_ref(), Some(&TaskId::new(parent)), "{child}");
        }
    }

    #[test]
    fn readiness_is_recomputed_from_the_stored_graph() {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("first")).unwrap();
        s.save_task(&task("second").after("first")).unwrap();

        let plan = s.load_plan().unwrap();
        assert!(plan.is_ready(&"first".into()));
        assert!(!plan.is_ready(&"second".into()));

        s.set_task_status(&"first".into(), TaskStatus::Done)
            .unwrap();
        assert!(s.load_plan().unwrap().is_ready(&"second".into()));
    }

    #[test]
    fn several_prerequisites_all_load() {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("a")).unwrap();
        s.save_task(&task("b")).unwrap();
        s.save_task(&task("c").after("a").after("b")).unwrap();

        let plan = s.load_plan().unwrap();
        let mut deps: Vec<&str> = plan
            .task(&"c".into())
            .unwrap()
            .depends_on
            .iter()
            .map(TaskId::as_str)
            .collect();
        deps.sort_unstable();
        assert_eq!(deps, vec!["a", "b"]);
    }

    #[test]
    fn saving_twice_replaces_rather_than_duplicates() {
        let s = store();
        s.save_project(&project()).unwrap();
        let mut t = task("layer").after("layer-2");
        s.save_task(&task("layer-2")).unwrap();
        s.save_task(&t).unwrap();

        // Drop the dependency and narrow the scope.
        t.depends_on.clear();
        t.scope = Scope::write(&["crates/only/**"]);
        s.save_task(&t).unwrap();

        let plan = s.load_plan().unwrap();
        let back = plan.task(&"layer".into()).unwrap();
        assert!(back.depends_on.is_empty(), "stale edge should be gone");
        assert_eq!(back.scope.write, vec!["crates/only/**".to_string()]);
    }

    #[test]
    fn a_status_the_domain_does_not_know_is_reported_not_guessed() {
        let s = store();
        s.save_project(&project()).unwrap();
        s.conn()
            .execute("UPDATE projects SET status = 'sideways'", [])
            .unwrap();
        match s.load_plan() {
            Err(StoreError::Corrupt { what, value }) => {
                assert_eq!(what, "project status");
                assert_eq!(value, "sideways");
            }
            other => panic!("expected a corruption error, got {other:?}"),
        }
    }

    #[test]
    fn a_persons_task_is_still_a_persons_after_a_restart() {
        // The whole point of the column. Everything above the store already reads the
        // doer — admission relaxes the scope, budget and acceptance a dispatch needs;
        // the tick stops the task on the operator instead of dispatching it — and all of
        // that is decided from a plan read back out of SQLite. A task that came back as
        // an agent's would be promoted and handed to an agent on the very next tick,
        // holding a receipt that said a person would do it.
        let s = store();
        s.save_project(&project()).unwrap();
        let t = Task::new("rotate-key", "caching", "rotate the signing key")
            .of_kind(TaskKind::Chore)
            .done_by(Doer::Person);
        s.save_task(&t).unwrap();

        let back = s
            .load_plan()
            .unwrap()
            .task(&"rotate-key".into())
            .unwrap()
            .clone();
        assert_eq!(back.doer, Doer::Person);
        assert!(back.is_done_by_a_person());
        // The two axes stay apart through storage, which is why this is not a kind:
        // rotating a key by hand is still a chore, and the row says which chore it was.
        assert_eq!(back.kind, TaskKind::Chore);
    }

    #[test]
    fn a_task_that_says_nothing_comes_back_an_agents() {
        // The default, and the reading every task written before the column existed
        // gets. `task()` declares no doer, so this is also what the rest of this file
        // has been asserting implicitly all along.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();

        let back = s
            .load_plan()
            .unwrap()
            .task(&"layer".into())
            .unwrap()
            .clone();
        assert_eq!(back.doer, Doer::Agent);
        assert!(back.is_dispatched());
    }

    #[test]
    fn the_narrow_writes_leave_the_doer_alone() {
        // A person's task moves through the plan like any other — it is promoted, it is
        // signed, it can be reshaped — and every one of those is a narrow UPDATE. The
        // column has to survive all of them, because the restart that reads it back is
        // usually the one after a status change.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("sprint")).unwrap();
        let t = Task::new("mint-token", "caching", "mint the deploy token").done_by(Doer::Person);
        s.save_task(&t).unwrap();

        s.set_task_status(&"mint-token".into(), TaskStatus::Ready)
            .unwrap();
        s.set_task_shape(&"mint-token".into(), Some(&"sprint".into()), &[])
            .unwrap();
        s.set_task_archived(&"mint-token".into(), true).unwrap();

        let back = s
            .load_plan()
            .unwrap()
            .task(&"mint-token".into())
            .unwrap()
            .clone();
        assert_eq!(back.doer, Doer::Person, "still nobody's to dispatch");
        assert_eq!(back.status, TaskStatus::Ready);
        assert_eq!(back.parent, Some(TaskId::new("sprint")));
        assert!(back.archived);
    }

    #[test]
    fn a_doer_the_domain_does_not_know_is_refused_rather_than_guessed() {
        // The one field where falling back to the default is the unsafe answer: a word
        // this build cannot read might be the word that says *not an agent*, and
        // guessing `agent` would dispatch the work the row was written to protect.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();
        s.conn()
            .execute("UPDATE tasks SET doer = 'contractor'", [])
            .unwrap();

        match s.load_plan() {
            Err(StoreError::Corrupt { what, value }) => {
                assert_eq!(what, "task doer");
                assert_eq!(value, "contractor");
            }
            other => panic!("expected a corruption error, got {other:?}"),
        }
    }

    #[test]
    fn what_a_person_is_told_to_do_survives_a_restart() {
        // The point of the column, and the same point the doer's has: a person's task is
        // dispatched by being described, so the description has to outlive the process
        // that took it down. The notification that carries it is sent by a loop started
        // days later.
        let s = store();
        s.save_project(&project()).unwrap();
        let t = Task::new("mint-token", "caching", "mint the fares token")
            .of_kind(TaskKind::Chore)
            .done_by(Doer::Person);
        s.save_task(&t).unwrap();
        let steps = "1. open the Travelpayouts console\n2. create a token\n";
        s.set_task_steps(&"mint-token".into(), steps).unwrap();

        assert_eq!(
            s.task_steps(&"mint-token".into()).unwrap().as_deref(),
            Some(steps),
            "as written, newlines and all — a runbook is not a summary"
        );
    }

    #[test]
    fn a_task_nobody_wrote_steps_for_says_so() {
        // Three absences that must all read the same way, because the command that asks
        // turns one advisory on all of them: a task with no steps, an id that is not in
        // the plan, and steps erased by writing blank over them.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();
        assert_eq!(s.task_steps(&"layer".into()).unwrap(), None);
        assert_eq!(s.task_steps(&"no-such-task".into()).unwrap(), None);

        s.set_task_steps(&"layer".into(), "1. do the thing\n").unwrap();
        assert!(s.task_steps(&"layer".into()).unwrap().is_some());
        s.set_task_steps(&"layer".into(), "  \n").unwrap();
        assert_eq!(
            s.task_steps(&"layer".into()).unwrap(),
            None,
            "whitespace is not a briefing"
        );
    }

    #[test]
    fn saving_a_task_again_does_not_erase_its_steps() {
        // `save_task` is what `assign`, `task scope` and every re-declaration go through,
        // and the [`Task`] it is handed has no idea this column exists. An `INSERT … ON
        // CONFLICT` naming every column *but* this one is what keeps the instructions
        // there; a `REPLACE` would take them out from under the notification.
        let s = store();
        s.save_project(&project()).unwrap();
        let t = Task::new("mint-token", "caching", "mint the fares token").done_by(Doer::Person);
        s.save_task(&t).unwrap();
        s.set_task_steps(&"mint-token".into(), "1. open the console\n")
            .unwrap();

        let mut again = t.clone();
        again.status = TaskStatus::Waiting;
        again.assignee = Some("chief".to_string());
        s.save_task(&again).unwrap();

        assert_eq!(
            s.task_steps(&"mint-token".into()).unwrap().as_deref(),
            Some("1. open the console\n"),
            "assigning a person's task did not un-brief it"
        );
    }

    #[test]
    fn removing_a_task_takes_its_steps_with_it() {
        // The column lives on the row, so nothing extra clears it — asserted rather than
        // assumed, because the same was once true of a table that had to be swept by
        // hand, and a task id can be used again.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();
        s.set_task_steps(&"layer".into(), "1. do the thing\n").unwrap();
        s.delete_task(&"layer".into()).unwrap();

        s.save_task(&task("layer")).unwrap();
        assert_eq!(
            s.task_steps(&"layer".into()).unwrap(),
            None,
            "a reused id does not inherit the last occupant's instructions"
        );
    }

    #[test]
    fn what_a_task_serves_survives_a_restart_and_the_narrow_writes() {
        // The point of the column. Before it, the only record was a ledger row, so
        // answering "what is this task for?" meant scanning the log — and the answer had
        // to survive every promotion, reshape and archive on the way, because the read
        // that wants it happens days after the claim.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("sprint")).unwrap();
        let t = Task::new("parse", "caching", "parse a reply").serving("sprint/FR-1");
        s.save_task(&t).unwrap();

        s.set_task_status(&"parse".into(), TaskStatus::Ready).unwrap();
        s.set_task_shape(&"parse".into(), Some(&"sprint".into()), &[])
            .unwrap();
        s.set_task_archived(&"parse".into(), true).unwrap();

        assert_eq!(
            s.requirement_of(&"parse".into()).unwrap().as_deref(),
            Some("sprint/FR-1")
        );
        let back = s.load_plan().unwrap().task(&"parse".into()).unwrap().clone();
        assert_eq!(back.requirement.as_deref(), Some("sprint/FR-1"));
    }

    #[test]
    fn a_task_answering_to_nothing_says_so_and_can_be_pointed_elsewhere() {
        // Three absences reading one way, as `task_steps` has: a task that claims
        // nothing, an id that is not in the plan, and a claim written blank over.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("layer")).unwrap();
        assert_eq!(s.requirement_of(&"layer".into()).unwrap(), None);
        assert_eq!(s.requirement_of(&"no-such-task".into()).unwrap(), None);

        s.set_task_requirement(&"layer".into(), "story/FR-1").unwrap();
        // Moved rather than added to. A task serves one obligation, and the ledger is
        // where what it used to serve stays on the record.
        s.set_task_requirement(&"layer".into(), "story/FR-2").unwrap();
        assert_eq!(
            s.requirement_of(&"layer".into()).unwrap().as_deref(),
            Some("story/FR-2")
        );
        s.set_task_requirement(&"layer".into(), "  ").unwrap();
        assert_eq!(s.requirement_of(&"layer".into()).unwrap(), None);
    }

    #[test]
    fn project_exists_avoids_loading_everything() {
        let s = store();
        assert!(!s.project_exists(&"caching".into()).unwrap());
        s.save_project(&project()).unwrap();
        assert!(s.project_exists(&"caching".into()).unwrap());
    }

    /// A story, saved. Aggregating kinds carry no scope and no acceptance of their own.
    fn story(id: &str) -> Task {
        Task::new(id, "caching", format!("one capability: {id}")).of_kind(TaskKind::Story)
    }

    /// A design task writing one named document.
    fn design(id: &str, document: &str) -> Task {
        Task::new(id, "caching", format!("decide {id}"))
            .of_kind(TaskKind::Design)
            .scoped(Scope::write(&[document]))
    }

    /// The story `cache`, with `cache-design` inside it writing `document`.
    fn governed(document: &str) -> Store {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&story("cache")).unwrap();
        s.save_task(&design("cache-design", document).under("cache"))
            .unwrap();
        s
    }

    #[test]
    fn a_story_is_governed_by_the_design_step_inside_it() {
        // The ordinary shape: the story contains its own design, and the build step
        // beside it is not what the question was about.
        let s = governed("docs/wecode/cache/design.md");
        s.save_task(&task("cache-build").under("cache")).unwrap();

        let d = s.design_of(&"cache".into()).unwrap().expect("its design");
        assert_eq!(d.task, TaskId::new("cache-design"));
        assert_eq!(d.document, "docs/wecode/cache/design.md");
        assert!(!d.decided, "written is not signed");
        assert_eq!(d.digest, None, "the store opened no file");

        // A design is finished when somebody signs it, so `done` is the whole test.
        s.set_task_status(&"cache-design".into(), TaskStatus::Done).unwrap();
        assert!(s.design_of(&"cache".into()).unwrap().unwrap().decided);
    }

    #[test]
    fn a_design_the_story_comes_after_governs_it_through_the_chain() {
        // The expansion's shape, and transitively: only the first link names the design,
        // and a story two steps downstream of it is built on it just the same.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&design("keys-design", "docs/wecode/keys/design.md"))
            .unwrap();
        s.save_task(&task("keys-spike").after("keys-design")).unwrap();
        s.save_task(&story("keys").after("keys-spike")).unwrap();

        let d = s.design_of(&"keys".into()).unwrap().expect("its design");
        assert_eq!(d.task, TaskId::new("keys-design"));
    }

    #[test]
    fn a_story_with_nothing_decided_behind_it_says_so() {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&story("cache")).unwrap();
        s.save_task(&task("cache-build").under("cache")).unwrap();
        assert_eq!(s.design_of(&"cache".into()).unwrap(), None);
        assert_eq!(s.design_of(&"no-such-story".into()).unwrap(), None);
    }

    #[test]
    fn a_design_that_named_no_document_falls_back_to_the_convention() {
        // A glob names a directory rather than a document, so choosing a file out of it
        // would be a second convention nobody declared.
        let s = governed("docs/**");
        assert_eq!(
            s.design_of(&"cache".into()).unwrap().unwrap().document,
            "docs/wecode/cache-design/design.md"
        );
    }

    #[test]
    fn a_digest_is_of_what_a_document_said_and_not_of_how_it_was_wrapped() {
        let one = "# Keys\n\nThe key is the URL and the vary header.\n";
        let rewrapped = "# Keys\n\nThe key is the URL\nand the vary header.";
        assert_eq!(Design::checksum(one), Design::checksum(rewrapped));
        assert_ne!(Design::checksum(one), Design::checksum("# Keys\n\nThe key is the URL.\n"));
        // Nothing said, however much whitespace it was said in.
        assert_eq!(Design::checksum(""), Design::checksum(" \n\n\t"));
    }

    #[test]
    fn a_digest_nobody_took_certifies_nothing() {
        // Reading *unchanged* out of *unrecorded* is how a drift check comes to certify
        // drift, so the store's own answer — digest `None` — matches no document at all.
        let s = governed("docs/wecode/cache/design.md");
        let text = "# Cache\n\nEvict on write.\n";
        let d = s.design_of(&"cache".into()).unwrap().unwrap();
        assert!(!d.unchanged(text));

        let read = d.clone().read(text);
        assert!(read.unchanged(text));
        assert!(!read.unchanged("# Cache\n\nEvict on read.\n"));
        assert_eq!(read.task, d.task, "reading the file moves nothing else");
    }
}
