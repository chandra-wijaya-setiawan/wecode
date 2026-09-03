//! The cockpit: **one application whose screens call each other**. HOME is the whole
//! portfolio under the four attention groups; `enter` opens PROJECT, that project's task

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
use wecode_store::{AuditLine, AuditQuery, Execution, Store, now_secs};

use crate::board::{self, Health, Vitals};
use crate::commands::view::{self, Fold, RowItem, Subject, Tree, caption};

/// How often to re-read the store.
const RELOAD: Duration = Duration::from_millis(1500);
/// How long to block waiting for a keypress before redrawing.
const POLL: Duration = Duration::from_millis(200);
/// How long a reload stands aside after a keystroke.
///
/// The tick re-reads the whole plan and the whole audit query out of a database `wecode
/// loop` is writing to, and rebuilds every row from it. Landing that mid-scroll costs a
/// frame the fingers feel, so it waits for the hand to pause — which is a beat, not a
/// mode: nothing is dropped, and the rhythm above is untouched.
const QUIET: Duration = Duration::from_millis(300);
/// How many rows the ledger tail takes under the table when `t` calls it up.
const TAIL: u16 = 7;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pane {
    Board,
    Help,
    /// Waiting for the screen name after the `v` (view) prefix.
    View,
    /// The query line has the keys: every character narrows what is on screen.
    Query,
}

/// Which screen is on the glass. Named rather than numbered: `L2` says how deep somebody
/// has gone, which is not what they need to know; `TASK cache-keys` says what they see.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Screen {
    Home,
    Agents,
    Project(ProjectId),
    Task(TaskId),
}

impl Screen {
    /// The row this screen was opened from, so `esc` can land the cursor back on it.
    fn subject(&self) -> Option<Subject> {
        match self {
            Self::Home | Self::Agents => None,
            Self::Project(id) => Some(Subject::Project(id.clone())),
            Self::Task(id) => Some(Subject::Task(id.clone())),
        }
    }

    fn title(&self) -> String {
        match self {
            Self::Home => "HOME".to_string(),
            Self::Agents => "ACTIVE AGENTS".to_string(),
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
    /// Runs that have not ended yet. Kept beside the plan and ledger because all three
    /// are one reading of the cockpit, refreshed on the same tick.
    active_agents: Vec<Execution>,
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
    /// When the last key was handled, so the reload can stand aside while a hand is
    /// still moving. `None` until one is: a keystroke nobody made is not a hand to
    /// wait for, and the first tick of a cockpit sitting untouched is due on time.
    last_key: Option<Instant>,
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
    /// Whether the ledger tail is under the table. Off until it is asked for: the rows a
    /// pane takes are the tree's, and the screen `enter` opens is one keystroke away.
    tail: bool,
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
            active_agents: store.unfinished_executions()?,
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
            last_key: None,
            show_archived: false,
            collapsed: HashSet::new(),
            query: String::new(),
            tail: false,
            status: "j/k move · / filter · : go to · v view · enter open · ? help · q quit"
                .into(),
            quit: false,
        };
        app.rebuild();
        Ok(app)
    }

    /// The screen on the glass.
    fn screen(&self) -> &Screen {
        self.stack.last().expect("HOME is never popped")
    }

    /// Whether the store is due to be re-read: on the tick, but never while the keys
    /// are still coming. Deferred rather than skipped — the moment the hand pauses the
    /// tick is already overdue, so the next pass takes it.
    fn reload_due(&self) -> bool {
        self.last_reload.elapsed() >= RELOAD
            && self.last_key.is_none_or(|k| k.elapsed() >= QUIET)
    }

