//! The cockpit: a full-screen board with the same four columns at every level —
//! what · status · spend · needs-you.
//!
//! Health is **computed**, never reported by an agent: it comes from status,
//! admission defects, the audit ledger and declared budgets. It is not a column,
//! because every cause of amber or red already writes a needs-you entry — it is
//! the colour of that cell. A health column beside it only ever repeated it, and
//! a progress bar on a leaf task only ever restated its status.
//!
//! Two levels of work means two levels of board — the portfolio lists projects
//! with the whole task tree under each, and a focus view narrows to one of them.
//! The tree goes all the way down: a plan that hangs its real work off a parent
//! task showed none of it while the portfolio stopped at roots.
//!
//! A project's status cell carries its **standing** — how much of its work is
//! finished — beside the state somebody declared for it. Still no progress column:
//! this is one reading in the cell that already answers *where is this*, and it goes
//! on projects only. `> active` says a project is open for work, which is a fact
//! about intent; `> active 2/5` says where the work has got to, which is the
//! question somebody away from their desk is actually asking. A task row keeps the
//! word alone, for the reason the progress bar went: on a leaf it would restate the
//! status, and a parent's subtasks are the rows immediately beneath it.
//!
//! A fraction says how far, not whether it can go further, so the needs-you cell
//! carries the two ends it cannot: work nobody has been handed, and work that has all
//! landed under a project still declared open. Both are a project sitting still with
//! every column around it reading healthy, and neither is resolved by the next tick.

use std::collections::BTreeMap;

use wecode_core::{
    Number, Plan, Project, ProjectId, ProjectStatus, Task, TaskId, TaskKind, TaskStatus, admission,
};
use wecode_store::AuditLine;

use crate::render::kind_tag;

/// Which kinds each project refuses without a design — its playbook's gate.
///
/// Resolved by the caller, because it takes each repo's playbook and the board
/// computes from values alone. A project absent from the map gates nothing, so the
/// board's defect counts agree with `wecode check` whether or not a playbook exists.
pub(crate) type DesignGates = BTreeMap<ProjectId, Vec<TaskKind>>;

/// The gate for one task's project. `&[]` when the project gates nothing.
fn gate_of<'a>(gates: &'a DesignGates, t: &Task) -> &'a [TaskKind] {
    gates.get(&t.project).map_or(&[], Vec::as_slice)
}

const RESET: &str = "\x1b[0m";
const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const AMBER: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Health {
    Green,
    Amber,
    Red,
}

/// Everything the board knows about one project or task, all of it derived.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Vitals {
    pub(crate) health: Health,
    pub(crate) spent: u64,
    pub(crate) budget: Option<u64>,
    pub(crate) alarms: usize,
    pub(crate) denials: usize,
    pub(crate) defects: usize,
    pub(crate) needs: Vec<String>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) struct Counts {
    spent: u64,
    alarms: usize,
    denials: usize,
}

impl Counts {
    fn add(&mut self, other: Self) {
        self.spent += other.spent;
        self.alarms += other.alarms;
        self.denials += other.denials;
    }
}

/// Spend and incidents folded from the ledger once, split by what they are
/// attributed to.
///
/// The two maps are separate because a record naming a task also names its
/// project: counting it in both would double every number.
#[derive(Default)]
pub(crate) struct Ledger {
    by_task: BTreeMap<String, Counts>,
    by_project: BTreeMap<String, Counts>,
}

pub(crate) fn ledger_index(audit: &[AuditLine]) -> Ledger {
    let mut out = Ledger::default();
    for l in audit {
        let mut c = Counts::default();
        if l.action == "spend" {
            // target is "<tokens>t/<secs>s"
            if let Some(t) = l.target.split('t').next()
                && let Ok(n) = t.parse::<u64>()
            {
                c.spent = n;
            }
        }
        if l.is_alarm() {
            c.alarms = 1;
        } else if l.is_denial() {
            c.denials = 1;
        }
        // A task-level record belongs to the task; the project sees it by rollup.
        if l.task.is_empty() {
            if !l.project.is_empty() {
                out.by_project.entry(l.project.clone()).or_default().add(c);
            }
        } else {
            out.by_task.entry(l.task.clone()).or_default().add(c);
        }
    }
    out
}

/// Rolled-up counts for a task and its subtasks.
fn task_totals(plan: &Plan, id: &TaskId, l: &Ledger) -> Counts {
    let mut total = l.by_task.get(id.as_str()).copied().unwrap_or_default();
    for kid in plan.subtasks(id) {
        total.add(task_totals(plan, &kid.id, l));
    }
    total
}

/// A project's own records plus every task in it.
fn project_totals(plan: &Plan, id: &ProjectId, l: &Ledger) -> Counts {
    let mut total = l.by_project.get(id.as_str()).copied().unwrap_or_default();
    // Every task, not just roots: a subtask's spend is the project's spend too, and
    // walking roots recursively would reach the same set by a longer road.
    for t in plan.tasks_of(id) {
        total.add(l.by_task.get(t.id.as_str()).copied().unwrap_or_default());
    }
    total
}

pub(crate) fn project_vitals(
    plan: &Plan,
    p: &Project,
    l: &Ledger,
    known_repos: &[String],
) -> Vitals {
    let c = project_totals(plan, &p.id, l);
    let defects = admission::check_project(p, plan, known_repos).len();
    let prog = plan.progress(&p.id);
    let over = p.budget.tokens.is_some_and(|b| c.spent > b);
    let stalled = c.spent > 0 && prog == 0.0 && p.status == ProjectStatus::Active;

    let mut needs = Vec::new();
    push_common(&mut needs, c.alarms, defects, over, stalled, c.denials);
    let waiting = plan
        .tasks_of(&p.id)
        .filter(|t| t.status.needs_a_human())
        .count();
    if waiting > 0 {
        needs.push(format!("{waiting} to answer"));
    }
    // Counted at the project level even though every subtask now has a row of its
    // own: the rows are what to read next, and this is the number that says whether
    // to read them at all. A count on the project also survives a long tree
    // scrolling its stuck row off the screen.
    let stuck = plan
        .tasks_of(&p.id)
        .filter(|t| !t.status.is_closed() && is_stuck(plan, t))
        .count();
    if stuck > 0 {
        needs.push(format!("{stuck} stuck"));
    }
    let unowned = unowned(plan, &p.id);
    if unowned > 0 {
        needs.push(format!("{unowned} to assign"));
    }
    // The far end of the standing. Nothing closes a project on its own, so one whose
    // last task landed weeks ago still reads `active` — and the only move left is the
    // operator's, which is the definition of this cell.
    let closable = !p.status.is_closed() && standing(plan, &p.id).is_some_and(|(d, n)| d == n);
    if closable {
        needs.push("ready to close".to_string());
    }
    if plan.tasks_of(&p.id).next().is_none() {
        needs.push("no tasks".to_string());
    }

    Vitals {
        health: health_of(
            c.alarms,
            over,
            defects,
            stalled,
            c.denials,
            waiting + stuck + unowned + usize::from(closable),
        ),
        spent: c.spent,
        budget: p.budget.tokens,
        alarms: c.alarms,
        denials: c.denials,
        defects,
        needs,
    }
}

