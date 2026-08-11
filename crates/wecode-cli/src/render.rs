//! Rendering: the plan, the admission dialogue, and the governance surfaces.
//!
//! Pure string functions so the output is testable without a terminal.

use std::time::Duration;

use wecode_core::{
    Admission, Blocker, Defect, Plan, Project, ProjectId, ProjectStatus, Task, TaskId, TaskKind,
    TaskStatus,
};
use wecode_gov::{Action, ControlMode, Decision, Grant, Invariant, WorkKind};
use wecode_org::{Company, Post};
use wecode_store::{AuditLine, SessionInfo};

#[must_use]
pub(crate) fn kind_tag(kind: TaskKind) -> &'static str {
    match kind {
        TaskKind::Feature => "feat",
        TaskKind::Bug => "bug",
        TaskKind::Chore => "chore",
        TaskKind::Spike => "spike",
        TaskKind::Docs => "docs",
    }
}

/// The one-line legend. Ten task statuses is more than a reader can hold, so the
/// marks are always explained rather than assumed.
pub(crate) const LEGEND: &str = "  · draft   ⋯ waiting   ○ ready   > running   ? verifying/input   ! approval   ✓ done   x failed   - dropped\n";

/// The whole plan: projects, each with its task tree.
#[must_use]
pub(crate) fn tree(p: &Plan) -> String {
    if p.is_empty() {
        return "no projects yet — try: wecode project add <id> --repo <name> \"<objective>\"\n"
            .to_string();
    }
    let mut out = String::new();
    for proj in p.projects() {
        out.push_str(&project_line(p, proj));
        let mut roots: Vec<&Task> = p.roots_of(&proj.id).collect();
        roots.sort_by(|a, b| a.id.cmp(&b.id));
        for t in roots {
            render_task(p, t, 1, &mut out);
        }
    }
    out.push('\n');
    out.push_str(LEGEND);
    out
}

fn project_line(plan: &Plan, p: &Project) -> String {
    let done = plan.progress(&p.id);
    format!(
        "{} {:<20} {:<28} [{}] {:.0}%\n",
        project_mark(p.status),
        p.id.to_string(),
        p.objective,
        p.repo,
        done * 100.0
    )
}

#[must_use]
pub(crate) fn project_mark(s: ProjectStatus) -> char {
    match s {
        ProjectStatus::Draft => '·',
        ProjectStatus::Active => '>',
        ProjectStatus::Done => '✓',
        ProjectStatus::Dropped => '-',
    }
}

fn render_task(plan: &Plan, t: &Task, depth: usize, out: &mut String) {
    let indent = "  ".repeat(depth);
    let mut suffix = String::new();
    if !t.depends_on.is_empty() {
        let names: Vec<String> = t.depends_on.iter().map(ToString::to_string).collect();
        suffix.push_str(&format!(" after {}", names.join(", ")));
    }
    if let Some(a) = &t.assignee {
        suffix.push_str(&format!(" → {a}"));
    }
    out.push_str(&format!(
        "{indent}{} {:<5} {:<18} {}{}\n",
        t.status.mark(),
        kind_tag(t.kind),
        t.id.to_string(),
        t.title,
        suffix
    ));
    let mut kids: Vec<&Task> = plan.subtasks(&t.id).collect();
    kids.sort_by(|a, b| a.id.cmp(&b.id));
    for k in kids {
        render_task(plan, k, depth + 1, out);
    }
}

/// Everything schedulable right now — what a dispatcher would pick up.
#[must_use]
pub(crate) fn ready(p: &Plan) -> String {
    let mut tasks: Vec<&Task> = p.ready_tasks().collect();
    tasks.sort_by(|a, b| a.id.cmp(&b.id));
    if tasks.is_empty() {
        let waiting = p
            .tasks()
            .filter(|t| t.status == TaskStatus::Waiting)
            .count();
        if waiting > 0 {
            return format!(
                "nothing ready — {waiting} task{} waiting on prerequisites\n  wecode tree  to see what on\n",
                if waiting == 1 { "" } else { "s" }
            );
        }
        return "nothing ready\n".to_string();
    }
    let mut out = format!(
        "{:<18} {:<12} {:<10} {}\n",
        "task", "project", "assignee", "title"
    );
    for t in tasks {
        out.push_str(&format!(
            "{:<18} {:<12} {:<10} {}\n",
            t.id.to_string(),
            t.project.to_string(),
            t.assignee.as_deref().unwrap_or("—"),
            t.title
        ));
    }
    out
}

