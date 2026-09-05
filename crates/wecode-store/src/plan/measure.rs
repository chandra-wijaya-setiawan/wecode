//! Measures as rows, in both directions.
//!
//! A project's measures and a task's acceptance are the same shape in two tables, so
//! the encoding lives once and the table is a parameter. Two copies of it would be two
//! ways for a `Cmp` to spell itself, and the pair that disagreed would only show up as
//! a measure that came back meaning something else.

use rusqlite::params;
use wecode_core::{Cmp, Measure};

use crate::{Store, StoreError};

/// Which table a measure came from, so one pair of helpers serves both.
pub(super) enum MeasureTable {
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
    pub(super) fn measures(&self, table: &MeasureTable, owner: &str) -> Result<Vec<Measure>, StoreError> {
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

    pub(super) fn replace_measures(
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
}

#[cfg(test)]
mod tests {
    use wecode_core::{Cmp, Measure, Number, Project};

    use crate::plan::fixtures::store;

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
}
