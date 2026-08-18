//! The plan as prose: the tree, the queue, one project or task in full, and the
//! admission dialogue that judges either of them.
//!
//! `wecode-core` owns every type here and is not allowed to know what a terminal is,
//! so this is where its concepts are read out. The two relations are printed as two
//! sections wherever both appear — `parent` decides which tree the work happens in,
//! `depends_on` decides when it may start — because merging them is the modelling
//! error the whole design exists to avoid, and a view that invited it would undo the
//! distinction the types keep.

use wecode_core::{Admission, Blocker, Defect, Plan, Project, ProjectId, Task, TaskId, TaskStatus};

use super::kind_tag;

/// The one-line legend. Ten task statuses is more than a reader can hold, so the
/// marks are always explained rather than assumed.
pub(crate) const LEGEND: &str = "  · draft   ⋯ waiting   ○ ready   > running   ? verifying/input   ! approval   ✓ done   x failed   - dropped\n";

/// The line that says the left column is usable, printed under any view that draws it.
///
/// Worth a line of its own: a column of numbers nobody has been told is a column of
/// numbers is decoration, and the whole point of them is that they can be *typed*.
pub(crate) const NUMBERS_NOTE: &str =
    "  the number in the left column names it: wecode show 4 · wecode merge 4\n";

/// Width of the number gutter, the trailing space included.
///
/// Fits `#999`. Past that a row is one character wider and the columns after it shift by
/// one, which is cosmetic and self-limiting — the number of projects and tasks one
/// operator can oversee is the premise of the whole cockpit.
const GUTTER: usize = 5;

/// The left gutter: a project's or a task's short number, or blank space when it has
/// none.
///
/// Un-indented, whatever the depth of the row — a number that moved right with the tree
/// could not be read as a column, and reading them as a column is what the operator does
/// before typing one.
fn gutter(number: Option<wecode_core::Number>) -> String {
    match number {
        Some(n) => format!("{n:>width$} ", width = GUTTER - 1),
        None => " ".repeat(GUTTER),
    }
}

/// The number beside a heading that already names the thing by its id — `  #4`.
///
/// On the detail views rather than only the lists, because the detail view is where an
/// operator lands after `wecode show <slug>` and is the one place they will be looking
/// when they decide to send the number to somebody else.
fn also_numbered(number: Option<wecode_core::Number>) -> String {
    number.map(|n| format!("  {n}")).unwrap_or_default()
}

/// The whole plan: projects, each with its task tree.
///
/// `show_all` includes filed-away work — projects and tasks alike. One flag for both
/// levels because an operator who files a task away and then sees it here reads the
/// filing as having failed: `--all` means *everything*, or it means nothing.
///
/// Hiding is never silent — when anything is omitted the footer says how much and how
/// to see it.
#[must_use]
pub(crate) fn tree(p: &Plan, show_all: bool) -> String {
    if p.is_empty() {
        return "no projects yet — try: wecode project add <id> --repo <name> \"<objective>\"\n"
            .to_string();
    }
    let projects: Vec<&Project> = if show_all {
        p.all_projects().collect()
    } else {
        p.projects().collect()
    };
    if projects.is_empty() {
        return format!(
            "every project is archived ({}) — wecode tree --all\n",
            p.archived_count()
        );
    }

    let mut listing = Listing {
        show_all,
        ..Listing::default()
    };
    for proj in projects {
        listing.text.push_str(&project_line(p, proj));
        let mut roots: Vec<&Task> = p.roots_of(&proj.id).collect();
        roots.sort_by(|a, b| a.id.cmp(&b.id));
        for t in roots {
            render_task(p, t, 1, false, &mut listing);
        }
    }
    let mut out = listing.text;
    out.push('\n');
    out.push_str(LEGEND);
    out.push_str(NUMBERS_NOTE);
    out.push_str(&archived_note(p, show_all, listing.filed));
    out
}

/// A plan being written out, and how much of it was filed away.
///
/// The count travels with the text because only the walk that met the rows knows how
/// many there were, and a view that shows less than everything has to be able to say so.
#[derive(Default)]
struct Listing {
    text: String,
    /// Whether filed-away tasks are written rather than skipped.
    show_all: bool,
    /// Filed-away groups met, counted once each. Filing a task takes its subtasks with
    /// it, so a feature and its four subtasks are one decision and read as `1`; four
    /// would say there is far more out of sight than there is.
    filed: usize,
}

