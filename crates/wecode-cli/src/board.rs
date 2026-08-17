//! The cockpit: a full-screen board with the same four columns at every level —
//! what · status · spend · needs-you.
//!
//! The portfolio **leads with attention, not with hierarchy**. A tree is the shape of
//! the system; four groups in the order a person acts — needs-you, moving, next, landed
//! — are the shape of the question they opened this to ask, which is *what is mine to
//! do*. The tree survives underneath, since how the work is organised is a real question
//! too, just not the first one. Each group stands its tail down to a count at
//! [`ATTENTION`] rows, so the whole answer is one screen however big the plan.
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
//! The project row answers *where is this* in one cell: its [`standing`] — `> active
//! 2/5` — beside the state somebody declared, because `active` reads the same on the day
//! a project opens as on the day its last task lands. A fraction says how far and not
//! whether it can go further, so the needs-you cell carries the two ends it cannot —
//! [`unowned`] work, and work that has all landed under a project still declared open.
//! Nor can any of it say *when*, being counted off the plan as it stands; the ledger is
//! the only record of that, and the gap since its newest line reads [`quiet_for`].

use std::cmp::Reverse;
use std::collections::BTreeMap;

use wecode_core::{
    Number, Plan, Project, ProjectId, ProjectStatus, Task, TaskId, TaskKind, TaskStatus, admission,
};
use wecode_store::{AuditLine, now_secs};

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

/// Everything the board knows about one project or task, all of it derived. Not the
/// incident counts: an alarm, a denial and a defect each write their own words into
/// `needs` and their own colour into `health`, so a field beside them was a third copy.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Vitals {
    pub(crate) health: Health,
    pub(crate) spent: u64,
    pub(crate) budget: Option<u64>,
    pub(crate) needs: Vec<String>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) struct Counts {
    spent: u64,
    alarms: usize,
    denials: usize,
    /// When the newest record here was written; `0` for a subject the ledger never named.
    last: u64,
}

impl Counts {
    fn add(&mut self, other: Self) {
        self.spent += other.spent;
        self.alarms += other.alarms;
        self.denials += other.denials;
        // The newest, not the sum: rolled up this says when anything under here last
        // moved, and a project quiet for a week is not quiet if a subtask ran an hour ago.
        self.last = self.last.max(other.last);
    }
}

/// Spend and incidents folded from the ledger once, split by what they are attributed
/// to. The two count maps are separate because a record naming a task also names its
/// project: counting it in both would double every number.
#[derive(Default)]
pub(crate) struct Ledger {
    by_task: BTreeMap<String, Counts>,
    by_project: BTreeMap<String, Counts>,
    /// The newest [`AT_THE_KEYBOARD`] act recorded against each task, as `<seq, "<action>
    /// <target>">` — what the moving group prints to answer *what is it doing*.
    ///
    /// Kept by `seq` rather than `at`, the sequence being the database's and so monotonic
    /// across every process that writes, while two records inside one second are common
    /// and their order by clock is a coin toss.
    doing: BTreeMap<String, (i64, String)>,
}

/// The acts that are somebody working on a task, as against wecode's own record of it.
///
/// `define`, `staff` and `approve` are things done *to* a task — writing it down, moving
/// it, signing it — and each is the newest record on a task that has never run, so a
/// moving row would report the planning that created it as what it is doing now. These
/// five are what the task's holder did with their hands. A spend is neither: that is the
/// meter, which the row's spend cell reads already.
const AT_THE_KEYBOARD: [&str; 5] = ["read", "write", "run", "network", "merge"];

pub(crate) fn ledger_index(audit: &[AuditLine]) -> Ledger {
    let mut out = Ledger::default();
    for l in audit {
        // Every record is movement, not only a spend: a denial, an approval and a merge
        // are all wecode having done something about this subject.
        let mut c = Counts { last: l.at, ..Counts::default() };
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
            if AT_THE_KEYBOARD.contains(&l.action.as_str()) {
                let seen = out.doing.entry(l.task.clone()).or_default();
                if l.seq >= seen.0 {
                    *seen = (l.seq, format!("{} {}", l.action, truncate(&l.target, 30)));
                }
            }
        }
    }
    out
}

