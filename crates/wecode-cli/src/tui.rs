//! The cockpit: **one application whose screens call each other**. HOME is the whole
//! portfolio under the four attention groups; `enter` opens PROJECT, that project's task
//! tree to the leaves; `enter` again opens TASK, one task in full — what it waits on,
//! what it is doing, what each attempt cost, the report it landed, its incidents. The
//! chain is drawn out in `docs/reference/commands.md`.
//!
//! `enter` opens what the cursor is on and `esc` goes back to the row it was opened
//! from. No screen is reachable only by quitting and starting again with a different
//! command, and no screen is a flag: that is the whole of the difference between this
//! and three views that happen to share a renderer. Everything else — the fold set, the
//! archived toggle, the query, the selection — survives the move, because a screen is a
//! place in one application rather than a program of its own.
//!
//! Same four columns wherever there is a table — what · status · spend · needs-you.
//! Health is computed from ground truth (see [`crate::board`]), never reported by an
//! agent; it is the colour of the needs-you cell rather than a column, every cause of
//! amber or red already writing an entry there.
//!
//! HOME **opens on the same four attention groups the snapshot leads with**, drawn from
//! [`board::attention_groups`] where `wecode board` gets its own — so a cockpit left
//! open on a desk and a snapshot read on a phone cannot disagree about what needs
//! somebody. The tree under them is the whole one, subtasks and their subtasks
//! included, and a row with work beneath it folds shut: what is not on screen is what
//! the operator put away, never what the view decided to omit.
//!
//! Reloads from the store on a tick, so it tracks state as it changes.
//!
//! An **instrument** rather than a display: `/` narrows the screen to what answers a
//! question, `:` asks it of the whole workspace and opens what it finds, the pane under
//! the table previews the screen `enter` would open, and `t` turns that pane into the
//! ledger as it is written — reaching one row out of a plan too long to read, or
//! reading it without leaving where you are.

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
use wecode_store::{AuditLine, AuditQuery, Store, now_secs};

use crate::board::{self, Health, Vitals};
use crate::commands::view::{self, Fold, RowItem, Subject, Tree, caption};

/// How often to re-read the store.
const RELOAD: Duration = Duration::from_millis(1500);
/// How long to block waiting for a keypress before redrawing.
const POLL: Duration = Duration::from_millis(200);
/// The pane under the table: a rail to glance at, and what `p` gives it to be read.
const ASIDE: (u16, u16) = (7, 16);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pane {
    Board,
    Help,
    /// The query line has the keys: every character narrows what is on screen.
    Query,
}

/// What the pane under the table is showing: the screen `enter` would open, as far down
/// as the pane is tall, or the ledger as it is written.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Aside {
    Preview,
    Tail,
}

