//! Reading and writing the plan.
//!
//! The database is the storage; [`wecode_core::Plan`] is the in-memory shape with
//! the structural rules. Loading builds a `Plan` and inserts through its own
//! validation, so a database that somehow held a cycle would be caught on read
//! rather than propagating.

use rusqlite::{OptionalExtension, params};
use wecode_core::{
    Budget, Cmp, Measure, Plan, Project, ProjectId, ProjectStatus, Scope, Task, TaskId, TaskKind,
    TaskStatus,
};

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

impl Store {
    /// Rebuilds the whole plan.
    pub fn load_plan(&self) -> Result<Plan, StoreError> {
        let mut plan = Plan::new();

        let mut stmt = self.conn().prepare(
            "SELECT id, repo, objective, status, budget_tokens, budget_wall
             FROM projects ORDER BY id",
        )?;
        type ProjectRow = (String, String, String, String, Option<i64>, Option<i64>);
        let rows: Vec<ProjectRow> = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })?
            .collect::<rusqlite::Result<_>>()?;

        for (id, repo, objective, status, tokens, wall) in rows {
            let mut p = Project::new(ProjectId::new(&id), repo, objective);
            p.status = ProjectStatus::parse(&status).ok_or_else(|| StoreError::Corrupt {
                what: "project status",
                value: status.clone(),
            })?;
            p.budget = Budget {
                tokens: tokens.map(|n| n as u64),
                wall_secs: wall.map(|n| n as u64),
            };
            p.measures = self.measures(&MeasureTable::Project, &id)?;
            plan.add_project(p).map_err(structural)?;
        }

        // Tasks arrive parent-before-child and prerequisite-before-dependent, so
        // `Plan`'s own checks can run on insert. Ordering by parent then id gets
        // parents first; dependencies are attached afterwards for the same reason.
        let mut stmt = self.conn().prepare(
            "SELECT id, project_id, kind, title, parent_id, status, assignee,
                    budget_tokens, budget_wall
             FROM tasks ORDER BY (parent_id IS NOT NULL), id",
        )?;
        type Row = (
            String,
            String,
            String,
            String,
            Option<String>,
            String,
            Option<String>,
            Option<i64>,
            Option<i64>,
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
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;

        for (id, project, kind, title, parent, status, assignee, tokens, wall) in rows {
            let mut t = Task::new(TaskId::new(&id), ProjectId::new(&project), title);
            t.kind = TaskKind::parse(&kind).ok_or_else(|| StoreError::Corrupt {
                what: "task kind",
                value: kind.clone(),
            })?;
            t.status = TaskStatus::parse(&status).ok_or_else(|| StoreError::Corrupt {
                what: "task status",
                value: status.clone(),
            })?;
            t.parent = parent.map(TaskId::new);
            t.assignee = assignee;
            t.budget = Budget {
                tokens: tokens.map(|n| n as u64),
                wall_secs: wall.map(|n| n as u64),
            };
            t.acceptance = self.measures(&MeasureTable::Task, &id)?;
            t.scope = self.scope(&id)?;
            plan.add_task(t).map_err(structural)?;
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
            .map(|(kind, cmd, status, name, target, cmp, path, note)| match kind.as_str() {
                "command" => Ok(Measure::Command {
                    cmd: cmd.unwrap_or_default(),
                    expect_status: status.unwrap_or(0) as i32,
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
            })
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
            "INSERT INTO projects (id, repo, objective, status, budget_tokens, budget_wall)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                repo = ?2, objective = ?3, status = ?4,
                budget_tokens = ?5, budget_wall = ?6",
            params![
                p.id.as_str(),
                p.repo,
                p.objective,
                p.status.as_str(),
                p.budget.tokens.map(|n| n as i64),
                p.budget.wall_secs.map(|n| n as i64),
            ],
        )?;
        self.replace_measures(&MeasureTable::Project, p.id.as_str(), &p.measures)?;
        Ok(())
    }

    /// Inserts or replaces a task, its acceptance, scope and dependencies.
    pub fn save_task(&self, t: &Task) -> Result<(), StoreError> {
        let c = self.conn();
        c.execute(
            "INSERT INTO tasks (id, project_id, kind, title, parent_id, status, assignee,
                                budget_tokens, budget_wall)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                project_id = ?2, kind = ?3, title = ?4, parent_id = ?5,
                status = ?6, assignee = ?7, budget_tokens = ?8, budget_wall = ?9",
            params![
                t.id.as_str(),
                t.project.as_str(),
                t.kind.as_str(),
                t.title,
                t.parent.as_ref().map(TaskId::as_str),
                t.status.as_str(),
                t.assignee,
                t.budget.tokens.map(|n| n as i64),
                t.budget.wall_secs.map(|n| n as i64),
            ],
        )?;
        self.replace_measures(&MeasureTable::Task, t.id.as_str(), &t.acceptance)?;

        c.execute("DELETE FROM task_scopes WHERE task_id = ?1", [t.id.as_str()])?;
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
            let seq = seq as i64;
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
            .query_row(
                "SELECT 1 FROM projects WHERE id = ?1",
                [id.as_str()],
                |r| r.get(0),
            )
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
        Project::new("caching", "wecode", "add response caching")
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
    fn a_project_round_trips_with_its_measures() {
        let s = store();
        let p = project();
        s.save_project(&p).unwrap();

        let loaded = s.load_plan().unwrap();
        assert_eq!(loaded.project(&"caching".into()), Some(&p));
    }

    #[test]
    fn a_task_round_trips_with_acceptance_and_scope() {
        let s = store();
        s.save_project(&project()).unwrap();
        let t = task("cache-layer");
        s.save_task(&t).unwrap();

        let loaded = s.load_plan().unwrap();
        assert_eq!(loaded.task(&"cache-layer".into()), Some(&t));
    }

    #[test]
    fn every_measure_variant_survives_the_round_trip() {
        let s = store();
        let p = Project::new("p", "wecode", "objective")
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
        assert_eq!(s.load_plan().unwrap().project(&"p".into()), Some(&p));
    }

    #[test]
    fn measure_order_is_preserved() {
        let s = store();
        let p = Project::new("p", "wecode", "objective")
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
            plan.task(&"struct".into()).unwrap().parent.as_ref().map(TaskId::as_str),
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
    fn readiness_is_recomputed_from_the_stored_graph() {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&task("first")).unwrap();
        s.save_task(&task("second").after("first")).unwrap();

        let plan = s.load_plan().unwrap();
        assert!(plan.is_ready(&"first".into()));
        assert!(!plan.is_ready(&"second".into()));

        s.set_task_status(&"first".into(), TaskStatus::Done).unwrap();
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
    fn project_exists_avoids_loading_everything() {
        let s = store();
        assert!(!s.project_exists(&"caching".into()).unwrap());
        s.save_project(&project()).unwrap();
        assert!(s.project_exists(&"caching".into()).unwrap());
    }
}