    /// Re-reads state. Errors become a status message rather than a crash: the
    /// cockpit staying up matters more than any single refresh.
    fn reload(&mut self) {
        match (
            self.store.load_plan(),
            self.store.audit(&AuditQuery::default()),
            self.store.unfinished_executions(),
        ) {
            (Ok(p), Ok(a), Ok(active)) => {
                self.gates = crate::commands::ctx::design_gates(&self.company, &p);
                self.plan = p;
                self.audit = a;
                self.active_agents = active;
                self.rebuild();
            }
            (Err(e), _, _) => self.status = format!("reload failed: {e}"),
            (_, Err(e), _) => self.status = format!("reload failed: {e}"),
            (_, _, Err(e)) => self.status = format!("reload failed: {e}"),
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
        // ACTIVE AGENTS has no plan rows of its own. Keep the rows and selection of the
        // screen underneath so leaving the view lands exactly where it was opened.
        if matches!(self.screen(), Screen::Agents) {
            return;
        }
        // A subject can appear in an attention group and again in the portfolio. Keep
        // which occurrence was active; restoring only by subject jumps to its first row.
        let selected = self.table.selected().and_then(|at| {
            let subject = self.rows.get(at)?.subject.clone()?;
            let occurrence = self.rows[..at]
                .iter()
                .filter(|row| row.subject.as_ref() == Some(&subject))
                .count();
            Some((subject, occurrence))
        });
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
            Screen::Agents => unreachable!("handled above"),
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
            .and_then(|(subject, occurrence)| {
                self.rows
                    .iter()
                    .enumerate()
                    .filter(|(_, row)| row.subject.as_ref() == Some(&subject))
                    .nth(occurrence)
                    .map(|(at, _)| at)
                    // If a group disappeared, keep the subject selected wherever it
                    // remains rather than falling all the way back to the first row.
                    .or_else(|| {
                        self.rows
                            .iter()
                            .position(|row| row.subject.as_ref() == Some(&subject))
                    })
            })
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

    /// Everything wecode holds about one task: the TASK screen.
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
                Screen::Home | Screen::Agents | Screen::Task(_) => false,
            }
    }