/// Which screen is on the glass. Named rather than numbered: `L2` says how deep somebody
/// has gone, which is not what they need to know; `TASK cache-keys` says what they see.
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
    /// The screens the operator has open, HOME at the bottom and never empty. A stack
    /// because `esc` means *back*, not *up*: a task opened from a HOME group row belongs
    /// to a project they never visited, and walking them up the is-part-of chain would
    /// leave them somewhere they then have to find their own way out of.
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
    /// Rows whose children are folded away. Empty to begin with: the tree is what there
    /// is to see, and a view that starts by hiding most of it is the gap this closed.
    /// Kept by subject, so it survives a reload that moves every row.
    collapsed: HashSet<Subject>,
    /// What the query line holds. Empty is no narrowing: a filter nobody typed is not a
    /// filter that happens to match everything.
    query: String,
    aside: Aside,
    /// Whether the pane under the table has room to be read rather than glanced at.
    tall: bool,
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
            query: String::new(),
            aside: Aside::Preview,
            tall: false,
            status: "j/k move · / filter · : go to · enter open · ? help · q quit".into(),
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
                // Skipped under a query too: the groups are the same leaves read a
                // second way, so a narrowed HOME would answer with one task twice.
                if !projects.is_empty() && self.query.is_empty() {
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
            // task holds — its runs, its spend, its report — is not rows.
            Screen::Task(_) => {}
        }
        // What a query leaves behind is what answers it — captions included, a heading
        // over nothing reading as an empty group rather than as a narrowed one.
        if !self.query.is_empty() {
            let q = self.query.to_lowercase();
            rows.retain(|r| r.subject.as_ref().is_some_and(|s| self.answers(s, r, &q)));
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

    /// Whether a row answers the query: its words, its status, what it says it wants —
    /// and the title it was written down with, which is what a person remembers a task
    /// by and the one thing these columns have no room for. Matched anywhere and without
    /// case, never as a pattern: `appr` is a question, not a glob.
    fn answers(&self, s: &Subject, r: &RowItem, q: &str) -> bool {
        let written = match s {
            Subject::Project(id) => self.plan.project(id).map(|p| p.objective.clone()),
            Subject::Task(id) => self.plan.task(id).map(|t| t.title.clone()),
        };
        let needs = r.vitals.as_ref().map_or_else(String::new, |v| v.needs.join(" "));
        format!("{} {} {needs} {}", r.label, r.status, written.unwrap_or_default())
            .to_lowercase()
            .contains(q)
    }

    fn selected(&self) -> Option<&RowItem> {
        self.rows.get(self.table.selected()?)
    }

    /// Everything wecode holds about one task: the TASK screen, and what the pane under
    /// the table previews as much of as it is tall.
    fn task_lines(&self, id: &TaskId) -> Vec<Line<'static>> {
        view::task_lines(
            &self.store,
            &self.company,
            &self.plan,
            &self.audit,
            &self.gates,
            id,
        )
    }

    /// The query line as the header prints it: what has been typed, and a bar while the
    /// keys still go there.
    fn prompt(&self) -> String {
        if self.query.is_empty() && self.pane != Pane::Query {
            return String::new();
        }
        format!(
            "  /{}{}",
            self.query,
            if self.pane == Pane::Query { "▏" } else { "" }
        )
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
    /// the table, and resting on one empties the pane below and leaves enter with
    /// nothing to do.
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
    /// Never refused — a leaf used to answer `nothing below`, which was true of the tree
    /// and false of the question, a leaf being where the runs and the report are.
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
        // A jump has landed, so the query that found it has done its work: leaving it on
        // would narrow the screen it just opened to the words that opened it.
        self.query.clear();
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

    /// Folds everything, or opens everything: the way back from a plan whose tree is
    /// longer than the screen, in one keystroke rather than one per project.
    ///
    /// "Everything" is every subject with children anywhere in the plan, not only the
    /// rows drawn: folding what is visible and leaving the rest open means the next
    /// descent lands somewhere the operator did not ask for.
    fn fold_all(&mut self, shut: bool) {
        self.collapsed.clear();
        if shut {
            // Only what has something to hide: a leaf recorded as folded is invisible
            // today and wrong the moment somebody hangs a subtask off it.
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

    /// Back to the screen this one was opened from, cursor on the row that opened it —
    /// which is what makes the pair reversible: looking into three tasks off one HOME
    /// group is three `enter`s and three `esc`s, not three searches.
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

    /// Opens the query line over whatever is on the glass.
    ///
    /// The palette is this same narrowing asked from HOME, which is why `:` pushes one
    /// first: HOME is where every project and every task has a row, so *go to anything
    /// from anywhere* needs no second search and no second list.
    fn ask(&mut self) {
        self.pane = Pane::Query;
        self.query.clear();
        self.status = "type to narrow · enter opens · esc clears".into();
        self.rebuild();
    }

    /// A keystroke while the query line is open. Every one of them rebuilds, which is
    /// what makes the narrowing live rather than something that happens on `enter`.
    fn typing(&mut self, k: KeyEvent) {
        match k.code {
            // A cancelled search is not a filter: esc leaves the screen as it found it.
            KeyCode::Esc => {
                self.query.clear();
                self.pane = Pane::Board;
            }
            // Enter means what it means everywhere else — open what the cursor is on,
            // which is what makes a narrowed list a way somewhere rather than a view.
            KeyCode::Enter => {
                self.pane = Pane::Board;
                self.descend();
            }
            KeyCode::Backspace => {
                self.query.pop();
            }
            KeyCode::Char(c) => self.query.push(c),
            // The letters are spoken for while this is open, so the arrows are what move
            // the cursor onto whatever the typing has left.
            KeyCode::Down => self.move_by(1),
            KeyCode::Up => self.move_by(-1),
            _ => {}
        }
        self.rebuild();
    }

    fn key(&mut self, k: KeyEvent) {
        if self.pane == Pane::Help {
            self.pane = Pane::Board;
            return;
        }
        if self.pane == Pane::Query {
            self.typing(k);
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
                // How much is filed away, for the message this prints.
                let n = self.plan.archived_count()
                    + self.plan.tasks().filter(|t| t.archived).count();
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
            KeyCode::Char('/') if !matches!(self.screen(), Screen::Task(_)) => self.ask(),
            // TASK is a page with no rows to narrow, so the only search that means
            // anything there is the one `:` asks anyway.
            KeyCode::Char('/' | ':') => {
                self.stack.push(Screen::Home);
                self.ask();
            }
            KeyCode::Char('t') => {
                self.aside = if self.aside == Aside::Tail {
                    Aside::Preview
                } else {
                    Aside::Tail
                };
            }
            KeyCode::Char('p') => self.tall = !self.tall,
            KeyCode::Char('?') => self.pane = Pane::Help,
            _ => {}
        }
    }
}

/// Colour follows meaning, not decoration: green is finished, yellow is waiting on
/// a person, cyan is in flight.
fn status_style(row: &RowItem) -> Style {
    let s = &row.status;
    let has = |w: &str| s.contains(w);
    Style::new().fg(if row.is_project() || has("running") || has("verifying") {
        Color::Cyan
    } else if has("done") {
        Color::Green
    } else if has("approval") || has("input") || has("failed") {
        Color::Yellow
    } else {
        Color::DarkGray
    })
}

/// The snapshot's spend cell without its padding, this table laying out its own columns.
/// Shortened by the same rule, so `1k` cannot mean two numbers on two boards.
fn spend_text(v: &Vitals) -> String {
    board::spend_cell(v.spent, v.budget).trim().to_string()
}

/// The needs-you cell, wearing its computed health as the colour of the words.
fn needs_span(v: &Vitals) -> Span<'static> {
    match v.health {
        _ if v.needs.is_empty() => Span::styled("—", Style::new().fg(Color::DarkGray)),
        Health::Red => Span::styled(v.needs.join(", "), Style::new().fg(Color::Red)),
        Health::Amber => Span::styled(v.needs.join(", "), Style::new().fg(Color::Yellow)),
        Health::Green => Span::raw(v.needs.join(", ")),
    }
}

fn draw(f: &mut Frame, app: &mut App) {
    // The same header and footer on every screen, because the frame is the application
    // and only the middle of it is the screen. TASK is one page and takes the whole of
    // that middle; the other two are a table with the detail pane under it.
    let screen = app.screen().clone();
    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(6),
        Constraint::Length(match (&screen, app.tall) {
            (Screen::Task(_), _) => 0,
            (_, true) => ASIDE.1,
            (_, false) => ASIDE.0,
        }),
        Constraint::Length(1),
    ])
    .split(f.area());

    header(f, areas[0], app);
    if let Screen::Task(id) = &screen {
        page(f, areas[1], app, id);
    } else {
        table(f, areas[1], app);
        aside(f, areas[2], app);
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
        // The query, while it is being typed and for as long as it holds: a narrowing
        // nobody can see is a cockpit that has quietly lost rows.
        Span::styled(app.prompt(), Style::new().fg(Color::Yellow)),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

/// The TASK screen: one task in full, scrolled with the keys that move a cursor
/// elsewhere.
fn page(f: &mut Frame, area: Rect, app: &mut App, id: &TaskId) {
    let lines = app.task_lines(id);
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
            // A caption has no cells but its own words: a spend of `0` under a heading
            // is a reading of nothing that reads as though it were a reading.
            let spend = r.vitals.as_ref().map_or_else(String::new, spend_text);
            let needs = r.vitals.as_ref().map_or_else(|| Span::raw(""), needs_span);
            // A project names itself in bold cyan; a task is plain and connected by a
            // tree glyph, so the two levels are told apart without reading. The title is
            // deliberately not here — at this width it truncated to noise, and the pane
            // below carries it in full.
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
        // An empty screen has two causes, one of them the operator's own doing: saying
        // how to start a workspace to somebody who has just mistyped a filter is what
        // makes a narrowing look like a crash.
        f.render_widget(
            Paragraph::new(if app.query.is_empty() {
                "no projects yet — wecode project add <id> --repo <name> \"<objective>\"".into()
            } else {
                format!("nothing here answers `{}` — esc clears it", app.query)
            })
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

/// The pane under the table: a preview of the screen `enter` would open, or the ledger
/// as it is written. Both are readings of the selection, so `t` swaps them in place
/// rather than adding a pane the table would have to give its rows up for.
///
/// The preview of a task is the TASK screen itself, cut off wherever the pane ends — the
/// same words rather than a summary of them, so descending reads *further*. `p` gives it
/// room when what is in it is worth more than another five rows. A caption previews
/// nothing: there is no subject behind a heading, and the cursor does not rest on one.
fn aside(f: &mut Frame, area: Rect, app: &App) {
    let subject = app.selected().and_then(|r| r.subject.clone());
    let (title, lines) = match (app.aside, &subject) {
        (Aside::Tail, _) => (" tail ", tail(app, subject.as_ref(), area.height)),
        (_, Some(Subject::Task(id))) => (" preview ", app.task_lines(id)),
        (_, Some(s)) => (" preview ", view::subject_lines(&app.plan, &app.audit, s)),
        (_, None) => (" preview ", Vec::new()),
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(Color::DarkGray))
        .title(title);
    f.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
}

/// The ledger's newest lines about whatever the cursor is on, oldest first — the way a
/// log reads, and the reload tick is what makes it a tail rather than a snapshot.
fn tail(app: &App, subject: Option<&Subject>, height: u16) -> Vec<Line<'static>> {
    let (project, task) = match subject {
        Some(Subject::Project(id)) => (id.as_str(), ""),
        Some(Subject::Task(id)) => ("", id.as_str()),
        None => ("", ""),
    };
    let now = now_secs();
    // Coloured whole: an ordinary act is dim because the eye is here for the one that
    // is not, and a refusal or an alarm is the reading this pane exists to carry.
    let mut lines: Vec<Line<'static>> =
        board::newest(&app.audit, project, task, height.saturating_sub(2) as usize)
            .iter()
            .map(|l| {
                let words = format!(
                    "{:>4}  {} {} {}",
                    board::ago(now.saturating_sub(l.at)),
                    l.post,
                    l.action,
                    l.target
                );
                Line::from(if l.is_alarm() {
                    words.fg(Color::Red)
                } else if l.is_denial() {
                    words.fg(Color::Yellow)
                } else {
                    words.fg(Color::DarkGray)
                })
            })
            .collect();
    lines.reverse();
    if lines.is_empty() {
        lines.push(Line::from("nothing recorded here yet".fg(Color::DarkGray)));
    }
    lines
}

fn footer(f: &mut Frame, area: Rect, app: &App) {
    let a = &app.company.attention;
    let line = format!(
        " {} attention {} items · {}/h · digest {}m",
        app.status, a.max_open_items, a.max_interrupts_per_hour, a.digest_interval_mins
    );
    f.render_widget(Paragraph::new(Line::from(line.fg(Color::DarkGray))), area);
}

fn help(f: &mut Frame, area: Rect) {
    let w = 54u16.min(area.width.saturating_sub(4));
    let h = 24u16.min(area.height.saturating_sub(2));
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
        Line::from("/            narrow this screen to what answers".to_string()),
        Line::from(":            go to anything, from anywhere".to_string()),
        Line::from("t            preview, or the ledger as it is written".to_string()),
        Line::from("p            room to read the pane, or a rail".to_string()),
        Line::from("a            show or hide what is filed away".to_string()),
        Line::from("r            reload now".to_string()),
        Line::from("q            quit".to_string()),
        Line::from(""),
        Line::from("HOME → PROJECT → TASK, and esc all the way back".fg(Color::DarkGray)),
        Line::from("the four groups lead; the tree is under PORTFOLIO".fg(Color::DarkGray)),
        Line::from("▾ open  ▸ folded shut  · the whole tree is drawn".fg(Color::DarkGray)),
        Line::from("declared  · draft ⋯ waiting ○ ready > running".fg(Color::DarkGray)),
        Line::from("          ? verifying ! approval ✓ done x failed".fg(Color::DarkGray)),
        Line::from("computed  red = alarm or over budget · amber =".fg(Color::DarkGray)),
        Line::from("          defects, denials, stalled, waiting on you".fg(Color::DarkGray)),
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
    use wecode_gov::{Action, Decision, Record, Source};

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

    /// A cockpit over its own store: in memory, and one per test, since they run in
    /// parallel and shared state means one test wipes another's mid-write.
    fn app() -> App {
        app_on(None)
    }

    /// The same, started on a named screen — what `wecode tui <id>` does.
    fn app_on(opening: Option<Screen>) -> App {
        let store = Store::in_memory().expect("store");
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

    /// One ledger line, in the shape the Broker writes them. The tail reads what a real
    /// run leaves behind, so a fixture that pushed rows straight at the pane would prove
    /// nothing about what an operator would see while an agent works.
    fn acted(task: &str, action: Action) -> Record {
        Record {
            seq: 1,
            session: "s-test".into(),
            post: "impl".into(),
            occupant: "claude-code".into(),
            human: Some("you".into()),
            project: Some("caching".into()),
            task: Some(task.into()),
            action,
            decision: Decision::Allow,
            source: Source::Broker,
        }
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
        // The headline. `wecode board` answers *what is mine to do* before *how is this
        // organised*, and a cockpit that opened on the tree sent the operator back to
        // the snapshot to find out what needed them.
        let mut a = app();
        let out = render(&mut a, 118, 30);
        let at = heads(&out);
        assert!(at.windows(2).all(|w| w[0] < w[1]), "out of order:\n{out}");
        // The tree survives under the last of them, which is what makes the rows above
        // it a view rather than a preamble somebody scrolls past.
        assert!(row_of(&out, "PROJECT caching") > at[4], "above PORTFOLIO:\n{out}");
        assert!(out.contains("feat keys"), "and goes all the way down it:\n{out}");

        // PROJECT leaves them behind: the question there is how one thing is put
        // together, which is why the snapshot's focus views are trees too.
        a.open(on("caching"));
        let out = render(&mut a, 118, 30);
        for head in HEADS {
            assert!(!out.contains(head), "`{head}` on PROJECT:\n{out}");
        }
    }

    #[test]
    fn the_cursor_never_rests_on_a_heading_and_clamps_at_both_ends() {
        // A heading points at nothing: stopping on one empties the pane under the table
        // and leaves enter with nothing to do, which reads as a cockpit that has hung.
        let mut a = app();
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
        // Past either end is the end, and the selection is held by subject, so the
        // reload every tick and a half does not walk it.
        a.move_by(-5);
        assert_eq!(a.selected().unwrap().subject, Some(leaf("keys")));
        a.move_by(100);
        assert_eq!(a.table.selected(), Some(a.rows.len() - 1));
        let before = a.selected().unwrap().subject.clone();
        a.reload();
        assert_eq!(a.selected().unwrap().subject, before);
    }

    #[test]
    fn a_group_row_answers_the_question_its_own_group_asks() {
        // Why grouping is not sorting: `· draft` is a fact these rows share, and what
        // would move this one is the question the status word cannot answer.
        let mut a = app();
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

        // A group shows a handful and says how many it stood down: one that drew its
        // whole tail would push the other three off the screen, which is the failure
        // leading with attention exists to fix. What it stood down is still in the tree.
        for n in 0..6 {
            let t = task(&format!("extra-{n}"), "another piece", &format!("src/extra-{n}/**"));
            a.store.save_task(&t).unwrap();
        }
        a.reload();
        let out = render(&mut a, 118, 40);
        assert!(out.contains("… and 1 more"), "six waiting, five rows:\n{out}");
        assert!(out.contains("feat extra-5"), "{out}");
    }

    #[test]
    fn the_frame_says_whose_workspace_this_is_and_draws_the_tree_whole() {
        // The four columns, the two dropped for only ever repeating them, and the words
        // around the table — which screen, whose company, which row is the project and
        // what code it works on. Then the tree all the way down: it stopped at root
        // tasks, and the work actually being done is usually a leaf.
        //
        // `salt` sorts after `keys` on purpose: the store loads non-root tasks in id
        // order, so a grandchild whose id sorts before its parent's cannot be read back.
        // That is a gap in `wecode-store`, recorded in features.md.
        let mut a = app();
        a.store
            .save_task(&task("salt", "pick the salt", "crates/cache/salt.rs").under("keys"))
            .unwrap();
        a.reload();
        // Tall enough for the groups and the whole tree under them.
        let out = render(&mut a, 118, 30);
        for shown in [
            "what", "status", "spend", "needs you", "HOME", "My Project", "attention",
            "PROJECT caching", "[main]", "feat layer", "feat keys", "feat salt", "· draft",
        ] {
            assert!(out.contains(shown), "missing `{shown}` in:\n{out}");
        }
        for gone in ["health", "progress"] {
            assert!(!out.contains(gone), "`{gone}` should be gone from:\n{out}");
        }

        // Each row says what it hangs off, and a declared status nobody could read off
        // a row before — a draft, a waiting and a ready task all rendered identically.
        a.store
            .set_task_status(&TaskId::new("layer"), TaskStatus::Done)
            .unwrap();
        a.reload();
        a.open(on("caching"));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("✓ done"), "{out}");
        assert!(out.contains("└─ ▾ feat layer"), "last root, work under it:\n{out}");
        assert!(out.contains("   └─ ▾ feat keys"), "the subtask nests deeper:\n{out}");
        assert!(out.contains("      └─   feat salt"), "and the leaf deeper still:\n{out}");
    }

    #[test]
    fn folding_a_row_hides_what_is_under_it_and_survives_a_reload() {
        // On the project, so this folds the whole tree away.
        let mut a = app();
        select(&mut a, &project("caching"));
        a.toggle_fold();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("▸ PROJECT caching"), "marker flips:\n{out}");
        assert!(!out.contains("feat layer"), "root task is away:\n{out}");

        // Kept by subject, not by row index: a fold that reopened itself every tick and
        // a half would be unusable.
        a.reload();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("▸ PROJECT caching"), "{out}");
        assert!(!out.contains("feat layer"), "{out}");

        a.toggle_fold();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("▾ PROJECT caching"), "{out}");
        assert!(out.contains("feat keys"), "and all of it is back:\n{out}");

        // A task folds the same way, keeping its own row; a leaf is told it has nothing.
        select(&mut a, &leaf("layer"));
        a.toggle_fold();
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat layer"), "the row itself stays:\n{out}");
        assert!(!out.contains("feat keys"), "its subtask goes:\n{out}");

        select(&mut a, &leaf("keys"));
        a.toggle_fold();
        assert!(a.status.contains("nothing to fold"), "{}", a.status);
        assert!(!a.collapsed.contains(&leaf("keys")), "a leaf is not folded");

        // `z` folds the whole plan and `Z` opens it. The groups above the tree are not a
        // branch of it and do not fold, and a leaf is never recorded as folded — the set
        // holds `caching` and `layer`, not `keys`.
        a.key(KeyEvent::from(KeyCode::Char('z')));
        assert!(
            !a.rows.iter().any(|r| r.subject == Some(leaf("layer"))),
            "the tree is folded away"
        );
        assert!(!a.collapsed.contains(&leaf("keys")));
        a.key(KeyEvent::from(KeyCode::Char('Z')));
        assert!(a.collapsed.is_empty());
        assert!(render(&mut a, 118, 24).contains("feat keys"));

        // And descending into something folded opens it on the way: otherwise zooming
        // in lands on a screen showing only the row that was zoomed into.
        a.key(KeyEvent::from(KeyCode::Char('z')));
        select(&mut a, &project("caching"));
        a.descend();
        assert_eq!(a.screen(), &on("caching"));
        assert!(render(&mut a, 118, 24).contains("feat layer"));
    }

    #[test]
    fn filing_a_task_away_takes_its_subtasks_off_the_cockpit() {
        let mut a = app();
        a.store
            .set_task_archived(&TaskId::new("layer"), true)
            .unwrap();
        a.reload();
        let out = render(&mut a, 118, 24);
        assert!(!out.contains("feat layer"), "{out}");
        assert!(!out.contains("feat keys"), "the group goes together:\n{out}");
        // The project row is left, reading as a leaf: a fold marker would otherwise
        // point at rows this view is not drawing.
        assert!(out.contains("PROJECT caching"), "{out}");
        assert!(!out.contains("▾ PROJECT caching"), "{out}");

        a.key(KeyEvent::from(KeyCode::Char('a')));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat layer  archived"), "{out}");
        assert!(out.contains("feat keys  archived"), "{out}");
        assert!(a.status.contains("showing 2 archived"), "{}", a.status);

        // Filing takes something off the lists; it does not put it out of reach. Opening
        // it is the way back in, and a screen that came up empty would leave `a` as the
        // only one — on a row `a` is needed to find in the first place.
        a.key(KeyEvent::from(KeyCode::Char('a')));
        a.open(onto("layer"));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("TASK layer"), "{out}");
        assert!(out.contains("write the cache layer"), "its own words:\n{out}");
    }

    #[test]
    fn the_screens_chain_home_to_project_to_task_and_esc_retraces_it() {
        // The headline. One application: every screen is a keystroke from the one
        // before it, and none of them is reachable only by quitting and starting again
        // with a different command.
        let mut a = app();
        select(&mut a, &project("caching"));
        a.key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(a.screen(), &on("caching"));
        let out = render(&mut a, 110, 24);
        assert!(out.lines().next().is_some_and(|l| l.contains("PROJECT caching")), "{out}");
        assert!(out.contains("feat keys"), "subtask now visible:\n{out}");
        assert!(out.contains("needs you"), "{out}");

        // A leaf opens too, rather than answering `nothing below` — true of the tree and
        // false of the question, a leaf being where the runs and the report are.
        select(&mut a, &leaf("keys"));
        a.key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(a.screen(), &onto("keys"));
        let out = render(&mut a, 110, 24);
        assert!(out.contains("TASK keys"), "{out}");
        assert!(out.contains("design the cache keys"), "{out}");
        assert!(out.contains("in caching / layer"), "where it sits:\n{out}");
        assert!(out.contains("no runs yet"), "and what it has cost:\n{out}");

        // Back the way it came, never up the is-part-of chain: `layer` is this task's
        // parent and a screen the operator never saw. And onto the row it was opened
        // from, so three looks off one group row is three enters and three escs.
        for want in [on("caching"), Screen::Home] {
            a.key(KeyEvent::from(KeyCode::Backspace));
            assert_eq!(a.screen(), &want);
        }
        assert_eq!(a.selected().unwrap().subject, Some(project("caching")));

        // HOME is the bottom of the stack: esc there is not a way out of the cockpit.
        a.back();
        assert_eq!(a.screen(), &Screen::Home);
        assert!(a.status.contains("q quits"), "{}", a.status);

        // `wecode tui <id>` is a starting point rather than a mode: HOME goes under what
        // it names, so `esc` from there behaves as it does anywhere else.
        assert_eq!(opening(&a.plan, "caching"), Ok(on("caching")));
        assert_eq!(opening(&a.plan, "keys"), Ok(onto("keys")));
        assert!(opening(&a.plan, "nope").is_err());
        let mut b = app_on(Some(onto("keys")));
        assert_eq!(b.screen(), &onto("keys"));
        b.back();
        assert_eq!(b.screen(), &Screen::Home);

        a.key(KeyEvent::from(KeyCode::Char('?')));
        assert!(a.pane == Pane::Help);
        a.key(KeyEvent::from(KeyCode::Char('j')));
        assert!(a.pane == Pane::Board, "any key closes help");
        assert!(!a.quit);
        a.key(KeyEvent::from(KeyCode::Char('q')));
        assert!(a.quit);
    }

    #[test]
    fn the_task_screen_says_what_each_attempt_cost_against_its_budget() {
        // The spend cell is one number for a whole task; which try spent it, and whether
        // that try went past what it was given, is what somebody opens a task to find.
        let mut a = app();
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
        a.open(onto("keys"));
        let out = render(&mut a, 110, 30);
        assert!(out.contains("runs (1)"), "{out}");
        // Budgeted at 9000, so this try went past it — a fact about the pair, and
        // unreadable from either number alone.
        assert!(out.contains("12k/9k"), "spend beside the budget:\n{out}");
        assert!(out.contains("acceptance failed"), "{out}");

        // A page has no selection to move, so the keys that move one scroll it: a key
        // that did nothing on one screen of three is a key nobody trusts on the others.
        a.key(KeyEvent::from(KeyCode::Char('j')));
        assert_eq!(a.scroll, 1);
        a.key(KeyEvent::from(KeyCode::Char('k')));
        assert_eq!(a.scroll, 0);
        a.key(KeyEvent::from(KeyCode::Char('k')));
        assert_eq!(a.scroll, 0, "and stops at the top");
    }

    #[test]
    fn the_query_line_narrows_this_screen_and_reaches_the_whole_workspace() {
        // A plan longer than the screen is not read by scrolling it, and what somebody
        // remembers about a task is its words rather than where it was filed — so the
        // query is matched against the title too, which these columns have no room for.
        let mut a = app();
        for k in ['/', 'l', 'a', 'y'] {
            a.key(KeyEvent::from(KeyCode::Char(k)));
        }
        assert_eq!(a.query, "lay");
        let out = render(&mut a, 118, 24);
        assert!(out.contains("/lay"), "the narrowing is on screen:\n{out}");
        assert!(out.contains("feat layer"), "{out}");
        assert!(!out.contains("feat keys"), "what does not answer is not:\n{out}");
        // The groups stand down under a query: they are the same leaves read a second
        // way, so a narrowed HOME would answer with one task twice.
        for head in HEADS.iter().take(4) {
            assert!(!out.contains(head), "`{head}` under a query:\n{out}");
        }

        a.key(KeyEvent::from(KeyCode::Esc));
        for k in ['/', 'c', 'a', 'c', 'h', 'e', ' ', 'k'] {
            a.key(KeyEvent::from(KeyCode::Char(k)));
        }
        let out = render(&mut a, 118, 24);
        assert!(out.contains("feat keys"), "matched on its title:\n{out}");
        assert!(!out.contains("feat layer"), "{out}");

        // A query nothing answers says so; the line about starting a workspace, read by
        // somebody who has just mistyped a filter, is a cockpit that has lost the plan.
        // Esc puts the screen back as it found it.
        a.key(KeyEvent::from(KeyCode::Char('z')));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("nothing here answers"), "{out}");
        assert!(!out.contains("no projects yet"), "{out}");
        a.key(KeyEvent::from(KeyCode::Esc));
        assert!(a.query.is_empty());
        assert!(render(&mut a, 118, 24).contains("NEEDS YOU"));

        // `:` is that same narrowing asked from HOME, where every project and every task
        // has a row — so *go to anything from anywhere* needs no second list. The HOME it
        // pushes is a screen like any other, so `esc` walks back out through it.
        a.open(onto("layer"));
        // `/` on a page has no rows to narrow, so it asks the same question `:` does.
        a.key(KeyEvent::from(KeyCode::Char('/')));
        for k in ['k', 'e', 'y'] {
            a.key(KeyEvent::from(KeyCode::Char(k)));
        }
        assert_eq!(a.selected().unwrap().subject, Some(leaf("keys")));
        a.key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(a.screen(), &onto("keys"), "enter opens what it found");
        // Left on, the query would narrow the very screen it opened.
        assert!(a.query.is_empty(), "{}", a.query);
        for want in [Screen::Home, onto("layer")] {
            a.back();
            assert_eq!(a.screen(), &want);
        }
    }

    #[test]
    fn the_pane_previews_what_enter_would_open_or_tails_the_ledger() {
        // The gap this closes: the pane said four lines about the selection while the
        // screen one keystroke away said everything, so reading a task meant leaving the
        // list of them. It is the TASK page now, cut off where the pane ends.
        let mut a = app();
        a.open(on("caching"));
        select(&mut a, &leaf("keys"));
        let out = render(&mut a, 110, 24);
        assert!(out.contains(" preview "), "the pane names itself:\n{out}");
        assert!(out.contains("in caching / layer"), "where it sits:\n{out}");
        assert!(!out.contains("no incidents"), "the rail ends here:\n{out}");

        // `p` gives it the room to be read where it stands — the difference between a
        // rail somebody glances at and a pane they work from.
        a.key(KeyEvent::from(KeyCode::Char('p')));
        let out = render(&mut a, 110, 24);
        assert!(out.contains("no runs yet"), "what it has cost:\n{out}");
        assert!(out.contains("no incidents"), "and what it tripped:\n{out}");
        // A prerequisite no tick will release reads differently from one that is met.
        a.store
            .save_task(&task("bench", "benchmark the cache", "benches/**").after("layer"))
            .unwrap();
        a.reload();
        select(&mut a, &leaf("bench"));
        assert!(render(&mut a, 110, 24).contains("waiting on: layer"));
        a.store
            .set_task_status(&TaskId::new("layer"), TaskStatus::Done)
            .unwrap();
        a.reload();
        select(&mut a, &leaf("bench"));
        assert!(render(&mut a, 110, 24).contains("prerequisites met"));

        // `t` swaps the same pane for the ledger. Every act an agent takes passes the
        // Broker on its way there, and the reload tick is what makes these a tail.
        select(&mut a, &leaf("keys"));
        a.key(KeyEvent::from(KeyCode::Char('t')));
        let out = render(&mut a, 110, 24);
        assert!(out.contains(" tail "), "{out}");
        assert!(out.contains("nothing recorded here yet"), "{out}");
        a.store
            .append_records(&[
                acted("keys", Action::Write { path: "crates/cache/keys.rs".into() }),
                acted("layer", Action::Write { path: "crates/cache/mod.rs".into() }),
            ])
            .unwrap();
        a.reload();
        let out = render(&mut a, 110, 24);
        assert!(out.contains("impl write crates/cache/keys.rs"), "{out}");
        assert!(out.contains("0s"), "and how long ago it was:\n{out}");
        // Another task's work is not this one's, however recent.
        assert!(!out.contains("crates/cache/mod.rs"), "{out}");
    }

    #[test]
    fn the_cells_and_the_frame_hold_at_any_size() {
        for (w, h) in [(40u16, 12u16), (20, 8), (200, 60)] {
            let out = render(&mut app(), w, h);
            assert!(!out.is_empty(), "{w}x{h} produced nothing");
        }
        let v = Vitals { health: Health::Green, spent: 1500, budget: Some(200_000), needs: vec![] };
        assert_eq!(spend_text(&v), "1k/200k");
        let no_budget = Vitals { budget: None, ..v };
        assert_eq!(spend_text(&no_budget), "1k");
    }
}
