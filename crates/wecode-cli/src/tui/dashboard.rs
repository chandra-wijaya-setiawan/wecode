//! The cockpit's front page: six panes, and the three screens they open.
//!
//! `wecode tui` lands here rather than on the board, because the first question an
//! operator has is never *what tasks exist* — it is *is anything wrong, and is anything
//! waiting for me*. The board answers the first question and is one keystroke away as
//! `v h`; this answers the second two without one.
//!
//! Six panes on one screen: a status band across the top, then Agent, Need you, Blocked
//! and Roadmap in a 2×2 grid, then the bar naming every key. **Nothing here scrolls.** A
//! pane that overflows shows what fits and counts the rest, because a front page that
//! scrolled would put the answer below the fold on exactly the day it mattered — and the
//! count in each title is that pane's whole answer, so it is never the thing pushed off.
//!
//! Drawn from `docs/design/tui-dashboard.md`. Two of its sources are decided and not yet
//! built — `idle-inspector` (`docs/wecode/idle-inspector-design/design.md`) and a
//! services indicator — so [`cause`] and [`services`] compute here, from the plan, the
//! open runs and the company profile alone. When `idle.rs` lands, this calls it: three
//! surfaces that decide idleness separately are three surfaces that will disagree about
//! it, and the phone is the one that gets believed.

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use wecode_core::{Blocker, Plan, Project, Task, TaskId, TaskStatus};

use super::{App, now_secs};
use crate::board;

/// How long a run's supervisor may go quiet before the Agent pane reads it as stalled.
///
/// The sweep's own window, and the same reading: `task_executions.beat` says somebody is
/// still watching, and a row nobody has spoken for in five minutes is a run this pane
/// must not report as working. Judged by [`crate::scheduler::stale`] rather than by a
/// comparison written out again here, so the pane and the sweep cannot disagree about
/// which runs have gone quiet.
const SILENT: std::time::Duration = std::time::Duration::from_secs(300);

/// How deep the two diagrams walk before they stop.
///
/// A guard, not a layout choice. Both walk edges the plan holds — waits-for and
/// is-part-of — and a cockpit is the instrument somebody opens *because* the plan looks
/// wrong, so it may not be the thing that hangs on a cycle somebody has just written.
const DEEP: usize = 8;

/// Which of the front page's screens is on the glass.
///
/// One variant of [`super::Screen`] carries all four, rather than four variants: they
/// share a stack, a key prefix and a way back, and the screen the operator names is the
/// only thing that differs between them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Panel {
    Dashboard,
    Needs,
    Blocked,
    Roadmap,
}

impl Panel {
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Dashboard => "DASHBOARD",
            Self::Needs => "NEED YOU",
            Self::Blocked => "BLOCKED",
            Self::Roadmap => "ROADMAP",
        }
    }

    /// The screen a `v` prefix and one letter opens, and `None` for a letter that names
    /// no screen. The key each pane prints is this table read the other way round.
    pub(crate) fn of_key(c: char) -> Option<Self> {
        Some(match c {
            'd' => Self::Dashboard,
            'y' => Self::Needs,
            'g' => Self::Blocked,
            'r' => Self::Roadmap,
            _ => return None,
        })
    }
}

/// The bar at the foot of the front page, and the line the `v` prefix prints while it
/// waits for the letter after it. One string, so a key added to one is in both.
pub(crate) const KEYS: &str =
    "home v-h · dashboard v-d · agents v-a · needs-you v-y · blocked v-g · roadmap v-r";

/// The front page, or whichever of its detail screens is open.
pub(super) fn draw(f: &mut Frame, area: Rect, app: &mut App, panel: Panel) {
    match panel {
        Panel::Dashboard => front(f, area, app),
        Panel::Needs => needs_page(f, area, app),
        Panel::Blocked => diagram(f, area, app, panel, blocked_dag(&app.plan)),
        Panel::Roadmap => diagram(f, area, app, panel, roadmap_dag(&app.plan)),
    }
}