/// One line naming what is not on screen. A view that quietly shows less than
/// everything is worse than one that shows too much.
///
/// Projects and filed-away task groups are one number, because `--all` is one flag: a
/// footer that counted only the projects would leave the tasks hidden *and* unmentioned.
fn archived_note(p: &Plan, show_all: bool, filed: usize) -> String {
    let n = p.archived_count() + filed;
    if n == 0 {
        String::new()
    } else if show_all {
        format!("  {n} archived, shown\n")
    } else {
        format!("  {n} archived, hidden — --all to include\n")
    }
}

fn project_line(plan: &Plan, p: &Project) -> String {
    let done = plan.progress(&p.id);
    // The marker goes at the end: a leading column would indent every project line
    // by one and erase the distinction from its indented tasks.
    format!(
        "{}{} {:<20} {:<28} [{}] {:.0}%{}\n",
        gutter(p.number),
        p.status.mark(),
        p.id.to_string(),
        p.objective,
        p.repo,
        done * 100.0,
        if p.archived { "  archived" } else { "" }
    )
}

/// A task's line, then every task beneath it.
///
/// `parent_filed` says the walk is already inside a filed-away group, so the group is
/// counted at the row that begins it and not again at each of its subtasks.
///
/// A filed-away task stops the walk when it is not being shown: its subtasks were put
/// away with it, and a subtask hung off it afterwards belongs to the same group.
fn render_task(plan: &Plan, t: &Task, depth: usize, parent_filed: bool, out: &mut Listing) {
    if t.archived && !parent_filed {
        out.filed += 1;
    }
    if t.archived && !out.show_all {
        return;
    }
    let indent = "  ".repeat(depth);
    let mut suffix = String::new();
    if !t.depends_on.is_empty() {
        let names: Vec<String> = t.depends_on.iter().map(ToString::to_string).collect();
        suffix.push_str(&format!(" after {}", names.join(", ")));
    }
    if let Some(a) = &t.assignee {
        suffix.push_str(&format!(" → {a}"));
    }
    // Beside the post rather than in the tag column, because it is not what the work is
    // — a manual chore is still a chore. What it changes is who the arrow points at: no
    // agent will ever be launched for this row, whatever post is named on it.
    if t.is_done_by_a_person() {
        suffix.push_str(" by hand");
    }
    // Last on the line, as on a project: this column is already the widest thing here,
    // and a marker in front of the status mark would indent every task by one.
    if t.archived {
        suffix.push_str("  archived");
    }
    out.text.push_str(&format!(
        "{}{indent}{} {:<5} {:<18} {}{}\n",
        gutter(t.number),
        t.status.mark(),
        kind_tag(t.kind),
        t.id.to_string(),
        t.title,
        suffix
    ));
    let mut kids: Vec<&Task> = plan.subtasks(&t.id).collect();
    kids.sort_by(|a, b| a.id.cmp(&b.id));
    for k in kids {
        render_task(plan, k, depth + 1, t.archived, out);
    }
}

/// Everything schedulable right now — what a dispatcher would pick up.
#[must_use]
pub(crate) fn ready(p: &Plan) -> String {
    let mut tasks: Vec<&Task> = p.ready_tasks().collect();
    tasks.sort_by(|a, b| a.id.cmp(&b.id));
    // A schedulable task whose prerequisite failed or was dropped is not merely
    // waiting: no tick will ever release it. Saying "waiting on prerequisites"
    // about it promises a resolution that will never come, so the two are counted
    // apart. Archived projects are skipped, matching `ready_tasks` — parked work
    // is not stuck, it is parked.
    let stuck = p
        .tasks()
        .filter(|t| t.status.is_schedulable())
        .filter(|t| p.project(&t.project).is_some_and(|pr| !pr.archived))
        .filter(|t| {
            p.blockers(&t.id)
                .iter()
                .any(|b| !matches!(b, Blocker::Waiting(_)))
        })
        .count();
    let stuck_note = |out: &mut String| {
        if stuck > 0 {
            out.push_str(&format!(
                "  {stuck} stuck on failed or dropped work — it cannot advance without you; wecode tree\n"
            ));
        }
    };
    if tasks.is_empty() {
        let waiting = p
            .tasks()
            .filter(|t| t.status == TaskStatus::Waiting)
            .count();
        if waiting > 0 {
            let mut out = format!(
                "nothing ready — {waiting} task{} waiting on prerequisites\n",
                if waiting == 1 { "" } else { "s" }
            );
            stuck_note(&mut out);
            out.push_str("  wecode tree  to see what on\n");
            return out;
        }
        let mut out = "nothing ready\n".to_string();
        stuck_note(&mut out);
        return out;
    }
    let mut out = format!(
        "{:>4} {:<18} {:<12} {:<10} {}\n",
        "#", "task", "project", "assignee", "title"
    );
    for t in tasks {
        out.push_str(&format!(
            "{}{:<18} {:<12} {:<10} {}\n",
            gutter(t.number),
            t.id.to_string(),
            t.project.to_string(),
            t.assignee.as_deref().unwrap_or("—"),
            t.title
        ));
    }
    stuck_note(&mut out);
    out
}

