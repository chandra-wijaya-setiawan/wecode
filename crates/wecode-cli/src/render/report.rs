//! A story's completion report, and where every line of it came from.
//!
//! ADR-0006 asks for one document per story and asks for it *generated*: the join of
//! requirements × the tasks that served them × what those runs cost × the acceptance they
//! were held to. It was read against a slice that had three hand-written files restating
//! one state between them, and the reason they drifted is that restating is the only
//! thing a hand-written file can do.
//!
//! So nothing here is authored. Every line is a row somebody else already wrote down: the
//! obligations are the `require` rows the store folds into [`Requirement`], the attempts
//! are the tasks that point at them, the cost is the `spend` rows beside them, and the
//! evidence is each task's own acceptance. An agent's account of its own work is
//! inadmissible everywhere else in wecode, and a story's report — the one document a
//! reader is most likely to take on trust — is where allowing it would cost the most.
//!
//! The report references handles and never restates their wording, which is ADR-0006's
//! fourth rule and the whole of it: a requirement's text lives in the row that stated it,
//! and a second copy inside a generated document is a copy that cannot be corrected.
//!
//! Here rather than beside the code that closes a story, on the rule [`crate::render`]
//! states: what this renders is a [`Plan`] and the store's rows, and neither of those
//! crates may know that a terminal exists.
//!
//! **One document either way.** A story that cannot close does not get a different
//! message — it gets this same report with `OPEN` on the first line and the unanswered
//! obligation sitting in the list under it. That is [`crate::record`]'s bargain between a
//! proposal and a record, made once more for the same reason: a refusal rendered
//! separately is a second account of one state, and there is no version of that which
//! does not eventually disagree with the receipt.

use wecode_core::requirement::requirement_is_met;
use wecode_core::{Plan, Task, TaskId, TaskStatus};
use wecode_store::AuditLine;
use wecode_store::audit::Requirement;

/// Whether every obligation this story stated has been answered — the only thing that
/// closes a story, and the whole of what a close is refused on.
///
/// A story that stated nothing does not close either, and that is not an edge case: an
/// obligation is what a story is *for*, so a container with none is one whose completion
/// nothing here can settle. Core says the same thing to a planner as a defect —
/// `Defect::StoryOwesNothing` — and this is that defect arriving at the far end of the
/// work instead of the near end.
#[must_use]
pub(crate) fn closes(story: &TaskId, reqs: &[Requirement], plan: &Plan) -> bool {
    let stated = owed(story, reqs);
    !stated.is_empty() && stated.iter().all(|r| answer(r, plan) != Answer::Open)
}

/// The report itself: the verdict, what it is made of, and the join behind it.
///
/// The verdict is the first word so that a reader who stops there has the answer, and it
/// is padded to one width so the story's id sits in the same column either way — two
/// readings of one document, and the eye should not have to find the difference.
#[allow(
    dead_code,
    reason = "the call site is the close command, out of this task's scope"
)]
#[must_use]
pub(crate) fn story(
    story: &Task,
    reqs: &[Requirement],
    plan: &Plan,
    ledger: &[AuditLine],
) -> String {
    let stated = owed(&story.id, reqs);
    let closed = closes(&story.id, reqs, plan);
    let mut out = format!(
        "{}  {} — {}\n\nsummary\n",
        if closed { "CLOSED" } else { "OPEN  " },
        story.id,
        story.title
    );
    out.push_str(&obligations(&stated, plan));
    out.push_str(&tasks(plan, &story.id));
    out.push_str(&spend(plan, &story.id, ledger));
    out.push_str(&refused(plan, &story.id, ledger));
    if !closed {
        out.push_str(&format!("  {:<11}{}\n", "not closed", unanswered(&stated, plan)));
    }
    out.push_str(&requirements(&stated, plan));
    out.push_str(&loose(plan, &story.id));
    out.push_str(
        "\nprovenance\n  \
         The rows that stated these obligations, the tasks that point at them, and what\n  \
         the ledger recorded beside those runs. No line of it was authored.\n",
    );
    out
}

/// The obligations one story stated, in the order they were stated in.
fn owed<'a>(story: &TaskId, reqs: &'a [Requirement]) -> Vec<&'a Requirement> {
    reqs.iter().filter(|r| r.story == *story).collect()
}

