//! The cockpit's agents view: what every live run is doing right now.
//!
//! Extracted from tui.rs when that file passed the ratchet's limit — the split
//! the ratchet exists to force. Read-only by construction: watching a run must
//! never become steering it, or verify stops meaning anything.

use super::{now_secs, App};
use wecode_core::TaskId;
use crate::board;
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph, Row, Table};

pub(super) fn active_agents(f: &mut Frame, area: Rect, app: &App) {
    agents_table(f, area, app, Some(4));
}

/// Every run still in flight, reached with `v` from any screen.
pub(super) fn agents_page(f: &mut Frame, area: Rect, app: &App) {
    if app.active_agents.is_empty() {
        f.render_widget(
            Paragraph::new("no active agents")
                .block(Block::default().borders(Borders::ALL).title(" ACTIVE AGENTS ")),
            area,
        );
    } else {
        agents_table(f, area, app, None);
    }
}

pub(super) fn agents_table(f: &mut Frame, area: Rect, app: &App, limit: Option<usize>) {
    let now = now_secs();
    let rows = app.active_agents.iter().take(limit.unwrap_or(usize::MAX)).map(|run| {
        let agent = app
            .audit
            .iter()
            .rev()
            .find(|line| line.session == run.session)
            .map_or(run.session.as_str(), |line| line.agent.as_str());
        let task = app
            .plan
            .task(&TaskId::new(&run.task))
            .map_or(run.task.as_str(), |task| task.title.as_str());
        Row::new(vec![
            agent.to_string(),
            format!("{} #{}", run.task, run.attempt),
            task.to_string(),
            run.status.as_str().to_string(),
            board::ago(now.saturating_sub(run.started)),
        ])
    });
    let widths = [
        Constraint::Length(16),
        Constraint::Length(20),
        Constraint::Min(20),
        Constraint::Length(14),
        Constraint::Length(7),
    ];
    let table = Table::new(rows, widths)
        .header(
            Row::new(["agent", "task / try", "objective", "state", "age"])
                .style(Style::new().fg(Color::DarkGray)),
        )
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::new().fg(Color::Cyan))
                .title(" ACTIVE AGENTS "),
        );
    f.render_widget(table, area);
}

