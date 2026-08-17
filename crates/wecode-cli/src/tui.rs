//! The cockpit: **one application whose screens call each other**.
//!
//! ```text
//! HOME     needs-you · moving · next · landed, over the whole portfolio,
//!          with the is-part-of tree under them
//!   ↓ enter
//! PROJECT  that project's task tree, to the leaves
//!   ↓ enter
//! TASK     one task in full — what it waits on, what it is doing, what each
//!          attempt cost, the report it landed, the incidents against it
//! ```
//!
//! `enter` opens what the cursor is on and `esc` goes back to the row it was opened
//! from. No screen is reachable only by quitting and starting again with a different
//! command, and no screen is a flag: that is the whole of the difference between this
//! and three views that happen to share a renderer. Everything else — the fold set, the
//! archived toggle, the selection — survives the move, because a screen is a place in
//! one application rather than a program of its own.
//!
//! Same four columns wherever there is a table — what · status · spend · needs-you —
//! which works because a project and a task answer the same four questions. Health is
//! computed from ground truth (see [`crate::board`]), never reported by an agent; it is
//! the colour of the needs-you cell rather than a column, because every cause of amber
//! or red already writes an entry there.
//!
//! HOME **opens on the same four attention groups the snapshot leads with**, and keeps
//! the tree under them. Not a second reading of the same statuses: the rows come from
//! [`board::attention_groups`], where `wecode board` gets its own, so a cockpit left
//! open on a desk and a snapshot read on a phone cannot disagree about what needs
//! somebody. There only, for the reason the snapshot's focus views are trees: descending
//! is what somebody does once a group row has told them where to look.
//!
//! Where there is a tree it is the whole one, subtasks and their subtasks included. A
//! row with work under it can be folded shut, which is how HOME stays a scan without
//! hiding anything by default: what is not on screen is what the operator put away, not
//! what the view decided to omit.
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
use wecode_core::{Plan, Project, ProjectId, TaskId};
use wecode_org::Company;
use wecode_store::{AuditLine, AuditQuery, Store};

use crate::board::{self, Health, Vitals};
use crate::commands::view::{Fold, RowItem, Subject, Tree, caption};

/// How often to re-read the store.
const RELOAD: Duration = Duration::from_millis(1500);
/// How long to block waiting for a keypress before redrawing.
const POLL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pane {
    Board,
    Help,
}

/// Which screen is on the glass.
///
/// Named rather than numbered. `L2` says how deep somebody has gone, which is not what
/// they need to know; `TASK cache-keys` says what they are looking at.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Screen {
    Home,
    Project(ProjectId),
    Task(TaskId),
}

impl Screen {
    /// The row this screen was opened from, so `esc` can land the cursor back on it.
    fn subject(&self) -> Option<Subject> {
        match self {
            Self::Home => None,
            Self::Project(id) => Some(Subject::Project(id.clone())),
            Self::Task(id) => Some(Subject::Task(id.clone())),
        }
    }

    fn title(&self) -> String {
        match self {
            Self::Home => "HOME".to_string(),
            Self::Project(id) => format!("PROJECT {id}"),
            Self::Task(id) => format!("TASK {id}"),
        }
    }
}

