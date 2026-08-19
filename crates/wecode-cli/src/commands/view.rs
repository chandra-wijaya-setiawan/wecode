//! What is on a screen: the rows a table is made of, and the words about one subject.
//!
//! The two commands that open the cockpit live here too, because `wecode tui` and
//! `wecode board` are one view of one workspace and not two products — the snapshot
//! exists because a pipe, a log and a machine with no terminal are real readers, not
//! because there is a second thing to say. [`crate::tui`] is the application that
//! navigates and draws what this module composes.
//!
//! The words about a subject are written once and used twice: as the detail pane under
//! the cockpit's HOME and PROJECT screens, and as the whole of its TASK screen — the
//! same paragraph plus everything a seven-line pane had no room for. What each attempt
//! cost against the budget it was held to, what the agent's last recorded act was while
//! it is still running, the report wecode wrote when the work landed. None of that is
//! new data; it is the plan, the ledger and the run table, put where somebody looking at
//! one task is already looking.

use std::collections::HashSet;

use ratatui::style::{Color, Style, Stylize};
use ratatui::text::{Line, Span};
use wecode_core::{Number, Plan, Project, ProjectId, Task, TaskId, TaskStatus};
use wecode_org::Company;
use wecode_store::{AuditLine, AuditQuery, Store};

use crate::args::Args;
use crate::board::{Ledger, Vitals, status_word};
use crate::commands::ctx::*;
use crate::{board, record, tui};

/// What a row points at. Two levels of work means a row is one or the other, and
/// an id alone cannot say which — project and task ids live in separate spaces.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Subject {
    Project(ProjectId),
    Task(TaskId),
}

/// Whether a row has anything under it, and whether it is showing it.
///
/// A leaf still occupies the marker column. Two spaces of nothing keep every id in
/// the same place down a branch; without them a row's indentation would encode its
/// depth *and* whether its neighbour had children, which is unreadable.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) enum Fold {
    #[default]
    Leaf,
    Open,
    Shut,
}

impl Fold {
    fn glyph(self) -> &'static str {
        match self {
            Self::Leaf => "  ",
            Self::Open => "▾ ",
            Self::Shut => "▸ ",
        }
    }
}

/// One visible line: a subject at a depth, with its derived vitals — or a caption, which
/// is a line of the view's own words with no subject behind it.
#[derive(Default)]
pub(crate) struct RowItem {
    /// `None` for a caption: a group heading, the dash under an empty group, or the
    /// count one ends with. In the table rather than in a pane of its own, because the
    /// table is what scrolls and a heading that stayed put would leave its rows behind.
    pub(crate) subject: Option<Subject>,
    /// The short number, in its own column. Not folded into `label` for the same
    /// reason as on the snapshot board: the label carries the indent and truncates,
    /// and a handle that moves and disappears is not a handle.
    pub(crate) number: Option<Number>,
    /// Already carries its own indentation and tree glyph, so a separate depth
    /// field would be a second source of truth for the same thing.
    pub(crate) label: String,
    /// The declared state, as a mark and a word. Distinct from `vitals.health`,
    /// which is computed — a task can be perfectly healthy and not started.
    pub(crate) status: String,
    /// `None` for a caption, which has no cells to fill but its own words.
    pub(crate) vitals: Option<Vitals>,
    pub(crate) fold: Fold,
}

impl RowItem {
    pub(crate) fn is_project(&self) -> bool {
        matches!(self.subject, Some(Subject::Project(_)))
    }
}

/// A row of the view's own words: a group heading, or the line a group ends with.
pub(crate) fn caption(text: &str) -> RowItem {
    RowItem {
        label: text.to_string(),
        ..RowItem::default()
    }
}

fn last(i: usize, n: usize) -> bool {
    i + 1 == n
}

/// Everything a row needs that is not the row's own subject.
///
/// Bundled so the walk can recurse without carrying five parameters down every
/// branch, and borrowed rather than owned so building the rows never copies the
/// plan.
pub(crate) struct Tree<'a> {
    pub(crate) plan: &'a Plan,
    pub(crate) ledger: &'a Ledger,
    pub(crate) gates: &'a board::DesignGates,
    pub(crate) collapsed: &'a HashSet<Subject>,
    /// Whether filed-away work is drawn. Applied where the children of a row are
    /// chosen rather than where a row is built, so a parent whose subtasks are all
    /// filed away reads as a leaf — a fold marker on it would point at nothing.
    pub(crate) show_archived: bool,
}

