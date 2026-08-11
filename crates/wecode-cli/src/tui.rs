//! The cockpit: a live, navigable dashboard.
//!
//! Same five columns at every zoom level — what · health · progress · spend ·
//! needs-you — which works only because the intent tree is self-similar. Health is
//! computed from ground truth (see [`crate::board`]), never reported by an agent.
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
use wecode_core::{Intent, IntentId, IntentTree};
use wecode_org::Company;
use wecode_store::{AuditLine, Store};

use crate::board::{self, Health, Vitals};

/// How often to re-read the store.
const RELOAD: Duration = Duration::from_millis(1500);
/// How long to block waiting for a keypress before redrawing.
const POLL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pane {
    Board,
    Help,
}

/// One visible line: an intent at a depth, with its derived vitals.
struct RowItem {
    id: IntentId,
    depth: usize,
    label: String,
    vitals: Vitals,
}

struct App {
    store: Store,
    company: Company,
    tree: IntentTree,
    audit: Vec<AuditLine>,
    /// `None` is the portfolio; `Some` is a focused subtree.
    focus: Option<IntentId>,
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
            tree: store.load_tree()?,
            audit: store.load_audit()?,
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
        match (self.store.load_tree(), self.store.load_audit()) {
            (Ok(t), Ok(a)) => {
                self.tree = t;
                self.audit = a;
                self.rebuild();
            }
            (Err(e), _) | (_, Err(e)) => self.status = format!("reload failed: {e}"),
        }
        self.last_reload = Instant::now();
    }

    /// Flattens the current view into rows, preserving the selected id if it
    /// survives the rebuild.
    fn rebuild(&mut self) {
        let selected_id = self.selected().map(|r| r.id.clone());
        let idx = board::ledger_index(&self.audit);
        let mut rows = Vec::new();

        match &self.focus {
            None => {
                let mut roots: Vec<&Intent> = self.tree.roots().collect();
                roots.sort_by_key(|r| r.id.clone());
                for r in roots {
                    push_row(&mut rows, &self.tree, r, 0, &idx);
                    let mut kids: Vec<&Intent> = self.tree.children(&r.id).collect();
                    kids.sort_by_key(|k| k.id.clone());
                    for k in kids {
                        push_row(&mut rows, &self.tree, k, 1, &idx);
                    }
                }
            }
            Some(id) => {
                if let Some(node) = self.tree.get(id) {
                    push_row(&mut rows, &self.tree, node, 0, &idx);
                    let mut kids: Vec<&Intent> = self.tree.children(id).collect();
                    kids.sort_by_key(|k| k.id.clone());
                    for k in kids {
                        push_row(&mut rows, &self.tree, k, 1, &idx);
                        let mut grand: Vec<&Intent> = self.tree.children(&k.id).collect();
                        grand.sort_by_key(|g| g.id.clone());
                        for g in grand {
                            push_row(&mut rows, &self.tree, g, 2, &idx);
                        }
                    }
                }
            }
        }

        self.rows = rows;
        let restored = selected_id
            .and_then(|id| self.rows.iter().position(|r| r.id == id))
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
        if let Some(row) = self.selected() {
            let id = row.id.clone();
            // Only descend where there is something below.
            if self.tree.children(&id).next().is_some() {
                self.focus = Some(id);
                self.rebuild();
                self.table.select(Some(0));
            } else {
                self.status = "leaf — nothing below".into();
            }
        }
    }

    fn ascend(&mut self) {
        let parent = self
            .focus
            .as_ref()
            .and_then(|id| self.tree.get(id))
            .and_then(|n| n.parent.clone());
        self.focus = parent;
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

fn push_row(
    rows: &mut Vec<RowItem>,
    tree: &IntentTree,
    intent: &Intent,
    depth: usize,
    idx: &std::collections::BTreeMap<String, (u64, usize, usize)>,
) {
    rows.push(RowItem {
        id: intent.id.clone(),
        depth,
        label: format!("{} {}", crate::render::kind_tag(intent.kind), intent.id),
        vitals: board::vitals(tree, intent, idx),
    });
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
        Some(id) => match app.tree.get(id) {
            Some(n) => format!("{} {}", crate::render::kind_tag(n.kind), id),
            None => id.to_string(),
        },
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
            Paragraph::new("no intents yet — wecode intent add vision <id> \"<statement>\"")
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

/// The selected intent's statement, lineage and incidents.
fn detail(f: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(Color::DarkGray))
        .title(" detail ");

    let Some(row) = app.selected() else {
        f.render_widget(Paragraph::new("").block(block), area);
        return;
    };
    let Some(node) = app.tree.get(&row.id) else {
        f.render_widget(Paragraph::new("").block(block), area);
        return;
    };

    let mut lines = vec![Line::from(node.statement.clone().bold())];

    // What it serves — the trajectory question.
    let mut chain: Vec<String> = app
        .tree
        .ancestors(&row.id)
        .map(|a| a.statement.clone())
        .collect();
    chain.reverse();
    if chain.is_empty() {
        lines.push(Line::from(
            "serves: nothing above (root)".fg(Color::DarkGray),
        ));
    } else {
        lines.push(Line::from(
            format!("serves: {}", chain.join(" → ")).fg(Color::DarkGray),
        ));
    }

    let incidents: Vec<&AuditLine> = app
        .audit
        .iter()
        .filter(|l| l.intent == row.id.as_str() && l.is_denial())
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
    let h = 14u16.min(area.height.saturating_sub(2));
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
        Line::from("amber = defects, denials, stalled".fg(Color::DarkGray)),
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
    use wecode_core::{Budget, IntentKind, Link, Measure, Scope};

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

    /// Each test gets its own store: they run in parallel, and a shared temp
    /// directory means one test wipes another's state mid-write.
    fn app(name: &str) -> App {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
        let dir = std::path::Path::new(&base).join(format!("wecode-tui-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir).expect("store");

        store
            .append_intent(&Intent::new("fast", IntentKind::Vision, "lead on speed"))
            .unwrap();
        store
            .append_intent(
                &Intent::new("p99", IntentKind::Goal, "cut p99 below 500ms")
                    .under("fast", Link::Requires)
                    .measured(Measure::Rollup),
            )
            .unwrap();
        store
            .append_intent(
                &Intent::new("caching", IntentKind::Project, "add response caching")
                    .under("p99", Link::Requires)
                    .measured(Measure::Command {
                        cmd: "cargo test".into(),
                        expect_status: 0,
                    })
                    .scoped(Scope::write(&["crates/**"]))
                    .budgeted(Budget {
                        tokens: Some(200_000),
                        wall_secs: Some(1800),
                    }),
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

    #[test]
    fn the_portfolio_frame_shows_all_five_columns() {
        let out = render(&mut app("portfolio"), 110, 24);
        for col in ["what", "health", "progress", "spend", "needs you"] {
            assert!(out.contains(col), "missing `{col}` in:\n{out}");
        }
        assert!(out.contains("L0 PORTFOLIO"), "{out}");
        assert!(out.contains("VIS fast"), "{out}");
        assert!(out.contains("GOAL p99"), "{out}");
    }

    #[test]
    fn the_header_names_the_company_and_the_footer_the_attention_budget() {
        let out = render(&mut app("header"), 110, 24);
        assert!(out.contains("My Project"), "{out}");
        assert!(out.contains("attention"), "{out}");
    }

    #[test]
    fn descending_changes_level_and_keeps_the_columns() {
        let mut a = app("descend");
        // Select the goal, then descend into it.
        a.move_by(1);
        assert_eq!(a.selected().unwrap().id.as_str(), "p99");
        a.descend();
        assert_eq!(a.focus.as_ref().unwrap().as_str(), "p99");

        let out = render(&mut a, 110, 24);
        assert!(out.contains("GOAL p99"), "{out}");
        assert!(
            out.contains("PROJ caching"),
            "child should be visible:\n{out}"
        );
        assert!(out.contains("needs you"), "{out}");
    }

    #[test]
    fn ascending_returns_to_the_portfolio() {
        let mut a = app("ascend");
        a.move_by(1);
        a.descend();
        a.ascend();
        assert_eq!(a.focus.as_ref().unwrap().as_str(), "fast", "up one level");
        a.ascend();
        assert!(a.focus.is_none(), "back to the portfolio");
    }

    #[test]
    fn descending_into_a_leaf_is_refused_with_a_reason() {
        let mut a = app("leaf");
        a.focus = Some(IntentId::new("p99"));
        a.rebuild();
        // `caching` has no children in this fixture.
        let pos = a
            .rows
            .iter()
            .position(|r| r.id.as_str() == "caching")
            .unwrap();
        a.table.select(Some(pos));
        a.descend();
        assert!(
            a.focus.as_ref().unwrap().as_str() == "p99",
            "focus unchanged"
        );
        assert!(a.status.contains("leaf"), "{}", a.status);
    }

    #[test]
    fn selection_survives_a_reload() {
        let mut a = app("reload");
        a.move_by(1);
        let before = a.selected().unwrap().id.clone();
        a.reload();
        assert_eq!(a.selected().unwrap().id, before);
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
    fn the_detail_pane_answers_what_this_serves() {
        let mut a = app("detail");
        a.move_by(2); // the project
        let out = render(&mut a, 110, 24);
        assert!(out.contains("serves:"), "{out}");
        assert!(
            out.contains("lead on speed"),
            "lineage should reach the root:\n{out}"
        );
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
    fn bar_clamps_out_of_range_input() {
        assert_eq!(bar(-1.0).chars().filter(|c| *c == '█').count(), 0);
        assert_eq!(bar(2.0).chars().filter(|c| *c == '█').count(), 8);
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
