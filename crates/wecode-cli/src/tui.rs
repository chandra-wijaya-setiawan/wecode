//! The cockpit: a live, navigable dashboard.
//!
//! Same four columns at every zoom level — what · status · spend · needs-you —
//! which works because a project and a task answer the same four questions.
//! Health is computed from ground truth (see [`crate::board`]), never reported
//! by an agent; it is the colour of the needs-you cell rather than a column,
//! because every cause of amber or red already writes an entry there.
//!
//! Every level draws the whole is-part-of tree beneath its subject, subtasks and
//! their subtasks included. A row with work under it can be folded shut, which is
//! how the portfolio stays a scan without hiding anything by default: what is not
//! on screen is what the operator put away, not what the view decided to omit.
//!
//! Reloads from the store on a tick, so it tracks state as it changes rather than
//! showing a snapshot.

use std::collections::HashSet;
use std::io;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Row, Table, TableState, Wrap};
use ratatui::{DefaultTerminal, Frame};
use wecode_core::{Plan, Project, ProjectId, Task, TaskId, TaskStatus};
use wecode_org::Company;
use wecode_store::{AuditLine, AuditQuery, Store};

use crate::board::{self, Health, Ledger, Vitals};

/// How often to re-read the store.
const RELOAD: Duration = Duration::from_millis(1500);
/// How long to block waiting for a keypress before redrawing.
const POLL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pane {
    Board,
    Help,
}

/// What a row points at. Two levels of work means a row is one or the other, and
/// an id alone cannot say which — project and task ids live in separate spaces.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
enum Subject {
    Project(ProjectId),
    Task(TaskId),
}

impl Subject {
    fn as_str(&self) -> &str {
        match self {
            Self::Project(p) => p.as_str(),
            Self::Task(t) => t.as_str(),
        }
    }
}

/// Whether a row has anything under it, and whether it is showing it.
///
/// A leaf still occupies the marker column. Two spaces of nothing keep every id in
/// the same place down a branch; without them a row's indentation would encode its
/// depth *and* whether its neighbour had children, which is unreadable.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fold {
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

/// One visible line: a subject at a depth, with its derived vitals.
struct RowItem {
    subject: Subject,
    /// Already carries its own indentation and tree glyph, so a separate depth
    /// field would be a second source of truth for the same thing.
    label: String,
    /// The declared state, as a mark and a word. Distinct from `vitals.health`,
    /// which is computed — a task can be perfectly healthy and not started.
    status: String,
    vitals: Vitals,
    fold: Fold,
}

impl RowItem {
    fn is_project(&self) -> bool {
        matches!(self.subject, Subject::Project(_))
    }
}

struct App {
    store: Store,
    company: Company,
    known_repos: Vec<String>,
    /// Which kinds each project refuses without a design, from its playbook. Read
    /// with the plan, so a row's defect count agrees with `wecode check`.
    gates: board::DesignGates,
    plan: Plan,
    audit: Vec<AuditLine>,
    /// `None` is the portfolio; `Some` is a focused project or task.
    focus: Option<Subject>,
    rows: Vec<RowItem>,
    table: TableState,
    pane: Pane,
    last_reload: Instant,
    /// Whether archived projects are on screen. Off by default — archiving is a
    /// request to stop seeing something.
    show_archived: bool,
    /// Rows whose children are folded away. Empty to begin with: the tree is what
    /// there is to see, and a view that starts by hiding most of it is the gap this
    /// closed. Kept by subject rather than by row index so it survives a reload
    /// that moves everything.
    collapsed: HashSet<Subject>,
    status: String,
    quit: bool,
}

impl App {
    fn new(store: Store, company: Company) -> Result<Self, Box<dyn std::error::Error>> {
        let plan = store.load_plan()?;
        let mut app = Self {
            gates: crate::commands::ctx::design_gates(&company, &plan),
            plan,
            audit: store.audit(&AuditQuery::default())?,
            known_repos: company.repos.iter().map(|r| r.name.clone()).collect(),
            store,
            company,
            focus: None,
            rows: Vec::new(),
            table: TableState::default().with_selected(Some(0)),
            pane: Pane::Board,
            last_reload: Instant::now(),
            show_archived: false,
            collapsed: HashSet::new(),
            status: "j/k move · space fold · enter descend · esc up · ? help · q quit".into(),
            quit: false,
        };
        app.rebuild();
        Ok(app)
    }

