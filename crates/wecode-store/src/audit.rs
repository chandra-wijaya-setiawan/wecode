//! The audit ledger: one row per decision, with the keys to correlate it.
//!
//! `seq` is assigned by the database, so the sequence is monotonic across every
//! process that ever writes. A per-process counter got that wrong once, and every
//! record claimed to be number one.
//!
//! Requirements are here for a reason worth stating, because the obvious place for
//! them is a table of their own. ADR-0005 asks for `requirements(id, story_id, type,
//! description, status)`, and three of those five fields are the ledger already: an
//! obligation is *stated* by somebody at a moment, and every task that takes a run at
//! it states so too. Only `status` wants a column, and it is the one field ADR-0005
//! also says must never be trusted on its own — "a requirement is only done while
//! nothing open references it" is a fact about the tasks, so it is derived from them
//! ([`wecode_core::admission::requirement_is_met`]) rather than written back. What is
//! left is rows, and rows with the correlation keys this table already carries.

use std::collections::BTreeMap;

use rusqlite::params;
use wecode_core::{ProjectId, TaskId};
use wecode_gov::{Action, ControlMode, Decision, Record, Source};

use crate::{Store, StoreError, now_secs};

/// A decoded ledger row. Kept as strings: the ledger is for reading and filtering,
/// not for reconstructing typed decisions.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AuditLine {
    pub seq: i64,
    pub at: u64,
    pub session: String,
    pub post: String,
    pub agent: String,
    /// The person in the seat; empty for an autonomous agent.
    pub human: String,
    pub project: String,
    pub task: String,
    pub source: String,
    pub action: String,
    pub target: String,
    pub outcome: String,
    pub mode: String,
    pub detail: String,
}

impl AuditLine {
    #[must_use]
    pub fn is_alarm(&self) -> bool {
        self.outcome == "alarm"
    }

    #[must_use]
    pub fn is_denial(&self) -> bool {
        self.outcome == "deny" || self.outcome == "alarm"
    }

    /// Tokens, when this row is a spend. Target reads `<tokens>t/<secs>s`.
    #[must_use]
    pub fn spent_tokens(&self) -> u64 {
        if self.action != "spend" {
            return 0;
        }
        self.target
            .split('t')
            .next()
            .and_then(|t| t.parse().ok())
            .unwrap_or(0)
    }
}

/// Functional or not — what the system must do, against how well it must do it.
///
/// Carried in the handle rather than in a column, so `checkout/NFR-1` says which it is
/// everywhere it is named: in the ledger, in a task's brief, in a merge report. A
/// column would say it in the one place that reads the column and leave the id, which
/// is what travels, meaning nothing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReqKind {
    Functional,
    NonFunctional,
}

impl ReqKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Functional => "FR",
            Self::NonFunctional => "NFR",
        }
    }
}

/// One obligation a story carries, folded out of the rows that stated it and the
/// rows that named it.
///
/// The wording is the contract; `served_by` is the attempts at it. Many tasks may
/// answer to one requirement — rework, a bug against it, a changed design — and that
/// is the point of keeping the attempts rather than a pointer: the history of an
/// obligation is what a story cannot otherwise show.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Requirement {
    /// `<story>/FR-1`. Minted per story and per kind.
    pub id: String,
    pub story: TaskId,
    pub project: ProjectId,
    pub wording: String,
    /// When it was last stated.
    pub at: u64,
    /// The person who stated it, or the post when the row named no person.
    pub by: String,
    /// Every task that named it, oldest first.
    pub served_by: Vec<TaskId>,
}

impl Requirement {
    #[must_use]
    pub fn kind(&self) -> ReqKind {
        if self.id.contains("/NFR-") {
            ReqKind::NonFunctional
        } else {
            ReqKind::Functional
        }
    }
}