/// The six panes, laid out as the drawing has them.
///
/// The grid is given whatever the status band and the key bar leave: the band is as tall
/// as the services it has to name, the bar is fixed, and the four questions take the
/// rest. Split evenly rather than weighted — a pane that shrank when it had least to say
/// would move the other three every time a run started.
fn front(f: &mut Frame, area: Rect, app: &App) {
    let kit = services(app);
    // The sentence, its own borders, and one line per pair of services.
    let band = u16::try_from(3 + kit.len().div_ceil(2)).unwrap_or(u16::MAX);
    let rows = Layout::vertical([
        Constraint::Length(band),
        Constraint::Min(6),
        Constraint::Length(3),
    ])
    .split(area);
    status(f, rows[0], app, &kit);

    let half = Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(rows[1]);
    let split =
        |r: Rect| Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(r);
    let (top, bottom) = (split(half[0]), split(half[1]));

    let agents = agent_rows(app);
    pane(f, top[0], "Agent", agents.len(), "v-a", Color::Cyan, agents);
    let (owed, hidden) = super::approvals::owed(app);
    let needs: Vec<Line<'static>> = owed
        .iter()
        .map(|o| {
            Line::from(vec![
                " • ".fg(Color::DarkGray),
                format!("{} ", o.word).fg(Color::Yellow),
                o.at.clone().into(),
            ])
        })
        .collect();
    pane(f, top[1], "Need you", needs.len() + hidden, "v-y", Color::Yellow, needs);

    let blocked = blocked_rows(&app.plan);
    pane(f, bottom[0], "Blocked", blocked.len(), "v-g (dag)", Color::Red, blocked);
    let roadmap = roadmap_rows(&app.plan);
    pane(f, bottom[1], "Roadmap", roadmap.len(), "v-r (dag)", Color::Blue, roadmap);

    f.render_widget(
        Paragraph::new(Line::from(KEYS.fg(Color::DarkGray))).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::new().fg(Color::DarkGray)),
        ),
        rows[2],
    );
}

/// The band across the top: one synthesised sentence, and the services under it.
///
/// The sentence and the services answer different questions and are drawn together
/// because a person asks both at once. *Healthy* is the services' word — whether the
/// machinery around wecode is wired and answering. Whether anything is **moving** is the
/// clause after the semicolon, which is why a workspace can read healthy and idle at the
/// same time: nothing is broken, and nothing is running, and the reason is named.
fn status(f: &mut Frame, area: Rect, app: &App, kit: &[(&'static str, bool)]) {
    let down = kit.iter().filter(|(_, up)| !up).count();
    let word = if down == 0 { "healthy" } else { "degraded" };
    let mut lines = vec![Line::from(vec![
        "Summary: ".fg(Color::DarkGray),
        format!("System is {word}").fg(if down == 0 { Color::Green } else { Color::Yellow }),
        format!("{}.", moving(app)).into(),
    ])];
    // Two to a line, so a handful of services costs two rows rather than a column the
    // four questions below would have to give their height to.
    for pair in kit.chunks(2) {
        let mut spans = Vec::new();
        for (name, up) in pair {
            spans.push("  • ".fg(Color::DarkGray));
            spans.push(format!("{name:<12} — ").into());
            // Padded to a fixed width so the second column starts in the same place
            // whichever word the first one landed on.
            spans.push(if *up {
                format!("{:<14}", "running").fg(Color::Green)
            } else {
                format!("{:<14}", "down").fg(Color::Red)
            });
        }
        lines.push(Line::from(spans));
    }
    f.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::new().fg(if down == 0 { Color::Green } else { Color::Yellow }))
                .title(" wecode status "),
        ),
        area,
    );
}

/// The clause after *System is healthy*: what is moving, or why nothing is.
///
/// The owner's own example is the specification — *"System is healthy; no agent are
/// running due to blocked by approval"*. A status word alone is what the board printed
/// before, and four empty groups with a green footer described a workspace that had
/// finished everything and one whose operator had forgotten to start `wecode loop`
/// identically. Naming the cause is the whole of this line's job.
fn moving(app: &App) -> String {
    let live = app.active_agents.len();
    if live > 0 {
        let s = if live == 1 { "" } else { "s" };
        return format!("; {live} agent{s} running");
    }
    format!("; no agents are running due to {}", cause(&app.plan))
}

