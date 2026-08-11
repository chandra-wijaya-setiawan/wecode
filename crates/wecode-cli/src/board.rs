//! The cockpit: a full-screen board with the same five columns at every level.
//!
//! Health is **computed**, never reported by an agent: it comes from status,
//! admission defects, the audit ledger and declared budgets.
//!
//! Two levels of work means two levels of board — the portfolio lists projects
//! with their root tasks, and a focus view descends into either.

use std::collections::BTreeMap;

use wecode_core::{Plan, Project, ProjectId, ProjectStatus, Task, TaskId, TaskStatus, admission};
use wecode_store::AuditLine;

use crate::render::kind_tag;

const RESET: &str = "\x1b[0m";
const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const GREEN: &str = "\x1b[32m";
const AMBER: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Health {
    Green,
    Amber,
    Red,
}

impl Health {
    fn dot(self) -> String {
        match self {
            Self::Green => format!("{GREEN}●{RESET}green"),
            Self::Amber => format!("{AMBER}●{RESET}amber"),
            Self::Red => format!("{RED}●{RESET}red  "),
        }
    }
}

/// Everything the board knows about one project or task, all of it derived.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Vitals {
    pub(crate) health: Health,
    pub(crate) progress: f32,
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
    push_common(&mut needs, c.alarms, defects, over, stalled);
    let waiting = plan
        .tasks_of(&p.id)
        .filter(|t| t.status.needs_a_human())
        .count();
    if waiting > 0 {
        needs.push(format!("{waiting} to answer"));
    }
    if plan.tasks_of(&p.id).next().is_none() {
        needs.push("no tasks".to_string());
    }

    Vitals {
        health: health_of(c.alarms, over, defects, stalled, c.denials, waiting),
        progress: prog,
        spent: c.spent,
        budget: p.budget.tokens,
        alarms: c.alarms,
        denials: c.denials,
        defects,
        needs,
    }
}

pub(crate) fn task_vitals(plan: &Plan, t: &Task, l: &Ledger) -> Vitals {
    let c = task_totals(plan, &t.id, l);
    let defects = admission::check_task(t, plan).len();
    let prog = task_progress(plan, t);
    let over = t.budget.tokens.is_some_and(|b| c.spent > b);
    let stalled = c.spent > 0 && prog == 0.0 && t.status == TaskStatus::Running;

    let mut needs = Vec::new();
    push_common(&mut needs, c.alarms, defects, over, stalled);
    let awaiting = usize::from(t.status.needs_a_human());
    if t.status.needs_a_human() {
        needs.push(t.status.as_str().to_string());
    }
    if t.status == TaskStatus::Draft && defects == 0 && t.assignee.is_none() {
        needs.push("unassigned".to_string());
    }
    for b in plan.blockers(&t.id) {
        if let wecode_core::Blocker::Missing(m) = b {
            needs.push(format!("{m} missing"));
        }
    }

    Vitals {
        health: health_of(c.alarms, over, defects, stalled, c.denials, awaiting),
        progress: prog,
        spent: c.spent,
        budget: t.budget.tokens,
        alarms: c.alarms,
        denials: c.denials,
        defects,
        needs,
    }
}

