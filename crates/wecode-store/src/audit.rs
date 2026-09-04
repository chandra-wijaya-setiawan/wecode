//! The audit ledger: one row per decision, with the keys to correlate it.
//!
//! `seq` is assigned by the database, so the sequence is monotonic across every
//! process that ever writes. A per-process counter got that wrong once, and every
//! record claimed to be number one.
//!
//! Requirements are here for a reason worth stating, because the obvious place for
//! them is a table of their own. ADR-0005 asks for `requirements(id, story_id, type,
//! description, status)`, and three of those five fields are the ledger already: an
//! obligation is *stated* by somebody at a moment, and that is exactly a row here.
//! `status` is the one field ADR-0005 also says must never be trusted on its own —
//! "a requirement is only done while nothing open references it" is a fact about the
//! tasks, so it is derived from them ([`wecode_core::requirement::requirement_is_met`])
//! rather than written back.
//!
//! ADRs are here on the same terms, and ADR-0005 says why in one line: "the table is the
//! index (id, status, supersedes), `docs/adr/*.md` is the text". An index of that shape is
//! four fields, three of which are the ledger already — a decision is *taken* by somebody
//! at a moment — so it is a `decide` row here and a `supersede` row for each replacement,
//! folded by [`Store::adrs`]. The prose stays in git, where review, diff and history
//! already live, and the number in the id names the file for anyone who wants it.
//!
//! The other half of ADR-0005's shape, `task.requirement_id`, *is* a column, and the
//! split is between state and event. Which obligation a task serves is a fact about the
//! task now, so it lives on the task's row and moves when the task does. That it claimed
//! that handle, when, and on whose say-so is a thing that happened, so it is a `serve`
//! row here and never changes. Neither is a copy of the other, and the fold below reads
//! the column: an attempt that has since been pointed elsewhere is not still a claim on
//! what it used to serve.

use std::collections::{BTreeMap, BTreeSet};

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

/// One obligation a story carries, folded out of the rows that stated it and the tasks
/// that point at it.
///
/// The wording is the contract; `served_by` is the attempts at it. Many tasks may
/// answer to one requirement — rework, a bug against it, a changed design — and that is
/// the point of gathering them here rather than hanging one pointer off the story: the
/// history of an obligation is what a story cannot otherwise show.
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
    /// Every task that serves it, in the order the tasks were created.
    ///
    /// The tasks pointing here *now*, not every task that ever claimed it. An attempt
    /// since aimed at another obligation is no longer a claim on this one, and would
    /// otherwise hold it open for ever.
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

/// One decision the repository has taken, folded out of the rows that recorded it.
///
/// The index and not the text: id, title, and what replaced it. A digest and a path were
/// in ADR-0005's first sketch of the table and are not here — the number in the id names
/// `docs/adr/NNNN-*.md` for ever, which a path column would only be a second, staler copy
/// of, and there is nothing yet that reads a digest.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Adr {
    /// `ADR-0004`, as the decision's own heading writes it.
    pub id: String,
    pub title: String,
    /// The repository that decided it, as its standing project (ADR-0002).
    pub project: ProjectId,
    /// The decision that replaced this one, where one has.
    pub superseded_by: Option<String>,
    /// When it was last recorded.
    pub at: u64,
    /// The person who recorded it, or the post when the row named no person.
    pub by: String,
}

impl Adr {
    /// `accepted`, or `superseded by ADR-0004`.
    ///
    /// Derived, for the reason ADR-0005 gives about a requirement's `status`: a word
    /// written into a row goes stale the moment the next decision lands, and here the
    /// successor cannot be recorded without naming what it replaces. So the state and
    /// its evidence arrive together, or neither does.
    #[must_use]
    pub fn status(&self) -> String {
        match &self.superseded_by {
            Some(next) => format!("superseded by {next}"),
            None => "accepted".to_string(),
        }
    }
}

/// What an ADR's own text says about itself: its heading, and its `Status:` line.
///
/// Parsed here, never read here. A document is somebody else's repository's file, so the
/// caller opens it and hands the text over — the idiom [`wecode_core::docs`] already uses
/// for the same reason. Which is also why the index is minted from the text on every pass
/// rather than edited: the file is the authority, and this is a cache of its first lines.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AdrHead {
    pub id: String,
    pub title: String,
    /// The first word of the `Status:` line, verbatim.
    pub status: String,
    /// The decision this one replaces, where the status line names one.
    pub supersedes: Option<String>,
    /// The decision that replaced this one, where the status line names one.
    pub superseded_by: Option<String>,
}