/// Why nothing is moving, ranked, first match winning.
///
/// The order is what makes the line useful: a cause the panes below cannot show comes
/// before one they already carry. It is `idle-inspector`'s ranking less the two rows that
/// need a fact the store does not hold yet — nothing wecode stores says a `wecode loop`
/// is alive, so row 2 here reads *dispatchable work and nothing running*, which cannot
/// tell an absent driver from one that started a second ago. Both want the same command.
fn cause(plan: &Plan) -> String {
    let projects: Vec<&Project> = plan.projects().collect();
    if projects.is_empty() {
        return "no projects yet — wecode project add <id> --repo <name> \"<objective>\"".into();
    }
    let open = leaves(plan);
    if open.is_empty() {
        return "all work is done".into();
    }
    let count = |f: &dyn Fn(&&Task) -> bool| open.iter().filter(|t| f(t)).count();
    let queued = count(&|t| t.status == TaskStatus::Ready && t.assignee.is_some());
    if queued > 0 {
        return format!("{queued} queued and nothing is dispatching — wecode loop");
    }
    let stopped = count(&|t| t.status.needs_a_human());
    if stopped > 0 {
        return format!("{stopped} blocked on you — press v-y");
    }
    let unstaffed = count(&|t| t.assignee.is_none());
    if unstaffed > 0 {
        return format!("{unstaffed} to assign — wecode assign <id> --to <post>");
    }
    if let Some(on) = open.iter().find_map(|t| waits_for(plan, &t.id)) {
        let n = count(&|t| waits_for(plan, &t.id).is_some());
        return format!("{n} waiting behind {on} — press v-g");
    }
    if let Some(p) = projects.iter().find(|p| plan.tasks_of(&p.id).next().is_none()) {
        return format!("nothing planned in {} — wecode task add {} \"<title>\"", p.id, p.id);
    }
    "nothing is queued".into()
}

/// The machinery around wecode, and whether each is doing its job.
///
/// Binary on purpose, and *down* means **something is wrong** rather than *idle*: a
/// supervisor with no runs to watch has nothing to be quiet about, and reading it as down
/// would put the band in amber every evening. An indicator that is amber every evening is
/// one nobody looks at on the morning it means something.
///
/// For the same reason a reach a workspace never configured is not listed at all. A solo
/// profile ships with no Telegram and no notify hook, and a front page that opened
/// *degraded* on a workspace doing exactly what it was asked to do would teach its reader
/// to stop believing the word. Whether a configured reach *answers* is `wecode doctor`'s
/// question — it takes a probe, and a front page may not run one every frame.
///
/// | service | listed when | running when |
/// |---|---|---|
/// | store | always | the last read of it succeeded |
/// | supervisor | always | no open run has gone quiet for [`SILENT`] |
/// | telegram | `[telegram] fetch` is set | a reply can reach wecode |
/// | notify | `[notify] command` is set | wecode can reach a person |
fn services(app: &App) -> Vec<(&'static str, bool)> {
    let quiet = crate::scheduler::stale(&app.beats, now_secs(), SILENT);
    let mut kit = vec![
        ("store", !app.status.starts_with("reload failed")),
        ("supervisor", quiet.is_empty()),
    ];
    if app.company.telegram.fetch.is_some() {
        kit.push(("telegram", app.company.telegram.answer.is_some()));
    }
    if app.company.notify.command.is_some() {
        kit.push(("notify", true));
    }
    kit
}

/// One pane: the count in its title, the rows it leads with, and the key that opens it.
///
/// The count is the answer to the question the pane exists to ask, so it is in the title
/// rather than buried in the rows — and it is the true total, not how many fitted. The
/// key is printed in the pane and again in the bar below, because a cockpit that has to
/// be remembered is one that gets closed.
fn pane(
    f: &mut Frame,
    area: Rect,
    title: &str,
    count: usize,
    key: &str,
    colour: Color,
    rows: Vec<Line<'static>>,
) {
    // Two borders and the line naming the key.
    let room = usize::from(area.height.saturating_sub(3));
    let mut lines = rows;
    if lines.len() > room || (count > lines.len() && lines.len() == room) {
        lines.truncate(room.saturating_sub(1));
    }
    let more = count.saturating_sub(lines.len());
    if more > 0 {
        lines.push(Line::from(format!(" … and {more} more").fg(Color::DarkGray)));
    }
    if count == 0 {
        lines.push(Line::from(" —".fg(Color::DarkGray)));
    }
    // Padded so every pane prints its key on the same row: four keys at four heights is
    // four things to find rather than one.
    while lines.len() < room {
        lines.push(Line::default());
    }
    lines.push(Line::from(format!(" detail: press {key}").fg(Color::DarkGray)));
    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::new().fg(colour))
                .title(format!(" {title}({count}) ")),
        ),
        area,
    );
}