    /// Re-reads state. Errors become a status message rather than a crash: the
    /// cockpit staying up matters more than any single refresh.
    fn reload(&mut self) {
        match (
            self.store.load_plan(),
            self.store.audit(&AuditQuery::default()),
        ) {
            (Ok(p), Ok(a)) => {
                self.gates = crate::commands::ctx::design_gates(&self.company, &p);
                self.plan = p;
                self.audit = a;
                self.rebuild();
            }
            (Err(e), _) => self.status = format!("reload failed: {e}"),
            (_, Err(e)) => self.status = format!("reload failed: {e}"),
        }
        self.last_reload = Instant::now();
    }

    /// Flattens the current view into rows, preserving the selection if it survives
    /// the rebuild.
    ///
    /// One walk serves all three levels, because all three draw the same thing —
    /// a subject and the tree beneath it — and only differ in where they start.
    /// Hand-unrolled, each level stopped at whatever depth its author wrote out,
    /// which is how the portfolio came to end at root tasks and a focused task at
    /// its grandchildren.
    fn rebuild(&mut self) {
        let selected = self.selected().map(|r| r.subject.clone());
        let l = board::ledger_index(&self.audit);
        let tree = Tree {
            plan: &self.plan,
            ledger: &l,
            gates: &self.gates,
            collapsed: &self.collapsed,
        };
        let mut rows = Vec::new();

        match &self.focus {
            None => {
                let projects: Vec<&Project> = if self.show_archived {
                    self.plan.all_projects().collect()
                } else {
                    self.plan.projects().collect()
                };
                for p in projects {
                    tree.push_project(&mut rows, p, &self.known_repos);
                }
            }
            Some(Subject::Project(id)) => {
                if let Some(p) = self.plan.project(id) {
                    tree.push_project(&mut rows, p, &self.known_repos);
                }
            }
            Some(Subject::Task(id)) => {
                if let Some(t) = self.plan.task(id) {
                    tree.push_task(&mut rows, t, 0, true);
                }
            }
        }

        self.rows = rows;
        let restored = selected
            .and_then(|s| self.rows.iter().position(|r| r.subject == s))
            .unwrap_or(0);
        self.table.select(if self.rows.is_empty() {
            None
        } else {
            Some(restored)
        });
    }

    fn selected(&self) -> Option<&RowItem> {
        self.rows.get(self.table.selected()?)
    }

    fn move_by(&mut self, delta: isize) {
        if self.rows.is_empty() {
            return;
        }
        // `checked_add_signed` keeps the whole thing in `usize`: moving up from the
        // first row underflows rather than wrapping, and lands on the first row.
        let cur = self.table.selected().unwrap_or(0);
        let last = self.rows.len().saturating_sub(1);
        self.table
            .select(Some(cur.checked_add_signed(delta).unwrap_or(0).min(last)));
    }

    fn descend(&mut self) {
        let Some(row) = self.selected() else { return };
        let subject = row.subject.clone();
        let has_children = match &subject {
            Subject::Project(id) => self.plan.tasks_of(id).next().is_some(),
            Subject::Task(id) => self.plan.subtasks(id).next().is_some(),
        };
        if has_children {
            // Zooming into something folded shut would land on a screen showing
            // only the thing you zoomed into. Descending *is* asking to see inside.
            self.collapsed.remove(&subject);
            self.focus = Some(subject);
            self.rebuild();
            self.table.select(Some(0));
        } else {
            self.status = "leaf — nothing below".into();
        }
    }

    /// Folds the selected row shut, or opens it again.
    fn toggle_fold(&mut self) {
        let Some(row) = self.selected() else { return };
        if row.fold == Fold::Leaf {
            self.status = "leaf — nothing to fold".into();
            return;
        }
        let subject = row.subject.clone();
        if !self.collapsed.remove(&subject) {
            self.collapsed.insert(subject);
        }
        self.rebuild();
    }

    /// Folds everything, or opens everything. The way back from a plan whose tree
    /// is longer than the screen — one keystroke rather than one per project.
    ///
    /// "Everything" is every subject with children anywhere in the plan, not only
    /// the rows currently drawn: folding what is visible and leaving the rest open
    /// means the next descent lands somewhere the operator did not ask for.
    fn fold_all(&mut self, shut: bool) {
        self.collapsed.clear();
        if shut {
            // Only what has something to hide. A leaf recorded as folded is
            // invisible today and wrong the moment somebody hangs a subtask off it.
            for p in self.plan.all_projects() {
                if self.plan.tasks_of(&p.id).next().is_some() {
                    self.collapsed.insert(Subject::Project(p.id.clone()));
                }
            }
            for t in self.plan.tasks() {
                if self.plan.subtasks(&t.id).next().is_some() {
                    self.collapsed.insert(Subject::Task(t.id.clone()));
                }
            }
        }
        self.status = if shut { "folded" } else { "unfolded" }.into();
        self.rebuild();
    }