impl AdrHead {
    /// The index fields, or `None` when the text is not an ADR — no `# ADR-nnnn: <title>`
    /// heading, which is what `docs/adr/README.md` is and what a template is.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let heading = text.lines().find(|l| l.starts_with("# ADR-"))?;
        let (id, title) = heading.trim_start_matches("# ").split_once(':')?;
        let status = text.lines().find(|l| l.starts_with("Status:")).unwrap_or("");
        Some(Self {
            id: id.trim().to_string(),
            title: title.trim().to_string(),
            status: status
                .trim_start_matches("Status:")
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_string(),
            // Two distinct phrases, not one with a suffix: `supersedes ADR-3` is never a
            // substring of `superseded by ADR-3`, so neither match can steal the other's.
            supersedes: named_after(status, "supersedes "),
            superseded_by: named_after(status, "superseded by "),
        })
    }

    /// Whether the repository has actually decided this one.
    ///
    /// A proposal is a document about a decision not yet taken, and an index listing it
    /// beside the decisions would answer "what did we decide?" with something nobody
    /// decided. It is left out rather than marked, and comes in when its status changes.
    #[must_use]
    pub fn decided(&self) -> bool {
        matches!(self.status.as_str(), "accepted" | "superseded")
    }
}

/// The handle after `marker` — `ADR-0004` in `superseded by ADR-0004 (31 Aug 2026)`.
fn named_after(line: &str, marker: &str) -> Option<String> {
    let handle = line
        .split(marker)
        .nth(1)?
        .split_whitespace()
        .next()?
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
    (!handle.is_empty()).then(|| handle.to_string())
}

/// Whether `next` is a decision taken after `id` — `ADR-0004` against `ADR-0003`.
///
/// By number rather than by text, because a handle nobody zero-padded sorts `ADR-12`
/// before `ADR-9`, and the numbers are minted in the order the decisions were taken. A
/// handle carrying no number is let through: this refuses a supersession running the
/// wrong way, which is a thing it can see, and does not police what a handle looks like.
fn is_later(next: &str, id: &str) -> bool {
    match (number_in(next), number_in(id)) {
        (Some(a), Some(b)) => a > b,
        _ => true,
    }
}