/// Agent(n): every run still in flight, and whether anybody is still watching it.
///
/// The execution row is the source rather than the task status, for the reason the
/// active-agents strip uses it: `running` says work is in flight and cannot say which
/// harness, which attempt, or that two agents are on it at once.
fn agent_rows(app: &App) -> Vec<Line<'static>> {
    let quiet: Vec<i64> = crate::scheduler::stale(&app.beats, now_secs(), SILENT)
        .iter()
        .map(|r| r.exec)
        .collect();
    app.active_agents
        .iter()
        .map(|run| {
            let harness = app
                .audit
                .iter()
                .rev()
                .find(|line| line.session == run.session)
                .map_or(run.session.as_str(), |line| line.agent.as_str());
            let task = app
                .plan
                .task(&TaskId::new(&run.task))
                .map_or(run.task.as_str(), |t| t.title.as_str());
            let stalled = quiet.contains(&run.id);
            Line::from(vec![
                " • ".fg(Color::DarkGray),
                format!("{harness} #{} ", run.attempt).fg(Color::Cyan),
                truncate(task, 24).into(),
                if stalled {
                    " — stalled".fg(Color::Red)
                } else {
                    " — running".fg(Color::Green)
                },
            ])
        })
        .collect()
}

/// Blocked(n): every open task waiting on a prerequisite that has not finished.
fn blocked_rows(plan: &Plan) -> Vec<Line<'static>> {
    leaves(plan)
        .iter()
        .filter_map(|t| Some((t, waits_for(plan, &t.id)?)))
        .map(|(t, on)| {
            Line::from(vec![
                " • ".fg(Color::DarkGray),
                name(t).fg(Color::Red),
                " waits for ".fg(Color::DarkGray),
                on.into(),
            ])
        })
        .collect()
}

/// Roadmap(n): the epics and stories still open, and how far each has got.
///
/// The aggregating kinds and nothing else. An epic is one objective decomposed and a
/// story is one capability under it (ADR-0004); neither is dispatched, so *how far* is
/// the only question either can answer, and it is answered by counting the leaves under
/// them rather than by any status of their own.
fn roadmap_rows(plan: &Plan) -> Vec<Line<'static>> {
    open_aggregates(plan)
        .iter()
        .map(|t| {
            let (done, all) = under(plan, &t.id, 0);
            Line::from(vec![
                " • ".fg(Color::DarkGray),
                name(t).fg(Color::Blue),
                format!("  {done}/{all}").fg(Color::DarkGray),
            ])
        })
        .collect()
}

/// NEED YOU in full: the same rows the pane leads with, with room for the command.
///
/// The panel's own drawing, at whatever height the screen gives it. Five rows and a count
/// here too, and not because the pane is small: that is `[attention] max_open_items`, the
/// number of things this company has already said a person can hold at once, and the same
/// rule the board and the snapshot on a phone print. What this screen adds is the width —
/// the pane has room for the category, and this has room for the command to be typed as
/// it is printed.
fn needs_page(f: &mut Frame, area: Rect, app: &App) {
    let (rows, hidden) = super::approvals::owed(app);
    if rows.is_empty() {
        f.render_widget(
            Paragraph::new("nothing waits on you").block(titled(" NEED YOU(0) ", Color::Yellow)),
            area,
        );
        return;
    }
    super::approvals::panel(f, area, &rows, hidden);
}

/// A diagram, scrolled with the keys that move a cursor elsewhere.
///
/// Blocked and Roadmap both answer a shape question — what waits on what, what is part of
/// what — and a list cannot show a shape. Drawn as an indented tree because that is the
/// shape a terminal can hold honestly: the edges are the plan's own, and every node names
/// its state, so the row that is holding the rest up is the one the eye lands on.
fn diagram(f: &mut Frame, area: Rect, app: &mut App, panel: Panel, lines: Vec<Line<'static>>) {
    let lines = if lines.is_empty() {
        vec![Line::from(match panel {
            Panel::Roadmap => "no epics or stories open — wecode task add <p> --kind epic \"…\"",
            _ => "nothing is waiting on anything",
        })]
    } else {
        lines
    };
    // Never scrolled past its own end: a page that has run out reads exactly like a
    // cockpit that has hung, and nothing on it says a key would bring it back.
    let last = u16::try_from(lines.len()).unwrap_or(u16::MAX).saturating_sub(1);
    app.scroll = app.scroll.min(last);
    let colour = if panel == Panel::Roadmap { Color::Blue } else { Color::Red };
    f.render_widget(
        Paragraph::new(lines)
            .block(titled(&format!(" {} — j/k scrolls · esc back ", panel.title()), colour))
            .scroll((app.scroll, 0)),
        area,
    );
}