/// Where one obligation stands, judged only by what answered it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Answer {
    /// Something finished against it and nothing open still claims it.
    Met,
    /// Every attempt at it is closed and none of them finished: a decision not to serve
    /// it, which ADR-0005 makes an end state rather than a loose end.
    Dropped,
    /// Nothing has answered it — including the case where nothing ever tried.
    Open,
}

impl Answer {
    fn word(self) -> &'static str {
        match self {
            Self::Met => "met",
            Self::Dropped => "dropped",
            Self::Open => "open",
        }
    }
}

/// What answered an obligation, from the attempts and nothing else.
///
/// `Met` is core's own rule ([`requirement_is_met`]) rather than a second reading of it,
/// because the reset ADR-0005 turns on — a new task against a requirement reopens it —
/// has to mean the same thing on a story's last day as it did on its first.
fn answer(r: &Requirement, plan: &Plan) -> Answer {
    let attempts = tried(r, plan);
    if requirement_is_met(&r.served_by, plan) {
        Answer::Met
    } else if !attempts.is_empty() && attempts.iter().all(|t| t.status.is_closed()) {
        Answer::Dropped
    } else {
        Answer::Open
    }
}

/// The attempts at an obligation that are still in the plan.
///
/// A task since removed is not an attempt at anything: `wecode task rm` erases work that
/// never ran, and counting one here would hold an obligation open for ever.
fn tried<'a>(r: &'a Requirement, plan: &'a Plan) -> Vec<&'a Task> {
    r.served_by.iter().filter_map(|id| plan.task(id)).collect()
}

/// How many obligations there are and how many are answered.
fn obligations(stated: &[&Requirement], plan: &Plan) -> String {
    if stated.is_empty() {
        return format!("  {:<11}nothing — no obligation was ever stated\n", "owes");
    }
    let answered = stated
        .iter()
        .filter(|r| answer(r, plan) != Answer::Open)
        .count();
    let how_many = if answered == stated.len() {
        "all answered".to_string()
    } else {
        format!("{answered} answered")
    };
    format!(
        "  {:<11}{} obligation{}, {how_many}\n",
        "owes",
        stated.len(),
        s(stated.len())
    )
}

/// What became of the work under the story.
fn tasks(plan: &Plan, story: &TaskId) -> String {
    let kids = under(plan, story);
    if kids.is_empty() {
        return format!("  {:<11}none — nothing was ever put under it\n", "tasks");
    }
    let done = kids.iter().filter(|t| t.status.is_done()).count();
    let dropped = kids
        .iter()
        .filter(|t| t.status == TaskStatus::Dropped)
        .count();
    let mut parts = vec![format!("{done} done")];
    if dropped > 0 {
        parts.push(format!("{dropped} dropped"));
    }
    // Named as still open rather than by status: a story is being closed, and what
    // matters about the rest is that they are not finished, not which way.
    if let Some(open) = kids.len().checked_sub(done + dropped).filter(|n| *n > 0) {
        parts.push(format!("{open} still open"));
    }
    format!("  {:<11}{}\n", "tasks", parts.join(", "))
}

/// What the runs under this story cost.
///
/// One `spend` row per run, whatever the run ended as — an expensive failure is part of
/// what a story cost. The number is the weaker half of the ledger and the line says so:
/// there is nothing between an agent and a model for wecode to count tokens at, so a
/// figure here is the harness reporting on itself, which is exactly why the count of runs
/// beside it is wecode's own.
fn spend(plan: &Plan, story: &TaskId, ledger: &[AuditLine]) -> String {
    let rows: Vec<&AuditLine> = mine(plan, story, ledger)
        .into_iter()
        .filter(|l| l.action == "spend")
        .collect();
    if rows.is_empty() {
        return String::new();
    }
    let tokens: u64 = rows.iter().map(|l| l.spent_tokens()).sum();
    format!(
        "  {:<11}{tokens} tokens over {} run{}, as the harnesses reported them\n",
        "spend",
        rows.len(),
        s(rows.len())
    )
}

/// What the Broker refused along the way, when it refused anything.
///
/// In the summary of a *completed* story on purpose. A story that landed having been told
/// no twice is a different thing from one that was never told no, and the only place that
/// difference survives is the ledger.
fn refused(plan: &Plan, story: &TaskId, ledger: &[AuditLine]) -> String {
    let denials = mine(plan, story, ledger)
        .into_iter()
        .filter(|l| l.is_denial())
        .count();
    if denials == 0 {
        return String::new();
    }
    format!(
        "  {:<11}{denials} act{} the Broker denied\n",
        "refused",
        s(denials)
    )
}

