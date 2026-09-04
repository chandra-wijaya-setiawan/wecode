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

#[cfg(test)]
mod tests {
    use super::super::tests::{app, leaf, render, select};
    use super::super::Screen;
    use crossterm::event::{KeyCode, KeyEvent};
    use wecode_core::TaskId;

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
}