/// The screen `wecode tui <id>` opens on.
///
/// A starting point, never a mode: what it lands on is a screen the keys reach from
/// HOME, and `esc` from it goes back there like any other.
pub(crate) fn opening(plan: &Plan, named: &str) -> Result<Screen, String> {
    if let Some(p) = plan.project_ref(named) {
        return Ok(Screen::Project(p.id.clone()));
    }
    if let Some(t) = plan.task_ref(named) {
        return Ok(Screen::Task(t.id.clone()));
    }
    Err(format!(
        "no project or task: {named} — `wecode tree` lists ids and numbers"
    ))
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
    /// The screens the operator has open, HOME at the bottom and never empty.
    ///
    /// A stack rather than a single screen, because `esc` means *back*, not *up*: a
    /// task opened from a HOME group row belongs to a project they never visited, and
    /// walking them up the is-part-of chain would leave them somewhere they then have
    /// to find their own way out of.
    stack: Vec<Screen>,
    rows: Vec<RowItem>,
    table: TableState,
    /// How far the TASK page is scrolled. Reset whenever a screen opens or closes: a
    /// page is scrolled to a place in *that* screen, and carrying the offset across
    /// would open the next one part-way down.
    scroll: u16,
    pane: Pane,
    last_reload: Instant,
    /// Whether filed-away projects and tasks are on screen. Off by default — archiving
    /// is a request to stop seeing something.
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
    fn new(
        store: Store,
        company: Company,
        opening: Option<Screen>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let plan = store.load_plan()?;
        let mut app = Self {
            gates: crate::commands::ctx::design_gates(&company, &plan),
            plan,
            audit: store.audit(&AuditQuery::default())?,
            known_repos: company.repos.iter().map(|r| r.name.clone()).collect(),
            store,
            company,
            // HOME is under whatever was named, rather than instead of it: `wecode tui
            // <id>` is a starting screen, and `esc` from one has somewhere to go.
            stack: std::iter::once(Screen::Home).chain(opening).collect(),
            rows: Vec::new(),
            table: TableState::default().with_selected(Some(0)),
            scroll: 0,
            pane: Pane::Board,
            last_reload: Instant::now(),
            show_archived: false,
            collapsed: HashSet::new(),
            status: "j/k move · space fold · enter open · esc back · ? help · q quit".into(),
            quit: false,
        };
        app.rebuild();
        Ok(app)
    }

    /// The screen on the glass.
    fn screen(&self) -> &Screen {
        self.stack.last().expect("HOME is never popped")
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

    /// Flattens the current screen into rows, preserving the selection if it survives
    /// the rebuild.
    ///
    /// One walk serves both screens that have a table, because both draw the same thing
    /// — a subject and the tree beneath it — and differ only in where they start. Hand
    /// unrolled, each stopped at whatever depth its author wrote out, which is how the
    /// portfolio came to end at root tasks.
    fn rebuild(&mut self) {
        let selected = self.selected().and_then(|r| r.subject.clone());
        let l = board::ledger_index(&self.audit);
        let tree = Tree {
            plan: &self.plan,
            ledger: &l,
            gates: &self.gates,
            collapsed: &self.collapsed,
            show_archived: self.archived_shown(),
        };
        let mut rows = Vec::new();

        match self.screen() {
            Screen::Home => {
                let projects: Vec<&Project> = if self.show_archived {
                    self.plan.all_projects().collect()
                } else {
                    self.plan.projects().collect()
                };
                // The four questions, then the shape of the plan — the order the
                // snapshot prints them in, and for the same reason. Skipped when there
                // is nothing at all, so an empty workspace still falls through to the
                // line saying how to start one rather than to four headings over none.
                if !projects.is_empty() {
                    tree.push_attention(&mut rows, &projects);
                    rows.push(caption("PORTFOLIO"));
                }
                for p in &projects {
                    tree.push_project(&mut rows, p, &self.known_repos);
                }
            }
            Screen::Project(id) => {
                if let Some(p) = self.plan.project(id) {
                    tree.push_project(&mut rows, p, &self.known_repos);
                }
            }
            // TASK is a page of the view's own words rather than a table: what a leaf
            // task actually holds — its runs, its spend, its report — is not rows, and
            // the tree it sits in is the screen it was opened from.
            Screen::Task(_) => {}
        }

        self.rows = rows;
        let restored = selected
            .and_then(|s| self.rows.iter().position(|r| r.subject.as_ref() == Some(&s)))
            .unwrap_or(0);
        self.table.select(if self.rows.is_empty() {
            None
        } else {
            Some(self.land_on(restored, true))
        });
    }

    fn selected(&self) -> Option<&RowItem> {
        self.rows.get(self.table.selected()?)
    }

    /// Whether filed-away rows are on screen: the `a` toggle, or a PROJECT screen whose
    /// project is itself archived.
    ///
    /// The second half is not a convenience. Filing a project away takes its work with
    /// it, so the group is one thing — and without this, opening one would land on a
    /// screen showing only the row it was opened from.
    fn archived_shown(&self) -> bool {
        self.show_archived
            || match self.screen() {
                Screen::Project(id) => self.plan.project(id).is_some_and(|p| p.archived),
                Screen::Home | Screen::Task(_) => false,
            }
    }

    /// How much is filed away, for the message the `a` key prints.
    fn archived_count(&self) -> usize {
        self.plan.archived_count() + self.plan.tasks().filter(|t| t.archived).count()
    }

    fn move_by(&mut self, delta: isize) {
        // A page of words has no selection to move, so the same keys move the page: `j`
        // is *next* on every screen, and what is next on a page is the line below.
        if matches!(self.screen(), Screen::Task(_)) {
            self.scroll = self
                .scroll
                .saturating_add_signed(if delta > 0 { 1 } else { -1 });
            return;
        }
        if self.rows.is_empty() {
            return;
        }
        // `checked_add_signed` keeps the whole thing in `usize`: moving up from the
        // first row underflows rather than wrapping, and lands on the first row.
        let cur = self.table.selected().unwrap_or(0);
        let last = self.rows.len().saturating_sub(1);
        let want = cur.checked_add_signed(delta).unwrap_or(0).min(last);
        self.table.select(Some(self.land_on(want, delta >= 0)));
    }

    /// The nearest row from `at` that points at something, searched the way the cursor
    /// was travelling and then back the other way. A caption is a row like any other to
    /// the table, and resting on one empties the detail pane and leaves enter with
    /// nothing to do — so the cursor steps over it.
    fn land_on(&self, at: usize, forward: bool) -> usize {
        let points = |i: &usize| self.rows.get(*i).is_some_and(|r| r.subject.is_some());
        let down = at..self.rows.len();
        let up = (0..=at).rev();
        if forward {
            down.chain(up).find(points)
        } else {
            up.chain(down).find(points)
        }
        .unwrap_or(at)
    }

    /// Opens the screen behind the selected row: a project's tree, a task's own page.
    ///
    /// Never refused. Every row has a screen behind it now — a leaf task used to answer
    /// `nothing below`, which was true of the tree and false of the question, since a
    /// leaf is exactly where the runs, the spend and the report are.
    fn descend(&mut self) {
        let screen = match self.selected().and_then(|r| r.subject.clone()) {
            Some(Subject::Project(id)) => Screen::Project(id),
            Some(Subject::Task(id)) => Screen::Task(id),
            None => return,
        };
        self.open(screen);
    }

    /// Pushes a screen and starts at the top of it.
    fn open(&mut self, screen: Screen) {
        // Opening something folded shut would land on a screen showing only what was
        // opened. Opening it *is* asking to see inside.
        if let Some(s) = screen.subject() {
            self.collapsed.remove(&s);
        }
        self.stack.push(screen);
        self.scroll = 0;
        self.rebuild();
        self.table.select(Some(self.land_on(0, true)));
    }

    /// Folds the selected row shut, or opens it again.
    fn toggle_fold(&mut self) {
        let Some(row) = self.selected() else { return };
        // A caption is a leaf as far as folding goes: there is nothing under either.
        let (Some(subject), Fold::Open | Fold::Shut) = (row.subject.clone(), row.fold) else {
            self.status = "leaf — nothing to fold".into();
            return;
        };
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

    /// Back to the screen this one was opened from, cursor on the row that opened it.
    ///
    /// Landing on that row rather than at the top is what makes the pair reversible:
    /// looking into three tasks off one HOME group is three `enter`s and three `esc`s,
    /// and a cursor that reset each time would make it three searches as well.
    fn back(&mut self) {
        if self.stack.len() < 2 {
            self.status = "HOME — q quits".into();
            return;
        }
        let gone = self.stack.pop().expect("checked just above");
        self.scroll = 0;
        self.rebuild();
        if let Some(s) = gone.subject()
            && let Some(i) = self.rows.iter().position(|r| r.subject.as_ref() == Some(&s))
        {
            self.table.select(Some(i));
        }
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
            KeyCode::Char('g') => self.table.select(Some(self.land_on(0, true))),
            KeyCode::Char('G') => {
                let last = self.rows.len().saturating_sub(1);
                self.table.select(Some(self.land_on(last, false)));
            }
            KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right => self.descend(),
            KeyCode::Esc | KeyCode::Backspace | KeyCode::Char('h') | KeyCode::Left => self.back(),
            KeyCode::Char(' ') => self.toggle_fold(),
            // Shut with `z`, open with `Z`, rather than one key that toggles: what a
            // toggle would do next depends on state the operator cannot see.
            KeyCode::Char('z') => self.fold_all(true),
            KeyCode::Char('Z') => self.fold_all(false),
            KeyCode::Char('a') => {
                self.show_archived = !self.show_archived;
                let n = self.archived_count();
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

/// Colour follows meaning, not decoration: green is finished, yellow is waiting on
/// a person, cyan is in flight.
fn status_style(row: &RowItem) -> Style {
    let base = Style::new();
    if row.is_project() {
        base.fg(Color::Cyan)
    } else if row.status.contains("done") {
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

/// The snapshot's spend cell without its padding, this table laying out its own columns.
/// Shortened by the same rule, so `1k` cannot mean two numbers on two boards.
fn spend_text(v: &Vitals) -> String {
    board::spend_cell(v.spent, v.budget).trim().to_string()
}

/// The needs-you cell, wearing its computed health as the colour of the words.
fn needs_span(v: &Vitals) -> Span<'static> {
    if v.needs.is_empty() {
        return Span::styled("—", Style::new().fg(Color::DarkGray));
    }
    let style = match v.health {
        Health::Red => Style::new().fg(Color::Red),
        Health::Amber => Style::new().fg(Color::Yellow),
        Health::Green => Style::new(),
    };
    Span::styled(v.needs.join(", "), style)
}

fn draw(f: &mut Frame, app: &mut App) {
    // The same header and footer on every screen, because the frame is the application
    // and only the middle of it is the screen. TASK is one page and takes the whole of
    // that middle; the other two are a table with the detail pane under it.
    let screen = app.screen().clone();
    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(6),
        Constraint::Length(if matches!(screen, Screen::Task(_)) { 0 } else { 7 }),
        Constraint::Length(1),
    ])
    .split(f.area());

    header(f, areas[0], app);
    if let Screen::Task(id) = &screen {
        page(f, areas[1], app, id);
    } else {
        table(f, areas[1], app);
        detail(f, areas[2], app);
    }
    footer(f, areas[3], app);

    if app.pane == Pane::Help {
        help(f, f.area());
    }
}

fn header(f: &mut Frame, area: Rect, app: &App) {
    let line = Line::from(vec![
        Span::styled(
            format!(" {} ", app.company.name),
            Style::new().add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("({}) ", app.company.profile),
            Style::new().fg(Color::DarkGray),
        ),
        Span::styled(app.screen().title(), Style::new().fg(Color::Cyan)),
        // Where `esc` goes, on the screens it goes anywhere from. A way out that is on
        // screen is the difference between a stack and a trap.
        Span::styled(
            if app.stack.len() > 1 { "  ← esc" } else { "" },
            Style::new().fg(Color::DarkGray),
        ),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

/// The TASK screen: one task in full, scrolled with the keys that move a cursor
/// elsewhere.
fn page(f: &mut Frame, area: Rect, app: &mut App, id: &TaskId) {
    let lines = crate::commands::view::task_lines(
        &app.store,
        &app.company,
        &app.plan,
        &app.audit,
        &app.gates,
        id,
    );
    // Never scrolled past its own end: a page that has run out reads exactly like a
    // cockpit that has hung, and nothing on it says a key would bring it back.
    let last = u16::try_from(lines.len()).unwrap_or(u16::MAX).saturating_sub(1);
    app.scroll = app.scroll.min(last);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(Color::DarkGray))
        .title(format!(" task {id} "));
    f.render_widget(
        Paragraph::new(lines).block(block).scroll((app.scroll, 0)),
        area,
    );
}

fn table(f: &mut Frame, area: Rect, app: &mut App) {
    let header = Row::new(vec!["#", "what", "status", "spend", "needs you"])
        .style(Style::new().fg(Color::DarkGray));

    let rows: Vec<Row> = app
        .rows
        .iter()
        .map(|r| {
            // A caption has no cells but its own words: a spend of `0` and a dash under
            // a heading are readings of nothing that read as though they were readings.
            let spend = r.vitals.as_ref().map_or_else(String::new, spend_text);
            let needs = match &r.vitals {
                None => Span::raw(""),
                Some(v) => needs_span(v),
            };
            // A project names itself in bold cyan; a task is plain and connected by
            // a tree glyph, so the two levels are distinguishable without reading.
            // The title is deliberately not here — at this width it truncated to
            // noise, and the detail pane already carries it in full.
            let what = if r.subject.is_none() {
                // Grey: a heading is a place on the screen, not a thing to act on.
                Line::from(r.label.clone().fg(Color::DarkGray))
            } else if r.is_project() {
                Line::from(Span::styled(
                    r.label.clone(),
                    Style::new().add_modifier(Modifier::BOLD).fg(Color::Cyan),
                ))
            } else {
                Line::from(Span::raw(r.label.clone()))
            };
            // Dim, because it is a handle rather than information: the operator reads
            // it only when they are about to type it somewhere else.
            let number = match r.number {
                Some(n) => Span::styled(n.to_string(), Style::new().fg(Color::DarkGray)),
                None => Span::raw(""),
            };
            Row::new(vec![
                Line::from(number),
                what,
                Line::from(Span::styled(r.status.clone(), status_style(r))),
                Line::from(spend),
                Line::from(needs),
            ])
        })
        .collect();

    let widths = [
        Constraint::Length(5),
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
    // A caption is not a subject: there is nothing to say about a heading, and the
    // cursor does not rest on one anyway.
    let lines = app.selected().and_then(|r| r.subject.as_ref()).map_or_else(
        Vec::new,
        |s| crate::commands::view::subject_lines(&app.plan, &app.audit, s),
    );
    f.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
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
    let h = 22u16.min(area.height.saturating_sub(2));
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
        Line::from("enter / l    open what the cursor is on".to_string()),
        Line::from("esc / ⌫ / h  back to the screen it came from".to_string()),
        Line::from("g / G        first / last".to_string()),
        Line::from("a            show or hide what is filed away".to_string()),
        Line::from("r            reload now".to_string()),
        Line::from("q            quit".to_string()),
        Line::from(""),
        Line::from("HOME → PROJECT → TASK, and esc all the way back".fg(Color::DarkGray)),
        Line::from("the four groups lead; the tree is under PORTFOLIO".fg(Color::DarkGray)),
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

/// Runs the cockpit until the operator quits, opening on `opening` or on HOME.
pub(crate) fn run(
    store: Store,
    company: Company,
    opening: Option<Screen>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, store, company, opening);
    ratatui::restore();
    result
}

fn event_loop(
    terminal: &mut DefaultTerminal,
    store: Store,
    company: Company,
    opening: Option<Screen>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(store, company, opening)?;

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
    use wecode_core::{Budget, Measure, Scope, Task, TaskStatus};

    use crate::board::status_word;

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
        app_on(name, None)
    }

    /// The same, started on a named screen — what `wecode tui <id>` does.
    fn app_on(name: &str, opening: Option<Screen>) -> App {
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

        App::new(store, company, opening).expect("app")
    }

    /// Opens a screen the way `enter` on its row would, without hunting for the row.
    fn go(a: &mut App, screen: Screen) {
        a.open(screen);
    }

    fn on(id: &str) -> Screen {
        Screen::Project(ProjectId::new(id))
    }

    fn onto(id: &str) -> Screen {
        Screen::Task(TaskId::new(id))
    }

    /// Puts the cursor on a subject's first row, the way `j` and `k` would. First,
    /// because a leaf is now on screen twice — once in the group asking about it, once
    /// in the tree — and the group row is the one the cockpit opens on.
    fn select(a: &mut App, subject: &Subject) {
        let pos = a
            .rows
            .iter()
            .position(|r| r.subject.as_ref() == Some(subject))
            .unwrap_or_else(|| panic!("no row for {subject:?}"));
        a.table.select(Some(pos));
    }

    fn project(id: &str) -> Subject {
        Subject::Project(ProjectId::new(id))
    }

    fn leaf(id: &str) -> Subject {
        Subject::Task(TaskId::new(id))
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

    /// Every heading the portfolio divides itself with, in the order it must draw them.
    const HEADS: [&str; 5] = ["NEEDS YOU", "MOVING", "NEXT", "LANDED", "PORTFOLIO"];

    /// Which row of a rendered frame names `needle`, so an assertion can say what is
    /// *above* what rather than only that both are somewhere on the screen.
    fn row_of(out: &str, needle: &str) -> usize {
        out.lines()
            .position(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("no `{needle}` in:\n{out}"))
    }

    /// The one rendered line naming `needle`.
    fn line_with<'a>(out: &'a str, needle: &str) -> &'a str {
        out.lines().nth(row_of(out, needle)).expect("the row")
    }

    /// Which row each heading is on. Matched at the start of its own cell rather than
    /// anywhere in the frame, so a cell that merely mentions a heading's word cannot
    /// report the tree as sitting above every group.
    fn heads(out: &str) -> Vec<usize> {
        let at = |h: &str| out.lines().position(|l| l.trim_start_matches(['│', ' ']).starts_with(h));
        HEADS
            .iter()
            .map(|h| at(h).unwrap_or_else(|| panic!("no `{h}` heading in:\n{out}")))
            .collect()
    }

    #[test]
    fn the_cockpit_opens_on_the_same_groups_the_snapshot_leads_with() {
        // The headline. `wecode board` answers *what is mine to do* before it answers
        // *how is this organised*, and a live cockpit that opened on the tree sent the
        // operator back to the snapshot to find out what needed them.
        let mut a = app("groups");
        let out = render(&mut a, 118, 30);
        let at = heads(&out);
        assert!(at.windows(2).all(|w| w[0] < w[1]), "out of order:\n{out}");
        // The tree survives, under the last of them — which is what makes the rows
        // above it a view rather than a preamble somebody scrolls past.
        assert!(row_of(&out, "PROJECT caching") > at[4], "above PORTFOLIO:\n{out}");
        assert!(out.contains("feat keys"), "and goes all the way down it:\n{out}");

        // PROJECT leaves them behind: the question there is how this one thing is put
        // together, which is why the snapshot's focus views are trees too.
        go(&mut a, on("caching"));
        let out = render(&mut a, 118, 30);
        for head in HEADS {
            assert!(!out.contains(head), "`{head}` on PROJECT:\n{out}");
        }
    }

    #[test]
    fn a_group_row_answers_the_question_its_own_group_asks() {
        // Why grouping is not sorting: `· draft` is a fact these rows share, and what
        // would move this one is the question the status word cannot answer.
        let mut a = app("group-rows");
        let out = render(&mut a, 118, 30);
        assert!(line_with(&out, "caching/keys").contains("unassigned"), "{out}");

        a.store
            .set_task_status(&TaskId::new("keys"), TaskStatus::NeedsApproval)
            .unwrap();
        a.reload();
        let out = render(&mut a, 118, 30);
        // And it leaves one group for another: a row in two of them is counted twice,
        // which is why these are four groups rather than four filters over one list.
        let at = heads(&out);
        let row = row_of(&out, "caching/keys");
        assert!(row > at[0] && row < at[1], "not in NEEDS YOU:\n{out}");
        assert!(line_with(&out, "caching/keys").contains("needs-approval"), "{out}");
    }

    #[test]
    fn a_group_shows_a_handful_and_says_how_many_it_stood_down() {
        // The ceiling the snapshot applies, applied here for the same reason: a group
        // that drew its whole tail would push the other three off the screen, which is
        // the failure leading with attention exists to fix.
        let mut a = app("ceiling");
        for n in 0..6 {
            let t = task(&format!("extra-{n}"), "another piece", &format!("src/extra-{n}/**"));
            a.store.save_task(&t).unwrap();
        }
        a.reload();
        let out = render(&mut a, 118, 40);
        assert!(out.contains("… and 2 more"), "seven leaves, five rows:\n{out}");
        // What it stood down is still reachable — the tree below drew all of them.
        assert!(out.contains("feat extra-5"), "{out}");
    }

    #[test]
    fn the_cursor_never_rests_on_a_heading() {
        // A heading points at nothing: stopping on one empties the detail pane and
        // leaves enter with nothing to do, which reads as a cockpit that has hung.
        let mut a = app("cursor");
        let points_at_something = |a: &App| {
            let row = a.selected().expect("a selection");
            assert!(row.subject.is_some(), "rested on `{}`", row.label);
        };
        assert_eq!(a.selected().unwrap().subject, Some(leaf("keys")), "opens on a row");
        for delta in [1, -1] {
            for _ in 0..a.rows.len() {
                a.move_by(delta);
                points_at_something(&a);
            }
        }
        for k in ['g', 'G'] {
            a.key(KeyEvent::from(KeyCode::Char(k)));
            points_at_something(&a);
        }
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
        assert!(out.contains("HOME"), "the screen names itself:\n{out}");
        assert!(out.contains("feat layer"), "{out}");
    }

    #[test]
    fn a_project_row_names_its_level_and_its_repo() {
        // Without these, nothing on screen says which row is the project or what
        // code it works on — the two things that actually confused a reader.
        let out = render(&mut app("level"), 118, 24);
        assert!(out.contains("PROJECT caching"), "{out}");
        assert!(out.contains("[main]"), "the repo belongs on the row:\n{out}");
    }

    #[test]
    fn tasks_hang_off_the_project_with_tree_glyphs() {
        let mut a = app("glyphs");
        go(&mut a, on("caching"));
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
            assert!(status_word(*s).len() <= 9, "{s:?} is too wide for the column");
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
        // Tall enough for the groups and the whole tree under them: the tree is what
        // this is about, and a row scrolled off the frame is not a row that is missing.
        let out = render(&mut a, 118, 30);
        for row in ["feat layer", "feat keys", "feat salt"] {
            assert!(out.contains(row), "missing `{row}` at L0:\n{out}");
        }
    }

    #[test]
    fn folding_a_row_hides_what_is_under_it_and_says_which_way_it_points() {
        let mut a = app("fold");
        // On the project, so this folds the whole tree away. Not the row the cockpit
        // opens on any more — that is the group row asking about the leaf.
        select(&mut a, &project("caching"));
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
        select(&mut a, &leaf("layer"));
        a.toggle_fold();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat layer"), "the row itself stays:\n{out}");
        assert!(!out.contains("feat keys"), "its subtask goes:\n{out}");
    }

    #[test]
    fn a_leaf_has_nothing_to_fold_and_is_told_so() {
        let mut a = app("fold-leaf");
        select(&mut a, &leaf("keys"));
        a.toggle_fold();
        assert!(a.status.contains("nothing to fold"), "{}", a.status);
        assert!(a.collapsed.is_empty(), "a leaf is not recorded as folded");
    }

    #[test]
    fn a_fold_survives_a_reload() {
        // Kept by subject, not by row index: a reload rebuilds every row, and a
        // fold that reopened itself every tick and a half would be unusable.
        let mut a = app("fold-reload");
        select(&mut a, &project("caching"));
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
        // The tree is one project row. The groups above it are not a branch of it and
        // do not fold — `keys` is still on screen, in the group that is asking about it.
        assert!(
            !a.rows.iter().any(|r| r.subject == Some(leaf("layer"))),
            "the tree is folded away"
        );
        // Leaves are never recorded: the set holds `caching` and `layer`, not `keys`.
        assert!(!a.collapsed.contains(&leaf("keys")));

        a.key(KeyEvent::from(KeyCode::Char('Z')));
        assert!(a.collapsed.is_empty());
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat keys"), "{out}");
    }

    #[test]
    fn descending_into_a_folded_row_opens_it_first() {
        // Otherwise zooming in lands on a screen showing only the thing zoomed into.
        let mut a = app("fold-descend");
        select(&mut a, &project("caching"));
        a.toggle_fold();
        a.descend();
        assert_eq!(a.screen(), &on("caching"));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat layer"), "{out}");
    }

    #[test]
    fn filing_a_task_away_takes_its_subtasks_off_the_cockpit() {
        let mut a = app("filed");
        a.store
            .set_task_archived(&TaskId::new("layer"), true)
            .unwrap();
        a.reload();
        let out = render(&mut a, 118, 24);
        assert!(!out.contains("feat layer"), "{out}");
        assert!(!out.contains("feat keys"), "the group goes together:\n{out}");
        // The project row is left, and reads as a leaf: the fold marker would otherwise
        // point at rows this view is not drawing.
        assert!(out.contains("PROJECT caching"), "{out}");
        assert!(!out.contains("▾ PROJECT caching"), "{out}");

        a.key(KeyEvent::from(KeyCode::Char('a')));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat layer  archived"), "{out}");
        assert!(out.contains("feat keys  archived"), "{out}");
        assert!(a.status.contains("showing 2 archived"), "{}", a.status);
    }

    #[test]
    fn a_filed_away_task_still_opens_when_it_is_named() {
        // Filing something away takes it off the lists; it does not put it out of
        // reach. Opening it is the way back in, and a screen that came up empty would
        // leave `a` as the only one — on a row `a` is needed to find in the first place.
        let mut a = app("filed-open");
        a.store
            .set_task_archived(&TaskId::new("layer"), true)
            .unwrap();
        a.reload();
        go(&mut a, onto("layer"));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("TASK layer"), "{out}");
        assert!(out.contains("write the cache layer"), "its own words:\n{out}");
    }

    #[test]
    fn the_header_names_the_company_and_the_footer_the_attention_budget() {
        let out = render(&mut app("header"), 110, 24);
        assert!(out.contains("My Project"), "{out}");
        assert!(out.contains("attention"), "{out}");
    }

    #[test]
    fn the_screens_chain_home_to_project_to_task_and_back() {
        // The headline. One application: every screen is a keystroke from the one
        // before it, and none of them is reachable only by quitting and starting again
        // with a different command.
        let mut a = app("chain");
        select(&mut a, &project("caching"));
        a.key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(a.screen(), &on("caching"));
        let out = render(&mut a, 110, 24);
        assert!(out.lines().next().is_some_and(|l| l.contains("PROJECT caching")), "{out}");
        assert!(out.contains("feat keys"), "subtask now visible:\n{out}");
        assert!(out.contains("needs you"), "{out}");

        select(&mut a, &leaf("keys"));
        a.key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(a.screen(), &onto("keys"));
        assert!(render(&mut a, 110, 24).contains("TASK keys"));

        for want in [on("caching"), Screen::Home] {
            a.key(KeyEvent::from(KeyCode::Backspace));
            assert_eq!(a.screen(), &want);
        }
    }

    #[test]
    fn esc_goes_back_the_way_the_operator_came() {
        // Not up the is-part-of chain. `keys` is opened here off a HOME group row, and
        // its parent `layer` is a screen the operator never saw — sending them there
        // would be somewhere they then have to find their own way out of.
        let mut a = app("back");
        select(&mut a, &leaf("keys"));
        a.descend();
        assert_eq!(a.screen(), &onto("keys"));
        a.back();
        assert_eq!(a.screen(), &Screen::Home, "not to `layer`, which was never open");
        // And on the row it was opened from, so three looks off one group is three
        // enters and three escs rather than three searches.
        assert_eq!(a.selected().unwrap().subject, Some(leaf("keys")));

        // HOME is the bottom of the stack: esc there is not a way out of the cockpit.
        a.back();
        assert_eq!(a.screen(), &Screen::Home);
        assert!(a.status.contains("q quits"), "{}", a.status);
        assert!(!a.quit);
    }

    #[test]
    fn enter_on_a_leaf_opens_it_rather_than_refusing() {
        // The gap this closes: a leaf answered `nothing below`, which was true of the
        // tree and false of the question — a leaf is exactly where the runs, the spend
        // and the report are, and the cockpit had nowhere to read them.
        let mut a = app("leaf-open");
        select(&mut a, &leaf("keys"));
        a.descend();
        assert_eq!(a.screen(), &onto("keys"));
        let out = render(&mut a, 110, 24);
        assert!(out.contains("design the cache keys"), "{out}");
        assert!(out.contains("in caching / layer"), "where it sits:\n{out}");
        assert!(out.contains("no runs yet"), "and what it has cost:\n{out}");
    }

    #[test]
    fn the_task_screen_says_what_each_attempt_cost_against_its_budget() {
        // The reading that had nowhere to live. The spend cell is one number for a
        // whole task; which try spent it, and whether that try went past what it was
        // given, is what somebody opens a task to find out.
        let mut a = app("runs");
        let id = TaskId::new("keys");
        let run = a.store.start_execution(&id, "s-test", None, None).unwrap();
        a.store
            .finish_execution(
                run,
                wecode_core::ExecutionStatus::Failed,
                "acceptance failed",
                wecode_store::execution::Spend {
                    tokens: Some(12_000),
                    replayed: None,
                },
            )
            .unwrap();
        go(&mut a, onto("keys"));
        let out = render(&mut a, 110, 30);
        assert!(out.contains("runs (1)"), "{out}");
        // Budgeted at 9000, so this try went past it — which is a fact about the pair
        // and unreadable from either number alone.
        assert!(out.contains("12k/9k"), "spend beside the budget:\n{out}");
        assert!(out.contains("acceptance failed"), "{out}");
    }

    #[test]
    fn j_and_k_scroll_the_task_page_the_way_they_move_a_cursor() {
        // A page has no selection to move, and a key that did nothing on one screen out
        // of three would be a key nobody trusts on the other two.
        let mut a = app("scroll");
        go(&mut a, onto("keys"));
        a.key(KeyEvent::from(KeyCode::Char('j')));
        assert_eq!(a.scroll, 1);
        a.key(KeyEvent::from(KeyCode::Char('k')));
        assert_eq!(a.scroll, 0);
        a.key(KeyEvent::from(KeyCode::Char('k')));
        assert_eq!(a.scroll, 0, "and stops at the top");
    }

    #[test]
    fn a_named_screen_is_where_it_opens_and_not_a_mode() {
        // `wecode tui <id>` is a starting point. HOME goes under it rather than
        // instead of it, so `esc` from a named screen behaves like `esc` anywhere else.
        let a = app("opening");
        assert_eq!(opening(&a.plan, "caching"), Ok(on("caching")));
        assert_eq!(opening(&a.plan, "keys"), Ok(onto("keys")));
        assert!(opening(&a.plan, "nope").is_err());

        let mut b = app_on("opening-on", Some(onto("keys")));
        assert_eq!(b.screen(), &onto("keys"));
        b.back();
        assert_eq!(b.screen(), &Screen::Home);
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
        // Not row zero any more: that is the `NEEDS YOU` heading. Clamping lands on
        // the first row there is anything to say about.
        assert_eq!(a.selected().unwrap().subject, Some(leaf("keys")));
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
        go(&mut a, on("caching"));
        select(&mut a, &leaf("keys"));
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
        select(&mut a, &leaf("bench"));
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
        select(&mut a, &leaf("bench"));
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
        let v = Vitals { health: Health::Green, spent: 1500, budget: Some(200_000), needs: vec![] };
        assert_eq!(spend_text(&v), "1k/200k");
        let no_budget = Vitals { budget: None, ..v };
        assert_eq!(spend_text(&no_budget), "1k");
    }
}