/// The waits-for graph: each blocked task, and under it what it is waiting on, to the
/// end of the chain.
fn blocked_dag(plan: &Plan) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    for t in leaves(plan).iter().filter(|t| waits_for(plan, &t.id).is_some()) {
        out.push(node(plan, t, 0, ""));
        chain(plan, &t.id, 1, &mut out);
    }
    out
}

/// One task's prerequisites, and theirs. Depth-capped rather than cycle-checked: the
/// cockpit is what somebody opens because the plan looks wrong, so it may not be the
/// thing a cycle hangs.
fn chain(plan: &Plan, id: &TaskId, depth: usize, out: &mut Vec<Line<'static>>) {
    if depth > DEEP {
        return;
    }
    for b in plan.blockers(id) {
        let (on, why) = match b {
            Blocker::Waiting(on) => (on, "after"),
            Blocker::Stuck(on, _) => (on, "stuck on"),
            Blocker::Missing(on) => {
                out.push(edge(depth, "missing", &format!("{on} — no such task")));
                continue;
            }
        };
        match plan.task(&on) {
            Some(t) => {
                out.push(node(plan, t, depth, why));
                chain(plan, &on, depth + 1, out);
            }
            None => out.push(edge(depth, why, on.as_str())),
        }
    }
}

/// The is-part-of graph from every open epic and story: what each is made of, and how
/// much of it has landed.
fn roadmap_dag(plan: &Plan) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    // Roots only — a story under an epic is drawn beneath it rather than twice.
    for t in open_aggregates(plan).iter().filter(|t| {
        t.parent.as_ref().is_none_or(|p| {
            plan.task(p).is_none_or(|up| !up.kind.aggregates() || up.status.is_closed())
        })
    }) {
        out.push(node(plan, t, 0, ""));
        parts(plan, &t.id, 1, &mut out);
    }
    out
}

fn parts(plan: &Plan, id: &TaskId, depth: usize, out: &mut Vec<Line<'static>>) {
    if depth > DEEP {
        return;
    }
    for t in board::sorted(plan.subtasks(id)).iter().filter(|t| !t.archived) {
        out.push(node(plan, t, depth, ""));
        parts(plan, &t.id, depth + 1, out);
    }
}

/// One row of a diagram: the indent, the edge it hangs off, the task, and its state —
/// which for an aggregating kind is how many of its leaves have landed, since an epic
/// has no acceptance of its own to have a status about.
fn node(plan: &Plan, t: &Task, depth: usize, why: &str) -> Line<'static> {
    let state = if t.kind.aggregates() {
        let (done, all) = under(plan, &t.id, 0);
        format!("{done}/{all}")
    } else {
        board::status_word(t.status).to_string()
    };
    let mut spans = vec![
        format!(" {:width$}{}", "", if depth == 0 { "" } else { "└─ " }, width = depth * 3)
            .fg(Color::DarkGray),
    ];
    if !why.is_empty() {
        spans.push(format!("{why} ").fg(Color::DarkGray));
    }
    spans.push(name(t).into());
    spans.push(format!("  {state}").fg(match t.status {
        TaskStatus::Done => Color::Green,
        TaskStatus::Running | TaskStatus::Verifying => Color::Cyan,
        s if s.needs_a_human() || s.is_dead_end() => Color::Yellow,
        _ => Color::DarkGray,
    }));
    Line::from(spans)
}

/// An edge whose other end is not in the plan — the one shape a node cannot draw.
fn edge(depth: usize, why: &str, what: &str) -> Line<'static> {
    Line::from(
        format!(" {:width$}└─ {why} {what}", "", width = depth * 3).fg(Color::Yellow),
    )
}

fn titled(title: &str, colour: Color) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(colour))
        .title(title.to_string())
}

/// Every open leaf on the board's own terms: not filed away, not closed, and nothing
/// broken down beneath it. A breakdown is not a piece of work — its pieces are — which is
/// why counting parents would put one job in front of a person twice.
fn leaves(plan: &Plan) -> Vec<&Task> {
    plan.projects()
        .flat_map(|p| plan.tasks_of(&p.id))
        .filter(|t| plan.subtasks(&t.id).next().is_none())
        .filter(|t| !t.archived && !t.status.is_closed())
        .collect()
}