/// Who is writing a row no Broker decided.
///
/// Everything the Broker authorises arrives as a [`Record`], which carries its own
/// attribution. A requirement is *stated* rather than authorised — the authorisation
/// is the `define` recorded beside it — and the row still has to say who said so,
/// because a ledger with an anonymous row in it is not a ledger.
#[derive(Clone, Copy, Debug)]
pub struct By<'a> {
    pub session: &'a str,
    pub post: &'a str,
    pub agent: &'a str,
    /// The person in the seat; empty for an autonomous agent, as in [`AuditLine`].
    pub human: &'a str,
}

/// How the ledger is queried. Each variant is one predicate, combined by the
/// caller — which is what a relational store buys over scanning a log.
#[derive(Clone, Default, Debug)]
pub struct AuditQuery {
    pub denied_only: bool,
    pub alarms_only: bool,
    pub project: Option<String>,
    pub task: Option<String>,
    pub limit: Option<usize>,
}

fn source_str(s: Source) -> &'static str {
    match s {
        Source::Broker => "broker",
        Source::Supervisor => "supervisor",
        Source::Harness => "harness",
    }
}

fn action_parts(a: &Action) -> (&'static str, String) {
    match a {
        Action::Read { path } => ("read", path.clone()),
        Action::Write { path } => ("write", path.clone()),
        Action::Run { argv } => ("run", argv.join(" ")),
        Action::Network { host } => ("network", host.clone()),
        Action::Spend { tokens, wall_secs } => ("spend", format!("{tokens}t/{wall_secs}s")),
        Action::Merge { branch } => ("merge", branch.clone()),
        Action::Approve { kind } => ("approve", format!("{kind:?}")),
        Action::Define { kind } => ("define", kind.as_str().to_string()),
        Action::Introspect { level } => ("introspect", format!("{level:?}")),
        Action::Staff => ("staff", String::new()),
    }
}

/// Who a stated row is attributed to. The person where there is one: a requirement is
/// somebody's undertaking, and the post they happened to be sitting in is not who has
/// to answer for the wording.
fn person_or_post(by: By<'_>) -> String {
    if by.human.is_empty() {
        by.post.to_string()
    } else {
        by.human.to_string()
    }
}

/// `(outcome, mode, detail)`.
fn decision_parts(d: &Decision) -> (&'static str, Option<&'static str>, String) {
    match d {
        Decision::Allow => ("allow", None, String::new()),
        Decision::RequireApproval { by } => ("approval", None, format!("{by:?}")),
        Decision::Deny {
            reason,
            mode,
            alarm,
        } => (
            if *alarm { "alarm" } else { "deny" },
            Some(match mode {
                ControlMode::Regimented => "regimented",
                ControlMode::Sanctioned => "sanctioned",
            }),
            reason.to_string(),
        ),
    }
}