pub(crate) fn task_vitals(plan: &Plan, t: &Task, l: &Ledger, gates: &DesignGates) -> Vitals {
    let c = task_totals(plan, &t.id, l);
    let defects = admission::check_task(t, plan, gate_of(gates, t)).len();
    let prog = task_progress(plan, t);
    let over = t.budget.tokens.is_some_and(|b| c.spent > b);
    let stalled = c.spent > 0 && prog == 0.0 && t.status == TaskStatus::Running;

    let mut needs = Vec::new();
    push_common(&mut needs, c.alarms, defects, over, stalled, c.denials);
    let mut awaiting = usize::from(t.status.needs_a_human());
    if t.status.needs_a_human() {
        needs.push(t.status.as_str().to_string());
    }
    if t.status == TaskStatus::Draft && defects == 0 && t.assignee.is_none() {
        needs.push("unassigned".to_string());
    }
    // A dead-end prerequisite is a question for a person as surely as a failed
    // task is — no tick will release this row, so a green "waiting" would lie.
    for b in plan.blockers(&t.id) {
        match b {
            wecode_core::Blocker::Stuck(id, status) => {
                needs.push(format!("stuck on {id} ({})", status.as_str()));
                awaiting += 1;
            }
            wecode_core::Blocker::Missing(m) => {
                needs.push(format!("{m} missing"));
                awaiting += 1;
            }
            wecode_core::Blocker::Waiting(_) => {}
        }
    }

    Vitals {
        health: health_of(c.alarms, over, defects, stalled, c.denials, awaiting),
        spent: c.spent,
        budget: t.budget.tokens,
        alarms: c.alarms,
        denials: c.denials,
        defects,
        needs,
    }
}

/// Whether a task is blocked by something no tick will ever release — a failed,
/// dropped or missing prerequisite. Such work cannot advance on its own.
fn is_stuck(plan: &Plan, t: &Task) -> bool {
    plan.blockers(&t.id)
        .iter()
        .any(|b| !matches!(b, wecode_core::Blocker::Waiting(_)))
}

fn push_common(
    needs: &mut Vec<String>,
    alarms: usize,
    defects: usize,
    over: bool,
    stalled: bool,
    denials: usize,
) {
    if alarms > 0 {
        needs.push(format!("{alarms} alarm"));
    }
    if defects > 0 {
        needs.push(format!("{defects} defect"));
    }
    if over {
        needs.push("over budget".to_string());
    }
    if stalled {
        needs.push("stalled".to_string());
    }
    // A denial used to be visible only as an amber dot in the health column. Now
    // that health is the colour of this cell, the cell has to carry the words.
    if denials > 0 {
        needs.push(format!("{denials} denied"));
    }
}

/// One rule, used for both levels. Red is reserved for the irreversible and the
/// already-breached; a question waiting on a person is amber, not red.
fn health_of(
    alarms: usize,
    over: bool,
    defects: usize,
    stalled: bool,
    denials: usize,
    awaiting: usize,
) -> Health {
    if alarms > 0 || over {
        Health::Red
    } else if defects > 0 || stalled || denials > 0 || awaiting > 0 {
        Health::Amber
    } else {
        Health::Green
    }
}

/// A task's own progress: done leaves beneath it, or itself if it is a leaf.
fn task_progress(plan: &Plan, t: &Task) -> f32 {
    let leaves = leaf_statuses(plan, t);
    if leaves.is_empty() {
        return 0.0;
    }
    let done = leaves.iter().filter(|s| **s == TaskStatus::Done).count();
    done as f32 / leaves.len() as f32
}

fn leaf_statuses(plan: &Plan, t: &Task) -> Vec<TaskStatus> {
    let kids: Vec<&Task> = plan.subtasks(&t.id).collect();
    if kids.is_empty() {
        return vec![t.status];
    }
    kids.iter().flat_map(|k| leaf_statuses(plan, k)).collect()
}

fn spend_cell(spent: u64, budget: Option<u64>) -> String {
    let k = |n: u64| {
        if n >= 1000 {
            format!("{}k", n / 1000)
        } else {
            n.to_string()
        }
    };
    match budget {
        Some(b) => format!("{:>5}/{:<5}", k(spent), k(b)),
        None => format!("{:>5}{:<6}", k(spent), ""),
    }
}

fn title_bar(level: &str, subject: &str, hint: &str) -> String {
    let head = format!(" {level} · {subject} ");
    let pad = 76usize.saturating_sub(head.chars().count() + hint.chars().count() + 3);
    format!(
        "{BOLD}┌{head}{RESET}{DIM}{}{hint} ─┐{RESET}\n",
        "─".repeat(pad)
    )
}

/// Room for the longest status word plus a two-digit standing beside it.
///
/// Padded, never cut: a plan with more tasks than that pushes the columns to its
/// right rather than losing a digit, because a ragged line still reads and `1/2` where
/// `1/20` was meant does not. `the_status_column_fits_every_word_a_row_can_carry`
/// holds the number to the vocabulary, so a new status is a failing test rather than a
/// board that quietly stopped lining up.
const STATUS_W: usize = 15;

fn header_row() -> String {
    format!(
        "{DIM}│ {:>4} {:<26} {:<STATUS_W$} {:<12} {}{RESET}\n",
        "#", "what", "status", "spend", "needs you"
    )
}

/// The short number, in a column of its own rather than inside `what`.
///
/// `what` truncates at 26 and carries the indent, so a number folded into it would be
/// the first thing a deep row lost and would sit at a different column on every level.
/// A number that cannot be read off in one glance is a number nobody types.
///
/// Blank rather than `—` when there is none, unlike every other cell here. A missing
/// spend is a fact about the run; a missing number is a plan nothing has minted numbers
/// for, which is only ever an in-memory one. This is a gutter, not a reading.
fn number_cell(n: Option<Number>) -> String {
    n.map_or_else(|| " ".repeat(4), |n| format!("{n:>4}"))
}