/// The epics and stories still open, in the order the board sorts work.
fn open_aggregates(plan: &Plan) -> Vec<&Task> {
    board::sorted(
        plan.projects()
            .flat_map(|p| plan.tasks_of(&p.id))
            .filter(|t| t.kind.aggregates() && !t.archived && !t.status.is_closed()),
    )
}

/// The nearest prerequisite that has not finished, and `None` when none is left.
fn waits_for(plan: &Plan, id: &TaskId) -> Option<String> {
    plan.blockers(id).into_iter().next().map(|b| match b {
        Blocker::Waiting(on) | Blocker::Stuck(on, _) => on.to_string(),
        Blocker::Missing(on) => format!("{on} (missing)"),
    })
}

/// How many leaves under a task have landed, out of how many there are. Aggregating
/// kinds have no acceptance of their own: an epic is done when its children are.
fn under(plan: &Plan, id: &TaskId, depth: usize) -> (usize, usize) {
    let mut got = (0, 0);
    if depth > DEEP {
        return got;
    }
    for t in plan.subtasks(id) {
        if t.archived {
            continue;
        }
        if plan.subtasks(&t.id).next().is_none() {
            got.1 += 1;
            got.0 += usize::from(t.status.is_done());
        } else {
            let below = under(plan, &t.id, depth + 1);
            got.0 += below.0;
            got.1 += below.1;
        }
    }
    got
}

/// How a task is named in a pane: its kind and its id, the pair the tree already prints,
/// so a row torn out of the tree and put on the front page reads as the same row.
fn name(t: &Task) -> String {
    format!("{} {}", crate::render::kind_tag(t.kind), t.id)
}

fn truncate(s: &str, at: usize) -> String {
    if s.chars().count() <= at {
        return s.to_string();
    }
    s.chars().take(at.saturating_sub(1)).chain(['…']).collect()
}