    /// Up one level. A task rises to its parent task if it has one, otherwise to
    /// its project — which is the is-part-of chain, not the dependency graph.
    fn ascend(&mut self) {
        self.focus = match self.focus.clone() {
            None => None,
            Some(Subject::Project(_)) => None,
            Some(Subject::Task(id)) => self.plan.task(&id).map(|t| match &t.parent {
                Some(p) => Subject::Task(p.clone()),
                None => Subject::Project(t.project.clone()),
            }),
        };
        self.rebuild();
    }

    fn key(&mut self, k: KeyEvent) {
        if self.pane == Pane::Help {
            self.pane = Pane::Board;
            return;
        }
        match k.code {
            KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => self.quit = true,
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('j') | KeyCode::Down => self.move_by(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_by(-1),
            KeyCode::Char('g') => self.table.select(Some(0)),
            KeyCode::Char('G') => self.table.select(Some(self.rows.len().saturating_sub(1))),
            KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right => self.descend(),
            KeyCode::Esc | KeyCode::Char('h') | KeyCode::Left => self.ascend(),
            KeyCode::Char(' ') => self.toggle_fold(),
            // Shut with `z`, open with `Z`, rather than one key that toggles: what a
            // toggle would do next depends on state the operator cannot see.
            KeyCode::Char('z') => self.fold_all(true),
            KeyCode::Char('Z') => self.fold_all(false),
            KeyCode::Char('a') => {
                self.show_archived = !self.show_archived;
                let n = self.plan.archived_count();
                self.status = if self.show_archived {
                    format!("showing {n} archived")
                } else {
                    format!("{n} archived hidden")
                };
                self.rebuild();
            }
            KeyCode::Char('r') => {
                self.reload();
                self.status = "reloaded".into();
            }
            KeyCode::Char('?') => self.pane = Pane::Help,
            _ => {}
        }
    }
}

/// Tasks in id order, so the view does not reshuffle between frames.
fn sorted<'a>(it: impl Iterator<Item = &'a Task>) -> Vec<&'a Task> {
    let mut v: Vec<&Task> = it.collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

fn last(i: usize, n: usize) -> bool {
    i + 1 == n
}

/// Everything a row needs that is not the row's own subject.
///
/// Bundled so the walk can recurse without carrying five parameters down every
/// branch, and borrowed rather than owned so building the rows never copies the
/// plan.
struct Tree<'a> {
    plan: &'a Plan,
    ledger: &'a Ledger,
    gates: &'a board::DesignGates,
    collapsed: &'a HashSet<Subject>,
}

impl Tree<'_> {
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
    fn push_project(&self, rows: &mut Vec<RowItem>, p: &Project, known_repos: &[String]) {
        let subject = Subject::Project(p.id.clone());
        let roots = sorted(self.plan.roots_of(&p.id));
        let fold = self.fold_of(&subject, !roots.is_empty());
        rows.push(RowItem {
            label: format!(
                "{}PROJECT {}  [{}]{}",
                fold.glyph(),
                p.id,
                p.repo,
                if p.archived { "  archived" } else { "" }
            ),
            status: format!("{} {}", p.status.mark(), p.status.as_str()),
            vitals: board::project_vitals(self.plan, p, self.ledger, known_repos),
            subject,
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
        let kids = sorted(self.plan.subtasks(&t.id));
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
            label: format!(
                "{connector}{}{} {}",
                fold.glyph(),
                crate::render::kind_tag(t.kind),
                t.id
            ),
            status: format!("{} {}", t.status.mark(), status_word(t.status)),
            vitals: board::task_vitals(self.plan, t, self.ledger, self.gates),
            subject,
            fold,
        });
        if fold == Fold::Open {
            for (i, k) in kids.iter().enumerate() {
                self.push_task(rows, k, depth + 1, last(i, kids.len()));
            }
        }
    }
}

/// Short enough for a column. `needs-approval` and `needs-input` are the reason
/// this exists rather than using `as_str` directly.
fn status_word(s: TaskStatus) -> &'static str {
    match s {
        TaskStatus::NeedsApproval => "approval",
        TaskStatus::NeedsInput => "input",
        other => other.as_str(),
    }
}

/// Colour follows meaning, not decoration: green is finished, yellow is waiting on
/// a person, cyan is in flight.
fn status_style(row: &RowItem) -> Style {
    let base = Style::new();
    match &row.subject {
        Subject::Project(_) => base.fg(Color::Cyan),
        Subject::Task(_) => {
            if row.status.contains("done") {
                base.fg(Color::Green)
            } else if row.status.contains("approval")
                || row.status.contains("input")
                || row.status.contains("failed")
            {
                base.fg(Color::Yellow)
            } else if row.status.contains("running") || row.status.contains("verifying") {
                base.fg(Color::Cyan)
            } else {
                base.fg(Color::DarkGray)
            }
        }
    }
}