fn push_common(needs: &mut Vec<String>, alarms: usize, defects: usize, over: bool, stalled: bool) {
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

fn bar(fraction: f32) -> String {
    let filled = (fraction * 6.0).round().clamp(0.0, 6.0) as usize;
    let mut s = String::new();
    for i in 0..6 {
        s.push(if i < filled { '█' } else { '▁' });
    }
    format!("{s} {:>3.0}%", fraction * 100.0)
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

fn header_row() -> String {
    format!(
        "{DIM}│ {:<26} {:<12} {:<11} {:<12} {}{RESET}\n",
        "what", "health", "progress", "spend", "needs you"
    )
}

fn row(label: &str, v: &Vitals) -> String {
    let needs = if v.needs.is_empty() {
        format!("{DIM}—{RESET}")
    } else {
        v.needs.join(", ")
    };
    format!(
        "│ {:<26} {:<12} {:<11} {:<12} {}\n",
        truncate(label, 26),
        v.health.dot(),
        bar(v.progress),
        spend_cell(v.spent, v.budget),
        needs
    )
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

/// The portfolio view: one line per project, then its root tasks.
pub(crate) fn portfolio(plan: &Plan, audit: &[AuditLine], known_repos: &[String]) -> String {
    if plan.is_empty() {
        return "no projects yet — wecode project add <id> --repo <name> \"<objective>\"\n"
            .to_string();
    }
    let l = ledger_index(audit);
    let mut out = title_bar("L0", "PORTFOLIO", "wecode board <id> to descend");
    out.push_str(&header_row());

    for p in plan.projects() {
        out.push_str(&row(
            &format!("{}", p.id),
            &project_vitals(plan, p, &l, known_repos),
        ));
        let mut roots: Vec<&Task> = plan.roots_of(&p.id).collect();
        roots.sort_by(|a, b| a.id.cmp(&b.id));
        for t in roots {
            out.push_str(&row(
                &format!("  {} {}", kind_tag(t.kind), t.id),
                &task_vitals(plan, t, &l),
            ));
        }
    }
    out.push_str(&footer("alarms freeze dispatch · silence on green"));
    out
}

/// A focused view on either level: the subject, what is beneath it, its incidents.
pub(crate) fn focus(plan: &Plan, audit: &[AuditLine], id: &str, known_repos: &[String]) -> String {
    let l = ledger_index(audit);

    if let Some(p) = plan.project(&ProjectId::new(id)) {
        let v = project_vitals(plan, p, &l, known_repos);
        let mut out = title_bar("L1", id, "wecode board to go up");
        out.push_str(&format!("{DIM}│ {}  [{}]{RESET}\n", p.objective, p.repo));
        out.push_str(&header_row());
        out.push_str(&row(&format!("{}", p.id), &v));
        let mut roots: Vec<&Task> = plan.roots_of(&p.id).collect();
        roots.sort_by(|a, b| a.id.cmp(&b.id));
        for t in roots {
            out.push_str(&row(
                &format!("  {} {}", kind_tag(t.kind), t.id),
                &task_vitals(plan, t, &l),
            ));
        }
        // Every incident in the project, including its tasks'. The project row
        // rolls their alarms up, so hiding the rows leaves a count with nothing to
        // explain it — and no way to find what tripped.
        out.push_str(&incidents(audit, |x| x.project == id));
        out.push_str(&footer(hint_for(&v)));
        return out;
    }

    if let Some(t) = plan.task(&TaskId::new(id)) {
        let v = task_vitals(plan, t, &l);
        let mut out = title_bar("L2", id, "wecode board to go up");
        out.push_str(&format!("{DIM}│ {}{RESET}\n", t.title));
        out.push_str(&header_row());
        out.push_str(&row(&format!("{} {}", kind_tag(t.kind), t.id), &v));
        let mut kids: Vec<&Task> = plan.subtasks(&t.id).collect();
        kids.sort_by(|a, b| a.id.cmp(&b.id));
        for k in kids {
            out.push_str(&row(
                &format!("  {} {}", kind_tag(k.kind), k.id),
                &task_vitals(plan, k, &l),
            ));
        }
        out.push_str(&incidents(audit, |x| x.task == id));
        out.push_str(&footer(hint_for(&v)));
        return out;
    }

    format!("no project or task: {id}\n")
}

fn hint_for(v: &Vitals) -> &'static str {
    if v.needs.is_empty() {
        "nothing needs you here"
    } else {
        "wecode check <id> · wecode audit --alarms"
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
        assert!(portfolio(&Plan::new(), &[], &repos()).contains("project add"));
    }

    #[test]
    fn portfolio_lists_projects_and_their_root_tasks() {
        let out = portfolio(&plan(), &[], &repos());
        assert!(out.contains("caching"), "{out}");
        assert!(out.contains("feat t1"), "{out}");
        assert!(out.contains("L0 · PORTFOLIO"), "{out}");
    }

    #[test]
    fn every_level_shows_the_same_five_columns() {
        for out in [
            portfolio(&plan(), &[], &repos()),
            focus(&plan(), &[], "caching", &repos()),
            focus(&plan(), &[], "t1", &repos()),
        ] {
            for col in ["what", "health", "progress", "spend", "needs you"] {
                assert!(out.contains(col), "missing `{col}` in:\n{out}");
            }
        }
    }

    #[test]
    fn an_alarm_on_a_task_turns_its_project_red_too() {
        let audit = vec![line("caching", "t1", "write", "x.pem", "alarm")];
        let p = plan();
        let l = ledger_index(&audit);
        assert_eq!(
            task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l).health,
            Health::Red
        );
        assert_eq!(
            project_vitals(
                &p,
                p.project(&ProjectId::new("caching")).unwrap(),
                &l,
                &repos()
            )
            .health,
            Health::Red,
            "an alarm must roll up"
        );
    }

    #[test]
    fn a_denial_is_amber_not_red() {
        let audit = vec![line("caching", "t1", "write", "other.rs", "deny")];
        let p = plan();
        let l = ledger_index(&audit);
        assert_eq!(
            task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l).health,
            Health::Amber
        );
    }

    #[test]
    fn task_spend_rolls_up_to_the_project_exactly_once() {
        // The double-count trap: the record names both a project and a task.
        let audit = vec![line("caching", "t1", "spend", "400t/10s", "allow")];
        let p = plan();
        let l = ledger_index(&audit);
        let v = project_vitals(
            &p,
            p.project(&ProjectId::new("caching")).unwrap(),
            &l,
            &repos(),
        );
        assert_eq!(v.spent, 400, "counted once, not twice");
    }

    #[test]
    fn project_level_spend_is_counted_without_a_task() {
        let audit = vec![line("caching", "", "spend", "150t/1s", "allow")];
        let p = plan();
        let l = ledger_index(&audit);
        let v = project_vitals(
            &p,
            p.project(&ProjectId::new("caching")).unwrap(),
            &l,
            &repos(),
        );
        assert_eq!(v.spent, 150);
        // ...and it does not leak onto the task.
        assert_eq!(
            task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l).spent,
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
            task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l).spent,
            700,
            "a parent task sees its subtask's spend"
        );
        assert_eq!(
            project_vitals(
                &p,
                p.project(&ProjectId::new("caching")).unwrap(),
                &l,
                &repos()
            )
            .spent,
            700
        );
    }

    #[test]
    fn exceeding_budget_is_red() {
        let audit = vec![line("caching", "t1", "spend", "5000t/0s", "allow")];
        let p = plan();
        let l = ledger_index(&audit);
        let v = task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l);
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

        let l = ledger_index(&[]);
        let v = task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l);
        assert_eq!(v.progress, 0.5, "one of two subtasks done");
    }

    #[test]
    fn a_draft_with_no_defects_reads_as_unassigned() {
        let p = plan();
        let l = ledger_index(&[]);
        let v = task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &l);
        assert_eq!(v.defects, 0, "control case must be defect-free");
        assert!(v.needs.iter().any(|n| n == "unassigned"), "{:?}", v.needs);
        assert_eq!(
            v.health,
            Health::Green,
            "waiting to be assigned is not a fault"
        );
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
        let v = task_vitals(&p, p.task(&TaskId::new("t1")).unwrap(), &ledger_index(&[]));
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
        let v = task_vitals(&p, p.task(&TaskId::new("t2")).unwrap(), &ledger_index(&[]));
        assert_eq!(v.defects, 0, "{:?}", v.needs);
        assert_eq!(v.health, Health::Green);
    }

    #[test]
    fn focus_on_a_missing_id_says_so() {
        assert!(focus(&plan(), &[], "nope", &repos()).contains("no project or task"));
    }

    #[test]
    fn a_project_explains_the_alarms_it_rolls_up() {
        // The count and the evidence must appear together, or the number is a
        // dead end.
        let p = plan();
        let audit = vec![line("caching", "t1", "write", "x.pem", "alarm")];
        let out = focus(&p, &audit, "caching", &repos());
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
        let out = focus(&p, &audit, "t1", &repos());
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