impl Store {
    /// Appends every record a Broker accumulated.
    ///
    /// The Broker numbers from 1 within its own lifetime, which is right for a
    /// Broker and wrong for the ledger. The database assigns `seq`, so its numbers
    /// are simply ignored here.
    pub fn append_records(&self, records: &[Record]) -> Result<(), StoreError> {
        let at = crate::int::to_db(now_secs());
        for r in records {
            let (action, target) = action_parts(&r.action);
            let (outcome, mode, detail) = decision_parts(&r.decision);
            self.conn().execute(
                "INSERT INTO audit_log
                   (at, session_id, post, agent, human, project_id, task_id,
                    source, action, target, outcome, mode, detail)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    at,
                    r.session,
                    r.post,
                    r.occupant,
                    r.human,
                    r.project,
                    r.task,
                    source_str(r.source),
                    action,
                    target,
                    outcome,
                    mode,
                    detail,
                ],
            )?;
        }
        Ok(())
    }

    /// Reads the ledger, oldest first.
    pub fn audit(&self, q: &AuditQuery) -> Result<Vec<AuditLine>, StoreError> {
        let mut sql = String::from(
            "SELECT seq, at, session_id, post, agent, human, project_id, task_id,
                    source, action, target, outcome, mode, detail
             FROM audit_log WHERE 1 = 1",
        );
        if q.alarms_only {
            sql.push_str(" AND outcome = 'alarm'");
        } else if q.denied_only {
            sql.push_str(" AND outcome IN ('deny','alarm')");
        }
        if q.project.is_some() {
            sql.push_str(" AND project_id = :project");
        }
        if q.task.is_some() {
            sql.push_str(" AND task_id = :task");
        }
        sql.push_str(" ORDER BY seq");
        if let Some(n) = q.limit {
            sql.push_str(&format!(" LIMIT {n}"));
        }

        let mut stmt = self.conn().prepare(&sql)?;
        let mut binds: Vec<(&str, &dyn rusqlite::ToSql)> = Vec::new();
        if let Some(p) = &q.project {
            binds.push((":project", p));
        }
        if let Some(t) = &q.task {
            binds.push((":task", t));
        }

        let rows = stmt
            .query_map(binds.as_slice(), |r| {
                Ok(AuditLine {
                    seq: r.get(0)?,
                    at: crate::int::from_row(r.get(1)?, 1)?,
                    session: r.get(2)?,
                    post: r.get(3)?,
                    agent: r.get(4)?,
                    human: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    project: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    task: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    source: r.get(8)?,
                    action: r.get(9)?,
                    target: r.get(10)?,
                    outcome: r.get(11)?,
                    mode: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
                    detail: r.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// States a requirement of a story, and returns the handle it now answers to.
    ///
    /// The number is minted per story and per kind out of what the ledger already
    /// holds, so `checkout/FR-2` is that story's second functional obligation whatever
    /// else has been written since. Minted rather than typed, because an id an
    /// operator chooses is an id two people choose differently.
    pub fn declare_requirement(
        &self,
        by: By<'_>,
        project: &ProjectId,
        story: &TaskId,
        kind: ReqKind,
        wording: &str,
    ) -> Result<Requirement, StoreError> {
        let mine = self.requirements(None, Some(story))?;
        let n = mine.iter().filter(|r| r.kind() == kind).count() + 1;
        let id = format!("{story}/{}-{n}", kind.as_str());
        let at = self.append_stated(by, project, story, "require", &id, wording)?;
        Ok(Requirement {
            id,
            story: story.clone(),
            project: project.clone(),
            wording: wording.to_string(),
            at,
            by: person_or_post(by),
            served_by: Vec::new(),
        })
    }

    /// Records that a task is an attempt at a requirement.
    ///
    /// Its own row rather than a column on the task, because it is an event with a
    /// time on it: this is what resets the obligation to open, and a column would
    /// remember only the last thing to have claimed it.
    pub fn serve_requirement(
        &self,
        by: By<'_>,
        project: &ProjectId,
        task: &TaskId,
        requirement: &str,
    ) -> Result<(), StoreError> {
        self.append_stated(by, project, task, "serve", requirement, "")?;
        Ok(())
    }

    /// One ledger row that states a fact rather than reporting a verdict.
    ///
    /// `supervisor`, not `broker`: nothing was decided here. The Broker's own row for
    /// the `define` that authorised the declaration sits beside this one, and a reader
    /// filtering the ledger for what was *judged* must not pick this up as a judgement.
    fn append_stated(
        &self,
        by: By<'_>,
        project: &ProjectId,
        task: &TaskId,
        action: &str,
        target: &str,
        detail: &str,
    ) -> Result<u64, StoreError> {
        let at = now_secs();
        self.conn().execute(
            "INSERT INTO audit_log
               (at, session_id, post, agent, human, project_id, task_id,
                source, action, target, outcome, mode, detail)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'supervisor',?8,?9,'allow',NULL,?10)",
            params![
                crate::int::to_db(at),
                by.session,
                by.post,
                by.agent,
                by.human,
                project.as_str(),
                task.as_str(),
                action,
                target,
                detail,
            ],
        )?;
        Ok(at)
    }

    /// Every requirement, oldest first — of one project, of one story, or of all of it.
    ///
    /// Folded on read rather than kept as a table, and the fold is the whole of the
    /// model: a later `require` row for the same handle restates the contract, and
    /// every `serve` row adds an attempt at it. A `serve` naming a handle nothing ever
    /// stated is dropped here; the gate refuses those before they can be written, and
    /// inventing a requirement out of a reference to one would hide that it had.
    pub fn requirements(
        &self,
        project: Option<&ProjectId>,
        story: Option<&TaskId>,
    ) -> Result<Vec<Requirement>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT at, post, human, project_id, task_id, action, target, detail
             FROM audit_log WHERE action IN ('require','serve') ORDER BY seq",
        )?;
        // Keyed by handle, and the order they were stated in is kept separately: the
        // handles sort `FR-1, FR-10, FR-2`, which is not an order anybody wrote.
        let mut found: BTreeMap<String, Requirement> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    crate::int::from_row(r.get(0)?, 0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        for (at, post, human, in_project, on_task, action, target, detail) in rows {
            let by = if human.is_empty() { post } else { human };
            if action == "require" {
                let r = found.entry(target.clone()).or_insert_with(|| {
                    order.push(target.clone());
                    Requirement {
                        id: target.clone(),
                        story: TaskId::new(&on_task),
                        project: ProjectId::new(&in_project),
                        wording: String::new(),
                        at,
                        by: String::new(),
                        served_by: Vec::new(),
                    }
                });
                // The newest statement is the contract; the attempts already made
                // against the old one stay, which is what makes the change visible.
                (r.wording, r.at, r.by) = (detail, at, by);
            } else if let Some(r) = found.get_mut(&target) {
                let task = TaskId::new(&on_task);
                if !r.served_by.contains(&task) {
                    r.served_by.push(task);
                }
            }
        }
        Ok(order
            .into_iter()
            .filter_map(|id| found.remove(&id))
            .filter(|r| project.is_none_or(|p| r.project == *p))
            .filter(|r| story.is_none_or(|s| r.story == *s))
            .collect())
    }

    /// Tokens spent, by project. The kind of aggregate a flat log could not do.
    pub fn spend_by_project(&self) -> Result<Vec<(String, u64)>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT coalesce(project_id, ''), target FROM audit_log
             WHERE action = 'spend' AND outcome = 'allow'",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;

        let mut totals: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        for (project, target) in rows {
            let tokens: u64 = target
                .split('t')
                .next()
                .and_then(|t| t.parse().ok())
                .unwrap_or(0);
            *totals.entry(project).or_default() += tokens;
        }
        Ok(totals.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_gov::{Broker, Charter, Effective, Grant, Invariant, Session};

    fn store() -> Store {
        Store::in_memory().unwrap()
    }

    fn ledger(actions: &[Action]) -> Vec<Record> {
        let mut b = Broker::new(Charter::with(vec![
            Invariant::NeverTouch(vec!["**/*.pem".into()]),
            Invariant::ApprovalToMerge(vec!["main".into()]),
        ]));
        let s = Session::new(
            "s-1",
            "impl",
            "claude-code",
            Effective::of(vec![
                Grant::writer(&["crates/export/**"])
                    .with_run(&["cargo *"])
                    .with_spend(1000, 60),
            ]),
        )
        .with_human(Some("Chandra".into()))
        .on(Some("caching".into()), Some("cache-layer".into()));
        for a in actions {
            b.authorize(&s, a);
        }
        b.ledger().to_vec()
    }

    #[test]
    fn an_allowed_action_records_who_and_what() {
        let s = store();
        s.append_records(&ledger(&[Action::Write {
            path: "crates/export/cache.rs".into(),
        }]))
        .unwrap();

        let rows = s.audit(&AuditQuery::default()).unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.outcome, "allow");
        assert_eq!(r.action, "write");
        assert_eq!(r.target, "crates/export/cache.rs");
        // Both the person and the agent, flatly.
        assert_eq!(r.human, "Chandra");
        assert_eq!(r.agent, "claude-code");
        // And the correlation keys that let the board roll it up.
        assert_eq!(r.project, "caching");
        assert_eq!(r.task, "cache-layer");
        assert_eq!(r.session, "s-1");
    }

    #[test]
    fn the_database_numbers_the_sequence_across_separate_appends() {
        let s = store();
        for path in ["a", "b", "c"] {
            s.append_records(&ledger(&[Action::Write {
                path: format!("crates/export/{path}"),
            }]))
            .unwrap();
        }
        let seqs: Vec<i64> = s
            .audit(&AuditQuery::default())
            .unwrap()
            .iter()
            .map(|r| r.seq)
            .collect();
        assert_eq!(seqs, vec![1, 2, 3], "one ledger, one sequence");
    }

    #[test]
    fn a_sanctioned_denial_keeps_its_mode() {
        let s = store();
        s.append_records(&ledger(&[Action::Write {
            path: "crates/auth/token.rs".into(),
        }]))
        .unwrap();
        let r = &s.audit(&AuditQuery::default()).unwrap()[0];
        assert_eq!(r.outcome, "deny");
        assert_eq!(r.mode, "sanctioned", "the attempt is diagnostic, not fatal");
        assert!(r.is_denial() && !r.is_alarm());
    }

    #[test]
    fn an_invariant_violation_is_an_alarm_and_regimented() {
        let s = store();
        s.append_records(&ledger(&[Action::Write {
            path: "deploy/key.pem".into(),
        }]))
        .unwrap();
        let r = &s.audit(&AuditQuery::default()).unwrap()[0];
        assert!(r.is_alarm());
        assert_eq!(r.mode, "regimented");
        assert!(r.detail.contains("invariant"), "{}", r.detail);
    }

    #[test]
    fn filters_select_alarms_denials_and_correlations() {
        let s = store();
        s.append_records(&ledger(&[
            Action::Write {
                path: "crates/export/ok.rs".into(),
            },
            Action::Write {
                path: "crates/auth/no.rs".into(),
            },
            Action::Write {
                path: "deploy/x.pem".into(),
            },
        ]))
        .unwrap();

        let alarms = s
            .audit(&AuditQuery {
                alarms_only: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(alarms.len(), 1);
        assert!(alarms[0].target.ends_with(".pem"));

        let denied = s
            .audit(&AuditQuery {
                denied_only: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(denied.len(), 2, "a denial and an alarm");

        let by_task = s
            .audit(&AuditQuery {
                task: Some("cache-layer".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_task.len(), 3);

        let elsewhere = s
            .audit(&AuditQuery {
                task: Some("other".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(elsewhere.is_empty());
    }

    #[test]
    fn spend_aggregates_by_project() {
        // The kind of query a flat log could not answer cheaply.
        let s = store();
        s.append_records(&ledger(&[
            Action::Spend {
                tokens: 400,
                wall_secs: 10,
            },
            Action::Spend {
                tokens: 250,
                wall_secs: 5,
            },
        ]))
        .unwrap();
        assert_eq!(
            s.spend_by_project().unwrap(),
            vec![("caching".to_string(), 650)]
        );
    }

    #[test]
    fn an_approval_is_not_a_denial() {
        let s = store();
        let mut b = Broker::new(Charter::with(vec![Invariant::ApprovalToMerge(vec![
            "main".into(),
        ])]));
        let sess = Session::new(
            "s-1",
            "review",
            "claude-code",
            Effective::of(vec![Grant::root()]),
        );
        b.authorize(
            &sess,
            &Action::Merge {
                branch: "main".into(),
            },
        );
        s.append_records(b.ledger()).unwrap();

        let r = &s.audit(&AuditQuery::default()).unwrap()[0];
        assert_eq!(r.outcome, "approval");
        assert!(!r.is_denial());
    }

    #[test]
    fn limit_bounds_the_result() {
        let s = store();
        for i in 0..5 {
            s.append_records(&ledger(&[Action::Write {
                path: format!("crates/export/{i}.rs"),
            }]))
            .unwrap();
        }
        let rows = s
            .audit(&AuditQuery {
                limit: Some(2),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(rows.len(), 2);
    }
}