fn spend_text(v: &Vitals) -> String {
    let k = |n: u64| {
        if n >= 1000 {
            format!("{}k", n / 1000)
        } else {
            n.to_string()
        }
    };
    match v.budget {
        Some(b) => format!("{}/{}", k(v.spent), k(b)),
        None => k(v.spent),
    }
}

fn draw(f: &mut Frame, app: &mut App) {
    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(6),
        Constraint::Length(7),
        Constraint::Length(1),
    ])
    .split(f.area());

    header(f, areas[0], app);
    table(f, areas[1], app);
    detail(f, areas[2], app);
    footer(f, areas[3], app);

    if app.pane == Pane::Help {
        help(f, f.area());
    }
}

fn header(f: &mut Frame, area: Rect, app: &App) {
    let level = match &app.focus {
        None => "L0 PORTFOLIO".to_string(),
        Some(Subject::Project(id)) => format!("L1 project {id}"),
        Some(Subject::Task(id)) => format!("L2 task {id}"),
    };
    let line = Line::from(vec![
        Span::styled(
            format!(" {} ", app.company.name),
            Style::new().add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("({}) ", app.company.profile),
            Style::new().fg(Color::DarkGray),
        ),
        Span::styled(level, Style::new().fg(Color::Cyan)),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

fn table(f: &mut Frame, area: Rect, app: &mut App) {
    let header = Row::new(vec!["what", "status", "spend", "needs you"])
        .style(Style::new().fg(Color::DarkGray));

    let rows: Vec<Row> = app
        .rows
        .iter()
        .map(|r| {
            let needs = if r.vitals.needs.is_empty() {
                Span::styled("—", Style::new().fg(Color::DarkGray))
            } else {
                let style = match r.vitals.health {
                    Health::Red => Style::new().fg(Color::Red),
                    Health::Amber => Style::new().fg(Color::Yellow),
                    Health::Green => Style::new(),
                };
                Span::styled(r.vitals.needs.join(", "), style)
            };
            // A project names itself in bold cyan; a task is plain and connected by
            // a tree glyph, so the two levels are distinguishable without reading.
            // The title is deliberately not here — at this width it truncated to
            // noise, and the detail pane already carries it in full.
            let what = if r.is_project() {
                Line::from(Span::styled(
                    r.label.clone(),
                    Style::new().add_modifier(Modifier::BOLD).fg(Color::Cyan),
                ))
            } else {
                Line::from(Span::raw(r.label.clone()))
            };
            Row::new(vec![
                what,
                Line::from(Span::styled(r.status.clone(), status_style(r))),
                Line::from(spend_text(&r.vitals)),
                Line::from(needs),
            ])
        })
        .collect();

    let widths = [
        Constraint::Min(30),
        Constraint::Length(11),
        Constraint::Length(12),
        Constraint::Min(14),
    ];

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(Color::DarkGray));

    if app.rows.is_empty() {
        f.render_widget(
            Paragraph::new(
                "no projects yet — wecode project add <id> --repo <name> \"<objective>\"",
            )
            .block(block),
            area,
        );
        return;
    }

    let table = Table::new(rows, widths)
        .header(header)
        .block(block)
        .row_highlight_style(Style::new().add_modifier(Modifier::REVERSED))
        .highlight_symbol("▌");

    f.render_stateful_widget(table, area, &mut app.table);
}

/// The selection in words: what it is, where it sits, what it waits on, and any
/// incidents against it.
fn detail(f: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(Color::DarkGray))
        .title(" detail ");

    let Some(row) = app.selected() else {
        f.render_widget(Paragraph::new("").block(block), area);
        return;
    };

    let mut lines = Vec::new();
    match &row.subject {
        Subject::Project(id) => {
            let Some(p) = app.plan.project(id) else {
                f.render_widget(Paragraph::new("").block(block), area);
                return;
            };
            lines.push(Line::from(p.objective.clone().bold()));
            lines.push(Line::from(
                format!("repo: {}  ·  {}", p.repo, p.status.as_str()).fg(Color::DarkGray),
            ));
        }
        Subject::Task(id) => {
            let Some(t) = app.plan.task(id) else {
                f.render_widget(Paragraph::new("").block(block), area);
                return;
            };
            lines.push(Line::from(t.title.clone().bold()));

            // The two relations, named apart. Conflating them is the error this
            // whole model exists to prevent.
            let mut chain: Vec<String> = app
                .plan
                .ancestors(id)
                .iter()
                .map(|a| a.id.to_string())
                .collect();
            chain.reverse();
            let part_of = if chain.is_empty() {
                format!("in {}", t.project)
            } else {
                format!("in {} / {}", t.project, chain.join(" / "))
            };
            lines.push(Line::from(part_of.fg(Color::DarkGray)));

            let blockers = app.plan.blockers(id);
            if blockers.is_empty() {
                if t.depends_on.is_empty() {
                    lines.push(Line::from("no prerequisites".fg(Color::DarkGray)));
                } else {
                    lines.push(Line::from("prerequisites met".fg(Color::Green)));
                }
            } else {
                let names: Vec<String> = blockers
                    .iter()
                    .map(|b| match b {
                        wecode_core::Blocker::Waiting(w) => w.to_string(),
                        wecode_core::Blocker::Stuck(w, s) => {
                            format!("{w} ({} — needs you)", s.as_str())
                        }
                        wecode_core::Blocker::Missing(m) => format!("{m} (missing)"),
                    })
                    .collect();
                lines.push(Line::from(
                    format!("waiting on: {}", names.join(", ")).fg(Color::Yellow),
                ));
            }
        }
    }

    let id = row.subject.as_str();
    let incidents: Vec<&AuditLine> = app
        .audit
        .iter()
        .filter(|l| l.is_denial() && attributed_to(l, &row.subject, id))
        .collect();

    if incidents.is_empty() {
        lines.push(Line::from("no incidents".fg(Color::DarkGray)));
    } else {
        for l in incidents.iter().rev().take(3) {
            let (mark, colour) = if l.is_alarm() {
                ("⚡", Color::Red)
            } else {
                ("✗", Color::Yellow)
            };
            lines.push(Line::from(vec![
                Span::styled(format!("{mark} "), Style::new().fg(colour)),
                Span::raw(format!("{} {} {}  ", l.post, l.action, l.target)),
                Span::styled(l.detail.clone(), Style::new().fg(Color::DarkGray)),
            ]));
        }
    }

    f.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
}

/// A project shows every incident within it, a task only its own. The project row
/// rolls its tasks' alarms up, so it has to be able to show what they were.
fn attributed_to(l: &AuditLine, subject: &Subject, id: &str) -> bool {
    match subject {
        Subject::Project(_) => l.project == id,
        Subject::Task(_) => l.task == id,
    }
}

fn footer(f: &mut Frame, area: Rect, app: &App) {
    let attention = format!(
        "attention {} items · {}/h · digest {}m",
        app.company.attention.max_open_items,
        app.company.attention.max_interrupts_per_hour,
        app.company.attention.digest_interval_mins
    );
    let line = Line::from(vec![
        Span::styled(
            format!(" {} ", app.status),
            Style::new().fg(Color::DarkGray),
        ),
        Span::styled(attention, Style::new().fg(Color::DarkGray)),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

fn help(f: &mut Frame, area: Rect) {
    let w = 54u16.min(area.width.saturating_sub(4));
    let h = 21u16.min(area.height.saturating_sub(2));
    let popup = Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y + (area.height.saturating_sub(h)) / 2,
        width: w,
        height: h,
    };
    let text = vec![
        Line::from("j / ↓        next".to_string()),
        Line::from("k / ↑        previous".to_string()),
        Line::from("space        fold or unfold the selection".to_string()),
        Line::from("z / Z        fold or unfold everything".to_string()),
        Line::from("enter / l    descend into selection".to_string()),
        Line::from("esc / h      up one level".to_string()),
        Line::from("g / G        first / last".to_string()),
        Line::from("a            show or hide archived projects".to_string()),
        Line::from("r            reload now".to_string()),
        Line::from("q            quit".to_string()),
        Line::from(""),
        Line::from("▾ open  ▸ folded shut  · the whole tree is drawn".fg(Color::DarkGray)),
        Line::from("status is declared:".fg(Color::DarkGray)),
        Line::from("  · draft  ⋯ waiting  ○ ready  > running".fg(Color::DarkGray)),
        Line::from("  ? verifying  ! approval  ✓ done  x failed".fg(Color::DarkGray)),
        Line::from("needs-you is computed, and coloured by it:".fg(Color::DarkGray)),
        Line::from("  red = alarm or over budget".fg(Color::DarkGray)),
        Line::from("  amber = defects, denials, stalled, waiting on you".fg(Color::DarkGray)),
    ];
    f.render_widget(Clear, popup);
    f.render_widget(
        Paragraph::new(text).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" keys — any key closes "),
        ),
        popup,
    );
}

/// Runs the cockpit until the operator quits.
pub(crate) fn run(store: Store, company: Company) -> Result<(), Box<dyn std::error::Error>> {
    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, store, company);
    ratatui::restore();
    result
}

