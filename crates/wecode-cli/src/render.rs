//! Rendering: the plan, the admission dialogue, and the governance surfaces.
//!
//! Pure string functions so the output is testable without a terminal.

use std::path::Path;
use std::time::Duration;

use wecode_a2a as a2a;
use wecode_core::{
    Admission, Blocker, Defect, Plan, Project, ProjectId, Task, TaskId, TaskKind, TaskStatus,
};
use wecode_gov::{Action, ControlMode, Decision, Grant, Invariant, WorkKind};
use wecode_org::{Company, Post};
use wecode_org::{Gap, Playbook};
use wecode_store::{AuditLine, SessionInfo};

use crate::record::Recorded;
use crate::teardown::{Swept, Torn};

#[must_use]
pub(crate) fn kind_tag(kind: TaskKind) -> &'static str {
    match kind {
        TaskKind::Feature => "feat",
        TaskKind::Bug => "bug",
        // Five characters at most: the tag column is padded to 5, and `refactor`
        // would push every title out of alignment.
        TaskKind::Refactor => "refac",
        TaskKind::Chore => "chore",
        TaskKind::Spike => "spike",
        TaskKind::Design => "dsgn",
        TaskKind::Docs => "docs",
    }
}

/// The one-line legend. Ten task statuses is more than a reader can hold, so the
/// marks are always explained rather than assumed.
pub(crate) const LEGEND: &str = "  · draft   ⋯ waiting   ○ ready   > running   ? verifying/input   ! approval   ✓ done   x failed   - dropped\n";

/// The whole plan: projects, each with its task tree.
///
/// `show_all` includes archived projects. Hiding is never silent — when anything is
/// omitted the footer says how much and how to see it.
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

    let mut out = String::new();
    for proj in projects {
        out.push_str(&project_line(p, proj));
        let mut roots: Vec<&Task> = p.roots_of(&proj.id).collect();
        roots.sort_by(|a, b| a.id.cmp(&b.id));
        for t in roots {
            render_task(p, t, 1, &mut out);
        }
    }
    out.push('\n');
    out.push_str(LEGEND);
    out.push_str(&archived_note(p, show_all));
    out
}

/// One line naming what is not on screen. A view that quietly shows less than
/// everything is worse than one that shows too much.
fn archived_note(p: &Plan, show_all: bool) -> String {
    let n = p.archived_count();
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
        "{} {:<20} {:<28} [{}] {:.0}%{}\n",
        p.status.mark(),
        p.id.to_string(),
        p.objective,
        p.repo,
        done * 100.0,
        if p.archived { "  archived" } else { "" }
    )
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
        "{}  {}\n  objective  {}\n  repo       {}\n  status     {}\n",
        p.status.mark(),
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

// -------------------------------------------------------------- playbook ------

fn playbook_header(project: &Project, pb: &Playbook) -> String {
    let lang = if pb.project.language.is_empty() {
        String::new()
    } else {
        format!(", {}", pb.project.language)
    };
    format!("  project   {}  [{}{}]\n", project.id, project.repo, lang)
}

/// Every kind this project has guidance for.
#[must_use]
pub(crate) fn playbook_all(project: &Project, pb: &Playbook, gaps: &[Gap]) -> String {
    let mut out = playbook_header(project, pb);
    if let Some(b) = &pb.project.merge_to {
        out.push_str(&format!("  branch    from {b}\n"));
    }
    // As written in the file, `~` and all. This is a view of the playbook; where that
    // path lands on this machine is what `wecode start` reports, in the notes beside
    // the worktree it belongs to.
    for c in &pb.project.build_cache {
        out.push_str(&format!("  cache     {} = {}\n", c.var, c.path));
    }
    if pb.is_empty() {
        out.push_str("\n  no kinds have guidance yet\n");
        return out;
    }
    out.push_str(&format!(
        "\n  {:<10} {:<9} {:<9} {}\n",
        "kind", "worktree", "assign", "accept"
    ));
    for (kind, k) in pb.kinds() {
        out.push_str(&format!(
            "  {:<10} {:<9} {:<9} {}\n",
            kind.as_str(),
            if k.worktree { "yes" } else { "no" },
            k.assign_to.as_deref().unwrap_or("—"),
            if k.accept.is_empty() {
                "—".to_string()
            } else {
                k.accept.join(", ")
            }
        ));
    }
    let templated: Vec<&str> = pb
        .kinds()
        .iter()
        .filter(|(_, k)| !k.subtasks.is_empty())
        .map(|(kind, _)| kind.as_str())
        .collect();
    if !templated.is_empty() {
        out.push_str(&format!(
            "\n  --expand emits subtasks for: {}\n",
            templated.join(", ")
        ));
    }
    let gated: Vec<&str> = pb
        .kinds()
        .iter()
        .filter(|(_, k)| k.design_required)
        .map(|(kind, _)| kind.as_str())
        .collect();
    if !gated.is_empty() {
        out.push_str(&format!(
            "\n  a design must stand before: {}\n",
            gated.join(", ")
        ));
    }
    out.push_str(&gap_count(gaps));
    out.push_str("\n  wecode playbook <kind>  for the guidance itself\n");
    out
}

/// What `playbook init` wrote, and what it decided while writing it.
///
/// Every decision the starter made on the project's behalf is reported here rather
/// than left in the file to be discovered: which language, where it was read from, the
/// commands that will judge every task, and the directory the worktrees will share.
/// These are the lines a person is expected to disagree with — a starter that stated
/// them only in TOML would be trusted by whoever never opened it.
///
/// `refusal` is the load-time check applied to what was just written. It is a warning
/// and not an error: the file is correct for the repository and wrong only for this
/// machine, and deleting it would be the wrong answer to that.
#[must_use]
pub(crate) fn playbook_written(
    project: &Project,
    w: &wecode_org::Written,
    refusal: Option<&str>,
) -> String {
    let mut out = format!("  wrote {}\n\n", w.path.display());

    match (&w.toolchain, w.detected_from) {
        (Some(t), Some(from)) => {
            out.push_str(&format!("  language  {} — read off {from}\n", t.name));
        }
        (Some(t), None) => out.push_str(&format!("  language  {}\n", t.name)),
        (None, _) => {
            let said = if w.language.is_empty() {
                "none given, and none could be read off the repo".to_string()
            } else {
                format!("{} — no toolchain here answers to it", w.language)
            };
            out.push_str(&format!(
                "  language  {said}\n            accept is empty and every guidance is TODO; \
                 wecode knows {}\n",
                wecode_org::toolchain::known()
            ));
        }
    }
    if let Some(t) = w.toolchain {
        for (i, cmd) in t.accept.iter().enumerate() {
            out.push_str(&format!(
                "  {:<9} {cmd}\n",
                if i == 0 { "accept" } else { "" }
            ));
        }
        for (i, (var, dir)) in w.cache.iter().enumerate() {
            out.push_str(&format!(
                "  {:<9} {var} = {dir}\n",
                if i == 0 { "cache" } else { "" }
            ));
        }
    }

    if let Some(why) = refusal {
        out.push_str(&format!(
            "\n  ! this machine cannot run what the starter names\n    {}\n    \
             every command that reads this playbook refuses it until that line names \
             something this machine has\n",
            why.trim()
        ));
    }

    out.push_str(if w.toolchain.is_some() {
        "\n  The accept lines are the toolchain's usual commands rather than this \
         project's —\n  run them once, then fill in the guidance for each kind:\n"
    } else {
        "\n  Fill in the acceptance commands and the guidance for each kind:\n"
    });
    out.push_str(&format!(
        "    wecode playbook bug --project {}\n\n  Commit it — it describes this code, \
         so it belongs with it.\n  Add {}/ to .gitignore; it is the worker-writable \
         area.\n",
        project.id,
        wecode_org::playbook::RUN_DIR
    ));
    out
}