/// The declared state alongside the computed one. Both, always: a task can be
/// entirely healthy and not started, and a board that shows only the faults cannot
/// say which. The needs-you cell wears the computed health as its colour.
///
/// A filed-away row is drawn grey. There is nowhere in these columns to write the word
/// — `what` truncates at 26, so a marker there is the first thing a deep row loses —
/// and a row that is only ever on screen because somebody asked for everything must
/// still not read as live.
fn row(number: Option<Number>, label: &str, status: &str, v: &Vitals, archived: bool) -> String {
    let needs = if v.needs.is_empty() {
        format!("{DIM}—{RESET}")
    } else {
        let words = v.needs.join(", ");
        match v.health {
            Health::Red => format!("{RED}{words}{RESET}"),
            Health::Amber => format!("{AMBER}{words}{RESET}"),
            Health::Green => words,
        }
    };
    let line = format!(
        "│ {} {:<26} {:<STATUS_W$} {:<12} {}",
        number_cell(number),
        truncate(label, 26),
        status,
        spend_cell(v.spent, v.budget),
        needs
    );
    if archived {
        // Re-opened after every reset the row already carries: the needs-you cell closes
        // its own colour, and the grey would otherwise end wherever that cell does.
        format!(
            "{DIM}{}{RESET}\n",
            line.replace(RESET, &format!("{RESET}{DIM}"))
        )
    } else {
        format!("{line}\n")
    }
}

/// How far a project's work has got: finished leaves over the leaves there are.
///
/// `None` when nothing has been planned yet. `0/0` is a reading of nothing, and the
/// needs-you cell already says `no tasks` for that case — which is the sentence, not
/// the arithmetic.
///
/// Leaves, and the same ones [`Plan::progress`] divides, so this cell cannot disagree
/// with the percentage `wecode plan` and `wecode show` print for the same project. Two
/// ways of counting would be two answers to *how far along is this*, and the board
/// would be the surface people stopped trusting. Dropped work therefore stays in the
/// denominator, as it does there: abandoning a task is a decision to record, not a way
/// for a project to finish.
///
/// Shown as a fraction rather than as that percentage because the board is read at a
/// glance: `99%` is what 199 of 200 and 999 of 1000 both round to, and how many tasks
/// are left is the part somebody acts on.
fn standing(plan: &Plan, id: &ProjectId) -> Option<(usize, usize)> {
    let leaves: Vec<&Task> = plan
        .tasks_of(id)
        .filter(|t| plan.subtasks(&t.id).next().is_none())
        .collect();
    if leaves.is_empty() {
        return None;
    }
    let done = leaves.iter().filter(|t| t.status.is_done()).count();
    Some((done, leaves.len()))
}

/// Open work nobody has been handed — the leaves still to do that name no post.
///
/// Not slow work: stopped work. `wecode task add` moves a task out of `draft` only once
/// it names a post, and [`crate::scheduler::dispatchable`] only ever picks up one that
/// has an assignee — so no tick promotes these and no loop starts them, however green
/// every other column reads.
///
/// The leaves the standing divides, less the closed and the filed-away, so the two
/// readings are halves of one sentence: `1/4` says where the work got to, `3 to assign`
/// says why it stopped there. Parents go with the parked — a breakdown is not
/// dispatched, its pieces are, and staffing what somebody archived teaches them to
/// ignore the cell.
///
/// Amber here while the task row calls the same task `unassigned` in green, on purpose:
/// one leaf mid-planning is normal and its own row is right there. The project row is
/// the one an operator reads from a phone, and there the count answers *does this need
/// me* — nothing else is going to start this.
fn unowned(plan: &Plan, id: &ProjectId) -> usize {
    plan.tasks_of(id)
        .filter(|t| plan.subtasks(&t.id).next().is_none())
        .filter(|t| !t.archived && !t.status.is_closed() && t.assignee.is_none())
        .count()
}

/// The declared state, and beside it where the work under it has got to.
///
/// The standing sits on the project row and nowhere else, for the reason the stuck
/// count does: the rows beneath are what to read next, and this is the number that
/// says whether to read them at all — and it is still there when a long tree has
/// scrolled every one of them off the screen.
fn project_status(plan: &Plan, p: &Project) -> String {
    let word = p.status.as_str();
    match standing(plan, &p.id) {
        Some((done, total)) => format!("{} {word} {done}/{total}", p.status.mark()),
        None => format!("{} {word}", p.status.mark()),
    }
}

/// Short enough for a column; `needs-approval` and `needs-input` are why.
fn status_word(s: TaskStatus) -> &'static str {
    match s {
        TaskStatus::NeedsApproval => "approval",
        TaskStatus::NeedsInput => "input",
        other => other.as_str(),
    }
}

fn task_status(t: &Task) -> String {
    format!("{} {}", t.status.mark(), status_word(t.status))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

fn footer(hint: &str) -> String {
    format!("{DIM}└─ {hint}{RESET}\n")
}

/// A project's root tasks in id order.
fn roots_of<'a>(plan: &'a Plan, p: &ProjectId) -> Vec<&'a Task> {
    let mut roots: Vec<&Task> = plan.roots_of(p).collect();
    roots.sort_by(|a, b| a.id.cmp(&b.id));
    roots
}

/// Subtasks in id order, so two runs of the same command agree.
fn kids_of<'a>(plan: &'a Plan, t: &Task) -> Vec<&'a Task> {
    let mut kids: Vec<&Task> = plan.subtasks(&t.id).collect();
    kids.sort_by(|a, b| a.id.cmp(&b.id));
    kids
}

/// A tree being drawn, and how many rows it left out.
///
/// The count travels with the text because only the walk that skipped the rows knows
/// how many there were, and a view that shows less than everything has to be able to
/// say so.
#[derive(Default, Debug)]
struct Drawn {
    text: String,
    hidden: usize,
}

/// A task's row, then every task beneath it, indented one step per level.
///
/// Recursive to the leaves. Both views used to stop one level short of wherever
/// their subject was — the portfolio at root tasks, a project focus at the same —
/// so a plan that broke its work down at all hid the half that was broken down.
///
/// A filed-away task stops the walk, and its subtasks are not counted separately: they
/// were put away as one group and reading them back as four hidden rows would say there
/// is far more out of sight than there is.
///
/// Depth is spelled in spaces rather than tree glyphs because this column
/// truncates at 26: a glyph that survives the cut while the id does not costs a
/// reader the one thing the row is for.
fn subtree(
    plan: &Plan,
    t: &Task,
    l: &Ledger,
    gates: &DesignGates,
    depth: usize,
    show_all: bool,
    out: &mut Drawn,
) {
    if t.archived && !show_all {
        out.hidden += 1;
        return;
    }
    out.text.push_str(&row(
        t.number,
        &format!("{}{} {}", "  ".repeat(depth), kind_tag(t.kind), t.id),
        &task_status(t),
        &task_vitals(plan, t, l, gates),
        t.archived,
    ));
    for k in kids_of(plan, t) {
        subtree(plan, k, l, gates, depth + 1, show_all, out);
    }
}