#[cfg(test)]
mod tests {
    use super::super::tests::{app, app_on, dash, render};
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent};
    use wecode_core::{Measure, Scope, TaskKind};

    fn key(a: &mut App, c: char) {
        a.key(KeyEvent::from(KeyCode::Char(c)));
    }

    #[test]
    fn the_cockpit_opens_on_six_panes_and_the_board_is_one_key_away() {
        // The headline. The first question an operator has is never *what tasks exist*,
        // so the tree is no longer what a bare `wecode tui` puts on the glass.
        let mut a = app_on(None);
        assert_eq!(a.screen(), &dash(Panel::Dashboard));
        let out = render(&mut a, 118, 34);
        for shown in [
            "wecode status", "Summary:", "Agent(0)", "Need you(0)", "Blocked(0)",
            "Roadmap(0)", "store        — running", "supervisor   — running",
        ] {
            assert!(out.contains(shown), "missing `{shown}` in:\n{out}");
        }
        // A reach this workspace never asked for is not a service that is down. The solo
        // profile ships without either, and a front page that opened *degraded* on a
        // workspace doing what it was told teaches its reader to stop believing the word.
        assert!(out.contains("System is healthy"), "{out}");
        for absent in ["telegram", "notify"] {
            assert!(!out.contains(absent), "`{absent}` is not configured here:\n{out}");
        }
        a.company.telegram.fetch = Some("fetch.sh".into());
        a.company.telegram.answer = Some("answer.sh".into());
        a.company.notify.command = Some("say".into());
        let out = render(&mut a, 118, 34);
        assert!(out.contains("telegram     — running"), "and once it is, it is:\n{out}");
        assert!(out.contains("notify       — running"), "{out}");
        // Every pane names the key that opens it, in the pane and again in the bar: a
        // cockpit that has to be remembered is one that gets closed.
        for k in ["v-a", "v-y", "v-g (dag)", "v-r (dag)"] {
            assert!(out.contains(&format!("detail: press {k}")), "no `{k}`:\n{out}");
        }
        assert!(out.contains("home v-h"), "and the bar names them all:\n{out}");
        assert!(!out.contains("NEEDS YOU"), "the four groups are HOME's:\n{out}");

        // The board is `v h`, and esc comes back the way it went.
        key(&mut a, 'v');
        key(&mut a, 'h');
        assert_eq!(a.screen(), &super::super::Screen::Home);
        assert!(render(&mut a, 118, 34).contains("PORTFOLIO"));
        a.back();
        assert_eq!(a.screen(), &dash(Panel::Dashboard));
        // And it is the bottom of the stack: esc there is not a way out of the cockpit.
        a.back();
        assert_eq!(a.screen(), &dash(Panel::Dashboard));
        assert!(a.status.contains("q quits"), "{}", a.status);
    }

    #[test]
    fn the_summary_names_the_cause_when_nothing_is_running() {
        // The rule the owner's own example fixes: a status word alone described a
        // finished workspace and a forgotten `wecode loop` identically.
        let mut a = app();
        a.open(dash(Panel::Dashboard));
        let out = render(&mut a, 118, 34);
        assert!(out.contains("System is healthy"), "nothing is broken:\n{out}");
        assert!(out.contains("no agents are running due to"), "{out}");
        assert!(out.contains("to assign"), "every task is unstaffed:\n{out}");

        // Staffed and ready, and still nothing is moving: the cause moves up the rank to
        // the one thing that would start it.
        for id in ["layer", "keys"] {
            let t = a.plan.task(&TaskId::new(id)).unwrap().clone().assigned_to("impl");
            a.store.save_task(&t).unwrap();
            a.store.set_task_status(&TaskId::new(id), TaskStatus::Ready).unwrap();
        }
        a.reload();
        let out = render(&mut a, 118, 34);
        assert!(out.contains("queued and nothing is dispatching"), "{out}");
        assert!(out.contains("wecode loop"), "and the command that starts it:\n{out}");

        // A signature outranks the queue: `wecode loop` will not clear it.
        a.store.set_task_status(&TaskId::new("keys"), TaskStatus::NeedsApproval).unwrap();
        a.store.set_task_status(&TaskId::new("layer"), TaskStatus::Draft).unwrap();
        a.reload();
        let out = render(&mut a, 118, 34);
        assert!(out.contains("blocked on you"), "{out}");
        assert!(out.contains("Need you(1)"), "and the pane counts it:\n{out}");

        // Finished is not the same reading as stopped, and says so.
        for id in ["layer", "keys"] {
            a.store.set_task_status(&TaskId::new(id), TaskStatus::Done).unwrap();
        }
        a.reload();
        assert!(render(&mut a, 118, 34).contains("all work is done"), "{}", "");
    }

    #[test]
    fn a_run_nobody_is_watching_reads_stalled_rather_than_running() {
        let mut a = app();
        a.open(dash(Panel::Dashboard));
        let id = TaskId::new("keys");
        let run = a.store.start_execution(&id, "agent-7", None, Some(1234)).unwrap();
        a.reload();
        let out = render(&mut a, 118, 34);
        assert!(out.contains("Agent(1)"), "the count is in the title:\n{out}");
        assert!(out.contains("agent-7 #1"), "{out}");
        assert!(out.contains("— running"), "somebody is watching it:\n{out}");
        assert!(out.contains("1 agent running"), "and the summary says so:\n{out}");
        assert!(out.contains("supervisor   — running"), "{out}");

        // A supervisor that has stopped saying so, on the sweep's own reading. Backdated
        // rather than waited for: five minutes is the window, not the test.
        a.store
            .backdate_run(run, now_secs().saturating_sub(SILENT.as_secs() + 1), None)
            .unwrap();
        a.reload();
        let out = render(&mut a, 118, 34);
        assert!(out.contains("— stalled"), "{out}");
        assert!(out.contains("System is degraded"), "a service is down:\n{out}");
        assert!(out.contains("supervisor   — down"), "{out}");
    }

    #[test]
    fn blocked_and_roadmap_open_as_diagrams_because_both_ask_a_shape() {
        let mut a = app();
        a.store
            .save_task(&aggregate("cockpit", TaskKind::Epic, None))
            .unwrap();
        a.store
            .save_task(&aggregate("panes", TaskKind::Story, Some("cockpit")))
            .unwrap();
        let bench = super::super::tests::task("bench", "benchmark it", "benches/**")
            .after("layer")
            .under("panes");
        a.store.save_task(&bench).unwrap();
        a.reload();
        a.open(dash(Panel::Dashboard));

        let out = render(&mut a, 118, 34);
        assert!(out.contains("Blocked(1)"), "one task waits on another:\n{out}");
        assert!(out.contains("feat bench waits for layer"), "{out}");
        assert!(out.contains("Roadmap(2)"), "the epic and the story:\n{out}");
        assert!(out.contains("EPIC cockpit  0/1"), "and how far it has got:\n{out}");

        // `v g` and `v r` open the shape, which a list cannot show.
        key(&mut a, 'v');
        key(&mut a, 'g');
        assert_eq!(a.screen(), &dash(Panel::Blocked));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("BLOCKED"), "{out}");
        assert!(out.contains("└─ after feat layer"), "the edge and its other end:\n{out}");

        a.back();
        key(&mut a, 'v');
        key(&mut a, 'r');
        assert_eq!(a.screen(), &dash(Panel::Roadmap));
        let out = render(&mut a, 118, 24);
        assert!(out.contains("EPIC cockpit"), "{out}");
        assert!(out.contains("   └─ story panes"), "the story hangs off it:\n{out}");
        assert!(out.contains("      └─ feat bench  draft"), "and the work under it:\n{out}");
        // An epic has no acceptance of its own — it is done when its children are — so
        // what it says here is how many of them have landed rather than a status.
        assert!(out.contains("EPIC cockpit  0/1"), "{out}");
        // A page has no selection to move, so the same keys scroll it.
        key(&mut a, 'j');
        assert_eq!(a.scroll, 1);
    }

    #[test]
    fn a_pane_that_overflows_counts_what_it_could_not_draw() {
        // Nothing on the front page scrolls, so a row that does not fit is a row nobody
        // can reach — and the count in the title is the answer either way.
        let mut a = app();
        for n in 0..9 {
            let t = super::super::tests::task(
                &format!("extra-{n}"),
                "another piece",
                &format!("src/extra-{n}/**"),
            );
            a.store.save_task(&t).unwrap();
            a.store
                .set_task_status(&TaskId::new(format!("extra-{n}")), TaskStatus::NeedsApproval)
                .unwrap();
        }
        a.reload();
        a.open(dash(Panel::Dashboard));
        let out = render(&mut a, 118, 26);
        assert!(out.contains("Need you(9)"), "the title carries the whole count:\n{out}");
        assert!(out.contains("… and 4 more"), "and says what it stood down:\n{out}");

        // `v y` is the same rows with room for the command that clears each.
        key(&mut a, 'v');
        key(&mut a, 'y');
        assert_eq!(a.screen(), &dash(Panel::Needs));
        let out = render(&mut a, 118, 26);
        assert!(out.contains("wecode merge extra-0"), "{out}");
    }

    #[test]
    fn a_letter_that_names_no_screen_says_which_ones_there_are() {
        let mut a = app_on(None);
        key(&mut a, 'v');
        key(&mut a, 'x');
        assert_eq!(a.screen(), &dash(Panel::Dashboard), "nothing opened");
        assert!(a.status.contains("v-r"), "{}", a.status);
        assert_eq!(Panel::of_key('q'), None);
        for (c, want) in [
            ('d', Panel::Dashboard),
            ('y', Panel::Needs),
            ('g', Panel::Blocked),
            ('r', Panel::Roadmap),
        ] {
            assert_eq!(Panel::of_key(c), Some(want));
            assert!(KEYS.contains(&format!("v-{c}")), "the bar names v-{c}");
        }
    }

    #[test]
    fn the_front_page_holds_at_any_size() {
        for (w, h) in [(40u16, 12u16), (20, 8), (200, 60)] {
            let out = render(&mut app_on(None), w, h);
            assert!(!out.is_empty(), "{w}x{h} produced nothing");
        }
        assert_eq!(truncate("short", 24), "short");
        assert_eq!(truncate(&"x".repeat(30), 5), "xxxx…");
    }

    /// An epic or a story: no scope and no acceptance of its own, which is what
    /// aggregating means.
    fn aggregate(id: &str, kind: TaskKind, parent: Option<&str>) -> wecode_core::Task {
        let t = wecode_core::Task::new(id, "caching", "a slice of the cockpit")
            .of_kind(kind)
            .accepting(Measure::Command { cmd: "true".into(), expect_status: 0 })
            .scoped(Scope::write(&["crates/**"]));
        match parent {
            Some(p) => t.under(p),
            None => t,
        }
    }
}