/// Counted rather than listed: the index is not where a gap is read, it is where a
/// reader finds out there is one. Saying nothing here would leave findings sitting in
/// a file nobody opens.
#[must_use]
pub(crate) fn gap_count(gaps: &[Gap]) -> String {
    if gaps.is_empty() {
        return String::new();
    }
    format!(
        "\n  {} gap{} recorded and not folded in — wecode playbook gaps\n",
        gaps.len(),
        if gaps.len() == 1 { "" } else { "s" }
    )
}

/// One kind in full: the typed defaults, then the prose.
#[must_use]
pub(crate) fn playbook_kind(
    project: &Project,
    pb: &Playbook,
    kind: TaskKind,
    gaps: &[Gap],
    now: u64,
) -> String {
    let mut out = playbook_header(project, pb);
    let Some(k) = pb.for_kind(kind) else {
        out.push_str(&format!(
            "\n  no [{}] section — this project has no guidance for that kind\n",
            kind.as_str()
        ));
        // Shown even here. "There is no section" is the strongest reason for a gap
        // to have been recorded against this kind, so it is the last place to hide
        // one.
        out.push_str(&gaps_against(kind, gaps, now));
        return out;
    };
    out.push_str(&format!(
        "  kind      {}\n  worktree  {}\n",
        kind.as_str(),
        if k.worktree {
            match &pb.project.merge_to {
                Some(b) => format!("yes, branched from {b}"),
                None => "yes".to_string(),
            }
        } else {
            "no".to_string()
        }
    ));
    if k.design_required {
        out.push_str("  design    required — admitted only behind a design task\n");
    }
    if let Some(post) = &k.assign_to {
        out.push_str(&format!("  assign    {post}\n"));
    }
    for cmd in &k.accept {
        out.push_str(&format!("  accept    {cmd}\n"));
    }
    // What `--expand` would emit. Shown before the prose because it is the part the
    // reader can act on without writing anything: a decomposition already decided.
    if !k.subtasks.is_empty() {
        out.push_str(&format!(
            "  expand    {}\n",
            k.subtasks
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>()
                .join(" → ")
        ));
        let width = k.subtasks.iter().map(|s| s.name.len()).max().unwrap_or(0);
        for s in &k.subtasks {
            out.push_str(&format!(
                "              {:<width$}  {:<5}  {}",
                s.name,
                kind_tag(s.kind.unwrap_or(kind)),
                if s.write.is_empty() {
                    "—".to_string()
                } else {
                    s.write.join(", ")
                }
            ));
            if !s.after.is_empty() {
                out.push_str(&format!("  after {}", s.after.join(", ")));
            }
            out.push('\n');
        }
    }
    if !k.guidance.is_empty() {
        out.push_str("  ---\n");
        for line in k.guidance.lines() {
            out.push_str(&format!("  {line}\n"));
        }
    }
    // After the prose, because that is the order they were learned in: the guidance
    // is what the project decided, a gap is what it has since found out and not yet
    // written down.
    out.push_str(&gaps_against(kind, gaps, now));
    out
}

/// The gaps a reader of one kind's guidance should see: the ones filed against that
/// kind, plus the ones filed against no kind at all, which are about how this project
/// is planned and therefore apply to all of them.
fn gaps_against(kind: TaskKind, gaps: &[Gap], now: u64) -> String {
    let mine: Vec<&Gap> = gaps.iter().filter(|g| g.applies_to(kind)).collect();
    if mine.is_empty() {
        return String::new();
    }
    format!(
        "\n  gaps found in this guidance and not folded in yet:\n\n{}",
        gap_entries(&mine, now)
    )
}

/// Every gap on a project, for `wecode playbook gaps`.
#[must_use]
pub(crate) fn gaps(
    project: &Project,
    gaps: &[Gap],
    now: u64,
    playbook: &Path,
    file: &Path,
) -> String {
    if gaps.is_empty() {
        return format!(
            "  no gaps recorded against {}'s playbook\n  \
             wecode playbook gap \"<what the guidance does not say>\" --kind <kind>\n",
            project.id
        );
    }
    let list: Vec<&Gap> = gaps.iter().collect();
    format!(
        "  {} gap{} against {}'s playbook, oldest first\n\n{}{}",
        gaps.len(),
        if gaps.len() == 1 { "" } else { "s" },
        project.id,
        gap_entries(&list, now),
        folding("each", playbook, file)
    )
}

/// How one stops being a gap. Printed wherever they are, because the file will not
/// empty itself and nothing else in wecode will empty it either.
fn folding(subject: &str, playbook: &Path, file: &Path) -> String {
    format!(
        "  Fold {subject} into {}\n  then delete it from {}\n",
        playbook.display(),
        file.display()
    )
}

/// One block per gap: where it belongs, who found it and when, then the note itself.
fn gap_entries(gaps: &[&Gap], now: u64) -> String {
    let mut out = String::new();
    for g in gaps {
        let mut head = format!(
            "    {}",
            // A gap filed against no kind is about the project's planning as a
            // whole, and saying "—" here would read as missing data.
            g.kind.map_or("every kind", TaskKind::as_str)
        );
        head.push_str(&format!("  ·  {} ago", ago(now.saturating_sub(g.at))));
        if !g.by.is_empty() {
            head.push_str(&format!("  ·  {}", g.by));
        }
        if let Some(task) = &g.task {
            head.push_str(&format!("  ·  found on {task}"));
        }
        out.push_str(&format!("{head}\n"));
        for line in g.note.lines() {
            out.push_str(&format!("      {line}\n"));
        }
        out.push('\n');
    }
    out
}