/// One project in full: objective, repo, measures, and its tasks by status.
#[must_use]
pub(crate) fn project_detail(plan: &Plan, id: &ProjectId) -> String {
    let Some(p) = plan.project(id) else {
        return format!("no such project: {id}\n");
    };
    let mut out = format!(
        "{}  {}{}\n  objective  {}\n  repo       {}\n  status     {}\n",
        p.status.mark(),
        p.id,
        also_numbered(p.number),
        p.objective,
        p.repo,
        p.status.as_str()
    );
    for m in &p.measures {
        out.push_str(&format!("  measure    {}\n", m.describe()));
    }
    budget_lines(&p.budget, &mut out);

    let tasks: Vec<&Task> = plan.tasks_of(id).collect();
    if tasks.is_empty() {
        out.push_str("\n  ⚠ no tasks — a project with no tasks cannot progress\n");
        return out;
    }
    out.push_str(&format!(
        "\ntasks ({} of {} done, {:.0}%)\n",
        tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Done)
            .count(),
        tasks.len(),
        plan.progress(id) * 100.0
    ));
    // Everything, filed away or not: this view is reached by naming the project, and
    // there is no `--all` at this level to get back what it left out. What filing buys
    // here is the marker — a hidden row that still dispatches must not read as live.
    let mut listing = Listing {
        show_all: true,
        ..Listing::default()
    };
    let mut roots: Vec<&Task> = plan.roots_of(id).collect();
    roots.sort_by(|a, b| a.id.cmp(&b.id));
    for t in roots {
        render_task(plan, t, 1, false, &mut listing);
    }
    out.push_str(&listing.text);
    out.push('\n');
    out.push_str(LEGEND);
    out.push_str(NUMBERS_NOTE);
    out
}

fn budget_lines(b: &wecode_core::Budget, out: &mut String) {
    if let Some(t) = b.tokens {
        out.push_str(&format!("  budget     {t} tokens\n"));
    }
    if let Some(w) = b.wall_secs {
        out.push_str(&format!("  wall       {w}s\n"));
    }
}

/// One task in full: where it sits, what it waits on, what would accept it.
///
/// The two relations are printed as separate sections on purpose. Merging them is
/// the modelling error this whole design exists to avoid, so the output should not
/// invite it either.
#[must_use]
pub(crate) fn task_detail(plan: &Plan, id: &TaskId) -> String {
    let Some(t) = plan.task(id) else {
        return format!("no such task: {id}\n");
    };
    let mut out = format!(
        "{} {} {}{}  {}\n  project    {}\n  status     {}\n",
        t.status.mark(),
        kind_tag(t.kind),
        t.id,
        also_numbered(t.number),
        t.title,
        t.project,
        t.status.as_str()
    );
    if let Some(a) = &t.assignee {
        out.push_str(&format!("  assignee   {a}\n"));
    }
    // Printed only when it is a person's, and directly under the post it qualifies: an
    // assignee reads as "who this is dispatched to", and for a manual task that is
    // exactly what it is not. Silence means the ordinary case, as it does for a kind.
    if t.is_done_by_a_person() {
        out.push_str("  done by    a person — no agent is dispatched\n");
    }

    // Where it sits: the is-part-of chain, root first.
    let mut chain: Vec<String> = plan
        .ancestors(id)
        .iter()
        .map(|a| a.id.to_string())
        .collect();
    if !chain.is_empty() {
        chain.reverse();
        chain.push(t.id.to_string());
        out.push_str(&format!("  part of    {}\n", chain.join(" / ")));
    }

    let kids: Vec<&Task> = plan.subtasks(id).collect();
    if !kids.is_empty() {
        out.push_str("\nsubtasks (part of this; not blocked by it)\n");
        let mut sorted = kids;
        sorted.sort_by(|a, b| a.id.cmp(&b.id));
        for k in sorted {
            out.push_str(&format!(
                "  {} {:<18} {}\n",
                k.status.mark(),
                k.id.to_string(),
                k.title
            ));
        }
    }

    if !t.depends_on.is_empty() {
        out.push_str("\ndepends on (must come after)\n");
        for d in &t.depends_on {
            let state = plan
                .task(d)
                .map_or_else(|| "MISSING".to_string(), |x| x.status.as_str().to_string());
            out.push_str(&format!("  {:<18} {}\n", d.to_string(), state));
        }
    }

    let blockers = plan.blockers(id);
    if blockers.is_empty() {
        if t.status.is_schedulable() {
            out.push_str("\n  ○ nothing blocking — ready\n");
        }
    } else {
        out.push_str("\nblocked by\n");
        for b in &blockers {
            out.push_str(&format!("  {}\n", blocker_line(b)));
        }
    }

    if !t.acceptance.is_empty() {
        out.push_str("\nacceptance\n");
        for m in &t.acceptance {
            out.push_str(&format!("  {}\n", m.describe()));
        }
    }
    if !t.scope.write.is_empty() {
        out.push_str(&format!("\n  writes     {}\n", t.scope.write.join(", ")));
    }
    if !t.scope.read.is_empty() {
        out.push_str(&format!("  reads      {}\n", t.scope.read.join(", ")));
    }
    let mut b = String::new();
    budget_lines(&t.budget, &mut b);
    out.push_str(&b);
    out
}

