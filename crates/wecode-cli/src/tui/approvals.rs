//! The cockpit's approval panel: what waits on the operator, and the key that clears
//! each — the command, with the id already in it, so it can be typed as printed.
//!
//! Drawn on every screen but HOME, where the four attention groups already lead with
//! these same rows. Two copies on one screen is what the dropped preview pane cost; one
//! copy on HOME *only* is what left somebody inside a project unable to see that an
//! approval was holding one of its tasks up, which is the gap this closes.
//!
//! Read-only, like the rest of the cockpit: the panel names the command, it does not run
//! it. An approval signed from the instrument that watched the run is a signature given
//! by the thing being judged — `wecode approve` and `wecode merge` have a channel, a
//! Broker and a ledger row of their own, and this points at them.

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Row, Table};
use wecode_core::Project;

use super::App;
use crate::board::{self, Group, Health, Vitals};

/// One stopped row: where the work is, what it is asking for, and what to type.
#[derive(Debug)]
pub(super) struct Owed {
    at: String,
    /// The category, a word learned once — `needs-approval`, `needs-input`, `failed`,
    /// `yours to do`, `stuck`. Held to a closed list by `docs/reference/board.md`.
    word: String,
    /// The one command that clears it, with the id already in it.
    key: String,
}

/// What waits on the operator across the whole workspace, and how many rows the group
/// stood down to a count.
///
/// Read off [`board::attention_groups`] rather than off the statuses a second time. The
/// panel, the snapshot on somebody's phone and HOME's own leading group cannot come to
/// disagree about what needs a person, because only one place decides it — and the cell
/// each row prints is the board's, so `needs-approval` cannot mean `merge` here and
/// `approve design` there.
///
/// The whole workspace, not the screen: a task stopped in another project is still
/// stopped, and a panel that answered *what waits on you here* would need reading twice.
pub(super) fn owed(app: &App) -> (Vec<Owed>, usize) {
    let projects: Vec<&Project> = if app.show_archived {
        app.plan.all_projects().collect()
    } else {
        app.plan.projects().collect()
    };
    let l = board::ledger_index(&app.ledger);
    let mut rows = Vec::new();
    let mut hidden = 0;
    for (group, shown, more) in board::attention_groups(&app.plan, &projects, &l, app.show_archived)
    {
        if group != Group::NeedsYou {
            continue;
        }
        hidden = more;
        for t in shown {
            // Vitals the needs-human line does not read: an incident colours a row in the
            // tree, and this panel is already the colour of a thing that has stopped.
            let v = Vitals { health: Health::Amber, spent: 0, budget: None, needs: Vec::new() };
            // The cell the board prints, split at its own separator so the command can be
            // the column the eye lands on. Unsplit, the whole cell is the command: a
            // reading that is long rather than one that is wrong.
            let cell = group.line(&app.plan, t, &l, &v);
            let (word, key) = cell.split_once(" · ").unwrap_or(("", cell.as_str()));
            rows.push(Owed {
                at: format!("{}/{}", t.project, t.id),
                word: word.to_string(),
                key: key.to_string(),
            });
        }
    }
    (rows, hidden)
}

/// How many rows the panel takes: one per stopped row, one more for the tail it stood
/// down, and its borders.
///
/// Nothing at all when nothing waits. An empty box drawn on every screen would cost the
/// tree a row in order to say that there was nothing to say, which is how a panel comes
/// to be read past rather than read.
pub(super) fn height(rows: &[Owed], hidden: usize) -> u16 {
    if rows.is_empty() {
        return 0;
    }
    u16::try_from(rows.len() + usize::from(hidden > 0))
        .unwrap_or(u16::MAX)
        .saturating_add(2)
}