impl<'a> Tree<'a> {
    /// The subtasks this view will draw, in id order so it does not reshuffle between
    /// frames.
    fn kids(&self, id: &TaskId) -> Vec<&'a Task> {
        board::sorted(
            self.plan
                .subtasks(id)
                .filter(|k| self.show_archived || !k.archived),
        )
    }

    /// The same for a project's top-level tasks.
    fn roots(&self, id: &ProjectId) -> Vec<&'a Task> {
        board::sorted(
            self.plan
                .roots_of(id)
                .filter(|t| self.show_archived || !t.archived),
        )
    }

    /// The four groups, above the tree and before it. Flat, and never folded: a group
    /// is not a branch of the tree, it is the same leaves torn out of it and asked a
    /// different question — which is why both halves are drawn.
    pub(crate) fn push_attention(&self, rows: &mut Vec<RowItem>, projects: &[&Project]) {
        let groups = board::attention_groups(self.plan, projects, self.ledger, self.show_archived);
        for (group, shown, hidden) in groups {
            rows.push(caption(group.title()));
            // An empty group keeps its heading, as on the snapshot: four of them in the
            // same places every time is what lets somebody find the one they came for.
            if shown.is_empty() {
                rows.push(caption("   —"));
            }
            for t in shown {
                let mut vitals = board::task_vitals(self.plan, t, self.ledger, self.gates);
                // The question this group asks, in the cell that carries the colour —
                // what tells four rows reading `> running` apart.
                vitals.needs = vec![group.line(self.plan, t, self.ledger, &vitals)];
                rows.push(RowItem {
                    subject: Some(Subject::Task(t.id.clone())),
                    number: t.number,
                    // A row torn out of the tree has to say which project it came from,
                    // or the id is the only handle on it.
                    label: format!("  {}/{}", t.project, t.id),
                    status: format!("{} {}", t.status.mark(), status_word(t.status)),
                    vitals: Some(vitals),
                    ..RowItem::default()
                });
            }
            if hidden > 0 {
                // What it stood down is not lost — the tree below drew all of it.
                rows.push(caption(&format!("   … and {hidden} more")));
            }
        }
    }

    fn fold_of(&self, subject: &Subject, has_children: bool) -> Fold {
        if !has_children {
            Fold::Leaf
        } else if self.collapsed.contains(subject) {
            Fold::Shut
        } else {
            Fold::Open
        }
    }

    /// A project row — the word `project`, its id, and the repo it owns — then its
    /// task tree. The repo is on the row rather than only in the detail pane
    /// because without it nothing on screen connects a project to the code it
    /// works on.
    pub(crate) fn push_project(
        &self,
        rows: &mut Vec<RowItem>,
        p: &Project,
        known_repos: &[String],
    ) {
        let subject = Subject::Project(p.id.clone());
        let roots = self.roots(&p.id);
        let fold = self.fold_of(&subject, !roots.is_empty());
        rows.push(RowItem {
            number: p.number,
            label: format!(
                "{}PROJECT {}  [{}]{}",
                fold.glyph(),
                p.id,
                p.repo,
                if p.archived { "  archived" } else { "" }
            ),
            status: format!("{} {}", p.status.mark(), p.status.as_str()),
            vitals: Some(board::project_vitals(self.plan, p, self.ledger, known_repos)),
            subject: Some(subject),
            fold,
        });
        if fold == Fold::Open {
            for (i, t) in roots.iter().enumerate() {
                self.push_task(rows, t, 1, last(i, roots.len()));
            }
        }
    }

    /// A task row, then everything beneath it — to the leaves, not to some depth
    /// this function picked — unless the operator has folded it shut.
    fn push_task(&self, rows: &mut Vec<RowItem>, t: &Task, depth: usize, is_last: bool) {
        let subject = Subject::Task(t.id.clone());
        let kids = self.kids(&t.id);
        let fold = self.fold_of(&subject, !kids.is_empty());
        // A child's connector lands in its parent's marker column, so a branch
        // reads as one column of glyphs rather than two that nearly line up.
        let connector = if depth == 0 {
            String::new()
        } else {
            format!(
                "{}{} ",
                "   ".repeat(depth - 1),
                if is_last { "└─" } else { "├─" }
            )
        };
        rows.push(RowItem {
            number: t.number,
            label: format!(
                "{connector}{}{} {}{}",
                fold.glyph(),
                crate::render::kind_tag(t.kind),
                t.id,
                // Said in words rather than by greying the row, as on a project. This
                // column has room to grow; the snapshot board's does not.
                if t.archived { "  archived" } else { "" }
            ),
            status: format!("{} {}", t.status.mark(), status_word(t.status)),
            vitals: Some(board::task_vitals(self.plan, t, self.ledger, self.gates)),
            subject: Some(subject),
            fold,
        });
        if fold == Fold::Open {
            for (i, k) in kids.iter().enumerate() {
                self.push_task(rows, k, depth + 1, last(i, kids.len()));
            }
        }
    }
}