    fn move_by(&mut self, delta: isize) {
        // A page of words has no selection to move, so the same keys move the page: `j`
        // is *next* on every screen, and what is next on a page is the line below.
        if matches!(self.screen(), Screen::Task(_) | Screen::Agents) {
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
    /// the table, and resting on one leaves enter with nothing to do.
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
        self.last_key = Some(Instant::now());
        if self.pane == Pane::Help {
            self.pane = Pane::Board;
            return;
        }
        if self.pane == Pane::View {
            self.pane = Pane::Board;
            match k.code {
                KeyCode::Char('a') if !matches!(self.screen(), Screen::Agents) => {
                    self.open(Screen::Agents);
                }
                KeyCode::Char('h') if !matches!(self.screen(), Screen::Home) => {
                    self.open(Screen::Home);
                }
                _ => self.status = "view: a agents · h home".into(),
            }
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
            KeyCode::Char('v') => {
                self.pane = Pane::View;
                self.status = "view: a agents · h home".into();
            }
            KeyCode::Char('/')
                if !matches!(self.screen(), Screen::Task(_) | Screen::Agents) =>
            {
                self.ask();
            }
            // TASK and ACTIVE AGENTS have no plan rows to narrow, so the only search
            // that means anything there is the one `:` asks anyway.
            KeyCode::Char('/' | ':') => {
                self.stack.push(Screen::Home);
                self.ask();
            }
            // The ledger as it is written, under the table, and away again with the same
            KeyCode::Char('t') => self.tail = !self.tail,
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
    let screen = app.screen().clone();
    let tailing = app.tail && !matches!(screen, Screen::Task(_) | Screen::Agents);
    let active_height = if app.active_agents.is_empty() || matches!(screen, Screen::Agents) {
        0
    } else {
        u16::try_from(app.active_agents.len())
            .unwrap_or(u16::MAX)
            .min(4)
            // Top and bottom borders, plus the column heading.
            .saturating_add(3)
    };
    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(active_height),
        Constraint::Min(6),
        Constraint::Length(if tailing { TAIL } else { 0 }),
        Constraint::Length(1),
    ])
    .split(f.area());

    header(f, areas[0], app);
    if active_height > 0 {
        active_agents(f, areas[1], app);
    }
    match &screen {
        Screen::Task(id) => page(f, areas[2], app, id),
        Screen::Agents => agents_page(f, areas[2], app),
        Screen::Home | Screen::Project(_) => {
            table(f, areas[2], app);
            if tailing {
                tail(f, areas[3], app);
            }
        }
    }
    footer(f, areas[4], app);

    if app.pane == Pane::Help {
        help(f, f.area());
    }
}

/// The work happening now, visible from every screen. An execution is the durable
/// source here: task status alone says that work is in flight, but cannot say which
/// agent, which attempt, or whether two agents are working at once.
mod agents;
use agents::{active_agents, agents_page};

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

/// The pane `t` puts under the table: the ledger's newest lines about whatever the cursor
/// is on, oldest first — the way a log reads, and the reload tick is what makes it a tail
/// rather than a snapshot. Not a second reading of the screen `enter` opens, which is what
/// the row already leads to; this is what an agent has actually done since.
fn tail(f: &mut Frame, area: Rect, app: &App) {
    let (project, task) = match app.selected().and_then(|r| r.subject.as_ref()) {
        Some(Subject::Project(id)) => (id.as_str(), ""),
        Some(Subject::Task(id)) => ("", id.as_str()),
        None => ("", ""),
    };
    let now = now_secs();
    // Coloured whole: an ordinary act is dim because the eye is here for the one that
    // is not, and a refusal or an alarm is the reading this pane exists to carry.
    let mut lines: Vec<Line<'static>> =
        board::newest(&app.audit, project, task, area.height.saturating_sub(2) as usize)
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
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(Color::DarkGray))
        .title(" tail ");
    f.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
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
        Line::from("v a          open active agents".to_string()),
        Line::from("v h          open home".to_string()),
        Line::from("t            show or hide the ledger as it is written".to_string()),
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

/// A panic must not leave the terminal raw, nor take its own message down with it.
mod crash;

/// Runs the cockpit until the operator quits, opening on `opening` or on HOME.
pub(crate) fn run(
    store: Store,
    company: Company,
    opening: Option<Screen>,
) -> Result<(), Box<dyn std::error::Error>> {
    std::panic::set_hook(crash::hook(store.path(), std::panic::take_hook()));
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

        // One draw per burst of keys, not one key per draw. A held `j` repeats around
        // thirty times a second and a full-frame draw is slower than that, so reading a
        if event::poll(POLL)? {
            loop {
                match event::read()? {
                    Event::Key(k) if k.is_press() => app.key(k),
                    Event::Resize(_, _) => {}
                    _ => {}
                }
                // Quitting stops here rather than draining what came after it: the keys
                // behind a `q` were typed at a cockpit that is going away.
                if app.quit || !event::poll(Duration::ZERO)? {
                    break;
                }
            }
        }
        if app.reload_due() {
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
        // A heading points at nothing: stopping on one leaves enter with nothing to do,
        // which reads as a cockpit that has hung.
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
    fn reload_preserves_which_copy_of_a_subject_is_selected() {
        let mut a = app();
        let copies: Vec<usize> = a
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.subject == Some(leaf("keys")))
            .map(|(at, _)| at)
            .collect();
        assert!(copies.len() > 1, "task appears in a group and the portfolio");
        let portfolio_copy = *copies.last().unwrap();
        a.table.select(Some(portfolio_copy));

        a.reload();

        assert_eq!(a.table.selected(), Some(portfolio_copy));
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
    fn active_agents_stay_on_the_cockpit_until_their_run_ends() {
        let mut a = app();
        let id = TaskId::new("keys");
        let run = a
            .store
            .start_execution(&id, "agent-7", None, Some(1234))
            .unwrap();
        a.reload();

        let out = render(&mut a, 118, 30);
        assert!(out.contains("ACTIVE AGENTS"), "{out}");
        assert!(out.contains("agent-7"), "the session identifies the agent:\n{out}");
        assert!(out.contains("keys #1"), "the task and attempt are visible:\n{out}");
        assert!(out.contains("design the cache keys"), "its objective is visible:\n{out}");
        assert!(out.contains("working"), "its live state is visible:\n{out}");

        a.store
            .finish_execution(
                run,
                wecode_core::ExecutionStatus::Completed,
                "exit 0",
                wecode_store::execution::Spend::default(),
            )
            .unwrap();
        a.reload();
        assert!(
            !render(&mut a, 118, 30).contains("ACTIVE AGENTS"),
            "finished work leaves the active panel"
        );
    }

    #[test]
    fn v_a_opens_active_agents_and_back_returns_to_the_same_place() {
        let mut a = app();
        select(&mut a, &leaf("keys"));
        let selected = a.selected().and_then(|row| row.subject.clone());

        a.key(KeyEvent::from(KeyCode::Char('v')));
        assert_eq!(a.screen(), &Screen::Home);
        a.key(KeyEvent::from(KeyCode::Char('a')));
        assert_eq!(a.screen(), &Screen::Agents);
        assert!(render(&mut a, 118, 24).contains("no active agents"));

        a.key(KeyEvent::from(KeyCode::Esc));
        assert_eq!(a.screen(), &Screen::Home);
        assert_eq!(a.selected().and_then(|row| row.subject.clone()), selected);
    }

    #[test]
    fn v_h_opens_home_and_back_returns_to_the_same_place() {
        let mut a = app();
        a.open(onto("layer"));

        a.key(KeyEvent::from(KeyCode::Char('v')));
        assert_eq!(a.screen(), &onto("layer"));
        a.key(KeyEvent::from(KeyCode::Char('h')));
        assert_eq!(a.screen(), &Screen::Home);

        a.key(KeyEvent::from(KeyCode::Esc));
        assert_eq!(a.screen(), &onto("layer"));
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
    fn t_puts_the_ledger_as_it_is_written_under_the_table() {
        // Nothing is under the table until it is asked for. A pane that previewed the
        // screen `enter` opens lived here and was dropped: it said a second time what one
        // keystroke says in full, for rows the tree wanted. What an agent is *doing* is
        // not in the plan at all, which is why this one stayed.
        let mut a = app();
        a.open(on("caching"));
        select(&mut a, &leaf("keys"));
        let out = render(&mut a, 110, 24);
        assert!(!out.contains(" tail "), "no pane nobody called up:\n{out}");
        assert!(!out.contains("in caching / layer"), "nor the screen below:\n{out}");

        // Every act an agent takes passes the Broker on its way to the ledger, and the
        // reload tick is what makes these a tail rather than a snapshot.
        a.key(KeyEvent::from(KeyCode::Char('t')));
        let out = render(&mut a, 110, 24);
        assert!(out.contains(" tail "), "the pane names itself:\n{out}");
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

        // And away with the same key: the rows go back to the tree.
        a.key(KeyEvent::from(KeyCode::Char('t')));
        let out = render(&mut a, 110, 24);
        assert!(!out.contains(" tail "), "{out}");
        assert!(out.contains("feat keys"), "the table has them:\n{out}");
    }

    #[test]
    fn the_task_screen_says_what_stands_in_a_task_s_way() {
        // A prerequisite no tick will release reads differently from one that is met —
        // on TASK, which is now the only place either is written.
        let mut a = app();
        a.store
            .save_task(&task("bench", "benchmark the cache", "benches/**").after("layer"))
            .unwrap();
        a.reload();
        a.open(onto("bench"));
        let out = render(&mut a, 110, 24);
        assert!(out.contains("waiting on: layer"), "{out}");
        assert!(out.contains("no runs yet"), "what it has cost:\n{out}");
        assert!(out.contains("no incidents"), "and what it tripped:\n{out}");

        a.store
            .set_task_status(&TaskId::new("layer"), TaskStatus::Done)
            .unwrap();
        a.reload();
        assert!(render(&mut a, 110, 24).contains("prerequisites met"));
    }

    #[test]
    fn the_reload_stands_aside_while_the_keys_are_still_coming() {
        // The tick reads the whole plan and the whole audit back out and rebuilds every
        // row from it. Due in the middle of a scroll, it lands as a stutter under the
        // fingers — so it waits for the hand to pause, and is never dropped for it.
        let mut a = app();
        a.last_reload = Instant::now() - RELOAD;
        assert!(a.reload_due(), "overdue with nobody typing");

        a.key(KeyEvent::from(KeyCode::Char('j')));
        assert!(!a.reload_due(), "not in the middle of a scroll");

        // A beat after the last key it is still overdue, and this pass takes it.
        a.last_key = Some(Instant::now() - QUIET);
        assert!(a.reload_due());
        a.reload();
        assert!(!a.reload_due(), "and the tick starts again from there");
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