/// Why it did not close, in the words the reader has to act on.
fn unanswered(stated: &[&Requirement], plan: &Plan) -> String {
    let open: Vec<&str> = stated
        .iter()
        .filter(|r| answer(r, plan) == Answer::Open)
        .map(|r| r.id.as_str())
        .collect();
    if open.is_empty() {
        // The story that stated nothing. Not an omission to fill in later: what would
        // settle it is a sentence somebody has to write, and no join can supply one.
        return "this story states no obligation, so nothing can settle it".to_string();
    }
    format!(
        "{} obligation{} not answered: {}",
        open.len(),
        s(open.len()),
        open.join(", ")
    )
}

/// The join: each obligation, then the attempts at it and what each one was held to.
///
/// Handles and never wordings — ADR-0006's fourth rule. The wording is one row in the
/// ledger, and a generated document that copied it would be a copy nobody can correct.
fn requirements(stated: &[&Requirement], plan: &Plan) -> String {
    if stated.is_empty() {
        return String::new();
    }
    let wide = stated.iter().map(|r| r.id.len()).max().unwrap_or(0);
    let mut out = String::from("\nrequirements\n");
    for r in stated {
        out.push_str(&format!(
            "  · {:<wide$}   {}\n",
            r.id,
            answer(r, plan).word()
        ));
        let attempts = tried(r, plan);
        if attempts.is_empty() {
            out.push_str("      nothing serves it\n");
            continue;
        }
        for t in attempts {
            out.push_str(&evidence(t));
        }
    }
    out
}

/// One attempt, and what it was held to.
///
/// Ticked only where the task finished, on [`crate::record::merged`]'s rule: a mark
/// beside an acceptance command is a claim that it passed, and only work downstream of a
/// verdict may make it. A person's task never ran a command and its evidence is its
/// signature, which is the one piece of evidence in wecode that was never an agent's word
/// about itself.
fn evidence(t: &Task) -> String {
    let mark = if t.status.is_done() { "✓" } else { "·" };
    let head = format!("      {:<20} {:<10}", t.id.as_str(), t.status.as_str());
    if t.is_done_by_a_person() {
        return format!("{head}{mark} a signature — nothing ran\n");
    }
    if t.acceptance.is_empty() {
        return format!("{head}· nothing declared\n");
    }
    let mut out = String::new();
    for (n, a) in t.acceptance.iter().enumerate() {
        // The id and the status sit on the first row only: repeating them down a column
        // would read as three attempts where there is one.
        let head = if n == 0 {
            head.clone()
        } else {
            " ".repeat(head.chars().count())
        };
        out.push_str(&format!("{head}{mark} {}\n", a.describe()));
    }
    out
}

/// The work under the story that answers to no obligation.
///
/// Named rather than left out, and never counted as evidence. A story's design task is
/// the usual one — it proposes what the others then serve — and a report that dropped it
/// would say a story was smaller than it was.
fn loose(plan: &Plan, story: &TaskId) -> String {
    let rest: Vec<&Task> = under(plan, story)
        .into_iter()
        .filter(|t| t.requirement.is_none())
        .collect();
    if rest.is_empty() {
        return String::new();
    }
    let mut out = String::from("\nalso under it\n");
    for t in rest {
        out.push_str(&format!(
            "  {:<20} {:<9} {}\n",
            t.id.as_str(),
            t.status.as_str(),
            t.title
        ));
    }
    out
}

/// Every task under the story, however deep the tree goes.
fn under<'a>(plan: &'a Plan, story: &TaskId) -> Vec<&'a Task> {
    let mut out = Vec::new();
    for kid in plan.subtasks(story) {
        out.push(kid);
        out.extend(under(plan, &kid.id));
    }
    out
}

/// The ledger rows belonging to this story or to anything under it.
///
/// The story's own id included, because a story is where a requirement is stated and
/// those rows are written against it.
fn mine<'a>(plan: &Plan, story: &TaskId, ledger: &'a [AuditLine]) -> Vec<&'a AuditLine> {
    let mut ids: Vec<String> = under(plan, story)
        .iter()
        .map(|t| t.id.to_string())
        .collect();
    ids.push(story.to_string());
    ledger.iter().filter(|l| ids.contains(&l.task)).collect()
}

fn s(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}