/// The newest records about one subject, newest first — what has just happened here, as
/// against what the plan says is meant to. A project's own records and its tasks' are
/// one set, every task record naming the project it belongs to; an empty name matches
/// everything, so naming neither is the whole workspace.
pub(crate) fn newest<'a>(
    audit: &'a [AuditLine],
    project: &str,
    task: &str,
    take: usize,
) -> Vec<&'a AuditLine> {
    audit
        .iter()
        .rev()
        .filter(|l| (project.is_empty() || l.project == project) && (task.is_empty() || l.task == task))
        .take(take)
        .collect()
}

/// An age in the largest unit that still says something.
pub(crate) fn ago(secs: u64) -> String {
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m", secs / 60),
        3600..=86_399 => format!("{}h", secs / 3600),
        _ => format!("{}d", secs / 86_400),
    }
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

pub(crate) fn project_vitals(plan: &Plan, p: &Project, l: &Ledger, repos: &[String]) -> Vitals {
    let c = project_totals(plan, &p.id, l);
    let defects = admission::check_project(p, plan, repos).len();
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
    // The one reading not a function of the plan and the ledger alone. The clock is read
    // at the call, so the rule itself is something a test can hand a time to.
    let quiet = quiet_for(plan, p, &c, now_secs());
    if let Some(days) = quiet {
        needs.push(format!("quiet {days}d"));
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
            waiting + stuck + unowned + usize::from(closable) + usize::from(quiet.is_some()),
        ),
        spent: c.spent,
        budget: p.budget.tokens,
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
    // Never empty: the walk bottoms out on the task's own status.
    let leaves = leaf_statuses(plan, t);
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

pub(crate) fn spend_cell(spent: u64, budget: Option<u64>) -> String {
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
/// Padded, never cut: a bigger plan pushes the columns to its right rather than losing a
/// digit, because a ragged line still reads and `1/2` where `1/20` was meant does not. A
/// test holds this to the vocabulary, so a new status arrives as a failure rather than as
/// a board that stopped lining up.
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
/// Blank rather than `—` when there is none, unlike every other cell here: a missing
/// number is a plan nothing has minted numbers for, which is only ever an in-memory
/// one. This is a gutter, not a reading.
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
/// `None` when nothing has been planned yet — `0/0` is arithmetic about nothing, and the
/// needs-you cell already says `no tasks` in words.
///
/// The same leaves [`Plan::progress`] divides, so this cannot disagree with the
/// percentage `wecode plan` and `wecode show` print; two answers to *how far along is
/// this* would make the board the surface people stopped trusting. Dropped work stays in
/// the denominator, as it does there: abandoning a task is a decision to record, not a
/// way for a project to finish. A fraction and not that percentage, because `99%` is
/// what 199 of 200 and 999 of 1000 both round to, and how many are left is what somebody
/// acts on.
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
/// has an assignee — so no tick promotes these, however green every other column reads.
///
/// The leaves the standing divides, less the closed and the filed-away, so the two are
/// halves of one sentence: `1/4` says where the work got to, `3 to assign` says why it
/// stopped there. Parents go with the parked — a breakdown is not dispatched, its pieces
/// are. Amber here while the same task reads `unassigned` in green below, on purpose:
/// one leaf mid-planning is normal, and the project row is the one read from a phone.
fn unowned(plan: &Plan, id: &ProjectId) -> usize {
    plan.tasks_of(id)
        .filter(|t| plan.subtasks(&t.id).next().is_none())
        .filter(|t| !t.archived && !t.status.is_closed() && t.assignee.is_none())
        .count()
}

/// How many rows a group shows before it stands the rest down to a count.
///
/// The company's own `[attention] max_open_items`, five in every template wecode ships:
/// the number of things it will run at once, and so the number it already believes a
/// person can hold. Spelled here because this module is handed the plan and the ledger
/// and computes from those alone — and the group says how many it stood down anyway.
const ATTENTION: usize = 5;

/// The four questions a person opens the board with, in the order they act on them.
///
/// Not four filters over one list: a row is in exactly one group, because somebody
/// reading four counts is counting, and a task in two of them is counted twice.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Group {
    NeedsYou,
    Moving,
    Next,
    Landed,
}

impl Group {
    pub(crate) const ALL: [Self; 4] = [Self::NeedsYou, Self::Moving, Self::Next, Self::Landed];

    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::NeedsYou => "NEEDS YOU",
            Self::Moving => "MOVING",
            Self::Next => "NEXT",
            Self::Landed => "LANDED",
        }
    }

    /// The sentence this group's own question wants, for one row.
    ///
    /// Each group asks something different of the same cell, which is the point of
    /// grouping at all: `> running` is a fact four rows share, and *what it is doing* is
    /// what tells them apart. Needs-you keeps what the row already computed, that cell
    /// being the answer to *what wants me* — and it is never empty there, since nothing
    /// joins that group without either a status a person owes something to or a dead-end
    /// prerequisite, each of which writes its own words in [`task_vitals`].
    pub(crate) fn line(self, plan: &Plan, t: &Task, l: &Ledger, v: &Vitals) -> String {
        match self {
            Self::NeedsYou => v.needs.join(", "),
            // Every act an agent takes passes the Broker on its way to the ledger, so
            // the newest record is the nearest thing wecode has to the agent's own last
            // line. A run that has not touched anything yet falls back to its title.
            Self::Moving => l
                .doing
                .get(t.id.as_str())
                .map_or_else(|| truncate(&t.title, 40), |(_, what)| what.clone()),
            Self::Next => blocking(plan, t),
            // What landed, in the words somebody wrote when they asked for it. The cost
            // is the spend cell, two columns left.
            Self::Landed => truncate(&t.title, 40),
        }
    }
}