/// One project in full: objective, repo, measures, and its tasks by status.
#[must_use]
pub(crate) fn project_detail(plan: &Plan, id: &ProjectId) -> String {
    let Some(p) = plan.project(id) else {
        return format!("no such project: {id}\n");
    };
    let mut out = format!(
        "{}  {}\n  objective  {}\n  repo       {}\n  status     {}\n",
        project_mark(p.status),
        p.id,
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
    let mut roots: Vec<&Task> = plan.roots_of(id).collect();
    roots.sort_by(|a, b| a.id.cmp(&b.id));
    for t in roots {
        render_task(plan, t, 1, &mut out);
    }
    out.push('\n');
    out.push_str(LEGEND);
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
        "{} {} {}  {}\n  project    {}\n  status     {}\n",
        t.status.mark(),
        kind_tag(t.kind),
        t.id,
        t.title,
        t.project,
        t.status.as_str()
    );
    if let Some(a) = &t.assignee {
        out.push_str(&format!("  assignee   {a}\n"));
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
    let mut h = format!("project {}  {}\n  repo       {}", p.id, p.objective, p.repo);
    for m in &p.measures {
        h.push_str(&format!("\n  measure    {}", m.describe()));
    }
    h
}

/// The heading line for a task under judgement.
#[must_use]
pub(crate) fn task_heading(t: &Task) -> String {
    let mut h = format!(
        "{} {}  {}\n  project    {}",
        kind_tag(t.kind),
        t.id,
        t.title,
        t.project
    );
    for m in &t.acceptance {
        h.push_str(&format!("\n  acceptance {}", m.describe()));
    }
    if !t.scope.write.is_empty() {
        h.push_str(&format!("\n  writes     {}", t.scope.write.join(", ")));
    }
    h
}

/// Available org templates.
#[must_use]
pub(crate) fn templates() -> String {
    let mut out = String::from("templates:\n");
    for t in wecode_org::template::all() {
        out.push_str(&format!("  {:<18} {}\n", t.name, t.summary));
    }
    out.push_str("\n  wecode init <dir> --template <name>\n");
    out
}

/// Named orgs, and which is the default.
#[must_use]
pub(crate) fn orgs() -> String {
    let found = wecode_org::workspace::list();
    if found.is_empty() {
        return format!(
            "no orgs yet in {}\n  wecode init <name>\n",
            wecode_org::workspace::workspaces_root().display()
        );
    }
    let default = wecode_org::workspace::default_workspace();
    let mut out = String::new();
    for (name, ws) in found {
        let mark = if default.as_ref().is_some_and(|d| d.root() == ws.root()) {
            "*"
        } else {
            " "
        };
        let title = ws.load().map_or_else(
            |e| format!("⚠ {e}"),
            |c| format!("{} ({} posts)", c.name, c.posts.len()),
        );
        out.push_str(&format!("{mark} {name:<14} {title}\n"));
    }
    out.push_str("\n* = default. wecode use <name> to change.\n");
    out
}

/// The company profile: who exists, what they may do, what outranks them.
#[must_use]
pub(crate) fn company(c: &Company) -> String {
    let mut out = format!("{}  ({} profile)\n", c.name, c.profile);
    if !c.description.is_empty() {
        for line in c.description.lines() {
            out.push_str(&format!("  {line}\n"));
        }
    }
    if !c.vision.is_empty() {
        out.push_str(&format!("\nvision: {}\n", c.vision));
    }

    out.push_str("\nposts\n");
    out.push_str(&format!(
        "  {:<10} {:<11} {:<14} {}\n",
        "post", "role", "agent", "writes"
    ));
    for p in &c.posts {
        let writes = match c.grant_of(p) {
            Some(g) if g.write.is_empty() => "— (read only)".to_string(),
            Some(g) => g.write.join(", "),
            None => "?? unknown role".to_string(),
        };
        out.push_str(&format!(
            "  {:<10} {:<11} {:<14} {}\n",
            p.name, p.role, p.agent, writes
        ));
    }

    if let Some(chief) = c.chief() {
        out.push_str(&format!(
            "\nchief of staff: {} — configures and assigns; cannot write or run\n",
            chief.name
        ));
    } else {
        out.push_str("\n⚠ no chief post: nothing can assign work\n");
    }

    if c.repos.is_empty() {
        out.push_str("\n⚠ no [[repos]] declared — nothing to work on yet\n");
    } else {
        out.push_str("\nrepos\n");
        for r in &c.repos {
            out.push_str(&format!("  {:<10} {}\n", r.name, r.path));
        }
    }

    out.push_str(&format!(
        "\nattention: {} open items, {} interrupts/hour, digest every {}m\n",
        c.attention.max_open_items,
        c.attention.max_interrupts_per_hour,
        c.attention.digest_interval_mins
    ));

    out.push_str("\ninvariants (outrank every grant above)\n");
    for inv in &c.charter.invariants {
        out.push_str(&format!("  {}\n", invariant_line(inv)));
    }
    out
}

fn invariant_line(inv: &Invariant) -> String {
    match inv {
        Invariant::NeverTouch(v) => format!("never touch    {}", v.join(", ")),
        Invariant::NeverRun(v) => format!("never run      {}", v.join(", ")),
        Invariant::ApprovalToMerge(v) => format!("approve merge  {}", v.join(", ")),
        Invariant::MaxTokens(n) => format!("max tokens     {n}"),
        Invariant::MaxWallSecs(n) => format!("max wall       {n}s"),
    }
}

/// The commands a grant unlocks.
///
/// **This is the discovery mechanism.** An agent logs in, asks `whoami`, and learns
/// its surface instead of guessing or hardcoding role names. Kept as one function
/// because an MCP server would expose exactly this list as its tool set — the
/// derivation should exist once.
#[must_use]
pub(crate) fn available_commands(grant: &Grant) -> Vec<(&'static str, String)> {
    let mut out = vec![
        ("tree", "projects and their tasks".to_string()),
        ("ready", "what is schedulable now".to_string()),
        ("show <id>", "one project or task in full".to_string()),
        ("board [<id>]", "the cockpit".to_string()),
        ("audit", "the ledger".to_string()),
    ];
    if grant.define.contains(&WorkKind::Project) {
        out.push(("project add", "define a project".to_string()));
    }
    if grant.define.contains(&WorkKind::Task) {
        out.push(("task add", "define a task".to_string()));
    }
    if grant.staff {
        out.push(("assign <task> --to <post>", "dispatch work".to_string()));
    }
    if !grant.approve.is_empty() {
        let kinds: Vec<String> = grant
            .approve
            .iter()
            .map(|k| k.as_str().to_string())
            .collect();
        out.push(("approve <what>", format!("may sign: {}", kinds.join(", "))));
    }
    out
}

/// The current seat, and what it may do.
#[must_use]
pub(crate) fn whoami(
    company: &Company,
    s: &SessionInfo,
    post: &Post,
    grant: Option<&Grant>,
) -> String {
    let mut out = format!(
        "{}  ·  {}\n  seat     {} ({})\n  who      {}\n",
        company.name,
        s.id,
        post.name,
        post.role,
        s.who()
    );

    let Some(g) = grant else {
        out.push_str("\n  ⚠ role has no grant — this seat can do nothing\n");
        return out;
    };

    if !g.write.is_empty() {
        out.push_str(&format!("  writes   {}\n", g.write.join(", ")));
    }
    if let Some(t) = g.tokens {
        out.push_str(&format!("  budget   {t} tokens\n"));
    }

    out.push_str("\ncommands\n");
    for (cmd, note) in available_commands(g) {
        out.push_str(&format!("  {cmd:<28} {note}\n"));
    }
    out
}

fn ago(secs: u64) -> String {
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m", secs / 60),
        3600..=86_399 => format!("{}h", secs / 3600),
        _ => format!("{}d", secs / 86_400),
    }
}