/// The portfolio view: one line per project, then the whole tree of its tasks.
pub(crate) fn portfolio(
    plan: &Plan,
    audit: &[AuditLine],
    known_repos: &[String],
    gates: &DesignGates,
    show_all: bool,
) -> String {
    if plan.is_empty() {
        return "no projects yet — wecode project add <id> --repo <name> \"<objective>\"\n"
            .to_string();
    }
    let l = ledger_index(audit);
    let mut out = title_bar("L0", "PORTFOLIO", "wecode board <id> to descend");
    out.push_str(&header_row());

    let projects: Vec<&Project> = if show_all {
        plan.all_projects().collect()
    } else {
        plan.projects().collect()
    };
    let mut drawn = Drawn::default();
    for p in projects {
        drawn.text.push_str(&row(
            p.number,
            &format!("PROJECT {} [{}]", p.id, p.repo),
            &project_status(plan, p),
            &project_vitals(plan, p, &l, known_repos),
            p.archived,
        ));
        for t in roots_of(plan, &p.id) {
            subtree(plan, t, &l, gates, 1, show_all, &mut drawn);
        }
    }
    out.push_str(&drawn.text);
    // Projects, plus whatever the walk stopped at. A hidden project's tasks are not
    // added to that: the project is the one row this view left out on their behalf.
    let hidden = if show_all {
        0
    } else {
        plan.archived_count() + drawn.hidden
    };
    out.push_str(&footer(&if hidden > 0 {
        format!("alarms freeze dispatch · {hidden} archived, --all to include")
    } else {
        "alarms freeze dispatch · silence on green".to_string()
    }));
    out
}

/// A focused view on either level: the subject, what is beneath it, its incidents.
///
/// `named` is what the operator typed — an id or a short number. Everything past the
/// lookup uses the subject's own id, because the incident filter and the title both have
/// to name what the ledger names.
///
/// Filed-away rows are hidden here as in the portfolio, with one exception: a subject
/// that is itself archived shows its group in full. Filing a task away takes its
/// subtasks with it, so the group is one thing — and naming it is the only way to reach
/// inside, there being no `--all` at this level.
pub(crate) fn focus(
    plan: &Plan,
    audit: &[AuditLine],
    named: &str,
    known_repos: &[String],
    gates: &DesignGates,
) -> String {
    let l = ledger_index(audit);

    if let Some(p) = plan.project_ref(named) {
        let id = p.id.as_str();
        let v = project_vitals(plan, p, &l, known_repos);
        let mut out = title_bar("L1", id, "wecode board to go up");
        out.push_str(&format!("{DIM}│ {}  [{}]{RESET}\n", p.objective, p.repo));
        out.push_str(&header_row());
        out.push_str(&row(
            p.number,
            &format!("PROJECT {} [{}]", p.id, p.repo),
            &project_status(plan, p),
            &v,
            p.archived,
        ));
        let mut drawn = Drawn::default();
        for t in roots_of(plan, &p.id) {
            subtree(plan, t, &l, gates, 1, p.archived, &mut drawn);
        }
        out.push_str(&drawn.text);
        // Every incident in the project, including its tasks'. The project row
        // rolls their alarms up, so hiding the rows leaves a count with nothing to
        // explain it — and no way to find what tripped.
        out.push_str(&incidents(audit, |x| x.project == id));
        out.push_str(&footer(&hint_for(&v, drawn.hidden)));
        return out;
    }

    if let Some(t) = plan.task_ref(named) {
        let id = t.id.as_str();
        let v = task_vitals(plan, t, &l, gates);
        let mut out = title_bar("L2", id, "wecode board to go up");
        out.push_str(&format!("{DIM}│ {}{RESET}\n", t.title));
        out.push_str(&header_row());
        out.push_str(&row(
            t.number,
            &format!("{} {}", kind_tag(t.kind), t.id),
            &task_status(t),
            &v,
            t.archived,
        ));
        let mut drawn = Drawn::default();
        for k in kids_of(plan, t) {
            subtree(plan, k, &l, gates, 1, t.archived, &mut drawn);
        }
        out.push_str(&drawn.text);
        out.push_str(&incidents(audit, |x| x.task == id));
        out.push_str(&footer(&hint_for(&v, drawn.hidden)));
        return out;
    }

    format!("no project or task: {named}\n")
}

/// The footer of a focused view, and what it left out. `--all` does not reach this
/// level, so the way back in is to name the filed-away task — which is what the count
/// is there to prompt.
fn hint_for(v: &Vitals, hidden: usize) -> String {
    let hint = if v.needs.is_empty() {
        "nothing needs you here"
    } else {
        "wecode check <id> · wecode audit --alarms"
    };
    if hidden == 0 {
        hint.to_string()
    } else {
        format!("{hidden} archived, hidden — name one to open it · {hint}")
    }
}