/// What `playbook gap` says once a finding is on the record.
#[must_use]
pub(crate) fn gap_recorded(g: &Gap, fresh: bool, playbook: &Path, file: &Path) -> String {
    let mut out = if fresh {
        format!("  recorded a gap in {}'s playbook\n\n", g.project)
    } else {
        // Not an error, and not silence either: something that records in a loop
        // needs to know the finding is held without being told it failed.
        format!(
            "  already recorded against {}'s playbook — nothing was added\n\n",
            g.project
        )
    };
    for line in g.note.lines() {
        out.push_str(&format!("    {line}\n"));
    }
    out.push_str(&format!(
        "\n  {}{}\n",
        match g.kind {
            Some(k) => format!("against [{}]", k.as_str()),
            None => "against the project, so every kind shows it".to_string(),
        },
        g.task
            .as_ref()
            .map_or_else(String::new, |t| format!(", found on {t}"))
    ));
    out.push_str(
        "\n  It is a note, not a change: nothing acts on it, and it stays here until\n\
         \x20 a person has done something about it.\n\n",
    );
    out.push_str(&folding("it", playbook, file));
    out
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

// ----------------------------------------------------------------- brief ------

/// What an agent needs to act as this seat.
///
/// Every claim is derived: the permissions come from the grant, the prohibitions from
/// the charter. A stored prompt would keep asserting authority after a role was
/// narrowed, and the Broker would then refuse what the briefing promised.
#[must_use]
pub(crate) fn brief(
    company: &Company,
    s: &SessionInfo,
    post: &Post,
    grant: Option<&Grant>,
    plan: &Plan,
    playbooks: &[(Project, Vec<&str>)],
    org: String,
) -> String {
    let mut out = format!(
        "You are working in {} as `{}` ({}), through {}.\n",
        company.name, post.name, post.role, post.agent
    );
    if let Some(h) = &s.human {
        out.push_str(&format!("The person in this seat is {h}.\n"));
    }
    if !company.vision.is_empty() {
        out.push_str(&format!("\n{}\n", company.vision));
    }

    let Some(g) = grant else {
        out.push_str("\n  ⚠ this role has no grant — the seat can do nothing\n");
        return out;
    };

    out.push_str("\nYOU MAY\n");
    for (cmd, note) in available_commands(g) {
        out.push_str(&format!("  {cmd:<26} {note}\n"));
    }
    if !g.write.is_empty() {
        out.push_str(&format!("  {:<26} {}\n", "write", g.write.join(", ")));
    }
    if !g.run.is_empty() {
        out.push_str(&format!("  {:<26} {}\n", "run", g.run.join(", ")));
    }

    // Stated explicitly, because an absent capability is invisible otherwise and the
    // agent would discover it as a refusal mid-task.
    out.push_str("\nYOU MAY NOT\n");
    if g.write.is_empty() {
        out.push_str("  write files                this seat assigns, it does not execute\n");
    }
    if g.run.is_empty() {
        out.push_str("  run commands\n");
    }
    out.push_str("  commit or merge            wecode does both, after checks pass\n");

    out.push_str("\nNEVER — charter invariants, which outrank every grant above\n");
    for inv in &company.charter.invariants {
        out.push_str(&format!("  {}\n", invariant_line(inv)));
    }

    out.push_str("\nPROJECTS\n");
    if playbooks.is_empty() {
        out.push_str("  none yet\n");
    }
    for (p, kinds) in playbooks {
        let total = plan.tasks_of(&p.id).count();
        out.push_str(&format!(
            "  {:<14} [{}]  {} task{}, {:.0}%   playbook: {}\n",
            p.id.to_string(),
            p.repo,
            total,
            if total == 1 { "" } else { "s" },
            plan.progress(&p.id) * 100.0,
            if kinds.is_empty() {
                "none — wecode playbook init".to_string()
            } else {
                kinds.join(" ")
            }
        ));
    }

    let ready: Vec<&Task> = plan.ready_tasks().collect();
    let waiting: Vec<&Task> = plan.tasks().filter(|t| t.status.needs_a_human()).collect();

    out.push_str("\nHOW TO WORK\n");
    if g.define.contains(&WorkKind::Task) {
        out.push_str(
            "  1  wecode playbook <kind>      read the project's guidance FIRST\n\
             \x20 2  wecode task add ...         one atomic task per outcome\n\
             \x20 3  wecode assign <t> --to <p>  admit it to the queue\n\
             \x20 4  wecode start <t>            worktree + envelope for the worker\n\
             \x20 5  wecode playbook gap \"...\"   when step 1 did not tell you something\n\
             \x20                                it should have. It reaches the next planner.\n",
        );
    } else {
        out.push_str(
            "  1  wecode ready                what you may pick up\n\
             \x20 2  wecode start <task>         your worktree and instructions\n\
             \x20 3  wecode show <task>          the acceptance you are judged by\n",
        );
    }
    out.push_str(&format!(
        "\n  {} ready · {} needs a human · worktrees under ~/.wecode/run/{}\n",
        ready.len(),
        waiting.len(),
        org
    ));
    if !waiting.is_empty() {
        for t in waiting.iter().take(5) {
            out.push_str(&format!(
                "    {} {}  {}\n",
                t.status.mark(),
                t.id,
                t.status.as_str()
            ));
        }
    }
    out
}

/// Who a listed worktree belongs to.
///
/// Four answers rather than two, because *ours with a task*, *ours with none*, and
/// *not ours at all* are different situations calling for different action, and the
/// previous two-way split called all three an orphan.
pub(crate) enum Tenant {
    /// A task in the plan works here.
    Task {
        id: String,
        project: String,
        status: TaskStatus,
    },
    /// wecode made it, and the task it was made for is no longer in the plan. This is
    /// the only real orphan: ours to clean up, with nothing left to ask.
    Orphan { task: String },
    /// The checkout a merge borrows for the integration branch. Created and removed
    /// inside one command, so seeing it means wecode died mid-merge.
    Merge,
    /// Another tool's worktree in the same repository. Not ours to touch — and saying
    /// so is the whole point, because a stranger reported as an orphan invites the
    /// operator to delete somebody else's work.
    Stranger,
}

impl Tenant {
    /// The `task` and `status` cells. Both are `—` for a tree with no task, rather
    /// than borrowing a status the tree does not have.
    fn cells(&self) -> (String, &str, &str) {
        match self {
            Self::Task {
                id,
                project,
                status,
            } => (id.clone(), project.as_str(), status.as_str()),
            Self::Orphan { task } => (format!("— orphan ({task})"), "—", "—"),
            Self::Merge => ("— merge scratch".to_string(), "—", "—"),
            Self::Stranger => ("— not ours".to_string(), "—", "—"),
        }
    }
}

/// One row of `wecode worktree`: where the tree is, and who is in it.
pub(crate) struct WorktreeRow {
    pub path: String,
    pub tenant: Tenant,
}

/// The worktrees of one repository. The repo is the unit a worktree belongs to, so it
/// is the unit the listing is grouped by — several projects sharing a repository share
/// this one set of trees, and each tree appears under it once.
pub(crate) struct RepoTrees {
    /// The `[[repos]]` name.
    pub repo: String,
    /// Where the main checkout is, so the group names a place and not just a label.
    pub path: String,
    pub rows: Vec<WorktreeRow>,
}

/// Every worktree wecode can see, grouped by the repository it was cut from.
#[must_use]
pub(crate) fn worktrees(repos: &[RepoTrees]) -> String {
    let total: usize = repos.iter().map(|r| r.rows.len()).sum();
    if total == 0 {
        return "no worktrees\n".to_string();
    }
    let mut out = format!(
        "  {:<20} {:<12} {:<10} {}\n",
        "task", "project", "status", "path"
    );
    for r in repos.iter().filter(|r| !r.rows.is_empty()) {
        out.push_str(&format!("{} — {}\n", r.repo, r.path));
        for row in &r.rows {
            let (task, project, status) = row.tenant.cells();
            out.push_str(&format!(
                "  {task:<20} {project:<12} {status:<10} {}\n",
                row.path
            ));
        }
    }
    out.push_str(&worktree_tally(repos, total));
    out
}

/// One line saying what the rows add up to. The fault that prompted this printed 27
/// rows for 4 trees of ours, and a count is what makes that visible at a glance.
fn worktree_tally(repos: &[RepoTrees], total: usize) -> String {
    let n_repos = repos.iter().filter(|r| !r.rows.is_empty()).count();
    let mut counts = (0, 0, 0);
    for row in repos.iter().flat_map(|r| &r.rows) {
        match row.tenant {
            Tenant::Task { .. } => counts.0 += 1,
            Tenant::Orphan { .. } | Tenant::Merge => counts.1 += 1,
            Tenant::Stranger => counts.2 += 1,
        }
    }
    let mut parts = vec![format!(
        "\n  {total} tree{} in {n_repos} repo{}",
        if total == 1 { "" } else { "s" },
        if n_repos == 1 { "" } else { "s" }
    )];
    if counts.0 > 0 {
        parts.push(format!("{} in use", counts.0));
    }
    if counts.1 > 0 {
        parts.push(format!("{} ours to clean up", counts.1));
    }
    if counts.2 > 0 {
        parts.push(format!("{} not ours", counts.2));
    }
    format!("{}\n", parts.join(" · "))
}

/// What became of a worktree that was asked to come down.
///
/// One formatter for all three outcomes, and the caller decides which of them is an
/// error. The refusal and the report have to be written together or they drift: it was
/// the refusal that had to name the files, and the report that had to name the branch.
#[must_use]
pub(crate) fn torn(path: &std::path::Path, branch: Option<&str>, t: &Torn) -> String {
    let mut out = String::new();
    match t {
        Torn::Removed { discarded } => {
            out.push_str(&format!("  removed {}\n", path.display()));
            if !discarded.is_empty() {
                out.push_str(&format!(
                    "  discarded {} uncommitted change(s)\n",
                    discarded.len()
                ));
            }
            // Said every time. The tree going and the branch staying is exactly the part
            // an operator would otherwise assume the other way round.
            if let Some(b) = branch {
                out.push_str(&format!(
                    "  branch {b} kept — its commits are safe there, and `wecode start` cuts the tree again\n"
                ));
            }
        }
        Torn::Absent { was_ours } => {
            out.push_str(&format!("  no worktree at {}\n", path.display()));
            if *was_ours {
                out.push_str("  it was ours — recorded as gone\n");
            }
        }
        Torn::Dirty { files } => {
            // Unindented and first, because this one is printed as an error and the
            // reason has to lead.
            out.push_str(&format!(
                "{} has {} uncommitted change{} — removing the worktree would lose them:\n",
                path.display(),
                files.len(),
                if files.len() == 1 { "" } else { "s" }
            ));
            for f in files.iter().take(10) {
                out.push_str(&format!("    {f}\n"));
            }
            out.push_str("  pass --force to discard them");
        }
    }
    out
}

/// Enough of a diff to work from; not so much that it crowds out the instruction.
const DIFF_CAP: usize = 4000;

/// What predecessors produced, as A2A artifacts.
///
/// Artifacts rather than prose because that is what they are — the output of a run
/// that already happened. Modelling them as such is what lets the same handoff reach a
/// remote agent as JSON without being rewritten for it.
fn predecessor_artifacts(task: &Task, plan: &Plan, cwd: &std::path::Path) -> Vec<a2a::Artifact> {
    task.depends_on
        .iter()
        .filter_map(|d| plan.task(d))
        // Unfinished work is not context, it is a blocker — and the task would not be
        // running if it had any.
        .filter(|t| t.status.is_done())
        .map(|t| {
            let mut body = String::new();
            // A predecessor may have worked in its own worktree — worktrees are per
            // main task, and two sibling tasks are two trees. They sit beside each
            // other under the run root, so the sibling path is where its commits are.
            //
            // Reading them is not the same as *having* them: this task's branch was
            // cut from the base, so the predecessor's changes are visible here but not
            // present. See `branch-from-predecessor`.
            let their_tree = crate::work::owner(plan, &t.id)
                .map(|o| cwd.with_file_name(o.id.as_str()))
                .filter(|d| d.is_dir())
                .unwrap_or_else(|| cwd.to_path_buf());
            match crate::git::attempts_on(&their_tree) {
                Ok(commits) => {
                    let mine: Vec<&(String, String)> = commits
                        .iter()
                        .filter(|(_, subject)| subject.starts_with(&format!("{}: ", t.id)))
                        .collect();
                    if mine.is_empty() {
                        body.push_str("  (no commits in this worktree)\n");
                    }
                    for (sha, subject) in mine.iter().take(1) {
                        body.push_str(&format!("  {sha}  {subject}\n"));
                        if let Ok((files, diff)) =
                            crate::git::commit_summary(&their_tree, sha, DIFF_CAP)
                        {
                            for f in &files {
                                body.push_str(&format!("    {f}\n"));
                            }
                            body.push_str(&indent_block(&diff));
                        }
                    }
                }
                Err(_) => body.push_str("  (not a worktree — no diff to show)\n"),
            }
            a2a::Artifact::new(t.id.as_str(), t.id.as_str(), vec![a2a::Part::text(body)])
                .described(t.title.clone())
        })
        .collect()
}

/// What this task tried last time — the artifacts of its own earlier executions.
///
/// Empty on a first attempt, which is the common case and should read as such rather
/// than as a heading with nothing under it.
fn attempt_artifacts(
    task: &Task,
    runs: &[wecode_store::Execution],
    cwd: &std::path::Path,
) -> Vec<a2a::Artifact> {
    let commits = crate::git::attempts_on(cwd).unwrap_or_default();
    runs.iter()
        .filter(|r| r.status.is_finished())
        .rev()
        .take(2)
        .map(|r| {
            let mut body = String::new();
            let wanted = format!("{}: attempt {}", task.id, r.attempt);
            if let Some((sha, _)) = commits.iter().find(|(_, s)| s == &wanted)
                && let Ok((files, diff)) = crate::git::commit_summary(cwd, sha, DIFF_CAP)
            {
                for f in &files {
                    body.push_str(&format!("  {f}\n"));
                }
                body.push_str(&indent_block(&diff));
            }
            a2a::Artifact::new(
                format!("{}-attempt-{}", task.id, r.attempt),
                format!("attempt {}", r.attempt),
                vec![a2a::Part::text(body)],
            )
            .described(format!("{} ({})", r.status.as_str(), r.detail))
        })
        .collect()
}

fn indent_block(s: &str) -> String {
    s.lines()
        .map(|l| format!("    {l}\n"))
        .collect::<Vec<_>>()
        .concat()
}

/// One attempt at one task, as the protocol models it.
///
/// Everything the worker is told is **assembled here from what wecode observed**,
/// never passed along by the agent that produced it. Posts do not talk to each other,
/// and an agent's account of its own work is inadmissible — so the handoff is read out
/// of git and the execution record instead. Two payloads, answering different
/// questions:
///
/// - **what came before you**, following `depends_on`, because that relation already
///   means "must come after" and is therefore exactly the edge a handoff travels
/// - **what you tried last time**, from this task's own earlier commits, because a
///   retry that cannot see its previous failure just repeats it
///
/// A2A's `Task` is wecode's *execution*: the state is `submitted` because nothing has
/// been spawned yet. The instruction is a message, and everything the worker is given
/// to read is an artifact — so the CLI prompt below and a remote agent's JSON are two
/// renderings of one record rather than two formats to keep in step.
#[must_use]
pub(crate) fn a2a_task(
    template: &str,
    task: &Task,
    project: &Project,
    plan: &Plan,
    cwd: &std::path::Path,
    runs: &[wecode_store::Execution],
) -> a2a::Task {
    let acceptance: Vec<String> = task.acceptance.iter().map(|m| m.describe()).collect();
    let acceptance_text = if acceptance.is_empty() {
        "(none declared)".to_string()
    } else {
        acceptance
            .iter()
            .map(|m| format!("- {m}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let write_scope = if task.scope.write.is_empty() {
        "nothing — this task changes no files".to_string()
    } else {
        task.scope.write.join(", ")
    };

    let context = predecessor_artifacts(task, plan, cwd);
    let attempts = attempt_artifacts(task, runs, cwd);
    let attempt = runs.iter().map(|r| r.attempt).max().unwrap_or(0) + 1;

    let context_text = if context.is_empty() {
        "(nothing came before this task)\n".to_string()
    } else {
        a2a::render::artifacts(&context)
    };

    // Appended when the template has no `{{context}}`. A project whose envelope omits
    // the placeholder would otherwise lose the handoff without saying so, and what a
    // predecessor produced is not optional detail.
    let orphaned_context = if template.contains("{{context}}") || context.is_empty() {
        String::new()
    } else {
        format!("\n\nCONTEXT FROM COMPLETED WORK\n{context_text}")
    };

    let filled = template
        .replace("{{task_id}}", task.id.as_str())
        .replace("{{project_id}}", project.id.as_str())
        .replace("{{objective}}", &project.objective)
        .replace("{{title}}", &task.title)
        .replace("{{acceptance}}", &acceptance_text)
        .replace("{{write_scope}}", &write_scope)
        .replace("{{context}}", &context_text);

    let prior = if attempts.is_empty() {
        String::new()
    } else {
        format!(
            "\nYOUR PREVIOUS ATTEMPTS\n{}Do not repeat what failed. Read the diff above before changing anything.\n",
            a2a::render::artifacts(&attempts)
        )
    };

    let text = if filled.trim().is_empty() {
        format!(
            "  no task_envelope in company.toml — nothing to hand to the worker\n  work in {}\n",
            cwd.display()
        )
    } else {
        format!(
            "{}{}{}\nWorking directory: {}\n",
            filled.trim(),
            orphaned_context,
            prior,
            cwd.display()
        )
    };

    // The structured half of the instruction. A coding CLI never sees it — only text
    // parts render — but anything that can parse gets the acceptance and the scope
    // without scraping them back out of the prose.
    let spec = serde_json::json!({
        "taskId": task.id.as_str(),
        "projectId": project.id.as_str(),
        "kind": task.kind.as_str(),
        "attempt": attempt,
        "acceptance": acceptance,
        "writeScope": task.scope.write,
        "workingDirectory": cwd.display().to_string(),
    });

    let execution = format!("{}-attempt-{attempt}", task.id);
    let message = a2a::Message::to_agent(
        format!("{execution}-instruction"),
        vec![a2a::Part::text(text), a2a::Part::data(spec)],
    )
    .about(task.id.as_str(), execution.clone());

    let mut out = a2a::Task::new(execution, task.id.as_str(), a2a::TaskState::Submitted);
    out.history.push(message);
    out.artifacts = context.into_iter().chain(attempts).collect();
    out
}

/// The prompt a coding CLI receives: the text of the instruction, nothing else.
///
/// The structured parts stay in the record. Handing a CLI agent a JSON blob on argv
/// would put it in the instruction, where it reads as noise.
#[must_use]
pub(crate) fn envelope(t: &a2a::Task) -> String {
    t.history
        .first()
        .map(a2a::Message::as_text)
        .unwrap_or_default()
}

/// Every run of a task, so a retry does not erase what happened last time.
#[must_use]
pub(crate) fn executions(runs: &[wecode_store::Execution]) -> String {
    if runs.is_empty() {
        return String::new();
    }
    let mut out = format!("\nruns ({})\n", runs.len());
    for r in runs {
        out.push_str(&format!(
            "  #{}  {:<10} {:<18} {:<10} {}\n",
            r.attempt,
            r.status.as_str(),
            match r.wall_secs {
                Some(w) => format!("{w}s"),
                // No end time means it never closed — wecode died mid-run, and the
                // pid is the only handle left on whatever it started.
                None => match r.pid {
                    Some(p) => format!("unfinished, pid {p}"),
                    None => "unfinished".to_string(),
                },
            },
            // Per attempt rather than only in total: a task that cost too much
            // usually cost it on one try, and the total cannot say which.
            match r.spent_tokens {
                Some(n) => format!("{n}t"),
                None => "—".to_string(),
            },
            r.detail
        ));
    }
    out
}

/// What a merge did: a summary anyone can act on, then the detail behind it.
///
/// The summary leads with what undoes it. Auto-merging is only defensible because it
/// is reversible, so the way back is the first thing worth knowing, not a footnote.
#[must_use]
pub(crate) fn merged(
    task: &Task,
    plan: &Plan,
    target: &str,
    branch: &str,
    m: &crate::git::Merged,
    signed: bool,
    swept: &Swept,
) -> String {
    let short = |sha: &str| sha.chars().take(9).collect::<String>();
    let unblocked: Vec<&Task> = plan
        .tasks()
        .filter(|t| t.depends_on.contains(&task.id) && !t.status.is_closed())
        .collect();

    let mut out = format!("MERGED  {} → {target}\n\nsummary\n", task.id);
    out.push_str(&format!(
        "  {} file{}, +{} −{}\n",
        m.files.len(),
        if m.files.len() == 1 { "" } else { "s" },
        m.insertions(),
        m.deletions()
    ));
    out.push_str(&format!(
        "  how        {}\n",
        if signed { "signed off" } else { "automatic" }
    ));
    if !unblocked.is_empty() {
        // The thing only wecode knows: what this merge lets start.
        out.push_str(&format!(
            "  unblocks   {}\n",
            unblocked
                .iter()
                .map(|t| t.id.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    out.push_str(&teardown_line(swept));
    out.push_str(&format!(
        "  undo       wecode rollback {}   (was {})\n",
        task.id,
        short(&m.was)
    ));

    out.push_str("\nwhat changed\n");
    if m.files.is_empty() {
        out.push_str("  nothing — the branch held no changes against the target\n");
    }
    for (path, add, del) in &m.files {
        out.push_str(&format!(
            "  {:<52} +{add:<5} −{del}\n",
            truncate_cmd(path, 52)
        ));
    }

    // Only when it actually groups. One line per file under a heading called "by
    // area" is the same list twice.
    let areas = by_area(&m.files);
    if areas.len() > 1 && areas.len() < m.files.len() {
        out.push_str("\nby area\n");
        for (area, files, add, del) in areas {
            out.push_str(&format!(
                "  {:<24} {files} file{}, +{add} −{del}\n",
                area,
                if files == 1 { "" } else { "s" }
            ));
        }
    }

    out.push_str("\nacceptance\n");
    if task.acceptance.is_empty() {
        out.push_str("  none declared\n");
    }
    for a in &task.acceptance {
        out.push_str(&format!("  ✓ {}\n", a.describe()));
    }

    out.push_str(&format!(
        "\nprovenance\n  branch     {branch}\n  merge      {}\n  target was {}\n",
        short(&m.sha),
        short(&m.was)
    ));
    out
}

/// The merge report as the file that gets committed.
///
/// The report goes in verbatim, inside a fence. It is deliberately *not* re-rendered
/// into markdown sections: this file is evidence, and evidence is the thing that was
/// produced, not a second telling of it. One generator means the file and the terminal
/// can never drift, and an operator comparing what they saw against what landed is
/// comparing identical text.
///
/// The heading and the two sentences above the fence are all that is added, and they
/// exist to answer the question a reader of a committed file asks first: who wrote this,
/// and may I believe it?
#[must_use]
pub(crate) fn report_file(task: &TaskId, target: &str, report: &str) -> String {
    format!(
        "# {task} → {target}\n\n\
         Written by wecode when the merge landed, from git and its own record of the\n\
         run. Generated, never authored: an agent's account of its own work is\n\
         inadmissible, and a file it could have written would be too.\n\n\
         ```text\n{}\n```\n",
        report.trim_end()
    )
}

/// The one line a merge says about where its own record went.
///
/// In `provenance` and last, because it is the only fact in the report that postdates
/// the report — it cannot be anywhere but the end. That is also why the committed file
/// does not contain this line: nothing can record its own landing.
#[must_use]
pub(crate) fn record_line(r: &Recorded) -> String {
    match r {
        Recorded::Kept { path, sha } => format!("  record     {path} @ {sha}\n"),
        // Named rather than swallowed. The merge is fine; the note about it is missing,
        // and only this line will ever say so.
        Recorded::Lost { path, why } => {
            format!("  record     not written to {path}\n             {why}\n")
        }
    }
}

/// The one line a merge says about the tree its work came out of.
///
/// In the summary rather than a section of its own, because it is a consequence of the
/// merge and not a topic: an operator scanning the report needs to know whether the
/// directory they had open is still there, and that is one line's worth.
///
/// Nothing at all when there was no tree. A merge under a playbook that asks for no
/// worktree would otherwise carry a line about something that never existed.
fn teardown_line(swept: &Swept) -> String {
    match swept {
        Swept::Nothing => String::new(),
        // Who, not just that. The next thing an operator does about a kept tree depends
        // entirely on which task is still in it.
        Swept::Busy { path, by } => format!(
            "  worktree   kept — {} still working in {path}\n",
            by.join(", ")
        ),
        Swept::Tried { path, torn } => match torn {
            Torn::Removed { .. } => format!("  worktree   removed {path}\n"),
            Torn::Absent { .. } => format!("  worktree   already gone — {path}\n"),
            // Never discarded on this path: teardown nobody asked for does not get to
            // decide that uncommitted work was worthless.
            Torn::Dirty { files } => format!(
                "  worktree   kept — {} uncommitted change{} the merge did not take, in {path}\n",
                files.len(),
                if files.len() == 1 { "" } else { "s" }
            ),
        },
    }
}

/// Files grouped by their first two path segments, largest first.
///
/// Two segments because one is usually `crates` or `src` and tells you nothing.
fn by_area(files: &[(String, u32, u32)]) -> Vec<(String, usize, u32, u32)> {
    let mut acc: std::collections::BTreeMap<String, (usize, u32, u32)> = Default::default();
    for (path, add, del) in files {
        // The directory it sits in. Splitting on a fixed depth made a top-level file
        // its own "area", which is the file list again with a different heading.
        let area = match path.rfind('/') {
            Some(i) => path[..i].to_string(),
            None => ".".to_string(),
        };
        let e = acc.entry(area).or_default();
        e.0 += 1;
        e.1 += add;
        e.2 += del;
    }
    let mut v: Vec<(String, usize, u32, u32)> =
        acc.into_iter().map(|(k, (n, a, d))| (k, n, a, d)).collect();
    v.sort_by_key(|x| std::cmp::Reverse(x.2 + x.3));
    v
}

/// What a rollback undid.
#[must_use]
pub(crate) fn rolled_back(task: &Task, target: &str, merge: &str, revert: &str) -> String {
    let mut out = format!("ROLLED BACK  {} from {target}\n\n", task.id);
    out.push_str(&format!(
        "  reverted   {}\n",
        merge.chars().take(9).collect::<String>()
    ));
    out.push_str(&format!("  revert     {revert}\n"));
    out.push_str("  status     needs-approval — verified, no longer landed\n\n");
    // Said plainly, because "rolled back" could be read as "erased".
    out.push_str("  The merge stays in history: a revert is a new commit, not a rewrite,\n");
    out.push_str("  so this is safe whether or not the branch has been shared.\n");
    // And so does its record, for the same reason. A rollback that deleted the report
    // would leave the branch carrying a merge and a revert that nothing accounts for.
    out.push_str(&format!(
        "  Its record stays too, at {} — the merge did happen.\n\n",
        crate::record::path_for(&task.id)
    ));
    // The trap, said before it is sprung.
    out.push_str("  git still counts the branch as merged, so `wecode merge` will not\n");
    out.push_str(&format!(
        "  bring it back. To restore it: git revert {revert}\n"
    ));
    out
}

/// What running the agent did. Facts only — the verdict comes from `verify`.
#[must_use]
pub(crate) fn ran(
    task: &Task,
    post: &Post,
    cwd: &std::path::Path,
    o: &crate::spawn::Outcome,
) -> String {
    let mut out = format!(
        "{} {}  {}\n  post     {} ({})\n  in       {}\n  took     {:.0}s\n  spent    {}\n  {}\n",
        kind_tag(task.kind),
        task.id,
        task.title,
        post.name,
        post.agent,
        cwd.display(),
        o.took.as_secs_f64(),
        match o.spent {
            Some(n) => format!("{n} tokens, as the agent reported them"),
            // Not "0": the agent's protocol says nothing wecode can read a count
            // out of, and a budget cannot be checked against a number nobody has.
            None => "unmetered — this agent reports no token usage".to_string(),
        },
        if o.ended.ok() {
            format!("✓ {}", o.ended.describe())
        } else {
            format!("✗ {}", o.ended.describe())
        }
    );
    if o.truncated {
        out.push_str("  output was capped\n");
    }
    // The tail, not the whole log: enough to see how it ended without burying the
    // verdict that follows.
    let tail: Vec<&str> = o.output.lines().rev().take(12).collect();
    if !tail.is_empty() {
        out.push_str("\nlast output\n");
        for line in tail.into_iter().rev() {
            out.push_str(&format!("  {}\n", truncate_cmd(line, 100)));
        }
    }
    out
}

/// What verification observed, and what it concluded.
#[must_use]
pub(crate) fn verdict(
    task: &Task,
    dir: &std::path::Path,
    v: &crate::verify::Verdict,
    next: TaskStatus,
) -> String {
    let mut out = format!(
        "{} {}  {}\n  in       {}\n",
        kind_tag(task.kind),
        task.id,
        task.title,
        dir.display()
    );

    out.push_str(&format!(
        "\ndiff — {} file{}\n",
        v.changed.len(),
        if v.changed.len() == 1 { "" } else { "s" }
    ));
    if v.changed.is_empty() {
        // Not neutral: a task that declared a write scope and changed nothing did
        // not do its work, whatever its acceptance says.
        out.push_str("  nothing changed\n");
    }
    for path in &v.changed {
        let bad = v.violations.contains(path);
        out.push_str(&format!(
            "  {} {}{}\n",
            if bad { "✗" } else { "✓" },
            path,
            if bad { "   outside scope" } else { "" }
        ));
    }

    if !v.checks.is_empty() {
        out.push_str("\nacceptance\n");
        for c in &v.checks {
            out.push_str(&format!(
                "  {} {:<44} {}\n",
                if c.passed() { "✓" } else { "✗" },
                truncate_cmd(&c.cmd, 44),
                c.describe()
            ));
        }
    }
    for u in &v.unjudgeable {
        out.push_str(&format!("  ? {u}   no command can settle this\n"));
    }

    out.push('\n');
    if v.passed() {
        out.push_str("  ✓ passed\n");
        if next == TaskStatus::NeedsApproval {
            out.push_str("    the branch is not merged — wecode does not merge yet\n");
        }
    } else {
        if !v.violations.is_empty() {
            out.push_str(&format!(
                "  ✗ {} write{} outside scope — recorded against this task\n",
                v.violations.len(),
                if v.violations.len() == 1 { "" } else { "s" }
            ));
        }
        let missing = v.unrunnable();
        let failed = v
            .checks
            .iter()
            .filter(|c| !c.passed() && !c.missing())
            .count();
        if failed > 0 {
            out.push_str(&format!("  ✗ {failed} acceptance check(s) failed\n"));
        }
        if !missing.is_empty() {
            // Not a verdict about the work — say so, or a missing toolchain reads as
            // a broken change.
            out.push_str(&format!(
                "  ⚠ {} check(s) could not run — the command was not found.\n\
                 \x20   wecode runs acceptance through `sh -c` with its own environment;\n\
                 \x20   this is a PATH problem, not a verdict on the work.\n",
                missing.len()
            ));
        }
        if v.checks.is_empty() && v.violations.is_empty() {
            out.push_str("  ✗ nothing to judge by\n");
        }
    }
    out.push_str(&format!("  {}\n", next.as_str()));
    out
}

fn truncate_cmd(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
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
    // Shown either way. A hook that is not there is the thing an operator wondering
    // why nothing told them needs to read, and silence would look like the same
    // silence they are already complaining about.
    match &c.notify.command {
        Some(cmd) => out.push_str(&format!(
            "notify:    {cmd} — when a task starts waiting, killed after {}s\n",
            c.notify.timeout.as_secs()
        )),
        None => out.push_str("notify:    nothing — no [notify] command; waits are silent\n"),
    }

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
        // Listed off the same capability that gates it, so a seat is never told it
        // may record one and then refused.
        out.push((
            "playbook gap \"<...>\"",
            "write down what the guidance did not say".to_string(),
        ));
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
///
/// `source` is a column rather than a footnote because it is what makes a row
/// admissible or not: `broker` decided it, `supervisor` measured it, `harness` is the
/// agent's account of itself. A spend row is the first one where that distinction is
/// load-bearing — nothing sits between an agent and its model to count tokens, so the
/// number is reported, and a reader must be able to see that without knowing which
/// actions happen to be measurable.
#[must_use]
pub(crate) fn audit(lines: &[AuditLine]) -> String {
    if lines.is_empty() {
        return "no matching audit records\n".to_string();
    }
    let mut out =
        String::from("seq  post        agent         verdict   source      action  target\n");
    for l in lines {
        let mark = match l.outcome.as_str() {
            "allow" => "✓ allow",
            "approval" => "⏸ approve",
            "alarm" => "⚡ ALARM",
            _ => "✗ deny",
        };
        out.push_str(&format!(
            "{:<4} {:<11} {:<13} {:<9} {:<11} {:<7} {}\n",
            l.seq, l.post, l.agent, mark, l.source, l.action, l.target
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
        assert!(!line.starts_with(' '), "{line:?}");
        assert!(line.contains("archived"), "{line:?}");
    }

    #[test]
    fn tree_nests_tasks_under_their_project() {
        let out = tree(&plan(), false);
        let proj = out.lines().find(|l| l.contains("export")).unwrap();
        let task = out.lines().find(|l| l.contains("cache")).unwrap();
        assert!(!proj.starts_with(' '), "{proj:?}");
        assert!(task.starts_with("  "), "{task:?}");
    }

    #[test]
    fn tree_shows_a_dependency_but_not_as_nesting() {
        // The whole point of the two-relation model: `bench` comes after `cache`
        // without being *part of* it, so it must not be indented under it.
        let out = tree(&plan(), false);
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
        let out = tree(&p, false);
        let sub = out.lines().find(|l| l.contains("cache-keys")).unwrap();
        assert_eq!(sub.len() - sub.trim_start().len(), 4, "{sub:?}");
        assert!(!sub.contains("after"), "{sub:?}");
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
    fn audit_says_where_each_record_came_from() {
        // The distinction the spend column rests on: 1540 tokens is the agent's own
        // account of itself, and a reader has to be able to see that it was not
        // measured. Nothing sits between an agent and its model to measure it.
        let mut b = Broker::new(Charter::with(vec![]));
        let s = Session::new("s", "impl", "claude-code", Effective::of(vec![engineer()]))
            .on(Some("export".into()), Some("cache".into()));
        b.observe(
            &s,
            Action::Spend {
                tokens: 1540,
                wall_secs: 42,
            },
            Decision::Allow,
            wecode_gov::Source::Harness,
        );
        let store = wecode_store::Store::in_memory().unwrap();
        store.append_records(b.ledger()).unwrap();

        let out = audit(&store.audit(&wecode_store::AuditQuery::default()).unwrap());
        assert!(out.contains("source"), "the column is headed: {out}");
        assert!(out.contains("harness"), "{out}");
        assert!(out.contains("1540t/42s"), "{out}");
    }

    #[test]
    fn the_shared_build_cache_is_listed_as_the_playbook_wrote_it() {
        // Unexpanded, because this is a view of the file. Where `~` lands on this
        // machine is what `wecode start` reports, beside the worktree it belongs to.
        let pb = Playbook::parse(
            "[project.build_cache]\nCARGO_TARGET_DIR = \"~/.cache/w/target\"\n\n[bug]\n",
        )
        .unwrap();
        let out = playbook_all(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &pb,
            &[],
        );
        assert!(
            out.contains("cache     CARGO_TARGET_DIR = ~/.cache/w/target"),
            "{out}"
        );
    }

    /// What `playbook init` returns for one language, without touching a repository.
    fn written(language: &str) -> wecode_org::Written {
        let dir = std::env::temp_dir().join(format!("wecode-render-init-{language}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        wecode_org::playbook::init(&dir, language).unwrap()
    }

    #[test]
    fn what_a_starter_decided_is_reported_rather_than_left_in_the_file() {
        // The accept commands and the shared cache are the two lines a person is
        // expected to disagree with. Stated only in TOML they would be trusted by
        // whoever never opened it.
        let out = playbook_written(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &written("rust"),
            None,
        );
        assert!(out.contains("language  rust"), "{out}");
        assert!(out.contains("accept    cargo test --workspace"), "{out}");
        assert!(out.contains("cargo clippy --all-targets"), "{out}");
        assert!(
            out.contains("cache     CARGO_TARGET_DIR = ~/.cache/"),
            "{out}"
        );
        assert!(
            out.contains("wecode playbook bug --project export"),
            "{out}"
        );
    }

    #[test]
    fn a_language_nothing_answers_to_says_what_it_could_have_written() {
        let out = playbook_written(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &written("cobol"),
            None,
        );
        assert!(out.contains("no toolchain here answers to it"), "{out}");
        assert!(out.contains("rust"), "the known ones are named: {out}");
        assert!(!out.contains("accept  "), "nothing to report: {out}");
        assert!(
            out.contains("Fill in the acceptance commands"),
            "and the reader is told whose job that now is: {out}"
        );
    }

    #[test]
    fn a_command_this_machine_lacks_is_a_warning_and_not_a_failure() {
        // The file is right for the repository and wrong only here — deleting it
        // would be the wrong answer, so the refusal is reported beside what was
        // written and the exit stays zero.
        let out = playbook_written(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &written("python"),
            Some("[bug] accept: `uv` is not on this machine — `uv run pytest -q` would ..."),
        );
        assert!(out.contains("wrote "), "{out}");
        assert!(out.contains("! this machine cannot run"), "{out}");
        assert!(out.contains("`uv` is not on this machine"), "{out}");
    }

    #[test]
    fn a_project_that_shares_nothing_says_nothing_about_a_cache() {
        let pb = Playbook::parse("[bug]\nguidance = \"reproduce first\"\n").unwrap();
        let out = playbook_all(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &pb,
            &[],
        );
        assert!(!out.contains("cache"), "{out}");
    }

    // ------------------------------------------------------------- gaps ------

    fn a_gap(kind: Option<TaskKind>, note: &str) -> Gap {
        Gap {
            project: "export".into(),
            kind,
            task: None,
            by: "chief".into(),
            at: 1_000,
            note: note.into(),
        }
    }

    #[test]
    fn a_kind_shows_its_own_gaps_and_the_ones_filed_against_no_kind() {
        let pb = Playbook::parse("[bug]\nguidance = \"reproduce first\"\n").unwrap();
        let found = [
            a_gap(Some(TaskKind::Bug), "declare the test file"),
            a_gap(None, "no integration branch is set"),
            a_gap(Some(TaskKind::Docs), "say where the reference is generated"),
        ];
        let out = playbook_kind(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &pb,
            TaskKind::Bug,
            &found,
            2_000,
        );
        assert!(out.contains("reproduce first"), "the guidance stays: {out}");
        assert!(out.contains("declare the test file"), "{out}");
        assert!(
            out.contains("no integration branch"),
            "applies to all: {out}"
        );
        assert!(!out.contains("where the reference is generated"), "{out}");
        // After the prose, in the order the two were learned in.
        assert!(
            out.find("reproduce first") < out.find("declare the test file"),
            "{out}"
        );
    }

    #[test]
    fn guidance_with_nothing_recorded_against_it_says_nothing_about_gaps() {
        // The silent case is the common one, and a heading with nothing under it
        // would be noise on every read.
        let pb = Playbook::parse("[bug]\nguidance = \"reproduce first\"\n").unwrap();
        let project = Project::new("export", "cut export p99 below 500ms", "api");
        let out = playbook_kind(&project, &pb, TaskKind::Bug, &[], 2_000);
        assert!(!out.contains("gap"), "{out}");
        assert!(!playbook_all(&project, &pb, &[]).contains("gap"), "{out}");
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

    #[test]
    fn a_worktree_listing_separates_ours_from_a_strangers() {
        // The distinction the whole view exists for. `orphan` and `not ours` used to
        // print identically, and one of them invites deleting somebody else's work.
        let out = worktrees(&[RepoTrees {
            repo: "api".into(),
            path: "/repos/api".into(),
            rows: vec![
                WorktreeRow {
                    path: "/run/cws/cache".into(),
                    tenant: Tenant::Task {
                        id: "cache".into(),
                        project: "export".into(),
                        status: TaskStatus::Running,
                    },
                },
                WorktreeRow {
                    path: "/run/cws/vanished".into(),
                    tenant: Tenant::Orphan {
                        task: "vanished".into(),
                    },
                },
                WorktreeRow {
                    path: "/elsewhere/theirs".into(),
                    tenant: Tenant::Stranger,
                },
            ],
        }]);

        // Asserted whole, because the columns are the point: a reader scans down the
        // first one to see what is theirs to touch.
        assert_eq!(
            out,
            "  task                 project      status     path
api — /repos/api
  cache                export       running    /run/cws/cache
  — orphan (vanished)  —            —          /run/cws/vanished
  — not ours           —            —          /elsewhere/theirs

  3 trees in 1 repo · 1 in use · 1 ours to clean up · 1 not ours
"
        );
    }

    #[test]
    fn a_removed_tree_says_the_branch_survived_it() {
        // The part an operator would otherwise assume the other way round, and the
        // reason teardown is safe to do without asking.
        let out = torn(
            std::path::Path::new("/run/cws/cache"),
            Some("wecode/cache"),
            &Torn::Removed {
                discarded: Vec::new(),
            },
        );
        assert!(out.contains("removed /run/cws/cache"), "{out}");
        assert!(out.contains("branch wecode/cache kept"), "{out}");
        assert!(!out.contains("discarded"), "nothing was discarded: {out}");
    }

    #[test]
    fn discarding_uncommitted_work_is_never_silent() {
        // `--force` was typed, so this is not a refusal — but destroying work without
        // saying so is the one thing teardown must not do, even when told to.
        let out = torn(
            std::path::Path::new("/run/cws/cache"),
            None,
            &Torn::Removed {
                discarded: vec!["a.rs".into(), "b.rs".into()],
            },
        );
        assert!(out.contains("discarded 2 uncommitted change(s)"), "{out}");
        // No branch was known — a path names none — so none is claimed.
        assert!(!out.contains("branch"), "{out}");
    }

    #[test]
    fn a_refused_removal_names_the_files_and_the_way_past_it() {
        let out = torn(
            std::path::Path::new("/run/cws/cache"),
            Some("wecode/cache"),
            &Torn::Dirty {
                files: vec!["half-done.rs".into()],
            },
        );
        // Singular, and the reason leads: this one is printed as an error.
        assert!(
            out.starts_with("/run/cws/cache has 1 uncommitted change —"),
            "{out}"
        );
        assert!(out.contains("half-done.rs"), "{out}");
        assert!(out.ends_with("pass --force to discard them"), "{out}");
    }

    #[test]
    fn an_absent_tree_reports_whether_the_registry_was_corrected() {
        let ours = torn(
            std::path::Path::new("/run/cws/cache"),
            None,
            &Torn::Absent { was_ours: true },
        );
        assert!(ours.contains("no worktree at /run/cws/cache"), "{ours}");
        assert!(ours.contains("recorded as gone"), "{ours}");

        let theirs = torn(
            std::path::Path::new("/elsewhere/theirs"),
            None,
            &Torn::Absent { was_ours: false },
        );
        assert!(!theirs.contains("recorded as gone"), "{theirs}");
    }

    #[test]
    fn a_merge_says_what_became_of_the_tree_and_why() {
        // Each of the three refusals reads differently on purpose: what the operator
        // does next depends entirely on which one it was.
        assert_eq!(
            teardown_line(&Swept::Nothing),
            "",
            "a playbook that asks for no worktree gets no line about one"
        );
        let busy = teardown_line(&Swept::Busy {
            path: "/run/cws/feat".into(),
            by: vec!["impl".into(), "docs".into()],
        });
        assert!(busy.contains("kept — impl, docs still working"), "{busy}");
        assert!(busy.contains("/run/cws/feat"), "{busy}");

        let dirty = teardown_line(&Swept::Tried {
            path: "/run/cws/feat".into(),
            torn: Torn::Dirty {
                files: vec!["scratch.txt".into()],
            },
        });
        assert!(
            dirty.contains("1 uncommitted change the merge did not take"),
            "{dirty}"
        );

        let gone = teardown_line(&Swept::Tried {
            path: "/run/cws/feat".into(),
            torn: Torn::Removed {
                discarded: Vec::new(),
            },
        });
        assert_eq!(gone, "  worktree   removed /run/cws/feat\n");
    }

    #[test]
    fn the_committed_report_is_the_printed_one_word_for_word() {
        // The reason for a fence instead of markdown sections: the file is evidence, so
        // it has to be the text that was produced rather than a second telling of it.
        // A re-rendered version could differ from what the operator saw, and then the
        // repository and the terminal disagree about one merge.
        let report = "MERGED  t → dev\n\nsummary\n  1 file, +2 −0\n";
        let file = report_file(&TaskId::new("t"), "dev", report);
        assert!(file.starts_with("# t → dev\n"), "{file}");
        assert!(file.contains(report.trim_end()), "{file}");
        assert!(file.contains("Generated, never authored"), "{file}");
        assert!(file.ends_with("```\n"), "{file}");
    }

    #[test]
    fn a_record_that_did_not_land_says_so_rather_than_nothing() {
        // The merge succeeded either way, so this line is the only thing that will ever
        // tell an operator the note about it is missing.
        let kept = record_line(&Recorded::Kept {
            path: "docs/wecode/t/report.md".into(),
            sha: "abc1234".into(),
        });
        assert_eq!(kept, "  record     docs/wecode/t/report.md @ abc1234\n");

        let lost = record_line(&Recorded::Lost {
            path: "docs/wecode/t/report.md".into(),
            why: "git worktree add failed: no space left on device".into(),
        });
        assert!(
            lost.contains("not written to docs/wecode/t/report.md"),
            "{lost}"
        );
        assert!(lost.contains("no space left on device"), "{lost}");
    }

    #[test]
    fn a_repo_with_no_worktrees_is_not_printed_as_an_empty_heading() {
        // Every project's repo is asked, and most have no trees. A heading per repo
        // would bury the few rows that matter.
        let out = worktrees(&[
            RepoTrees {
                repo: "api".into(),
                path: "/repos/api".into(),
                rows: vec![WorktreeRow {
                    path: "/run/cws/cache".into(),
                    tenant: Tenant::Merge,
                }],
            },
            RepoTrees {
                repo: "web".into(),
                path: "/repos/web".into(),
                rows: vec![],
            },
        ]);
        assert!(!out.contains("web"), "{out}");
        assert!(out.contains("1 tree in 1 repo"), "{out}");

        assert_eq!(
            worktrees(&[RepoTrees {
                repo: "web".into(),
                path: "/repos/web".into(),
                rows: vec![],
            }]),
            "no worktrees\n"
        );
    }
}