/// Everything connected right now.
#[must_use]
pub(crate) fn who(sessions: &[SessionInfo], ttl: Duration, now: u64) -> String {
    if sessions.is_empty() {
        return "nobody connected — wecode login <user>\n".to_string();
    }
    let mut out = format!(
        "{:<11} {:<10} {:<24} {:<7} {:<7} {}\n",
        "session", "post", "who", "age", "idle", "state"
    );
    for s in sessions {
        let expired = s.is_expired(ttl, now);
        out.push_str(&format!(
            "{:<11} {:<10} {:<24} {:<7} {:<7} {}\n",
            s.id,
            s.post,
            s.who(),
            ago(s.age_secs(now)),
            ago(s.idle_secs(now)),
            if expired {
                "expired"
            } else if s.is_autonomous() {
                "working"
            } else {
                "live"
            }
        ));
    }
    out
}

/// One authorisation verdict, with the reason and what happens next.
#[must_use]
pub(crate) fn decision(post: &str, occupant: &str, action: &Action, d: &Decision) -> String {
    let (verb, target) = match action {
        Action::Read { path } => ("read", path.clone()),
        Action::Write { path } => ("write", path.clone()),
        Action::Run { argv } => ("run", argv.join(" ")),
        Action::Merge { branch } => ("merge", branch.clone()),
        Action::Spend { tokens, wall_secs } => ("spend", format!("{tokens} tokens, {wall_secs}s")),
        other => ("act", format!("{other:?}")),
    };

    let mut out = format!("{post} ({occupant})  {verb} {target}\n\n");
    match d {
        Decision::Allow => out.push_str("  ✓ allowed\n"),
        Decision::RequireApproval { by } => out.push_str(&format!(
            "  ⏸ needs approval: {}\n     nothing happens until a holder signs.\n",
            by.as_str()
        )),
        Decision::Deny {
            reason,
            mode,
            alarm,
        } => {
            out.push_str(&format!("  ✗ denied — {reason}\n"));
            match mode {
                ControlMode::Regimented => {
                    out.push_str("     regimented: blocked before it happens.\n");
                }
                ControlMode::Sanctioned => out.push_str(
                    "     sanctioned: recoverable, so the attempt is recorded as a signal.\n\
                     \x20    repeated attempts mean the scope is wrong, not the agent.\n",
                ),
            }
            if *alarm {
                out.push_str(
                    "\n  ⚡ ALARM — charter invariant. Dispatch freezes until acknowledged.\n",
                );
            }
        }
    }
    out
}

