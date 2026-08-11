//! The cockpit: a live, navigable dashboard.
//!
//! Same five columns at every zoom level — what · health · progress · spend ·
//! needs-you — which works because a project and a task answer the same five
//! questions. Health is computed from ground truth (see [`crate::board`]), never
//! reported by an agent.
//!
//! Reloads from the store on a tick, so it tracks state as it changes rather than
//! showing a snapshot.

use std::io;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Row, Table, TableState, Wrap};
use ratatui::{DefaultTerminal, Frame};
use wecode_core::{Plan, ProjectId, Task, TaskId};
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
#[derive(Clone, PartialEq, Eq, Debug)]
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

/// One visible line: a subject at a depth, with its derived vitals.
struct RowItem {
    subject: Subject,
    depth: usize,
    label: String,
    vitals: Vitals,
}

struct App {
    store: Store,
    company: Company,
    known_repos: Vec<String>,
    plan: Plan,
    audit: Vec<AuditLine>,
    /// `None` is the portfolio; `Some` is a focused project or task.
    focus: Option<Subject>,
    rows: Vec<RowItem>,
    table: TableState,
    pane: Pane,
    last_reload: Instant,
    status: String,
    quit: bool,
}

impl App {
    fn new(store: Store, company: Company) -> Result<Self, Box<dyn std::error::Error>> {
        let mut app = Self {
            plan: store.load_plan()?,
            audit: store.audit(&AuditQuery::default())?,
            known_repos: company.repos.iter().map(|r| r.name.clone()).collect(),
            store,
            company,
            focus: None,
            rows: Vec::new(),
            table: TableState::default().with_selected(Some(0)),
            pane: Pane::Board,
            last_reload: Instant::now(),
            status: "j/k move · enter descend · esc up · ? help · q quit".into(),
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
    fn rebuild(&mut self) {
        let selected = self.selected().map(|r| r.subject.clone());
        let l = board::ledger_index(&self.audit);
        let mut rows = Vec::new();

        match self.focus.clone() {
            None => {
                for p in self.plan.projects() {
                    rows.push(project_row(&self.plan, p, &l, &self.known_repos, 0));
                    for t in sorted(self.plan.roots_of(&p.id)) {
                        rows.push(task_row(&self.plan, t, &l, 1));
                    }
                }
            }
            Some(Subject::Project(id)) => {
                if let Some(p) = self.plan.project(&id) {
                    rows.push(project_row(&self.plan, p, &l, &self.known_repos, 0));
                    for t in sorted(self.plan.roots_of(&id)) {
                        rows.push(task_row(&self.plan, t, &l, 1));
                        for k in sorted(self.plan.subtasks(&t.id)) {
                            rows.push(task_row(&self.plan, k, &l, 2));
                        }
                    }
                }
            }
            Some(Subject::Task(id)) => {
                if let Some(t) = self.plan.task(&id) {
                    rows.push(task_row(&self.plan, t, &l, 0));
                    for k in sorted(self.plan.subtasks(&id)) {
                        rows.push(task_row(&self.plan, k, &l, 1));
                        for g in sorted(self.plan.subtasks(&k.id)) {
                            rows.push(task_row(&self.plan, g, &l, 2));
                        }
                    }
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
        let cur = self.table.selected().unwrap_or(0) as isize;
        let next = (cur + delta).clamp(0, self.rows.len() as isize - 1);
        self.table.select(Some(next as usize));
    }

    fn descend(&mut self) {
        let Some(row) = self.selected() else { return };
        let subject = row.subject.clone();
        let has_children = match &subject {
            Subject::Project(id) => self.plan.tasks_of(id).next().is_some(),
            Subject::Task(id) => self.plan.subtasks(id).next().is_some(),
        };
        if has_children {
            self.focus = Some(subject);
            self.rebuild();
            self.table.select(Some(0));
        } else {
            self.status = "leaf — nothing below".into();
        }
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

fn project_row(
    plan: &Plan,
    p: &wecode_core::Project,
    l: &Ledger,
    known_repos: &[String],
    depth: usize,
) -> RowItem {
    RowItem {
        subject: Subject::Project(p.id.clone()),
        depth,
        label: format!("▪ {}", p.id),
        vitals: board::project_vitals(plan, p, l, known_repos),
    }
}

fn task_row(plan: &Plan, t: &Task, l: &Ledger, depth: usize) -> RowItem {
    RowItem {
        subject: Subject::Task(t.id.clone()),
        depth,
        label: format!("{} {}", crate::render::kind_tag(t.kind), t.id),
        vitals: board::task_vitals(plan, t, l),
    }
}

fn health_span(h: Health) -> Span<'static> {
    match h {
        Health::Green => Span::styled("● green", Style::new().fg(Color::Green)),
        Health::Amber => Span::styled("● amber", Style::new().fg(Color::Yellow)),
        Health::Red => Span::styled("● red", Style::new().fg(Color::Red)),
    }
}

fn bar(fraction: f32) -> String {
    let filled = (fraction * 8.0).round().clamp(0.0, 8.0) as usize;
    let mut s = String::new();
    for i in 0..8 {
        s.push(if i < filled { '█' } else { '▁' });
    }
    format!("{s} {:>3.0}%", fraction * 100.0)
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
    let header = Row::new(vec!["what", "health", "progress", "spend", "needs you"])
        .style(Style::new().fg(Color::DarkGray));

    let rows: Vec<Row> = app
        .rows
        .iter()
        .map(|r| {
            let indent = "  ".repeat(r.depth);
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
            Row::new(vec![
                Line::from(format!("{indent}{}", r.label)),
                Line::from(health_span(r.vitals.health)),
                Line::from(bar(r.vitals.progress)),
                Line::from(spend_text(&r.vitals)),
                Line::from(needs),
            ])
        })
        .collect();

    let widths = [
        Constraint::Min(28),
        Constraint::Length(9),
        Constraint::Length(14),
        Constraint::Length(14),
        Constraint::Min(20),
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
    let h = 15u16.min(area.height.saturating_sub(2));
    let popup = Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y + (area.height.saturating_sub(h)) / 2,
        width: w,
        height: h,
    };
    let text = vec![
        Line::from("j / ↓        next".to_string()),
        Line::from("k / ↑        previous".to_string()),
        Line::from("enter / l    descend into selection".to_string()),
        Line::from("esc / h      up one level".to_string()),
        Line::from("g / G        first / last".to_string()),
        Line::from("r            reload now".to_string()),
        Line::from("q            quit".to_string()),
        Line::from(""),
        Line::from("health is computed, never reported:".fg(Color::DarkGray)),
        Line::from("red = alarm or over budget".fg(Color::DarkGray)),
        Line::from("amber = defects, denials, stalled, waiting on you".fg(Color::DarkGray)),
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
    use wecode_core::{Budget, Measure, Project, Scope, TaskStatus};

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
    fn the_portfolio_frame_shows_all_five_columns() {
        let out = render(&mut app("portfolio"), 110, 24);
        for col in ["what", "health", "progress", "spend", "needs you"] {
            assert!(out.contains(col), "missing `{col}` in:\n{out}");
        }
        assert!(out.contains("L0 PORTFOLIO"), "{out}");
        assert!(out.contains("caching"), "{out}");
        assert!(out.contains("feat layer"), "{out}");
    }

    #[test]
    fn the_portfolio_shows_projects_and_root_tasks_but_not_subtasks() {
        // Depth is bounded on purpose: the portfolio is a scan, not a full tree.
        let out = render(&mut app("depth"), 110, 24);
        assert!(out.contains("feat layer"), "{out}");
        assert!(
            !out.contains("feat keys"),
            "subtask should need a descend:\n{out}"
        );
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
    fn bar_is_fixed_width_and_monotonic() {
        assert_eq!(bar(0.0).chars().count(), bar(1.0).chars().count());
        let zero = bar(0.0).chars().filter(|c| *c == '█').count();
        let half = bar(0.5).chars().filter(|c| *c == '█').count();
        let full = bar(1.0).chars().filter(|c| *c == '█').count();
        assert!(zero < half && half < full, "{zero} {half} {full}");
    }

    #[test]
    fn spend_abbreviates_thousands_and_shows_the_cap() {
        let v = Vitals {
            health: Health::Green,
            progress: 0.0,
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