/// The live cockpit: full-screen, navigable, reloads as state changes.
///
/// `wecode tui <id>` opens on that project or task instead of on HOME. A starting
/// screen, never a mode: everything it opens on is reachable by keys from HOME, and
/// `esc` from it goes back there — a flag that froze navigation into the invocation
/// would be the thing this command exists to stop doing.
pub(crate) fn cockpit(a: &Args) -> Res {
    let (store, company) = open(a)?;
    if !tui::is_tty() {
        return Err("wecode tui needs a terminal — try `wecode board` for a snapshot".into());
    }
    let opening = match a.cmd(1) {
        "" => None,
        named => Some(tui::opening(&store.load_plan()?, named)?),
    };
    tui::run(store, company, opening)?;
    Ok(String::new())
}

/// A snapshot of the same state, for pipes and logs.
pub(crate) fn board_snapshot(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let known_repos = repo_names(&company);
    let plan = store.load_plan()?;
    let audit = store.audit(&AuditQuery::default())?;
    let gates = design_gates(&company, &plan);
    match a.cmd(1) {
        "" => Ok(board::portfolio(
            &plan,
            &audit,
            &known_repos,
            &gates,
            a.has("all"),
        )),
        id => Ok(board::focus(&plan, &audit, id, &known_repos, &gates)),
    }
}

/// The TASK screen: everything wecode holds about one task, in the order somebody
/// reading it asks for — what it is, where it sits, what stands in its way, what it is
/// doing, what it has cost, what it landed, what it tripped.
pub(crate) fn task_lines(
    store: &Store,
    company: &Company,
    plan: &Plan,
    audit: &[AuditLine],
    gates: &board::DesignGates,
    id: &TaskId,
) -> Vec<Line<'static>> {
    let subject = Subject::Task(id.clone());
    let mut lines = about(plan, &subject);
    let Some(t) = plan.task(id) else { return lines };
    lines.push(Line::from(
        format!("{} {}", t.status.mark(), t.status.as_str()).fg(Color::DarkGray),
    ));
    lines.extend(doing(plan, audit, gates, t));
    lines.extend(runs(store, t));
    lines.extend(report(company, plan, t));
    lines.extend(incidents(audit, &subject, 8));
    lines
}

/// What the subject is and where it sits: the two halves every screen leads with.
fn about(plan: &Plan, subject: &Subject) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    match subject {
        Subject::Project(id) => {
            let Some(p) = plan.project(id) else {
                return Vec::new();
            };
            lines.push(Line::from(p.objective.clone().bold()));
            lines.push(Line::from(
                format!("repo: {}  ·  {}", p.repo, p.status.as_str()).fg(Color::DarkGray),
            ));
        }
        Subject::Task(id) => {
            let Some(t) = plan.task(id) else {
                return Vec::new();
            };
            lines.push(Line::from(t.title.clone().bold()));

            // The two relations, named apart. Conflating them is the error this
            // whole model exists to prevent.
            let mut chain: Vec<String> =
                plan.ancestors(id).iter().map(|a| a.id.to_string()).collect();
            chain.reverse();
            let part_of = if chain.is_empty() {
                format!("in {}", t.project)
            } else {
                format!("in {} / {}", t.project, chain.join(" / "))
            };
            lines.push(Line::from(part_of.fg(Color::DarkGray)));
            lines.push(waiting_on(plan, id, t));
        }
    }
    lines
}

/// The prerequisite line: met, none at all, or the ones no tick will release.
fn waiting_on(plan: &Plan, id: &TaskId, t: &Task) -> Line<'static> {
    let blockers = plan.blockers(id);
    if blockers.is_empty() {
        return if t.depends_on.is_empty() {
            Line::from("no prerequisites".fg(Color::DarkGray))
        } else {
            Line::from("prerequisites met".fg(Color::Green))
        };
    }
    let names: Vec<String> = blockers
        .iter()
        .map(|b| match b {
            wecode_core::Blocker::Waiting(w) => w.to_string(),
            wecode_core::Blocker::Stuck(w, s) => format!("{w} ({} — needs you)", s.as_str()),
            wecode_core::Blocker::Missing(m) => format!("{m} (missing)"),
        })
        .collect();
    Line::from(format!("waiting on: {}", names.join(", ")).fg(Color::Yellow))
}