/// The audit ledger.
#[must_use]
pub(crate) fn audit(lines: &[AuditLine]) -> String {
    if lines.is_empty() {
        return "no matching audit records\n".to_string();
    }
    let mut out = String::from("seq  post        agent         verdict   action  target\n");
    for l in lines {
        let mark = match l.outcome.as_str() {
            "allow" => "✓ allow",
            "approval" => "⏸ approve",
            "alarm" => "⚡ ALARM",
            _ => "✗ deny",
        };
        out.push_str(&format!(
            "{:<4} {:<11} {:<13} {:<9} {:<7} {}\n",
            l.seq, l.post, l.agent, mark, l.action, l.target
        ));
        if !l.detail.is_empty() && l.outcome != "allow" {
            out.push_str(&format!("     └─ {}\n", l.detail));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Budget, Measure, Scope, admission};
    use wecode_gov::{Broker, Charter, Effective, Grant, Invariant, Session};

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
        let out = tree(&Plan::new());
        assert!(out.contains("no projects yet"), "{out}");
        assert!(out.contains("project add"), "{out}");
    }

    #[test]
    fn tree_nests_tasks_under_their_project() {
        let out = tree(&plan());
        let proj = out.lines().find(|l| l.contains("export")).unwrap();
        let task = out.lines().find(|l| l.contains("cache")).unwrap();
        assert!(!proj.starts_with(' '), "{proj:?}");
        assert!(task.starts_with("  "), "{task:?}");
    }

    #[test]
    fn tree_shows_a_dependency_but_not_as_nesting() {
        // The whole point of the two-relation model: `bench` comes after `cache`
        // without being *part of* it, so it must not be indented under it.
        let out = tree(&plan());
        let bench = out.lines().find(|l| l.contains("bench")).unwrap();
        assert!(bench.contains("after cache"), "{bench:?}");
        assert_eq!(
            bench.len() - bench.trim_start().len(),
            2,
            "a dependency is a sibling, not a child: {bench:?}"
        );
    }

    #[test]
    fn a_subtask_is_indented_and_carries_no_after_note() {
        let mut p = plan();
        p.add_task(Task::new("cache-keys", "export", "design the cache keys").under("cache"))
            .unwrap();
        let out = tree(&p);
        let sub = out.lines().find(|l| l.contains("cache-keys")).unwrap();
        assert_eq!(sub.len() - sub.trim_start().len(), 4, "{sub:?}");
        assert!(!sub.contains("after"), "{sub:?}");
    }

    #[test]
    fn the_legend_is_always_present_because_ten_marks_is_too_many_to_recall() {
        assert!(tree(&plan()).contains("⋯ waiting"));
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
    }

    #[test]
    fn admission_lists_numbered_questions() {
        let mut p = Plan::new();
        p.add_project(Project::new("x", "an objective sentence", "api"))
            .unwrap();
        let t = Task::new("t", "x", "make the export faster");
        let defects = admission::check_task(&t, &p);
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
        let defects = admission::check_task(t, &p);
        let out = admission(&task_heading(t), &defects, None);
        assert!(out.contains("admitted"), "{out}");
        assert!(out.contains("cargo test cache"), "{out}");
        assert!(out.contains("crates/export/**"), "{out}");
    }

    #[test]
    fn a_waived_verdict_still_shows_the_defects() {
        let mut p = Plan::new();
        p.add_project(Project::new("x", "an objective sentence", "api"))
            .unwrap();
        let t = Task::new("t", "x", "");
        let defects = admission::check_task(&t, &p);
        let waived = Admission::decide(defects.clone(), "operator", vec![]);
        let out = admission(&task_heading(&t), &defects, Some(&waived));
        assert!(out.contains("defect"), "{out}");
    }

    fn verdict_for(grant: Grant, action: &Action) -> (Decision, Vec<AuditLine>) {
        let mut b = Broker::new(Charter::with(vec![
            Invariant::NeverTouch(vec!["**/*.pem".into()]),
            Invariant::ApprovalToMerge(vec!["main".into()]),
        ]));
        let s = Session::new("s", "impl-api", "claude-code", Effective::of(vec![grant]))
            .on(Some("export".into()), Some("cache".into()));
        let d = b.authorize(&s, action);
        let store = wecode_store::Store::in_memory().unwrap();
        store.append_records(b.ledger()).unwrap();
        let lines = store.audit(&wecode_store::AuditQuery::default()).unwrap();
        (d, lines)
    }

    fn engineer() -> Grant {
        Grant::writer(&["crates/**"])
            .with_run(&["cargo *"])
            .with_spend(1000, 60)
    }

    #[test]
    fn allowed_action_reads_plainly() {
        let action = Action::Write {
            path: "crates/export/a.rs".into(),
        };
        let (d, _) = verdict_for(engineer(), &action);
        let out = decision("impl-api", "claude-code", &action, &d);
        assert!(out.contains("allowed"), "{out}");
        assert!(out.contains("crates/export/a.rs"), "{out}");
    }

    #[test]
    fn sanctioned_denial_explains_it_is_a_signal() {
        let action = Action::Write {
            path: "secrets/other.txt".into(),
        };
        let (d, _) = verdict_for(engineer(), &action);
        let out = decision("impl-api", "claude-code", &action, &d);
        assert!(out.contains("denied"), "{out}");
        assert!(out.contains("sanctioned"), "{out}");
        assert!(out.contains("scope is wrong"), "{out}");
    }

    #[test]
    fn an_invariant_violation_announces_the_freeze() {
        let action = Action::Write {
            path: "deploy/key.pem".into(),
        };
        let (d, _) = verdict_for(Grant::root(), &action);
        let out = decision("impl-api", "claude-code", &action, &d);
        assert!(out.contains("ALARM"), "{out}");
        assert!(out.contains("freezes"), "{out}");
    }

    #[test]
    fn approval_says_nothing_happens_yet() {
        let action = Action::Merge {
            branch: "main".into(),
        };
        let (d, _) = verdict_for(Grant::root(), &action);
        let out = decision("review", "claude-code", &action, &d);
        assert!(out.contains("needs approval"), "{out}");
        assert!(out.contains("nothing happens"), "{out}");
    }

    #[test]
    fn empty_audit_says_so() {
        assert!(audit(&[]).contains("no matching"));
    }

    #[test]
    fn audit_shows_verdict_and_reason() {
        let action = Action::Write {
            path: "deploy/key.pem".into(),
        };
        let (_, lines) = verdict_for(Grant::root(), &action);
        let out = audit(&lines);
        assert!(out.contains("ALARM"), "{out}");
        assert!(out.contains("deploy/key.pem"), "{out}");
        assert!(out.contains("└─"), "reason should be shown: {out}");
    }

    #[test]
    fn audit_omits_a_reason_for_allowed_actions() {
        let action = Action::Write {
            path: "crates/a.rs".into(),
        };
        let (_, lines) = verdict_for(engineer(), &action);
        let out = audit(&lines);
        assert!(out.contains("allow"), "{out}");
        assert!(!out.contains("└─"), "{out}");
    }

    #[test]
    fn available_commands_track_the_grant_not_the_role_name() {
        let chief = Grant {
            read: vec!["**".into()],
            define: [WorkKind::Project, WorkKind::Task].into(),
            staff: true,
            ..Grant::default()
        };
        let cmds = available_commands(&chief);
        let names: Vec<&str> = cmds.iter().map(|(c, _)| *c).collect();
        assert!(names.contains(&"project add"), "{names:?}");
        assert!(names.contains(&"task add"), "{names:?}");

        let coder = available_commands(&engineer());
        let names: Vec<&str> = coder.iter().map(|(c, _)| *c).collect();
        assert!(!names.contains(&"project add"), "{names:?}");
    }
}