/// The panel, under the header and above whatever the screen is otherwise showing.
pub(super) fn panel(f: &mut Frame, area: Rect, rows: &[Owed], hidden: usize) {
    let mut table: Vec<Row> = rows
        .iter()
        .map(|r| {
            Row::new(vec![
                Line::from(r.at.clone().fg(Color::Cyan)),
                Line::from(r.word.clone().fg(Color::Yellow)),
                // Bold, because it is the one cell here that is an instruction rather
                // than a reading: it is typed, not read.
                Line::from(Span::styled(
                    r.key.clone(),
                    Style::new().add_modifier(Modifier::BOLD),
                )),
            ])
        })
        .collect();
    if hidden > 0 {
        // Said the way the board says it, and never dropped in silence: a panel that
        // showed five of nine without saying so is a count somebody acts on.
        table.push(Row::new(vec![
            Line::from(""),
            Line::from(""),
            Line::from(format!("… and {hidden} more").fg(Color::DarkGray)),
        ]));
    }
    let widths = [
        Constraint::Length(26),
        Constraint::Length(15),
        Constraint::Min(28),
    ];
    let title = format!(
        " {} — {} waiting · w hides ",
        Group::NeedsYou.title(),
        rows.len() + hidden
    );
    f.render_widget(
        Table::new(table, widths).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::new().fg(Color::Yellow))
                .title(title),
        ),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::super::tests::{app, on, onto, render};
    use crossterm::event::{KeyCode, KeyEvent};
    use wecode_core::{TaskId, TaskStatus};

    #[test]
    fn the_panel_names_what_waits_and_the_command_that_clears_it() {
        // The headline. An operator who has descended into a project has left the four
        // groups behind, and an approval blocking one of its tasks used to leave with
        // them — the one reading the cockpit exists to carry, gone one keystroke in.
        let mut a = app();
        a.store
            .set_task_status(&TaskId::new("keys"), TaskStatus::NeedsApproval)
            .unwrap();
        a.reload();

        // Not on HOME: the groups there are these same rows, and a screen that answered
        // one question twice teaches a reader to skip both answers.
        let out = render(&mut a, 118, 30);
        assert!(!out.contains("w hides"), "the groups already lead HOME:\n{out}");

        a.open(on("caching"));
        let out = render(&mut a, 118, 30);
        assert!(out.contains("NEEDS YOU"), "{out}");
        assert!(out.contains("caching/keys"), "which work stopped:\n{out}");
        assert!(out.contains("needs-approval"), "what it is asking:\n{out}");
        assert!(out.contains("wecode merge keys"), "and the key that clears it:\n{out}");

        // It follows the operator onto a page, which has no rows of its own at all.
        a.open(onto("layer"));
        assert!(render(&mut a, 118, 30).contains("wecode merge keys"));
    }

    #[test]
    fn the_command_is_the_one_the_row_actually_wants() {
        // Why the cell is the board's rather than this panel's own: `needs-approval` and
        // `failed` both stop for a person and want different moves, and a panel that
        // printed the status and stopped would send somebody to look up which.
        let mut a = app();
        a.open(on("caching"));
        // Every task is a draft — stopped for nobody, so nothing is drawn. An empty box
        // on every screen costs the tree a row to say there is nothing to say.
        assert!(!render(&mut a, 118, 30).contains("NEEDS YOU"), "no empty panel");

        a.store
            .set_task_status(&TaskId::new("keys"), TaskStatus::Failed)
            .unwrap();
        a.reload();
        let out = render(&mut a, 118, 30);
        assert!(out.contains("failed"), "{out}");
        assert!(out.contains("wecode run keys"), "a failure is run again:\n{out}");

        // And away with `w`, like the tail: the rows a panel takes are the tree's.
        a.key(KeyEvent::from(KeyCode::Char('w')));
        assert!(!render(&mut a, 118, 30).contains("wecode run keys"), "away");
        assert!(a.status.contains("hidden"), "{}", a.status);
        a.key(KeyEvent::from(KeyCode::Char('w')));
        assert!(render(&mut a, 118, 30).contains("wecode run keys"), "and back");
    }
}