/// Which group a leaf belongs to — exactly one, or none.
///
/// Read in order, because the earlier question wins. Failed work is a person's move
/// whatever else is true of it, and a task stuck behind a dead end is a question too
/// even though its own status reads `waiting` — no tick is coming for either. A dropped
/// task is in no group at all: not waiting, not moving, and it did not land. It is a
/// decision already taken, which the tree below still records.
fn group_of(plan: &Plan, t: &Task) -> Option<Group> {
    if t.status.needs_a_human() || is_stuck(plan, t) {
        Some(Group::NeedsYou)
    } else if matches!(t.status, TaskStatus::Running | TaskStatus::Verifying) {
        Some(Group::Moving)
    } else if t.status.is_done() {
        Some(Group::Landed)
    } else if t.status.is_closed() {
        None
    } else {
        Some(Group::Next)
    }
}

/// The one thing standing between an open task and a dispatch.
///
/// Nearest first: an unfinished predecessor is the answer even for a task that is also
/// unassigned, because staffing it changes nothing while it waits. Naming the post is
/// what turns `ready` from a state into a sentence about somebody — and `unassigned` is
/// the one entry here that no tick will ever clear on its own.
fn blocking(plan: &Plan, t: &Task) -> String {
    for b in plan.blockers(&t.id) {
        if let wecode_core::Blocker::Waiting(on) = b {
            return format!("after {on}");
        }
    }
    match &t.assignee {
        Some(post) => format!("queued for {post}"),
        None => "unassigned".to_string(),
    }
}