/// `4` in `ADR-0004`.
fn number_in(id: &str) -> Option<u32> {
    id.rsplit('-').next()?.parse().ok()
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
        let at = self.append_stated(by, project, Some(story), "require", &id, wording)?;
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

    /// Records that a task claimed a requirement, at a moment and on somebody's say-so.
    ///
    /// A row *beside* [`Store::set_task_requirement`] rather than instead of it. The
    /// column is the state — what this task serves — and this is the event, which the
    /// column cannot hold: a column remembers only the latest claim, and what an
    /// obligation has been through is the thing a story cannot otherwise show. Writing
    /// only the row was the earlier shape, and it made every reader of "what does this
    /// task serve?" scan the ledger to find out.
    pub fn serve_requirement(
        &self,
        by: By<'_>,
        project: &ProjectId,
        task: &TaskId,
        requirement: &str,
    ) -> Result<(), StoreError> {
        self.append_stated(by, project, Some(task), "serve", requirement, "")?;
        Ok(())
    }

    /// Indexes one decision, and returns what the index now holds for it.
    ///
    /// `None`, and nothing written, for a document the repository has not decided —
    /// see [`AdrHead::decided`]. Recording it is idempotent: the same head indexed twice
    /// restates the same handle, as a restated requirement does, so a pass over
    /// `docs/adr/` can be run as often as anyone likes.
    ///
    /// Supersession is written in whichever direction the file in hand states it, and
    /// both are stated in practice — ADR-0004 says it supersedes ADR-0003 and ADR-0003
    /// says it was superseded by ADR-0004. Recording either is what makes the index agree
    /// with itself however the directory is walked, and while only one file has been seen.
    pub fn record_adr(
        &self,
        by: By<'_>,
        project: &ProjectId,
        head: &AdrHead,
    ) -> Result<Option<Adr>, StoreError> {
        if !head.decided() {
            return Ok(None);
        }
        let at = self.append_stated(by, project, None, "decide", &head.id, &head.title)?;
        if let Some(old) = &head.supersedes {
            self.append_stated(by, project, None, "supersede", old, &head.id)?;
        }
        if let Some(next) = &head.superseded_by {
            self.append_stated(by, project, None, "supersede", &head.id, next)?;
        }
        Ok(Some(Adr {
            id: head.id.clone(),
            title: head.title.clone(),
            project: project.clone(),
            // What this file says. What the successor's file says about it arrives in
            // the fold, which is the only place the whole index is in view.
            superseded_by: head.superseded_by.clone(),
            at,
            by: person_or_post(by),
        }))
    }

    /// Every decision the repository has taken, by number.
    ///
    /// Keyed by id, which for a four-digit handle sorts as the numbers do — the order
    /// `docs/adr/README.md` lists them in, and the order a reader arriving from a
    /// citation expects. The requirements fold below cannot do this, because `FR-10`
    /// sorts between `FR-1` and `FR-2`; a zero-padded handle is what buys it here.
    ///
    /// A superseded decision stays in the index, exactly as it stays in the directory:
    /// the row is how a reader arriving from an old citation learns which decision
    /// replaced it. A supersession naming a decision nothing recorded is dropped, on the
    /// same terms as a task pointing at a requirement nobody stated — inventing the row
    /// would hide that the tree cites a decision the index has never seen. That holds at
    /// both ends of one: a decision is retired only by a *later* decision the repository
    /// actually took, so a supersession is believed only while its successor is itself in
    /// the index ([`AdrHead::decided`] keeps a proposal out of it) and only while it runs
    /// forward. Neither is a guess about what somebody meant — a status line failing
    /// either says something the repository has not decided, and the index answers "what
    /// did we decide?" with what stands until the file that retires it is written.
    pub fn adrs(&self) -> Result<Vec<Adr>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT at, post, human, project_id, action, target, detail
             FROM audit_log WHERE action IN ('decide','supersede') ORDER BY seq",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    crate::int::from_row(r.get(0)?, 0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut found: BTreeMap<String, Adr> = BTreeMap::new();
        let mut replaced: BTreeMap<String, String> = BTreeMap::new();
        for (at, post, human, in_project, action, target, detail) in rows {
            if action == "supersede" {
                // Refused here rather than at the end, so a backwards claim cannot
                // displace the live supersession it was recorded after.
                if is_later(&detail, &target) {
                    replaced.insert(target, detail);
                }
                continue;
            }
            // The newest recording is the index; an earlier one is a file as it read
            // before somebody fixed the title, and nothing is served by keeping it.
            found.insert(
                target.clone(),
                Adr {
                    id: target,
                    title: detail,
                    project: ProjectId::new(&in_project),
                    superseded_by: None,
                    at,
                    by: if human.is_empty() { post } else { human },
                },
            );
        }
        // The decisions taken, which is what a successor has to be one of.
        let decided: BTreeSet<String> = found.keys().cloned().collect();
        Ok(found
            .into_values()
            .map(|a| Adr {
                superseded_by: replaced
                    .get(&a.id)
                    .filter(|next| decided.contains(*next))
                    .cloned(),
                ..a
            })
            .collect())
    }

    /// One ledger row that states a fact rather than reporting a verdict.
    ///
    /// `supervisor`, not `broker`: nothing was decided here. The Broker's own row for
    /// the `define` that authorised the declaration sits beside this one, and a reader
    /// filtering the ledger for what was *judged* must not pick this up as a judgement.
    ///
    /// No task, for a fact about the repository rather than about one piece of work. An
    /// ADR is the case: it is decided once and outlives every task that cites it, so the
    /// column is NULL rather than carrying whichever task happened to index it.
    fn append_stated(
        &self,
        by: By<'_>,
        project: &ProjectId,
        task: Option<&TaskId>,
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
                task.map(TaskId::as_str),
                action,
                target,
                detail,
            ],
        )?;
        Ok(at)
    }

    /// Every requirement, oldest first — of one project, of one story, or of all of it.
    ///
    /// Folded on read rather than kept as a table, out of the two halves ADR-0005 splits
    /// this into. The ledger states the contract: a later `require` row for the same
    /// handle restates it, and the attempts already made against the old wording stay,
    /// which is what makes the change visible. The `tasks` table says who is answering
    /// it, because that is a fact about a task and moves when the task does.
    ///
    /// A task pointing at a handle nothing ever stated is dropped here. The gate refuses
    /// those before the row can be written, and inventing a requirement out of a
    /// reference to one would hide that it had.
    pub fn requirements(
        &self,
        project: Option<&ProjectId>,
        story: Option<&TaskId>,
    ) -> Result<Vec<Requirement>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT at, post, human, project_id, task_id, target, detail
             FROM audit_log WHERE action = 'require' ORDER BY seq",
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
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        for (at, post, human, in_project, on_task, target, detail) in rows {
            let by = if human.is_empty() { post } else { human };
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
        }

        for (handle, task) in self.serving_tasks()? {
            if let Some(r) = found.get_mut(&handle) {
                r.served_by.push(task);
            }
        }
        Ok(order
            .into_iter()
            .filter_map(|id| found.remove(&id))
            .filter(|r| project.is_none_or(|p| r.project == *p))
            .filter(|r| story.is_none_or(|s| r.story == *s))
            .collect())
    }

    /// `(handle, task)` for every task that names an obligation, oldest task first.
    ///
    /// Ordered by short number, which is the order the tasks were created: numbers are
    /// minted once and never reissued, so this is stable across a restart and across a
    /// file restored on another machine. The alternative orderings are both wrong for a
    /// reader — by id sorts `FR-10` between `FR-1` and `FR-2` all over again, and by
    /// nothing at all is whatever SQLite feels like.
    fn serving_tasks(&self) -> Result<Vec<(String, TaskId)>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT t.requirement_id, t.id FROM tasks t
             LEFT JOIN short_numbers s ON s.kind = 'task' AND s.id = t.id
             WHERE t.requirement_id IS NOT NULL ORDER BY s.n",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, TaskId::new(r.get::<_, String>(1)?)))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
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
    use wecode_core::{Project, Task};
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
    fn an_obligation_gathers_the_tasks_that_point_at_it_now() {
        // The fold reads two halves, and this is why they are split. The ledger holds the
        // contract and every claim ever made against it; the tasks hold which obligation
        // each is answering today. Read the claims instead and a task re-aimed at another
        // requirement goes on holding the first one open for ever.
        let s = store();
        s.save_project(&Project::new("caching", "add response caching", "wecode"))
            .unwrap();
        for id in ["story", "parse", "retry"] {
            s.save_task(&Task::new(id, "caching", format!("do {id}")))
                .unwrap();
        }
        let by = By {
            session: "s-1",
            post: "lead",
            agent: "claude-code",
            human: "Chandra",
        };
        let (project, story) = (ProjectId::new("caching"), TaskId::new("story"));
        let state = |wording| {
            s.declare_requirement(by, &project, &story, ReqKind::Functional, wording)
                .unwrap()
                .id
        };
        assert_eq!(state("a reply naming a task signs it"), "story/FR-1");
        assert_eq!(state("a reply naming nothing is ignored"), "story/FR-2");

        let claim = |task: &str, handle: &str| {
            s.serve_requirement(by, &project, &TaskId::new(task), handle)
                .unwrap();
            s.set_task_requirement(&TaskId::new(task), handle).unwrap();
        };
        claim("parse", "story/FR-1");
        claim("retry", "story/FR-1");
        let found = s.requirements(Some(&project), None).unwrap();
        assert_eq!(
            found[0].served_by,
            vec![TaskId::new("parse"), TaskId::new("retry")],
            "in the order the tasks were created"
        );
        assert!(found[1].served_by.is_empty());

        claim("retry", "story/FR-2");
        let found = s.requirements(Some(&project), None).unwrap();
        assert_eq!(found[0].served_by, vec![TaskId::new("parse")]);
        assert_eq!(found[1].served_by, vec![TaskId::new("retry")]);
        // And nothing was rewritten to say so: both claims are still on the record.
        let rows = s
            .audit(&AuditQuery {
                task: Some("retry".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].target, "story/FR-1");
    }

    #[test]
    fn a_task_pointing_at_a_handle_nobody_stated_invents_no_requirement() {
        // Only reachable by writing the column behind the gate's back, which is exactly
        // when it matters: a fold that conjured a requirement out of a reference to one
        // would hide that the workspace holds a task aimed at nothing.
        let s = store();
        s.save_project(&Project::new("caching", "add response caching", "wecode"))
            .unwrap();
        s.save_task(&Task::new("parse", "caching", "parse a reply").serving("ghost/FR-1"))
            .unwrap();
        assert!(s.requirements(None, None).unwrap().is_empty());
    }

    /// An ADR as this repository writes one: front-matter, heading, status line.
    fn adr_text(id: &str, title: &str, status: &str) -> String {
        format!("---\nclass: record\n---\n# {id}: {title}\n\nStatus: {status}\n\n## Context\n")
    }

    fn indexer() -> By<'static> {
        By {
            session: "s-1",
            post: "lead",
            agent: "claude-code",
            human: "Chandra",
        }
    }

    #[test]
    fn a_head_is_read_off_the_heading_and_the_status_line() {
        let h = AdrHead::parse(&adr_text(
            "ADR-0004",
            "The aggregating kind is `epic`, not `milestone`",
            "accepted (31 Aug 2026) · supersedes ADR-0003",
        ))
        .unwrap();
        assert_eq!(h.id, "ADR-0004");
        assert_eq!(h.title, "The aggregating kind is `epic`, not `milestone`");
        assert_eq!(h.status, "accepted");
        assert_eq!(h.supersedes.as_deref(), Some("ADR-0003"));
        // The two phrases are distinct, so neither match steals the other's handle.
        assert_eq!(h.superseded_by, None);

        let old = AdrHead::parse(&adr_text(
            "ADR-0003",
            "Grouping is a task kind, not a project",
            "superseded by ADR-0004 (31 Aug 2026)",
        ))
        .unwrap();
        assert_eq!(old.status, "superseded");
        assert_eq!(old.superseded_by.as_deref(), Some("ADR-0004"));
        assert_eq!(old.supersedes, None);

        // The directory's own README is not a decision, and neither is anything else
        // without the heading. Nothing to skip by name.
        assert!(AdrHead::parse("# Architecture Decision Records\n").is_none());
    }

    #[test]
    fn the_index_holds_what_was_decided_and_what_replaced_it() {
        let s = store();
        s.save_project(&Project::new("wecode", "run agents as staff", "wecode"))
            .unwrap();
        let project = ProjectId::new("wecode");
        let record = |text: &str| {
            s.record_adr(indexer(), &project, &AdrHead::parse(text).unwrap())
                .unwrap()
        };
        // Out of order on purpose: the index is by number, not by when it was walked.
        record(&adr_text("ADR-0004", "epic aggregates", "accepted · supersedes ADR-0003"));
        record(&adr_text("ADR-0003", "grouping is a kind", "superseded by ADR-0004"));
        record(&adr_text("ADR-0001", "the codemap is a cache", "accepted"));

        let found = s.adrs().unwrap();
        let ids: Vec<&str> = found.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["ADR-0001", "ADR-0003", "ADR-0004"]);
        assert_eq!(found[1].status(), "superseded by ADR-0004");
        assert_eq!(found[2].status(), "accepted");
        assert_eq!(found[0].title, "the codemap is a cache");
        assert_eq!(found[0].by, "Chandra");
        assert_eq!(found[0].project, project);
    }

    #[test]
    fn indexing_the_directory_twice_indexes_it_once() {
        // The index is minted from the text on every pass, so a pass must be repeatable:
        // the file is the authority and the row is a cache of its first lines.
        let s = store();
        let project = ProjectId::new("wecode");
        let text = adr_text("ADR-0007", "hold is not archive", "accepted");
        for _ in 0..3 {
            s.record_adr(indexer(), &project, &AdrHead::parse(&text).unwrap())
                .unwrap();
        }
        let renamed = adr_text("ADR-0007", "`hold` suspends work", "accepted");
        s.record_adr(indexer(), &project, &AdrHead::parse(&renamed).unwrap())
            .unwrap();

        let found = s.adrs().unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "`hold` suspends work", "the newest pass wins");
    }

    #[test]
    fn a_proposal_is_not_a_decision_and_leaves_no_row() {
        // The question the index answers is "what did we decide?", and a proposal is a
        // document about a decision nobody has taken yet.
        let s = store();
        let text = adr_text("ADR-0008", "a shape being argued", "proposed");
        let head = AdrHead::parse(&text).unwrap();
        assert!(!head.decided());
        assert_eq!(
            s.record_adr(indexer(), &ProjectId::new("wecode"), &head)
                .unwrap(),
            None
        );
        assert!(s.adrs().unwrap().is_empty());
        assert!(s.audit(&AuditQuery::default()).unwrap().is_empty());
    }

    #[test]
    fn a_supersession_of_a_decision_nothing_recorded_invents_no_row() {
        // The same rule as a task pointing at a requirement nobody stated: conjuring the
        // row would hide that the tree cites a decision the index has never seen.
        let s = store();
        let project = ProjectId::new("wecode");
        let text = adr_text("ADR-0004", "epic aggregates", "accepted · supersedes ADR-0003");
        s.record_adr(indexer(), &project, &AdrHead::parse(&text).unwrap())
            .unwrap();
        let ids: Vec<String> = s.adrs().unwrap().into_iter().map(|a| a.id).collect();
        assert_eq!(ids, vec!["ADR-0004"], "no ADR-0003 conjured out of a citation");
    }

    #[test]
    fn a_decision_is_retired_only_by_a_successor_the_repository_decided() {
        // The other end of the same rule. A decision pointing forward at a document
        // nobody has accepted — a proposal, or a number the tree never reached — would
        // otherwise read as retired, and a reader following the pointer arrives nowhere.
        let s = store();
        let project = ProjectId::new("wecode");
        let record = |text: &str| {
            s.record_adr(indexer(), &project, &AdrHead::parse(text).unwrap())
                .unwrap()
        };
        record(&adr_text("ADR-0003", "grouping is a kind", "superseded by ADR-0009"));
        record(&adr_text("ADR-0009", "a shape being argued", "proposed"));

        let found = s.adrs().unwrap();
        assert_eq!(found.len(), 1, "the proposal is not in the index");
        assert_eq!(
            found[0].status(),
            "accepted",
            "a decision stands until the one that retires it is taken"
        );

        // And it is retired the moment that one is.
        record(&adr_text("ADR-0009", "a shape now settled", "accepted"));
        let found = s.adrs().unwrap();
        assert_eq!(found[0].status(), "superseded by ADR-0009");
    }

    #[test]
    fn a_supersession_running_backwards_retires_nothing() {
        // Numbers are minted in the order the decisions were taken, so a status line
        // naming an earlier decision as the replacement is a typo. Believed, it would
        // retire the newer of the two — the inversion of what a supersession means.
        let s = store();
        let project = ProjectId::new("wecode");
        let record = |text: &str| {
            s.record_adr(indexer(), &project, &AdrHead::parse(text).unwrap())
                .unwrap()
        };
        record(&adr_text("ADR-0002", "one repo, one standing project", "accepted"));
        record(&adr_text("ADR-0007", "hold is not archive", "superseded by ADR-0002"));

        let status = |id: &str| {
            s.adrs()
                .unwrap()
                .into_iter()
                .find(|a| a.id == id)
                .unwrap_or_else(|| panic!("{id} is in the index"))
                .status()
        };
        assert_eq!(status("ADR-0007"), "accepted", "the newer decision still stands");
        assert_eq!(status("ADR-0002"), "accepted");

        // Stated the other way round it is the same claim, and refused on the same terms.
        record(&adr_text(
            "ADR-0002",
            "one repo, one standing project",
            "accepted · supersedes ADR-0007",
        ));
        assert_eq!(status("ADR-0007"), "accepted");
    }

    #[test]
    fn a_decision_is_the_repositorys_and_belongs_to_no_task() {
        // A task indexes it; the decision outlives the task. A task id on the row would
        // make `wecode check <that task>` claim the decision as its own doing.
        let s = store();
        let text = adr_text("ADR-0002", "one repo, one standing project", "accepted");
        s.record_adr(
            indexer(),
            &ProjectId::new("wecode"),
            &AdrHead::parse(&text).unwrap(),
        )
        .unwrap();
        let rows = s.audit(&AuditQuery::default()).unwrap();
        assert_eq!(rows[0].action, "decide");
        assert_eq!(rows[0].source, "supervisor", "nothing was judged here");
        assert!(rows[0].task.is_empty());
        assert_eq!(rows[0].project, "wecode");
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