fn blocker_line(b: &Blocker) -> String {
    match b {
        Blocker::Waiting(id) => format!("{id} is not done"),
        Blocker::Stuck(id, status) => format!(
            "{id} is {} — it will not finish on its own; reopen or re-point it",
            status.as_str()
        ),
        Blocker::Missing(id) => format!("{id} does not exist — dependency can never be satisfied"),
    }
}

/// The admission verdict: either admitted, or the numbered questions to answer.
///
/// One function for both levels because the dialogue is the same dialogue — the
/// gate does not care whether it is judging a project or a task.
#[must_use]
pub(crate) fn admission(heading: &str, defects: &[Defect], verdict: Option<&Admission>) -> String {
    let mut out = format!("{heading}\n");

    if defects.is_empty() {
        out.push_str("\n  ✓ admitted\n");
        return out;
    }
    let waived = verdict.is_some_and(Admission::is_admitted);
    out.push_str(&format!(
        "\n  ⚠ {} defect{}{}\n\n",
        defects.len(),
        if defects.len() == 1 { "" } else { "s" },
        if waived {
            " (waived)"
        } else {
            " — not admitted"
        }
    ));
    for (i, d) in defects.iter().enumerate() {
        out.push_str(&format!("  {}  {}\n", i + 1, d.question()));
    }
    out
}

/// The heading line for a project under judgement.
#[must_use]
pub(crate) fn project_heading(p: &Project) -> String {
    let mut h = format!(
        "project {}{}  {}\n  repo       {}",
        p.id,
        also_numbered(p.number),
        p.objective,
        p.repo
    );
    for m in &p.measures {
        h.push_str(&format!("\n  measure    {}", m.describe()));
    }
    h
}

/// The heading line for a task under judgement.
#[must_use]
pub(crate) fn task_heading(t: &Task) -> String {
    let mut h = format!(
        "{} {}{}  {}\n  project    {}",
        kind_tag(t.kind),
        t.id,
        also_numbered(t.number),
        t.title,
        t.project
    );
    // Said first among the qualifiers, because it is what explains the absences below
    // it: a manual task is admitted with no write scope, no budget and no acceptance at
    // all, and a heading that showed only the empty lines would read as a task missing
    // three things rather than one asked for none of them.
    if t.is_done_by_a_person() {
        h.push_str("\n  done by    a person");
    }
    for m in &t.acceptance {
        h.push_str(&format!("\n  acceptance {}", m.describe()));
    }
    if !t.scope.write.is_empty() {
        h.push_str(&format!("\n  writes     {}", t.scope.write.join(", ")));
    }
    h
}