/// Each group, the rows it leads with in the order it shows them, and the tail it stood
/// down to a count — the whole of the grouping, and the only copy of it. [`crate::tui`]
/// draws its own rows from this rather than reading the same statuses a second time, so
/// the board an operator leaves open and the snapshot they get on their phone cannot come
/// to disagree about what needs them.
///
/// `projects` is the same list the tree below walks, so the two halves of one view can
/// never disagree about which projects are on screen. Leaves only, for the reason the
/// standing counts leaves: a breakdown is not a piece of work, its pieces are — and those
/// pieces are rows in this very list, so grouping the parent would put one job in front of
/// a person twice.
pub(crate) fn attention_groups<'a>(
    plan: &'a Plan,
    projects: &[&Project],
    l: &Ledger,
    show_all: bool,
) -> Vec<(Group, Vec<&'a Task>, usize)> {
    let leaves: Vec<&Task> = projects
        .iter()
        .flat_map(|p| plan.tasks_of(&p.id))
        .filter(|t| plan.subtasks(&t.id).next().is_none())
        .filter(|t| show_all || !t.archived)
        .collect();
    let mut out = Vec::new();
    for group in Group::ALL {
        let mut shown: Vec<&Task> = leaves
            .iter()
            .copied()
            .filter(|t| group_of(plan, t) == Some(group))
            .collect();
        if group == Group::Landed {
            // Newest first — "recently" is the whole of what this group claims. Every
            // other group is left in id order, so two runs of the same command agree.
            shown.sort_by_key(|t| Reverse(l.by_task.get(t.id.as_str()).map_or(0, |c| c.last)));
        }
        let hidden = shown.len().saturating_sub(ATTENTION);
        shown.truncate(ATTENTION);
        out.push((group, shown, hidden));
    }
    out
}

/// The groups, drawn before any tree.
fn attention(
    plan: &Plan,
    projects: &[&Project],
    l: &Ledger,
    gates: &DesignGates,
    show_all: bool,
) -> String {
    let mut out = String::new();
    for (g, shown, hidden) in attention_groups(plan, projects, l, show_all) {
        out.push_str(&format!("{DIM}│ {}{RESET}\n", g.title()));
        if shown.is_empty() {
            // Drawn empty rather than dropped: four headings in the same places every
            // time is what lets somebody find the one they came for without reading.
            out.push_str(&format!("{DIM}│      —{RESET}\n"));
            continue;
        }
        for t in shown {
            let mut v = task_vitals(plan, t, l, gates);
            // The group's answer, in the cell that already carries the colour. An
            // incident on a moving row still turns it red; the words for it are on that
            // task's own row in the tree below, which is what the tree is still for.
            v.needs = vec![g.line(plan, t, l, &v)];
            out.push_str(&row(
                t.number,
                // Hierarchy survives inside a group: a row torn out of the tree has to
                // say which project it came from, or the id is the only handle on it.
                &format!("  {}/{}", t.project, t.id),
                &task_status(t),
                &v,
                t.archived,
            ));
        }
        if hidden > 0 {
            out.push_str(&format!("{DIM}│      … and {} more{RESET}\n", hidden));
        }
    }
    out
}

/// A day: the gap under which the board says nothing about time. The shortest silence
/// that cannot be an ordinary night — wecode runs tasks in minutes, so an hour would be
/// true of every workspace whose operator went to lunch, and a cell that is right about
/// everybody is read by nobody.
const QUIET_AFTER: u64 = 24 * 60 * 60;

/// Whole days between two ledger times, once there is at least one. Rounded down, so the
/// reading is never longer than the silence, and `None` rather than a wrap for a record
/// dated ahead of the clock — a clock that went backwards is not a project racing ahead.
fn quiet_days(last: u64, now: u64) -> Option<u64> {
    let days = now.saturating_sub(last) / QUIET_AFTER;
    (days > 0).then_some(days)
}

/// How long a project has stood still, in whole days — `None` while it is still moving.
///
/// Silent in four cases, each a row that would otherwise cry wolf. A closed project is
/// meant to stand still. One with no open work left already says `ready to close`, and
/// two cells for one fact teach a reader to skip both. A run in flight writes nothing to
/// the ledger until it lands, so it reads exactly like silence and is the opposite of it.
/// And a project the ledger has never named has no silence to measure — unreachable in a
/// stored workspace, where defining one is itself a record.
fn quiet_for(plan: &Plan, p: &Project, c: &Counts, now: u64) -> Option<u64> {
    if p.status.is_closed() || c.last == 0 {
        return None;
    }
    let open: Vec<&Task> = plan.tasks_of(&p.id).filter(|t| !t.status.is_closed()).collect();
    if open.is_empty()
        || open.iter().any(|t| matches!(t.status, TaskStatus::Running | TaskStatus::Verifying))
    {
        return None;
    }
    quiet_days(c.last, now)
}