fn event_loop(
    terminal: &mut DefaultTerminal,
    store: Store,
    company: Company,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(store, company)?;

    while !app.quit {
        terminal.draw(|f| draw(f, &mut app))?;

        if event::poll(POLL)? {
            match event::read()? {
                Event::Key(k) if k.is_press() => app.key(k),
                Event::Resize(_, _) => {}
                _ => {}
            }
        }
        if app.last_reload.elapsed() >= RELOAD {
            app.reload();
        }
    }
    Ok(())
}

/// Reports whether stdout is a terminal, so the CLI can refuse politely instead of
/// scribbling escape codes into a pipe.
#[must_use]
pub(crate) fn is_tty() -> bool {
    io::IsTerminal::is_terminal(&io::stdout())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use wecode_core::{Budget, Measure, Scope};

    /// Renders one frame into an in-memory backend and returns it as text.
    fn render(app: &mut App, w: u16, h: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).expect("test backend");
        terminal.draw(|f| draw(f, app)).expect("draw");
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol().to_string())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Each test gets its own store: they run in parallel, and a shared temp file
    /// means one test wipes another's state mid-write.
    fn app(name: &str) -> App {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
        let dir = std::path::Path::new(&base).join(format!("wecode-tui-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let store = Store::open(dir.join("wecode.db")).expect("store");

        store
            .save_project(
                &Project::new("caching", "cut export p99 below 500ms", "main")
                    .measured(Measure::Command {
                        cmd: "cargo bench".into(),
                        expect_status: 0,
                    })
                    .budgeted(Budget {
                        tokens: Some(200_000),
                        wall_secs: Some(1800),
                    }),
            )
            .unwrap();
        store
            .save_task(&task("layer", "write the cache layer", "crates/cache/**"))
            .unwrap();
        store
            .save_task(
                &task("keys", "design the cache keys", "crates/cache/keys.rs").under("layer"),
            )
            .unwrap();

        let company = Company::parse(
            wecode_org::template::SOLO
                .files
                .iter()
                .find(|(p, _)| *p == "company.toml")
                .unwrap()
                .1,
        )
        .expect("template parses");

        App::new(store, company).expect("app")
    }

    fn task(id: &str, title: &str, glob: &str) -> Task {
        Task::new(id, "caching", title)
            .accepting(Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 0,
            })
            .scoped(Scope::write(&[glob]))
            .budgeted(Budget {
                tokens: Some(9000),
                wall_secs: Some(600),
            })
    }

    #[test]
    fn the_portfolio_frame_shows_every_column() {
        let out = render(&mut app("portfolio"), 118, 24);
        for col in ["what", "status", "spend", "needs you"] {
            assert!(out.contains(col), "missing `{col}` in:\n{out}");
        }
        for gone in ["health", "progress"] {
            assert!(!out.contains(gone), "`{gone}` should be gone from:\n{out}");
        }
        assert!(out.contains("L0 PORTFOLIO"), "{out}");
        assert!(out.contains("feat layer"), "{out}");
    }

    #[test]
    fn a_project_row_names_its_level_and_its_repo() {
        // Without these, nothing on screen says which row is the project or what
        // code it works on — the two things that actually confused a reader.
        let out = render(&mut app("level"), 118, 24);
        assert!(out.contains("PROJECT caching"), "{out}");
        assert!(
            out.contains("[main]"),
            "the repo belongs on the row:\n{out}"
        );
    }

    #[test]
    fn tasks_hang_off_the_project_with_tree_glyphs() {
        let mut a = app("glyphs");
        a.focus = Some(Subject::Project(ProjectId::new("caching")));
        a.rebuild();
        let out = render(&mut a, 118, 24);
        assert!(
            out.contains("└─ ▾ feat layer"),
            "the only root task is last, and has work under it:\n{out}"
        );
        assert!(
            out.contains("   └─   feat keys"),
            "the subtask nests deeper, and is a leaf:\n{out}"
        );
    }

    #[test]
    fn declared_status_is_on_every_row() {
        // The gap this closes: a draft, a waiting and a ready task were all rendered
        // identically, indistinguishable.
        let mut a = app("status");
        let out = render(&mut a, 118, 24);
        assert!(out.contains("· draft"), "a fresh task is a draft:\n{out}");

        a.store
            .set_task_status(&TaskId::new("layer"), TaskStatus::Done)
            .unwrap();
        a.reload();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("✓ done"), "{out}");
    }

    #[test]
    fn the_long_statuses_are_shortened_to_fit_the_column() {
        assert_eq!(status_word(TaskStatus::NeedsApproval), "approval");
        assert_eq!(status_word(TaskStatus::NeedsInput), "input");
        // Everything else keeps the name the CLI accepts.
        assert_eq!(status_word(TaskStatus::Waiting), "waiting");
        for s in TaskStatus::all() {
            assert!(
                status_word(*s).len() <= 9,
                "{s:?} is too wide for the column"
            );
        }
    }

    #[test]
    fn the_portfolio_draws_the_whole_tree_not_just_root_tasks() {
        // The gap this closes: the portfolio stopped at root tasks, so a plan that
        // broke its work down hid the half that was broken down — and the work
        // actually being done is usually a leaf.
        let mut a = app("depth");
        // `salt` sorts after `keys` on purpose: the store loads non-root tasks in
        // id order, so a grandchild whose id sorts before its parent's cannot be
        // read back. That is a gap in `wecode-store`, recorded in features.md, and
        // this test would be about it rather than about the view.
        a.store
            .save_task(&task("salt", "pick the salt", "crates/cache/salt.rs").under("keys"))
            .unwrap();
        a.reload();
        let out = render(&mut a, 118, 24);
        for row in ["feat layer", "feat keys", "feat salt"] {
            assert!(out.contains(row), "missing `{row}` at L0:\n{out}");
        }
    }

    #[test]
    fn folding_a_row_hides_what_is_under_it_and_says_which_way_it_points() {
        let mut a = app("fold");
        // The project is selected to begin with, so this folds the whole tree away.
        a.toggle_fold();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("▸ PROJECT caching"), "marker flips:\n{out}");
        assert!(!out.contains("feat layer"), "root task is away:\n{out}");

        a.toggle_fold();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("▾ PROJECT caching"), "{out}");
        assert!(out.contains("feat keys"), "and all of it is back:\n{out}");
    }

    #[test]
    fn folding_a_task_hides_its_subtasks_and_leaves_the_task() {
        let mut a = app("fold-task");
        let pos = a
            .rows
            .iter()
            .position(|r| r.subject == Subject::Task(TaskId::new("layer")))
            .unwrap();
        a.table.select(Some(pos));
        a.toggle_fold();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat layer"), "the row itself stays:\n{out}");
        assert!(!out.contains("feat keys"), "its subtask goes:\n{out}");
    }

    #[test]
    fn a_leaf_has_nothing_to_fold_and_is_told_so() {
        let mut a = app("fold-leaf");
        let pos = a
            .rows
            .iter()
            .position(|r| r.subject == Subject::Task(TaskId::new("keys")))
            .unwrap();
        a.table.select(Some(pos));
        a.toggle_fold();
        assert!(a.status.contains("nothing to fold"), "{}", a.status);
        assert!(a.collapsed.is_empty(), "a leaf is not recorded as folded");
    }

    #[test]
    fn a_fold_survives_a_reload() {
        // Kept by subject, not by row index: a reload rebuilds every row, and a
        // fold that reopened itself every tick and a half would be unusable.
        let mut a = app("fold-reload");
        a.toggle_fold();
        a.reload();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("▸ PROJECT caching"), "{out}");
        assert!(!out.contains("feat layer"), "{out}");
    }

    #[test]
    fn z_folds_the_whole_plan_and_shift_z_opens_it() {
        let mut a = app("fold-all");
        a.key(KeyEvent::from(KeyCode::Char('z')));
        assert_eq!(a.rows.len(), 1, "projects only");
        // Leaves are never recorded: the set holds `caching` and `layer`, not `keys`.
        assert!(!a.collapsed.contains(&Subject::Task(TaskId::new("keys"))));

        a.key(KeyEvent::from(KeyCode::Char('Z')));
        assert!(a.collapsed.is_empty());
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat keys"), "{out}");
    }

    #[test]
    fn descending_into_a_folded_row_opens_it_first() {
        // Otherwise zooming in lands on a screen showing only the thing zoomed into.
        let mut a = app("fold-descend");
        a.toggle_fold();
        a.descend();
        assert_eq!(a.focus, Some(Subject::Project(ProjectId::new("caching"))));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat layer"), "{out}");
    }

    #[test]
    fn the_header_names_the_company_and_the_footer_the_attention_budget() {
        let out = render(&mut app("header"), 110, 24);
        assert!(out.contains("My Project"), "{out}");
        assert!(out.contains("attention"), "{out}");
    }

    #[test]
    fn descending_a_project_reveals_its_tasks() {
        let mut a = app("descend");
        assert_eq!(
            a.selected().unwrap().subject,
            Subject::Project(ProjectId::new("caching"))
        );
        a.descend();
        assert_eq!(a.focus, Some(Subject::Project(ProjectId::new("caching"))));

        let out = render(&mut a, 110, 24);
        assert!(out.contains("L1 project caching"), "{out}");
        assert!(out.contains("feat keys"), "subtask now visible:\n{out}");
        assert!(out.contains("needs you"), "{out}");
    }

    #[test]
    fn a_task_ascends_to_its_parent_task_then_to_its_project() {
        // The is-part-of chain, which is what "up" means — not the dependency graph.
        let mut a = app("ascend");
        a.focus = Some(Subject::Task(TaskId::new("keys")));
        a.rebuild();
        a.ascend();
        assert_eq!(a.focus, Some(Subject::Task(TaskId::new("layer"))));
        a.ascend();
        assert_eq!(a.focus, Some(Subject::Project(ProjectId::new("caching"))));
        a.ascend();
        assert!(a.focus.is_none(), "back to the portfolio");
    }

    #[test]
    fn descending_into_a_leaf_is_refused_with_a_reason() {
        let mut a = app("leaf");
        a.focus = Some(Subject::Project(ProjectId::new("caching")));
        a.rebuild();
        let pos = a
            .rows
            .iter()
            .position(|r| r.subject == Subject::Task(TaskId::new("keys")))
            .unwrap();
        a.table.select(Some(pos));
        a.descend();
        assert_eq!(
            a.focus,
            Some(Subject::Project(ProjectId::new("caching"))),
            "focus unchanged"
        );
        assert!(a.status.contains("leaf"), "{}", a.status);
    }

    #[test]
    fn selection_survives_a_reload() {
        let mut a = app("reload");
        a.move_by(1);
        let before = a.selected().unwrap().subject.clone();
        a.reload();
        assert_eq!(a.selected().unwrap().subject, before);
    }

    #[test]
    fn navigation_clamps_at_both_ends() {
        let mut a = app("clamp");
        a.move_by(-5);
        assert_eq!(a.table.selected(), Some(0));
        a.move_by(100);
        assert_eq!(a.table.selected(), Some(a.rows.len() - 1));
    }

    #[test]
    fn q_quits_and_help_closes_on_any_key() {
        let mut a = app("keys");
        a.key(KeyEvent::from(KeyCode::Char('?')));
        assert!(a.pane == Pane::Help);
        a.key(KeyEvent::from(KeyCode::Char('j')));
        assert!(a.pane == Pane::Board, "any key closes help");

        assert!(!a.quit);
        a.key(KeyEvent::from(KeyCode::Char('q')));
        assert!(a.quit);
    }

    #[test]
    fn the_detail_pane_says_where_a_task_sits() {
        let mut a = app("detail");
        a.focus = Some(Subject::Project(ProjectId::new("caching")));
        a.rebuild();
        let pos = a
            .rows
            .iter()
            .position(|r| r.subject == Subject::Task(TaskId::new("keys")))
            .unwrap();
        a.table.select(Some(pos));
        let out = render(&mut a, 110, 24);
        assert!(out.contains("in caching / layer"), "{out}");
    }

    #[test]
    fn the_detail_pane_names_an_unmet_prerequisite() {
        let mut a = app("blocked");
        a.store
            .save_task(&task("bench", "benchmark the cache", "benches/**").after("layer"))
            .unwrap();
        a.reload();
        let pos = a
            .rows
            .iter()
            .position(|r| r.subject == Subject::Task(TaskId::new("bench")))
            .unwrap();
        a.table.select(Some(pos));
        let out = render(&mut a, 110, 24);
        assert!(out.contains("waiting on: layer"), "{out}");
    }

    #[test]
    fn a_met_prerequisite_reads_differently_from_none_at_all() {
        let mut a = app("met");
        a.store
            .save_task(&task("bench", "benchmark the cache", "benches/**").after("layer"))
            .unwrap();
        a.store
            .set_task_status(&TaskId::new("layer"), TaskStatus::Done)
            .unwrap();
        a.reload();
        let pos = a
            .rows
            .iter()
            .position(|r| r.subject == Subject::Task(TaskId::new("bench")))
            .unwrap();
        a.table.select(Some(pos));
        let out = render(&mut a, 110, 24);
        assert!(out.contains("prerequisites met"), "{out}");
    }

    #[test]
    fn a_narrow_terminal_still_renders_without_panicking() {
        for (w, h) in [(40u16, 12u16), (20, 8), (200, 60)] {
            let out = render(&mut app("narrow"), w, h);
            assert!(!out.is_empty(), "{w}x{h} produced nothing");
        }
    }

    #[test]
    fn spend_abbreviates_thousands_and_shows_the_cap() {
        let v = Vitals {
            health: Health::Green,
            spent: 1500,
            budget: Some(200_000),
            alarms: 0,
            denials: 0,
            defects: 0,
            needs: vec![],
        };
        assert_eq!(spend_text(&v), "1k/200k");

        let no_budget = Vitals { budget: None, ..v };
        assert_eq!(spend_text(&no_budget), "1k");
    }
}