fn incidents(audit: &[AuditLine], mine: impl Fn(&AuditLine) -> bool) -> String {
    let found: Vec<&AuditLine> = audit.iter().filter(|l| mine(l) && l.is_denial()).collect();
    if found.is_empty() {
        return String::new();
    }
    let mut out = format!("{DIM}│{RESET}\n{DIM}│ incidents{RESET}\n");
    for l in found.iter().take(5) {
        let mark = if l.is_alarm() {
            format!("{RED}⚡{RESET}")
        } else {
            format!("{AMBER}✗{RESET}")
        };
        // The target is the point of an incident line: what was touched.
        out.push_str(&format!(
            "│  {mark} {:<10} {:<6} {:<24} {DIM}{}{RESET}\n",
            l.post,
            l.action,
            truncate(&l.target, 24),
            l.detail
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Measure, Scope};

    fn repos() -> Vec<String> {
        vec!["wecode".to_string()]
    }

    fn no_gates() -> DesignGates {
        DesignGates::new()
    }

    /// The vitals of `caching`, the project every fixture here builds.
    fn vitals(p: &Plan, l: &Ledger) -> Vitals {
        project_vitals(p, p.project(&ProjectId::new("caching")).unwrap(), l, &repos())
    }

    /// The same, for the tests with no ledger to speak of.
    fn quiet(p: &Plan) -> Vitals {
        vitals(p, &ledger_index(&[]))
    }

    /// A project with one well-formed task, so a defect in a test is one the test
    /// introduced rather than background noise.
    fn plan() -> Plan {
        let mut p = Plan::new();
        p.add_project(
            Project::new("caching", "cut export p99 below 500ms", "wecode")
                .measured(Measure::Command {
                    cmd: "cargo bench".into(),
                    expect_status: 0,
                })
                .budgeted(Budget {
                    tokens: Some(1000),
                    wall_secs: Some(60),
                }),
        )
        .unwrap();
        p.add_task(good_task("t1", "write the cache layer", "crates/cache/**"))
            .unwrap();
        p
    }

    fn good_task(id: &str, title: &str, glob: &str) -> Task {
        Task::new(id, "caching", title)
            .accepting(Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 0,
            })
            .scoped(Scope::write(&[glob]))
            .budgeted(Budget {
                tokens: Some(500),
                wall_secs: Some(30),
            })
    }

    fn line(project: &str, task: &str, action: &str, target: &str, outcome: &str) -> AuditLine {
        AuditLine {
            seq: 1,
            at: 0,
            session: "s-test".into(),
            post: "impl".into(),
            human: "chandra".into(),
            agent: "claude-code".into(),
            project: project.into(),
            task: task.into(),
            source: "broker".into(),
            action: action.into(),
            target: target.into(),
            outcome: outcome.into(),
            mode: "regimented".into(),
            detail: "d".into(),
        }
    }

    #[test]
    fn empty_plan_suggests_a_next_step() {
        assert!(portfolio(&Plan::new(), &[], &repos(), &no_gates(), false).contains("project add"));
    }

    #[test]
    fn portfolio_lists_projects_and_their_root_tasks() {
        let out = portfolio(&plan(), &[], &repos(), &no_gates(), false);
        assert!(out.contains("caching"), "{out}");
        assert!(out.contains("feat t1"), "{out}");
        assert!(out.contains("L0 · PORTFOLIO"), "{out}");
    }

    /// A task row as it appears at a given depth, number column included.
    ///
    /// Spelled as the row is built rather than as a hand-counted string of spaces, so a
    /// depth assertion pins the tree indent and not the width of the handle beside it.
    fn at_depth(label: &str, depth: usize) -> String {
        format!("│ {} {}{label}", number_cell(None), "  ".repeat(depth))
    }

    /// `t1` with `t2` under it and `t3` under that — three levels, so a view that
    /// stops one short of the leaves is caught rather than passing on the middle row.
    fn nested() -> Plan {
        let mut p = plan();
        p.add_task(good_task("t2", "design the cache keys", "crates/cache/keys.rs").under("t1"))
            .unwrap();
        p.add_task(good_task("t3", "pick the hash", "crates/cache/hash.rs").under("t2"))
            .unwrap();
        p
    }

    #[test]
    fn every_row_carries_its_number_in_a_column_of_its_own() {
        // The handle column, and the property that makes it one: it is the same width
        // at every depth, so an operator reads down the left edge rather than hunting
        // for the number inside a truncated label.
        let mut p = nested();
        let mut proj = p.project(&ProjectId::new("caching")).unwrap().clone();
        proj.number = Some(Number::new(1));
        p.update_project(proj).unwrap();
        for (id, n) in [("t1", 2), ("t2", 3), ("t3", 4)] {
            let mut t = p.task(&TaskId::new(id)).unwrap().clone();
            t.number = Some(Number::new(n));
            p.update_task(t).unwrap();
        }
        let out = portfolio(&p, &[], &repos(), &no_gates(), false);
        for (n, label, depth) in [
            (1, "PROJECT caching", 0),
            (2, "feat t1", 1),
            (3, "feat t2", 2),
            (4, "feat t3", 3),
        ] {
            let row = format!("│ {:>4} {}{label}", format!("#{n}"), "  ".repeat(depth));
            assert!(out.contains(&row), "missing `{row}` in:\n{out}");
        }
    }

    #[test]
    fn the_portfolio_draws_the_whole_tree_not_just_root_tasks() {
        // The gap this closes: a plan that broke its work down showed only the tops
        // of the breakdowns, and the work actually being done is usually a leaf.
        let out = portfolio(&nested(), &[], &repos(), &no_gates(), false);
        // Indented one step per level. Asserted with the row's leading `│` and number
        // column so the depth is pinned — `  feat t2` alone matches at any depth below
        // its own.
        for (label, depth) in [("feat t1", 1), ("feat t2", 2), ("feat t3", 3)] {
            let row = at_depth(label, depth);
            assert!(out.contains(&row), "missing `{row}` in:\n{out}");
        }
    }

    #[test]
    fn a_focused_project_reaches_past_its_root_tasks() {
        let out = focus(&nested(), &[], "caching", &repos(), &no_gates());
        assert!(out.contains(&at_depth("feat t3", 3)), "{out}");
    }

    #[test]
    fn a_focused_task_reaches_past_its_own_children() {
        // `t3` is a grandchild of `t1`, and L2 used to end at children.
        let out = focus(&nested(), &[], "t1", &repos(), &no_gates());
        assert!(out.contains(&at_depth("feat t2", 1)), "{out}");
        assert!(out.contains(&at_depth("feat t3", 2)), "{out}");
    }

    #[test]
    fn every_level_shows_the_same_four_columns() {
        for out in [
            portfolio(&plan(), &[], &repos(), &no_gates(), false),
            focus(&plan(), &[], "caching", &repos(), &no_gates()),
            focus(&plan(), &[], "t1", &repos(), &no_gates()),
        ] {
            for col in ["what", "status", "spend", "needs you"] {
                assert!(out.contains(col), "missing `{col}` in:\n{out}");
            }
            // The columns that said nothing: health repeated the needs-you cell,
            // and a leaf's progress bar restated its status.
            for gone in ["health", "progress"] {
                assert!(!out.contains(gone), "`{gone}` should be gone from:\n{out}");
            }
        }
    }

    /// Marks a task finished, the way `wecode status <id> done` would.
    fn finish(p: &mut Plan, id: &str) {
        let mut t = p.task(&TaskId::new(id)).unwrap().clone();
        t.status = TaskStatus::Done;
        p.update_task(t).unwrap();
    }

    /// Which column a needle lands in, counted as a terminal would count it: colour
    /// codes take no width and a glyph takes one however many bytes it needs, so a
    /// column assertion made on `str::find` alone would be measuring the encoding.
    fn column_of(line: &str, needle: &str) -> usize {
        let at = line
            .find(needle)
            .unwrap_or_else(|| panic!("no `{needle}` in {line:?}"));
        let mut width = 0;
        let mut escaping = false;
        for c in line[..at].chars() {
            if escaping {
                escaping = c != 'm';
            } else if c == '\x1b' {
                escaping = true;
            } else {
                width += 1;
            }
        }
        width
    }

    #[test]
    fn a_project_row_says_how_much_of_its_work_is_finished() {
        // The reading the declared state cannot give: `· draft` is the same word on the
        // day a project is opened and on the day its last task lands.
        let mut p = plan();
        p.add_task(good_task("t2", "the second half", "crates/other/**"))
            .unwrap();
        finish(&mut p, "t1");
        let out = portfolio(&p, &[], &repos(), &no_gates(), false);
        let row = out
            .lines()
            .find(|l| l.contains("PROJECT caching"))
            .expect("the project row");
        // Beside the declared word, never instead of it: a project can be open and
        // untouched, or finished and still open, and only both readings tell them apart.
        assert!(row.contains("draft 1/2"), "{row}");
    }

    #[test]
    fn the_standing_counts_leaves_so_a_breakdown_is_not_counted_twice() {
        // `nested` is t1 › t2 › t3, which is one piece of work broken down twice — not
        // three. Counting the parents would put a project at 1/3 for finishing all of it.
        let mut p = nested();
        finish(&mut p, "t3");
        assert_eq!(standing(&p, &ProjectId::new("caching")), Some((1, 1)));
    }

    #[test]
    fn the_standing_is_the_reading_the_other_views_print_as_a_percentage() {
        // The property, not the number: `wecode plan` and `wecode show` divide the same
        // leaves, and a board that counted its own way would be a second answer to how
        // far along a project is. Dropped work therefore stays in the denominator here
        // too — it is a decision recorded, not a way to reach the end of a project.
        let mut p = plan();
        for (id, glob) in [("t2", "crates/b/**"), ("t3", "crates/c/**")] {
            p.add_task(good_task(id, "another half", glob)).unwrap();
        }
        finish(&mut p, "t1");
        let mut dropped = p.task(&TaskId::new("t2")).unwrap().clone();
        dropped.status = TaskStatus::Dropped;
        p.update_task(dropped).unwrap();

        let id = ProjectId::new("caching");
        let (done, total) = standing(&p, &id).expect("three tasks");
        assert_eq!((done, total), (1, 3));
        assert!(
            (done as f32 / total as f32 - p.progress(&id)).abs() < f32::EPSILON,
            "{done}/{total} against {}",
            p.progress(&id)
        );
    }

    #[test]
    fn a_project_with_nothing_planned_yet_has_no_standing_to_report() {
        // `0/0` is arithmetic about nothing, and the row already says `no tasks` in
        // words — which is the sentence a person acts on.
        let mut p = Plan::new();
        p.add_project(Project::new("bare", "some real objective here", "wecode"))
            .unwrap();
        assert_eq!(standing(&p, &ProjectId::new("bare")), None);
        let row = project_status(&p, p.project(&ProjectId::new("bare")).unwrap());
        assert_eq!(row, "· draft");
    }

    #[test]
    fn a_task_row_carries_its_word_alone() {
        // Why the standing stops at the project row: on a leaf it would restate the
        // status — `✓ done 1/1` — and a parent's breakdown is the rows directly beneath
        // it, indented, already on the screen.
        let mut p = nested();
        finish(&mut p, "t3");
        for id in ["t1", "t3"] {
            let cell = task_status(p.task(&TaskId::new(id)).unwrap());
            assert!(!cell.contains('/'), "{id}: {cell}");
        }
    }

    #[test]
    fn the_status_column_fits_every_word_a_row_can_carry() {
        // Holds `STATUS_W` to the vocabulary rather than to today's longest word, so a
        // new status arrives as a failing test instead of as a board that stopped
        // lining up.
        for s in ProjectStatus::all() {
            let cell = format!("{} {} 99/99", s.mark(), s.as_str());
            assert!(cell.chars().count() <= STATUS_W, "{cell:?}");
        }
        for s in TaskStatus::all() {
            let cell = format!("{} {}", s.mark(), status_word(*s));
            assert!(cell.chars().count() <= STATUS_W, "{cell:?}");
        }
    }

    #[test]
    fn the_standing_leaves_the_columns_where_the_header_says_they_are() {
        // Two format strings hold this layout, and the widths only agree because
        // somebody keeps them agreeing. Measured against the header, so widening one
        // and not the other fails here rather than in a screenshot.
        let out = portfolio(&nested(), &[], &repos(), &no_gates(), false);
        let header = out.lines().find(|l| l.contains("needs you")).unwrap();
        let spend = column_of(header, "spend");
        for (label, cell) in [
            ("PROJECT caching", spend_cell(0, Some(1000))),
            ("feat t1", spend_cell(0, Some(500))),
        ] {
            let row = out.lines().find(|l| l.contains(label)).expect(label);
            assert_eq!(column_of(row, cell.trim_end()), spend, "{label}: {row}");
        }
    }

    #[test]
    fn an_alarm_on_a_task_turns_its_project_red_too() {
        let audit = vec![line("caching", "t1", "write", "x.pem", "alarm")];
        let p = plan();
        let l = ledger_index(&audit);
        assert_eq!(
            task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l, &no_gates()).health,
            Health::Red
        );
        assert_eq!(vitals(&p, &l).health, Health::Red, "an alarm must roll up");
    }

    #[test]
    fn a_denial_is_amber_not_red_and_names_itself() {
        let audit = vec![line("caching", "t1", "write", "other.rs", "deny")];
        let p = plan();
        let l = ledger_index(&audit);
        let v = task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l, &no_gates());
        assert_eq!(v.health, Health::Amber);
        // Health is only a colour now, so the denial must appear in words too.
        assert!(v.needs.iter().any(|n| n == "1 denied"), "{:?}", v.needs);
    }

    #[test]
    fn task_spend_rolls_up_to_the_project_exactly_once() {
        // The double-count trap: the record names both a project and a task.
        let audit = vec![line("caching", "t1", "spend", "400t/10s", "allow")];
        let p = plan();
        let l = ledger_index(&audit);
        assert_eq!(vitals(&p, &l).spent, 400, "counted once, not twice");
    }

    #[test]
    fn project_level_spend_is_counted_without_a_task() {
        let audit = vec![line("caching", "", "spend", "150t/1s", "allow")];
        let p = plan();
        let l = ledger_index(&audit);
        assert_eq!(vitals(&p, &l).spent, 150);
        // ...and it does not leak onto the task.
        assert_eq!(
            task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l, &no_gates()).spent,
            0
        );
    }

    #[test]
    fn a_subtasks_spend_reaches_its_parent_task_and_the_project() {
        let mut p = plan();
        p.add_task(good_task("t1a", "the inner half", "crates/cache/inner/**").under("t1"))
            .unwrap();
        let audit = vec![line("caching", "t1a", "spend", "700t/2s", "allow")];
        let l = ledger_index(&audit);
        assert_eq!(
            task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l, &no_gates()).spent,
            700,
            "a parent task sees its subtask's spend"
        );
        assert_eq!(vitals(&p, &l).spent, 700);
    }

    #[test]
    fn exceeding_budget_is_red() {
        let audit = vec![line("caching", "t1", "spend", "5000t/0s", "allow")];
        let p = plan();
        let l = ledger_index(&audit);
        let v = task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l, &no_gates());
        assert_eq!(v.health, Health::Red);
        assert!(
            v.needs.iter().any(|n| n.contains("over budget")),
            "{:?}",
            v.needs
        );
    }

    #[test]
    fn progress_is_the_done_fraction_of_leaves() {
        let mut p = plan();
        assert_eq!(p.progress(&ProjectId::new("caching")), 0.0);

        let mut t = p.task(&TaskId::new("t1")).unwrap().clone();
        t.status = TaskStatus::Done;
        p.update_task(t).unwrap();
        assert_eq!(p.progress(&ProjectId::new("caching")), 1.0);

        p.add_task(good_task("t2", "the second half", "crates/other/**"))
            .unwrap();
        assert_eq!(p.progress(&ProjectId::new("caching")), 0.5);
    }

    #[test]
    fn a_parent_tasks_progress_comes_from_its_subtasks_not_itself() {
        let mut p = plan();
        p.add_task(good_task("t1a", "first inner", "crates/cache/a/**").under("t1"))
            .unwrap();
        p.add_task(good_task("t1b", "second inner", "crates/cache/b/**").under("t1"))
            .unwrap();
        let mut a = p.task(&TaskId::new("t1a")).unwrap().clone();
        a.status = TaskStatus::Done;
        p.update_task(a).unwrap();

        assert_eq!(
            task_progress(&p, p.task(&TaskId::new("t1")).unwrap()),
            0.5,
            "one of two subtasks done"
        );
    }

    #[test]
    fn a_projects_design_gate_reaches_its_rows() {
        // The board's defect count must agree with `wecode check`, or a feature the
        // gate refuses would sit green on the cockpit.
        let p = plan();
        let gates: DesignGates = [(ProjectId::new("caching"), vec![TaskKind::Feature])].into();
        let v = task_vitals(
            &p,
            p.task(&TaskId::new("t1")).unwrap(),
            &ledger_index(&[]),
            &gates,
        );
        assert_eq!(v.defects, 1, "{:?}", v.needs);
        assert_eq!(v.health, Health::Amber);
    }

    #[test]
    fn a_draft_with_no_defects_reads_as_unassigned() {
        let p = plan();
        let l = ledger_index(&[]);
        let v = task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l, &no_gates());
        assert_eq!(v.defects, 0, "control case must be defect-free");
        assert!(v.needs.iter().any(|n| n == "unassigned"), "{:?}", v.needs);
        assert_eq!(
            v.health,
            Health::Green,
            "waiting to be assigned is not a fault"
        );
    }

    #[test]
    fn a_project_counts_the_work_nobody_has_been_handed() {
        // The gap the standing leaves: `draft 0/1` says none of it is finished and
        // stops there, while the reason is that no post owns it — so no tick promotes
        // it and the loop never picks it up. Green, that project waits for ever.
        let v = quiet(&plan());
        assert!(v.needs.iter().any(|n| n == "1 to assign"), "{:?}", v.needs);
        assert_eq!(v.health, Health::Amber);

        let mut p = plan();
        let mut t = p.task(&TaskId::new("t1")).unwrap().clone();
        t.assignee = Some("impl".to_string());
        p.update_task(t).unwrap();
        let v = quiet(&p);
        assert!(!v.needs.iter().any(|n| n.ends_with("to assign")), "{:?}", v.needs);
        assert_eq!(v.health, Health::Green, "handed over is nothing to report");
    }

    #[test]
    fn only_the_leaves_that_are_still_open_are_counted_as_unassigned() {
        // Three ways a task is not somebody's next move: it is finished, it is filed
        // away, or it is a breakdown rather than a piece of work. `nested` is t1 › t2 ›
        // t3, so counting parents would ask for three posts where one piece of work is.
        let mut p = nested();
        assert_eq!(unowned(&p, &ProjectId::new("caching")), 1, "t3 alone");
        finish(&mut p, "t3");
        assert_eq!(unowned(&p, &ProjectId::new("caching")), 0);

        let mut p = nested();
        file_away(&mut p, "t3");
        assert_eq!(unowned(&p, &ProjectId::new("caching")), 0, "parked, not owed");
    }

    #[test]
    fn a_project_whose_work_has_all_landed_asks_to_be_closed() {
        // Where `5/5` runs out. No tick closes a project, so one whose last task landed
        // goes on reading `active` — and the board is the surface that should say the
        // remaining move is the operator's.
        let mut p = plan();
        finish(&mut p, "t1");
        let v = quiet(&p);
        assert!(v.needs.iter().any(|n| n == "ready to close"), "{:?}", v.needs);
        assert_eq!(v.health, Health::Amber);

        // And it stops once they have. A closed project asking to be closed is the
        // reading that teaches people the cell is noise.
        let mut done = p.project(&ProjectId::new("caching")).unwrap().clone();
        done.status = ProjectStatus::Done;
        p.update_project(done).unwrap();
        let v = quiet(&p);
        assert!(v.needs.is_empty(), "{:?}", v.needs);
    }

    #[test]
    fn a_project_with_no_tasks_says_so_and_is_amber() {
        let mut p = Plan::new();
        p.add_project(
            Project::new("bare", "some real objective here", "wecode")
                .measured(Measure::Command {
                    cmd: "cargo test".into(),
                    expect_status: 0,
                })
                .budgeted(Budget {
                    tokens: Some(10),
                    wall_secs: Some(1),
                }),
        )
        .unwrap();
        let v = project_vitals(
            &p,
            p.project(&ProjectId::new("bare")).unwrap(),
            &ledger_index(&[]),
            &repos(),
        );
        assert!(v.needs.iter().any(|n| n == "no tasks"), "{:?}", v.needs);
        assert_eq!(v.health, Health::Amber);
    }

    #[test]
    fn a_task_awaiting_a_person_is_amber_and_names_the_reason() {
        let mut p = plan();
        let mut t = p.task(&TaskId::new("t1")).unwrap().clone();
        t.status = TaskStatus::NeedsApproval;
        p.update_task(t).unwrap();
        let v = task_vitals(
            &p,
            p.task(&TaskId::new("t1")).unwrap(),
            &ledger_index(&[]),
            &no_gates(),
        );
        assert!(
            v.needs.iter().any(|n| n == "needs-approval"),
            "{:?}",
            v.needs
        );
        assert_eq!(v.health, Health::Amber);
    }

    #[test]
    fn a_waiting_prerequisite_is_not_itself_a_fault() {
        // Depending on unfinished work is normal; only a defect or an incident
        // should colour a row.
        let mut p = plan();
        p.add_task(good_task("t2", "the second half", "crates/other/**").after("t1"))
            .unwrap();
        let v = task_vitals(
            &p,
            p.task(&TaskId::new("t2")).unwrap(),
            &ledger_index(&[]),
            &no_gates(),
        );
        assert_eq!(v.defects, 0, "{:?}", v.needs);
        assert_eq!(v.health, Health::Green);
    }

    #[test]
    fn a_dead_end_prerequisite_turns_its_dependent_amber_and_names_it() {
        // The contrast with the waiting case above: a dropped prerequisite will
        // never finish, so its dependent cannot advance on its own. Left green, a
        // dead chain looks exactly like one that time will fix.
        let mut p = plan();
        p.add_task(good_task("t2", "the second half", "crates/other/**").after("t1"))
            .unwrap();
        let mut t1 = p.task(&TaskId::new("t1")).unwrap().clone();
        t1.status = TaskStatus::Dropped;
        p.update_task(t1).unwrap();

        let v = task_vitals(
            &p,
            p.task(&TaskId::new("t2")).unwrap(),
            &ledger_index(&[]),
            &no_gates(),
        );
        assert_eq!(v.health, Health::Amber);
        assert!(
            v.needs.iter().any(|n| n == "stuck on t1 (dropped)"),
            "{:?}",
            v.needs
        );
    }

    #[test]
    fn stuck_work_is_counted_on_its_projects_row() {
        // The portfolio draws root rows only, so a stuck subtask must surface as a
        // count on the project or it is invisible until someone descends.
        let mut p = plan();
        p.add_task(good_task("t1a", "the dead half", "crates/cache/a/**").under("t1"))
            .unwrap();
        p.add_task(
            good_task("t1b", "the stranded half", "crates/cache/b/**")
                .under("t1")
                .after("t1a"),
        )
        .unwrap();
        let mut dead = p.task(&TaskId::new("t1a")).unwrap().clone();
        dead.status = TaskStatus::Failed;
        p.update_task(dead).unwrap();

        let v = quiet(&p);
        assert!(v.needs.iter().any(|n| n == "1 stuck"), "{:?}", v.needs);
        assert_eq!(v.health, Health::Amber);
    }

    /// Files a task away in a plan, the way the store's cascade would.
    fn file_away(p: &mut Plan, id: &str) {
        let mut t = p.task(&TaskId::new(id)).unwrap().clone();
        t.archived = true;
        p.update_task(t).unwrap();
    }

    #[test]
    fn a_filed_away_task_leaves_the_portfolio_with_its_subtasks() {
        // The cascade is what makes filing worth doing, so the view has to honour it:
        // one hidden group, not one hidden heading over three visible rows.
        let mut p = nested();
        for id in ["t1", "t2", "t3"] {
            file_away(&mut p, id);
        }
        let out = portfolio(&p, &[], &repos(), &no_gates(), false);
        for row in ["feat t1", "feat t2", "feat t3"] {
            assert!(!out.contains(row), "`{row}` should be filed away:\n{out}");
        }
        // Counted as the one group it is. Three would read as three separate decisions.
        assert!(out.contains("1 archived, --all to include"), "{out}");
        assert!(out.contains("PROJECT caching"), "the project stays:\n{out}");
    }

    #[test]
    fn all_brings_a_filed_away_group_back_greyed() {
        let mut p = nested();
        file_away(&mut p, "t2");
        let out = portfolio(&p, &[], &repos(), &no_gates(), true);
        assert!(out.contains("feat t2"), "{out}");
        assert!(out.contains("feat t3"), "and what is under it:\n{out}");
        assert!(!out.contains("archived, --all"), "nothing left out:\n{out}");
        // Grey, because there is nowhere in these columns to write the word.
        let t2 = out
            .lines()
            .find(|l| l.contains("feat t2"))
            .expect("the row is there");
        assert!(t2.starts_with(DIM), "{t2:?}");
        let t1 = out.lines().find(|l| l.contains("feat t1")).unwrap();
        assert!(!t1.starts_with(DIM), "a live row is not greyed: {t1:?}");
    }

    #[test]
    fn filing_a_subtask_leaves_its_parent_on_the_board() {
        let mut p = nested();
        file_away(&mut p, "t2");
        let out = portfolio(&p, &[], &repos(), &no_gates(), false);
        assert!(out.contains("feat t1"), "the parent stays:\n{out}");
        assert!(!out.contains("feat t2"), "{out}");
        assert!(!out.contains("feat t3"), "and what is under it:\n{out}");
        assert!(out.contains("1 archived"), "{out}");
    }

    #[test]
    fn naming_a_filed_away_task_shows_its_whole_group() {
        // There is no --all at this level, so naming the group is the way in. Without
        // this, descending onto something filed away lands on an empty screen.
        let mut p = nested();
        file_away(&mut p, "t2");
        file_away(&mut p, "t3");
        let out = focus(&p, &[], "t2", &repos(), &no_gates());
        assert!(out.contains("feat t2"), "{out}");
        assert!(out.contains(&at_depth("feat t3", 1)), "{out}");
        assert!(
            !out.contains("archived, hidden"),
            "nothing left out:\n{out}"
        );
    }

    #[test]
    fn a_focused_project_says_how_much_it_is_not_showing() {
        // Hiding is never silent — the count is what tells a reader there is something
        // to name.
        let mut p = nested();
        file_away(&mut p, "t2");
        let out = focus(&p, &[], "caching", &repos(), &no_gates());
        assert!(out.contains("feat t1"), "{out}");
        assert!(!out.contains("feat t2"), "{out}");
        assert!(out.contains("1 archived, hidden"), "{out}");
    }

    #[test]
    fn focus_on_a_missing_id_says_so() {
        assert!(focus(&plan(), &[], "nope", &repos(), &no_gates()).contains("no project or task"));
    }

    #[test]
    fn a_project_explains_the_alarms_it_rolls_up() {
        // The count and the evidence must appear together, or the number is a
        // dead end.
        let p = plan();
        let audit = vec![line("caching", "t1", "write", "x.pem", "alarm")];
        let out = focus(&p, &audit, "caching", &repos(), &no_gates());
        assert!(out.contains("1 alarm"), "{out}");
        assert!(
            out.contains("x.pem"),
            "the evidence, not just the count:\n{out}"
        );
    }

    #[test]
    fn focus_shows_incidents_for_that_subject_only() {
        let mut p = plan();
        p.add_task(good_task("t2", "the second half", "crates/other/**"))
            .unwrap();
        let audit = vec![
            line("caching", "t1", "write", "x.pem", "alarm"),
            line("caching", "t2", "write", "elsewhere.rs", "deny"),
        ];
        let out = focus(&p, &audit, "t1", &repos(), &no_gates());
        assert!(out.contains("incidents"), "{out}");
        assert!(out.contains("x.pem"), "{out}");
        assert!(
            !out.contains("elsewhere.rs"),
            "should not show another task's: {out}"
        );
    }

    #[test]
    fn long_labels_are_truncated_not_wrapped() {
        let s = truncate("a-very-long-task-identifier-that-overflows", 26);
        assert_eq!(s.chars().count(), 26);
        assert!(s.ends_with('…'));
    }
}