/// The declared state, and beside it where the work under it has got to.
///
/// On the project row and nowhere else, for the reason the stuck count is: the rows
/// beneath are what to read next, this is the number that says whether to read them at
/// all, and it survives a long tree scrolling every one of them off the screen.
fn project_status(plan: &Plan, p: &Project) -> String {
    let word = p.status.as_str();
    match standing(plan, &p.id) {
        Some((done, total)) => format!("{} {word} {done}/{total}", p.status.mark()),
        None => format!("{} {word}", p.status.mark()),
    }
}

/// Short enough for a column; `needs-approval` and `needs-input` are why.
pub(crate) fn status_word(s: TaskStatus) -> &'static str {
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

/// Tasks in id order, so two runs of one command — and both cockpits — agree.
pub(crate) fn sorted<'a>(it: impl Iterator<Item = &'a Task>) -> Vec<&'a Task> {
    let mut v: Vec<&Task> = it.collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

/// A tree being drawn, and how many rows it left out.
///
/// The count travels with the text because only the walk that skipped the rows knows how
/// many there were, and a view showing less than everything has to be able to say so.
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
/// were put away as one group, and reading them back as four hidden rows would say there
/// is far more out of sight than there is.
///
/// Depth is spelled in spaces rather than tree glyphs because this column truncates at
/// 26: a glyph that survives the cut while the id does not costs a reader the one thing
/// the row is for.
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
    for k in sorted(plan.subtasks(&t.id)) {
        subtree(plan, k, l, gates, depth + 1, show_all, out);
    }
}