/// What `--expand` created, one line per subtask.
///
/// The whole point is that these are ordinary tasks, so the columns are the ones that
/// decide whether each is workable: what it is, what it may write, who has it, and
/// what it waits for.
#[must_use]
pub(crate) fn expansion(main: &Task, tasks: &[Task]) -> String {
    let mut out = format!(
        "\n  expanded {} into {} subtask{}\n\n",
        main.id,
        tasks.len(),
        if tasks.len() == 1 { "" } else { "s" }
    );
    let width = tasks.iter().map(|t| t.id.as_str().len()).max().unwrap_or(0);
    for t in tasks {
        out.push_str(&format!(
            "    {} {:<width$}  {:<5}  {:<32}  {}",
            t.status.mark(),
            t.id.as_str(),
            kind_tag(t.kind),
            if t.scope.write.is_empty() {
                "—".to_string()
            } else {
                t.scope.write.join(", ")
            },
            t.assignee.as_deref().unwrap_or("—"),
        ));
        if !t.depends_on.is_empty() {
            out.push_str(&format!(
                "  after {}",
                t.depends_on
                    .iter()
                    .map(TaskId::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        out.push('\n');
    }
    out.push_str("\n  They are ordinary tasks: edit, drop or add to them before dispatching.\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Measure, Scope, admission};

    /// A line past its number gutter, so an indentation assertion measures the tree and
    /// not the handle column standing to the left of it.
    fn body(line: &str) -> &str {
        line.get(GUTTER..).unwrap_or(line)
    }

    fn plan() -> Plan {
        let mut p = Plan::new();
        p.add_project(
            Project::new("export", "cut export p99 below 500ms", "api")
                .measured(Measure::Command {
                    cmd: "cargo bench".into(),
                    expect_status: 0,
                })
                .budgeted(Budget {
                    tokens: Some(50_000),
                    wall_secs: None,
                }),
        )
        .unwrap();
        p.add_task(
            Task::new("cache", "export", "add a response cache")
                .accepting(Measure::Command {
                    cmd: "cargo test cache".into(),
                    expect_status: 0,
                })
                .scoped(Scope::write(&["crates/export/**"]))
                .budgeted(Budget {
                    tokens: Some(9000),
                    wall_secs: Some(600),
                }),
        )
        .unwrap();
        p.add_task(
            Task::new("bench", "export", "benchmark the cache")
                .after("cache")
                .accepting(Measure::Command {
                    cmd: "cargo bench".into(),
                    expect_status: 0,
                })
                .scoped(Scope::write(&["benches/**"]))
                .budgeted(Budget {
                    tokens: Some(3000),
                    wall_secs: Some(300),
                }),
        )
        .unwrap();
        p
    }

    #[test]
    fn empty_plan_suggests_a_next_step() {
        let out = tree(&Plan::new(), false);
        assert!(out.contains("no projects yet"), "{out}");
        assert!(out.contains("project add"), "{out}");
    }

    #[test]
    fn a_project_line_never_starts_with_a_space_so_tasks_read_as_nested() {
        // Regression: an archived marker in a leading column indented every project
        // by one and made it indistinguishable from its own tasks.
        let mut p = plan();
        let mut arch = p.project(&ProjectId::new("export")).unwrap().clone();
        arch.archived = true;
        p.update_project(arch).unwrap();
        let out = tree(&p, true);
        let line = out.lines().find(|l| l.contains("export")).unwrap();
        assert!(!body(line).starts_with(' '), "{line:?}");
        assert!(line.contains("archived"), "{line:?}");
    }

    /// Files a task away in a plan, the way the store's cascade would.
    fn file_away(p: &mut Plan, id: &str) {
        let mut t = p.task(&TaskId::new(id)).unwrap().clone();
        t.archived = true;
        p.update_task(t).unwrap();
    }

    #[test]
    fn a_filed_away_task_is_off_the_listing_and_counted() {
        // Regression: `--all` hid and showed archived *projects* here while an archived
        // task was printed exactly as if it were live — no marker, no count, and `--all`
        // changed nothing. Filing it away read as having failed.
        let mut p = plan();
        file_away(&mut p, "cache");
        let out = tree(&p, false);
        assert!(!out.contains("add a response cache"), "{out}");
        assert!(
            out.contains("benchmark the cache"),
            "the rest stays:\n{out}"
        );
        assert!(
            out.contains("1 archived, hidden — --all to include"),
            "{out}"
        );
    }

    #[test]
    fn all_brings_a_filed_away_task_back_and_says_which_it_is() {
        let mut p = plan();
        file_away(&mut p, "cache");
        let out = tree(&p, true);
        let line = out
            .lines()
            .find(|l| l.contains("add a response cache"))
            .unwrap();
        assert!(line.contains("archived"), "{line:?}");
        // Last on the line, or every task indents by the width of the marker.
        assert!(!body(line).starts_with("   "), "{line:?}");
        assert!(out.contains("1 archived, shown"), "{out}");
    }

    #[test]
    fn filing_a_task_away_takes_its_subtasks_and_counts_the_group_once() {
        // Filing is one decision about one piece of work. Counting the subtasks
        // separately would say there is far more out of sight than there is.
        let mut p = plan();
        p.add_task(Task::new("cache-keys", "export", "design the cache keys").under("cache"))
            .unwrap();
        file_away(&mut p, "cache");
        file_away(&mut p, "cache-keys");
        let out = tree(&p, false);
        assert!(!out.contains("design the cache keys"), "{out}");
        assert!(out.contains("1 archived"), "{out}");
        assert!(
            !out.contains("2 archived"),
            "one group, not two rows:\n{out}"
        );
    }

    #[test]
    fn a_filed_away_project_and_a_filed_away_task_are_one_count() {
        // `--all` is one flag, so the line that says what it would bring back has to be
        // one number. Counting only the projects left the tasks hidden and unmentioned.
        let mut p = plan();
        p.add_project(Project::new("billing", "invoice the right amount", "api"))
            .unwrap();
        p.add_task(Task::new("rates", "billing", "load the rate table"))
            .unwrap();
        let mut arch = p.project(&ProjectId::new("billing")).unwrap().clone();
        arch.archived = true;
        p.update_project(arch).unwrap();
        file_away(&mut p, "cache");

        assert!(
            tree(&p, false).contains("2 archived, hidden"),
            "{}",
            tree(&p, false)
        );
    }

    #[test]
    fn a_subtask_hung_off_a_filed_away_parent_goes_with_the_group() {
        // It was added after the cascade ran, so its own flag is clear — but it is part
        // of work the operator has put away, and a lone subtask under a heading that is
        // not on screen is worse than not showing it.
        let mut p = plan();
        file_away(&mut p, "cache");
        p.add_task(Task::new("cache-keys", "export", "design the cache keys").under("cache"))
            .unwrap();
        let out = tree(&p, false);
        assert!(!out.contains("design the cache keys"), "{out}");
        assert!(out.contains("1 archived"), "{out}");
    }

    #[test]
    fn naming_a_project_reports_every_task_whatever_its_filing() {
        // There is no `--all` at this level, so hiding here would put the row out of
        // reach. The marker is what keeps it from reading as live.
        let mut p = plan();
        file_away(&mut p, "cache");
        let out = project_detail(&p, &ProjectId::new("export"));
        let line = out
            .lines()
            .find(|l| l.contains("add a response cache"))
            .unwrap();
        assert!(line.contains("archived"), "{line:?}");
        let bench = out
            .lines()
            .find(|l| l.contains("benchmark the cache"))
            .unwrap();
        assert!(!bench.contains("archived"), "{bench:?}");
    }

    #[test]
    fn tree_nests_tasks_under_their_project() {
        let out = tree(&plan(), false);
        let proj = out.lines().find(|l| l.contains("export")).unwrap();
        let task = out.lines().find(|l| l.contains("cache")).unwrap();
        assert!(!body(proj).starts_with(' '), "{proj:?}");
        assert!(body(task).starts_with("  "), "{task:?}");
    }

    #[test]
    fn tree_shows_a_dependency_but_not_as_nesting() {
        // The whole point of the two-relation model: `bench` comes after `cache`
        // without being *part of* it, so it must not be indented under it.
        let out = tree(&plan(), false);
        let bench = out.lines().find(|l| l.contains("bench")).unwrap();
        assert!(bench.contains("after cache"), "{bench:?}");
        let indent = body(bench);
        assert_eq!(
            indent.len() - indent.trim_start().len(),
            2,
            "a dependency is a sibling, not a child: {bench:?}"
        );
    }

    #[test]
    fn a_subtask_is_indented_and_carries_no_after_note() {
        let mut p = plan();
        p.add_task(Task::new("cache-keys", "export", "design the cache keys").under("cache"))
            .unwrap();
        let out = tree(&p, false);
        let sub = out.lines().find(|l| l.contains("cache-keys")).unwrap();
        let indent = body(sub);
        assert_eq!(indent.len() - indent.trim_start().len(), 4, "{sub:?}");
        assert!(!sub.contains("after"), "{sub:?}");
    }

    #[test]
    fn the_number_column_is_the_same_width_at_every_depth() {
        // The property that makes it typeable: read down the left edge and every handle
        // is in one place, whatever level of the tree it belongs to.
        let mut p = plan();
        let mut proj = p.project(&ProjectId::new("export")).unwrap().clone();
        proj.number = Some(wecode_core::Number::new(1));
        p.update_project(proj).unwrap();
        for (id, n) in [("cache", 2), ("bench", 3)] {
            let mut t = p.task(&TaskId::new(id)).unwrap().clone();
            t.number = Some(wecode_core::Number::new(n));
            p.update_task(t).unwrap();
        }
        let out = tree(&p, false);
        for (needle, want) in [
            ("cut export", "  #1"),
            ("response cache", "  #2"),
            ("benchmark", "  #3"),
        ] {
            let line = out.lines().find(|l| l.contains(needle)).unwrap();
            assert!(line.starts_with(want), "{line:?} should start with {want:?}");
        }
        // And the reader is told the column can be typed. A column of numbers nobody
        // explains is decoration.
        assert!(out.contains("wecode show 4"), "{out}");
    }

    #[test]
    fn the_legend_is_always_present_because_ten_marks_is_too_many_to_recall() {
        assert!(tree(&plan(), false).contains("⋯ waiting"));
    }

    #[test]
    fn task_detail_separates_the_two_relations() {
        let mut p = plan();
        p.add_task(Task::new("keys", "export", "design keys").under("cache"))
            .unwrap();
        let out = task_detail(&p, &TaskId::new("cache"));
        assert!(out.contains("subtasks"), "{out}");
        assert!(out.contains("not blocked by it"), "{out}");

        let bench = task_detail(&p, &TaskId::new("bench"));
        assert!(bench.contains("depends on"), "{bench}");
        assert!(bench.contains("must come after"), "{bench}");
    }

    #[test]
    fn a_dangling_prerequisite_is_refused_rather_than_rendered() {
        // The unsatisfiable case cannot be built through the API at all, which is
        // the stronger guarantee: `Blocker::Missing` is defence against an
        // out-of-band edit to wecode.db, not a state the CLI can produce.
        let mut p = Plan::new();
        p.add_project(Project::new("x", "an objective sentence", "api"))
            .unwrap();
        assert!(
            p.add_task(Task::new("t", "x", "do the thing").after("ghost"))
                .is_err()
        );
    }

    #[test]
    fn task_detail_of_a_missing_task_says_so() {
        assert!(task_detail(&plan(), &TaskId::new("nope")).contains("no such task"));
    }

    #[test]
    fn project_detail_warns_when_a_project_has_no_tasks() {
        let mut p = Plan::new();
        p.add_project(Project::new("bare", "some real objective here", "api"))
            .unwrap();
        let out = project_detail(&p, &ProjectId::new("bare"));
        assert!(out.contains("no tasks"), "{out}");
    }

    #[test]
    fn ready_lists_only_unblocked_tasks() {
        // Both are schedulable; only the dependency separates them.
        let mut p = plan();
        for id in ["cache", "bench"] {
            let mut t = p.task(&TaskId::new(id)).unwrap().clone();
            t.status = TaskStatus::Waiting;
            p.update_task(t).unwrap();
        }
        let out = ready(&p);
        assert!(out.contains("cache"), "{out}");
        assert!(!out.contains("bench"), "bench waits on cache: {out}");
    }

    #[test]
    fn a_draft_task_is_not_ready_however_unblocked_it_is() {
        // Drafts are not dispatchable: `assign` is what admits work to the queue.
        let out = ready(&plan());
        assert!(out.contains("nothing ready"), "{out}");
    }

    #[test]
    fn ready_explains_an_empty_queue_that_is_merely_waiting() {
        let mut p = Plan::new();
        p.add_project(Project::new("x", "an objective sentence", "api"))
            .unwrap();
        p.add_task(Task::new("a", "x", "first")).unwrap();
        p.add_task(Task::new("b", "x", "second").after("a"))
            .unwrap();
        for id in ["a", "b"] {
            let mut t = p.task(&TaskId::new(id)).unwrap().clone();
            t.status = TaskStatus::Waiting;
            p.update_task(t).unwrap();
        }
        let mut a = p.task(&TaskId::new("a")).unwrap().clone();
        a.status = TaskStatus::Running;
        p.update_task(a).unwrap();
        let out = ready(&p);
        assert!(out.contains("waiting on prerequisites"), "{out}");
        // Merely waiting: the prerequisite is running, so time resolves this.
        assert!(!out.contains("stuck"), "{out}");
    }

    #[test]
    fn ready_tells_apart_waiting_that_will_resolve_from_waiting_that_will_not() {
        // "Waiting on prerequisites" promises a resolution. When the prerequisite
        // failed, that promise is false — the queue will stay empty until a person
        // acts, and the message has to say so.
        let mut p = Plan::new();
        p.add_project(Project::new("x", "an objective sentence", "api"))
            .unwrap();
        p.add_task(Task::new("a", "x", "first")).unwrap();
        p.add_task(Task::new("b", "x", "second").after("a"))
            .unwrap();
        let mut b = p.task(&TaskId::new("b")).unwrap().clone();
        b.status = TaskStatus::Waiting;
        p.update_task(b).unwrap();
        let mut a = p.task(&TaskId::new("a")).unwrap().clone();
        a.status = TaskStatus::Failed;
        p.update_task(a).unwrap();

        let out = ready(&p);
        assert!(out.contains("stuck on failed or dropped work"), "{out}");
        assert!(out.contains("cannot advance without you"), "{out}");
    }

    #[test]
    fn ready_does_not_call_parked_work_stuck() {
        // Archiving parks a project deliberately; its chains are not a cry for help.
        let mut p = Plan::new();
        p.add_project(Project::new("x", "an objective sentence", "api"))
            .unwrap();
        p.add_task(Task::new("a", "x", "first")).unwrap();
        p.add_task(Task::new("b", "x", "second").after("a"))
            .unwrap();
        let mut b = p.task(&TaskId::new("b")).unwrap().clone();
        b.status = TaskStatus::Waiting;
        p.update_task(b).unwrap();
        let mut a = p.task(&TaskId::new("a")).unwrap().clone();
        a.status = TaskStatus::Dropped;
        p.update_task(a).unwrap();
        let mut proj = p.project(&ProjectId::new("x")).unwrap().clone();
        proj.archived = true;
        p.update_project(proj).unwrap();

        assert!(!ready(&p).contains("stuck"), "{}", ready(&p));
    }

    #[test]
    fn task_detail_says_when_a_prerequisite_will_never_finish() {
        let mut p = plan();
        let mut cache = p.task(&TaskId::new("cache")).unwrap().clone();
        cache.status = TaskStatus::Failed;
        p.update_task(cache).unwrap();

        let out = task_detail(&p, &TaskId::new("bench"));
        assert!(out.contains("blocked by"), "{out}");
        assert!(out.contains("will not finish on its own"), "{out}");
        assert!(out.contains("reopen or re-point"), "{out}");
    }

    #[test]
    fn admission_lists_numbered_questions() {
        let mut p = Plan::new();
        p.add_project(Project::new("x", "an objective sentence", "api"))
            .unwrap();
        let t = Task::new("t", "x", "make the export faster");
        let defects = admission::check_task(&t, &p, &[]);
        let out = admission(&task_heading(&t), &defects, None);
        assert!(out.contains("defect"), "{out}");
        assert!(out.contains("  1  "), "{out}");
        // The vague term must appear in the question, not just be counted.
        assert!(out.contains("faster"), "{out}");
    }

    #[test]
    fn admission_confirms_a_well_formed_task() {
        let p = plan();
        let t = p.task(&TaskId::new("cache")).unwrap();
        let defects = admission::check_task(t, &p, &[]);
        let out = admission(&task_heading(t), &defects, None);
        assert!(out.contains("admitted"), "{out}");
        assert!(out.contains("cargo test cache"), "{out}");
        assert!(out.contains("crates/export/**"), "{out}");
    }

    /// The plan with `cache` turned into a person's job, stripped of everything a
    /// dispatch would have needed — which is how a manual task is actually declared.
    fn manual_plan() -> Plan {
        let mut p = plan();
        let mut t = p.task(&TaskId::new("cache")).unwrap().clone();
        t.doer = wecode_core::task::Doer::Person;
        t.acceptance.clear();
        t.scope = Scope::default();
        t.budget = Budget::default();
        t.assignee = Some("owner".into());
        p.update_task(t).unwrap();
        p
    }

    #[test]
    fn the_tree_says_which_rows_no_agent_will_ever_be_launched_for() {
        let out = tree(&manual_plan(), false);
        let line = out.lines().find(|l| l.contains("response cache")).unwrap();
        assert!(line.contains("by hand"), "{line:?}");
        // Beside the post, not instead of it: somebody still owns the job.
        assert!(line.contains("→ owner"), "{line:?}");
        let other = out.lines().find(|l| l.contains("benchmark")).unwrap();
        assert!(!other.contains("by hand"), "an agent's task says nothing");
    }

    #[test]
    fn a_manual_task_reads_as_admitted_rather_than_as_three_things_missing() {
        // The gate asks it for no scope, no budget and no acceptance, so the heading
        // has to say why it is short of all three — otherwise "admitted" over an empty
        // heading looks like the gate went to sleep.
        let p = manual_plan();
        let t = p.task(&TaskId::new("cache")).unwrap();
        let defects = admission::check_task(t, &p, &[]);
        assert!(defects.is_empty(), "{defects:?}");
        let out = admission(&task_heading(t), &defects, None);
        assert!(out.contains("admitted"), "{out}");
        assert!(out.contains("done by    a person"), "{out}");

        let detail = task_detail(&p, &TaskId::new("cache"));
        assert!(detail.contains("no agent is dispatched"), "{detail}");
    }

    #[test]
    fn a_waived_verdict_still_shows_the_defects() {
        let mut p = Plan::new();
        p.add_project(Project::new("x", "an objective sentence", "api"))
            .unwrap();
        let t = Task::new("t", "x", "");
        let defects = admission::check_task(&t, &p, &[]);
        let waived = Admission::decide(defects.clone(), "operator", vec![]);
        let out = admission(&task_heading(&t), &defects, Some(&waived));
        assert!(out.contains("defect"), "{out}");
    }
}