/// What the agent is doing, while it is doing it.
///
/// Every act an agent takes passes the Broker on its way to the ledger, so the newest
/// record is the nearest thing wecode has to the agent's own last line — and it is the
/// same sentence the MOVING group prints on both boards, from the same function, so the
/// row that sent somebody here and the screen they arrived at cannot disagree.
///
/// Only while the work is in flight. On a task that has stopped this is history, and the
/// runs below say more about what happened than one line could.
fn doing(
    plan: &Plan,
    audit: &[AuditLine],
    gates: &board::DesignGates,
    t: &Task,
) -> Vec<Line<'static>> {
    if !matches!(t.status, TaskStatus::Running | TaskStatus::Verifying) {
        return Vec::new();
    }
    let l = board::ledger_index(audit);
    let v = board::task_vitals(plan, t, &l, gates);
    vec![Line::from(vec![
        Span::styled("doing   ", Style::new().fg(Color::DarkGray)),
        Span::styled(
            board::Group::Moving.line(plan, t, &l, &v),
            Style::new().fg(Color::Cyan),
        ),
    ])]
}

/// Every attempt, and what it cost against the budget it was held to.
///
/// Per attempt rather than only in total, for the reason `wecode show` prints them that
/// way: a task that cost too much usually cost it on one try, and a total cannot say
/// which. The budget rides in the same cell because the figure means nothing without it
/// — `9k` is a bargain or a breach depending on a number that would otherwise be on
/// another screen. Red when the try went past it, which is the one reading here that is
/// a judgement rather than a record.
fn runs(store: &Store, t: &Task) -> Vec<Line<'static>> {
    let Ok(attempts) = store.executions(&t.id) else {
        return Vec::new();
    };
    if attempts.is_empty() {
        return vec![Line::from("no runs yet".fg(Color::DarkGray))];
    }
    let mut out = vec![Line::from(format!("runs ({})", attempts.len()).bold())];
    for r in &attempts {
        let spent = r.spent_tokens.unwrap_or_default();
        let over = t.budget.tokens.is_some_and(|b| spent > b);
        out.push(Line::from(vec![
            Span::raw(format!(
                "  #{}  {:<9} {:<7} ",
                r.attempt,
                r.status.as_str(),
                // No end time means it never closed: wecode died mid-run, and the row
                // saying so is the recovery information rather than a gap to tidy away.
                match r.wall_secs {
                    Some(w) => format!("{w}s"),
                    None => "—".to_string(),
                }
            )),
            Span::styled(
                board::spend_cell(spent, t.budget.tokens).trim().to_string(),
                if over {
                    Style::new().fg(Color::Red)
                } else {
                    Style::new()
                },
            ),
            Span::styled(
                format!("  {}", r.detail),
                Style::new().fg(Color::DarkGray),
            ),
        ]));
    }
    out
}

/// The merge report, once the work has landed.
///
/// Read out of the repository rather than out of the database, because that is where
/// `wecode merge` put it: committed to the target branch beside the code it describes,
/// which makes this the same file somebody would open there. Silent until then, and
/// silent for a repo that has moved — an operator reading a task that has not landed is
/// not asking why there is no report.
fn report(company: &Company, plan: &Plan, t: &Task) -> Vec<Line<'static>> {
    let Some(p) = plan.project(&t.project) else {
        return Vec::new();
    };
    let Ok(root) = repo_path(company, p) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(root.join(record::path_for(&t.id))) else {
        return Vec::new();
    };
    let mut out = vec![Line::from("report".bold())];
    out.extend(
        text.lines()
            .map(|l| Line::from(format!("  {l}").fg(Color::DarkGray))),
    );
    out
}

/// What the ledger refused or flagged here, newest first.
///
/// A project shows every incident within it, a task only its own: the project row rolls
/// its tasks' alarms up, so it has to be able to show what they were.
fn incidents(audit: &[AuditLine], subject: &Subject, take: usize) -> Vec<Line<'static>> {
    let mine = |l: &AuditLine| match subject {
        Subject::Project(id) => l.project == id.as_str(),
        Subject::Task(id) => l.task == id.as_str(),
    };
    let found: Vec<&AuditLine> = audit.iter().filter(|l| l.is_denial() && mine(l)).collect();
    if found.is_empty() {
        return vec![Line::from("no incidents".fg(Color::DarkGray))];
    }
    found
        .iter()
        .rev()
        .take(take)
        .map(|l| {
            let (mark, colour) = if l.is_alarm() {
                ("⚡", Color::Red)
            } else {
                ("✗", Color::Yellow)
            };
            Line::from(vec![
                Span::styled(format!("{mark} "), Style::new().fg(colour)),
                Span::raw(format!("{} {} {}  ", l.post, l.action, l.target)),
                Span::styled(l.detail.clone(), Style::new().fg(Color::DarkGray)),
            ])
        })
        .collect()
}
