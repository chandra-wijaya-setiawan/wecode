//! Rebuilding a [`Plan`] from the rows.
//!
//! The one reader that touches every table at once, and the only place a stored plan is
//! checked against the domain's rules: `Plan` validates on insert, so a database that
//! somehow held a cycle is caught here rather than propagating into everything that
//! reads it.

use std::collections::BTreeMap;

use wecode_core::task::Doer;
use wecode_core::{
    Budget, Number, Plan, Project, ProjectId, ProjectStatus, Scope, Task, TaskId, TaskKind,
    TaskStatus,
};

use crate::plan::measure::MeasureTable;
use crate::short::Level;
use crate::{Store, StoreError};

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

    pub(super) fn scope(&self, task: &str) -> Result<Scope, StoreError> {
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
    use wecode_core::task::Doer;
    use wecode_core::{Task, TaskId, TaskKind, TaskStatus};

    use crate::StoreError;
    use crate::plan::fixtures::{project, store, task};

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
}