/// The board: the four attention groups, then one line per project and its whole tree.
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
    let mut out = title_bar("L0", "BOARD", "wecode board <id> to descend");
    out.push_str(&header_row());

    let projects: Vec<&Project> = if show_all {
        plan.all_projects().collect()
    } else {
        plan.projects().collect()
    };
    out.push_str(&attention(plan, &projects, &l, gates, show_all));
    // The tree, after the answer — and named, because the heading is what makes the rows
    // above it a view rather than a preamble somebody scrolls past.
    out.push_str(&format!("{DIM}│{RESET}\n{DIM}│ PORTFOLIO{RESET}\n"));
    let mut drawn = Drawn::default();
    for p in &projects {
        drawn.text.push_str(&row(
            p.number,
            &format!("PROJECT {} [{}]", p.id, p.repo),
            &project_status(plan, p),
            &project_vitals(plan, p, &l, known_repos),
            p.archived,
        ));
        for t in sorted(plan.roots_of(&p.id)) {
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
/// A tree, not the four groups: descending is what somebody does once a group row has
/// already told them where to look, and the question there is how this one thing is put
/// together. Filed-away rows are hidden as in the portfolio, with one exception — a
/// subject that is itself archived shows its group in full, since filing a task takes
/// its subtasks with it and naming it is the only way in without an `--all` at this
/// level.
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
        for t in sorted(plan.roots_of(&p.id)) {
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
        for k in sorted(plan.subtasks(&t.id)) {
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
    fn bare(p: &Plan) -> Vitals {
        vitals(p, &ledger_index(&[]))
    }

    /// One task's vitals, ungated. Spelled once: the four arguments took four lines in
    /// each of a dozen tests, and only one of those tests was about any of them.
    fn task_of(p: &Plan, l: &Ledger, id: &str) -> Vitals {
        task_vitals(p, p.task(&TaskId::new(id)).unwrap(), l, &no_gates())
    }

    /// Moves a task into a state, the way the store would.
    fn set(p: &mut Plan, id: &str, s: TaskStatus) {
        let mut t = p.task(&TaskId::new(id)).unwrap().clone();
        t.status = s;
        p.update_task(t).unwrap();
    }

    const DAY: u64 = 24 * 60 * 60;

    /// The ledger of a project whose newest record was written `days` ago.
    fn aged(days: u64) -> Ledger {
        let at = now_secs() - days * DAY;
        ledger_index(&[AuditLine { at, ..line("caching", "t1", "spend", "10t/1s", "allow") }])
    }

    /// The measure and the budget every fixture here carries. Spelled once: what each
    /// test is about is the plan's shape, never which command judges it.
    fn cmd(c: &str) -> Measure {
        Measure::Command {
            cmd: c.into(),
            expect_status: 0,
        }
    }

    fn budget(tokens: u64, wall_secs: u64) -> Budget {
        Budget {
            tokens: Some(tokens),
            wall_secs: Some(wall_secs),
        }
    }

    /// A project with one well-formed task, so a defect in a test is one the test
    /// introduced rather than background noise.
    fn plan() -> Plan {
        let mut p = Plan::new();
        p.add_project(
            Project::new("caching", "cut export p99 below 500ms", "wecode")
                .measured(cmd("cargo bench"))
                .budgeted(budget(1000, 60)),
        )
        .unwrap();
        p.add_task(good_task("t1", "write the cache layer", "crates/cache/**"))
            .unwrap();
        p
    }

    fn good_task(id: &str, title: &str, glob: &str) -> Task {
        Task::new(id, "caching", title)
            .accepting(cmd("cargo test"))
            .scoped(Scope::write(&[glob]))
            .budgeted(budget(500, 30))
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
    fn the_board_opens_with_attention_and_keeps_the_tree_underneath() {
        // The headline rule: the first rows are the four questions, not the shape of
        // the plan. A board that opens on `PROJECT` has answered *how is this
        // organised* to somebody who asked *what is mine to do*.
        let out = portfolio(&plan(), &[], &repos(), &no_gates(), false);
        let heads: Vec<&str> = out
            .lines()
            .filter(|l| Group::ALL.iter().any(|g| l.contains(g.title())) || l.contains("PROJECT"))
            .collect();
        assert_eq!(heads.len(), 5, "{out}");
        for (i, g) in Group::ALL.iter().enumerate() {
            assert!(heads[i].contains(g.title()), "group {i}: {out}");
        }
        assert!(heads[4].contains("PROJECT caching"), "the tree survives:\n{out}");
        assert!(out.contains("feat t1"), "and goes down it:\n{out}");
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
        // The indent is pinned here too, one step per level, with the leading `│` and
        // the number column in the needle: `  feat t2` alone matches at any depth below
        // its own, and the tree stopping at root tasks is the bug this catches.
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
    fn a_focused_view_reaches_past_the_children_of_its_subject() {
        // `t3` is a grandchild of `t1`: L1 used to end at root tasks and L2 at children.
        let out = focus(&nested(), &[], "caching", &repos(), &no_gates());
        assert!(out.contains(&at_depth("feat t3", 3)), "{out}");
        let out = focus(&nested(), &[], "t1", &repos(), &no_gates());
        assert!(out.contains(&at_depth("feat t2", 1)), "{out}");
        assert!(out.contains(&at_depth("feat t3", 2)), "{out}");
    }

    /// Marks a task finished, the way `wecode status <id> done` would.
    fn finish(p: &mut Plan, id: &str) {
        set(p, id, TaskStatus::Done);
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
    fn the_standing_counts_leaves_and_belongs_to_the_project_row_alone() {
        // `nested` is t1 › t2 › t3, one piece of work broken down twice — not three.
        // Counting the parents would put a project at 1/3 for finishing all of it. On a
        // task row the fraction would restate the status — `✓ done 1/1` — and a parent's
        // breakdown is the rows directly beneath it, indented, already on the screen.
        let mut p = nested();
        finish(&mut p, "t3");
        assert_eq!(standing(&p, &ProjectId::new("caching")), Some((1, 1)));
        for id in ["t1", "t3"] {
            let cell = task_status(p.task(&TaskId::new(id)).unwrap());
            assert!(!cell.contains('/'), "{id}: {cell}");
        }
    }

    #[test]
    fn the_status_column_fits_every_word_a_row_can_carry() {
        // Holds `STATUS_W` to the vocabulary rather than to today's longest word, so a
        // new status arrives as a failing test instead of as a board that stopped
        // lining up. Two names are shortened to fit; the rest are what the CLI accepts.
        assert_eq!(status_word(TaskStatus::NeedsApproval), "approval");
        assert_eq!(status_word(TaskStatus::NeedsInput), "input");
        assert_eq!(status_word(TaskStatus::Waiting), "waiting");
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
    fn an_incident_rolls_up_to_the_project_and_says_which_it_was() {
        // An alarm is red and a denial amber, at both levels. Health is only a colour
        // now, so the words for a denial have to be in the cell it colours.
        let p = plan();
        let l = ledger_index(&[line("caching", "t1", "write", "x.pem", "alarm")]);
        assert_eq!(task_of(&p, &l, "t1").health, Health::Red);
        assert_eq!(vitals(&p, &l).health, Health::Red, "an alarm must roll up");

        let l = ledger_index(&[line("caching", "t1", "write", "other.rs", "deny")]);
        let v = task_of(&p, &l, "t1");
        assert_eq!(v.health, Health::Amber);
        assert!(v.needs.iter().any(|n| n == "1 denied"), "{:?}", v.needs);
    }

    #[test]
    fn spend_reaches_the_project_from_every_level_and_is_counted_once() {
        // The double-count trap: a task's record names its project too. A project's own
        // records are its alone, and a subtask's reach both the task above it and the
        // project.
        let p = plan();
        let l = ledger_index(&[line("caching", "t1", "spend", "400t/10s", "allow")]);
        assert_eq!(vitals(&p, &l).spent, 400, "counted once, not twice");

        let l = ledger_index(&[line("caching", "", "spend", "150t/1s", "allow")]);
        assert_eq!(vitals(&p, &l).spent, 150);
        assert_eq!(task_of(&p, &l, "t1").spent, 0, "and it does not leak onto the task");

        let mut p = plan();
        p.add_task(good_task("t1a", "the inner half", "crates/cache/inner/**").under("t1"))
            .unwrap();
        let l = ledger_index(&[line("caching", "t1a", "spend", "700t/2s", "allow")]);
        assert_eq!(task_of(&p, &l, "t1").spent, 700, "a parent sees its subtask's spend");
        assert_eq!(vitals(&p, &l).spent, 700);
    }

    #[test]
    fn a_parent_tasks_progress_comes_from_its_subtasks_not_itself() {
        let mut p = plan();
        p.add_task(good_task("t1a", "first inner", "crates/cache/a/**").under("t1"))
            .unwrap();
        p.add_task(good_task("t1b", "second inner", "crates/cache/b/**").under("t1"))
            .unwrap();
        finish(&mut p, "t1a");
        let t1 = p.task(&TaskId::new("t1")).unwrap();
        assert_eq!(task_progress(&p, t1), 0.5, "one of two subtasks done");
    }

    #[test]
    fn a_draft_reads_as_unassigned_until_its_project_gates_the_kind() {
        // Waiting to be assigned is not a fault. A gated kind is: the board's defect
        // count must agree with `wecode check`, or a feature the gate refuses would sit
        // green on the cockpit.
        let p = plan();
        let v = task_of(&p, &ledger_index(&[]), "t1");
        assert!(!v.needs.iter().any(|n| n.ends_with("defect")), "{:?}", v.needs);
        assert!(v.needs.iter().any(|n| n == "unassigned"), "{:?}", v.needs);
        assert_eq!(v.health, Health::Green);

        let gates: DesignGates = [(ProjectId::new("caching"), vec![TaskKind::Feature])].into();
        let v = task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &ledger_index(&[]), &gates);
        assert!(v.needs.iter().any(|n| n == "1 defect"), "{:?}", v.needs);
        assert_eq!(v.health, Health::Amber);
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
        let v = bare(&p);
        assert!(v.needs.iter().any(|n| n == "ready to close"), "{:?}", v.needs);
        assert_eq!(v.health, Health::Amber);

        // And it is the whole of what the row asks, however long ago that last task
        // landed: two cells for one fact teach a reader to skip both.
        assert_eq!(vitals(&p, &aged(9)).needs, vec!["ready to close".to_string()]);

        // It stops once they have. A closed project asking to be closed is the reading
        // that teaches people the cell is noise.
        let mut done = p.project(&ProjectId::new("caching")).unwrap().clone();
        done.status = ProjectStatus::Done;
        p.update_project(done).unwrap();
        assert!(bare(&p).needs.is_empty(), "{:?}", bare(&p).needs);
        assert!(vitals(&p, &aged(9)).needs.is_empty(), "nor is it quiet: it is closed");
    }

    #[test]
    fn a_project_nothing_has_happened_in_says_how_long() {
        // What the standing cannot say: `draft 0/1` prints the same on the evening a
        // task was written and a fortnight later, and only one of those wants somebody.
        let v = vitals(&plan(), &aged(3));
        assert!(v.needs.iter().any(|n| n == "quiet 3d"), "{:?}", v.needs);
        assert_eq!(v.health, Health::Amber);
        // Silent while the workspace is warm, and silent for a plan the ledger has never
        // named — no record is no gap, only a project nothing has started yet.
        for l in [aged(0), ledger_index(&[])] {
            let needs = vitals(&plan(), &l).needs;
            assert!(!needs.iter().any(|n| n.starts_with("quiet")), "{needs:?}");
        }
    }

    #[test]
    fn a_run_in_flight_is_not_silence_however_old_the_last_record_is() {
        // An agent mid-run writes nothing to the ledger until it lands, so a long run
        // reads exactly like a dead project and is the opposite of one.
        let mut p = plan();
        for s in [TaskStatus::Running, TaskStatus::Verifying] {
            set(&mut p, "t1", s);
            let needs = vitals(&p, &aged(9)).needs;
            assert!(!needs.iter().any(|n| n.starts_with("quiet")), "{s:?}: {needs:?}");
        }
    }

    #[test]
    fn the_silence_is_counted_in_whole_days_so_it_never_overstates() {
        assert_eq!(quiet_days(0, DAY - 1), None, "under a day is not a reading");
        assert_eq!(quiet_days(0, 2 * DAY - 1), Some(1), "rounded down, never up");
        assert_eq!(quiet_days(9 * DAY, 0), None, "a clock that went backwards");
    }

    #[test]
    fn a_task_awaiting_a_person_is_amber_and_names_the_reason() {
        let mut p = plan();
        set(&mut p, "t1", TaskStatus::NeedsApproval);
        let v = task_of(&p, &ledger_index(&[]), "t1");
        assert!(v.needs.iter().any(|n| n == "needs-approval"), "{:?}", v.needs);
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

        // And a subtask filed away on its own leaves the task it belongs to behind.
        let mut p = nested();
        file_away(&mut p, "t2");
        let out = portfolio(&p, &[], &repos(), &no_gates(), false);
        assert!(out.contains("feat t1"), "the parent stays:\n{out}");
        assert!(!out.contains("feat t2"), "{out}");
        assert!(!out.contains("feat t3"), "and what is under it:\n{out}");
        assert!(out.contains("1 archived"), "{out}");
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
    fn naming_a_filed_away_task_shows_its_whole_group() {
        // There is no --all at this level, so naming the group is the way in. Without
        // this, descending onto something filed away lands on an empty screen.
        let mut p = nested();
        file_away(&mut p, "t2");
        file_away(&mut p, "t3");
        let out = focus(&p, &[], "t2", &repos(), &no_gates());
        assert!(out.contains("feat t2"), "{out}");
        assert!(out.contains(&at_depth("feat t3", 1)), "{out}");
        assert!(!out.contains("archived, hidden"), "nothing left out:\n{out}");
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
    fn a_project_explains_the_alarms_it_rolls_up() {
        // The count and the evidence must appear together, or the number is a
        // dead end.
        let p = plan();
        let audit = vec![line("caching", "t1", "write", "x.pem", "alarm")];
        let out = focus(&p, &audit, "caching", &repos(), &no_gates());
        assert!(out.contains("1 alarm"), "{out}");
        assert!(out.contains("x.pem"), "the evidence, not just the count:\n{out}");
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
        assert!(!out.contains("elsewhere.rs"), "not another task's: {out}");
    }

    #[test]
    fn long_labels_are_truncated_not_wrapped() {
        let s = truncate("a-very-long-task-identifier-that-overflows", 26);
        assert_eq!(s.chars().count(), 26);
        assert!(s.ends_with('…'));
    }
}
