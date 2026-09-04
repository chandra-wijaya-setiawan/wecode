//! What a story's completion report may claim, and what it must refuse to claim.
//!
//! The renderer is reached by path rather than by import, because `wecode-cli` is a
//! binary with no library target and the suites beside this one all drive the built
//! executable. There is no `wecode close` yet to drive — the command is the next change,
//! and `record.rs` names the two lines that add it — so the join itself is compiled in
//! here and exercised directly. That is not a workaround for missing coverage: what these
//! tests are about is the *shape of the claim* a generated document makes, which is a
//! question about one pure function and needs no workspace, no repository and no agent.
//!
//! The module has no `mod tests` of its own for the same reason. One home for the tests
//! of one renderer, and this is it.
#[path = "../src/render/report.rs"]
mod report;

use wecode_core::task::Doer;
use wecode_core::{Measure, Plan, Project, Task, TaskId, TaskKind, TaskStatus};
use wecode_store::AuditLine;
use wecode_store::audit::Requirement;

/// The story every fixture hangs off: one user-visible capability, in one project.
const STORY: &str = "one-tap-checkout";

fn story_task() -> Task {
    Task::new(STORY, "cart", "buy a basket in one step").of_kind(TaskKind::Story)
}

/// A plan holding the story and whatever was put under it.
fn plan_of(kids: Vec<Task>) -> Plan {
    let mut plan = Plan::new();
    plan.add_project(Project::new("cart", "sell a basket of things", "repo"))
        .unwrap();
    plan.add_task(story_task()).unwrap();
    for k in kids {
        plan.add_task(k).unwrap();
    }
    plan
}

/// An attempt at an obligation, held to one command.
fn attempt(id: &str, status: TaskStatus, serves: &str) -> Task {
    let mut t = Task::new(id, "cart", "an attempt at it")
        .under(STORY)
        .serving(serves)
        .accepting(Measure::Command {
            cmd: "cargo test --workspace".into(),
            expect_status: 0,
        });
    t.status = status;
    t
}

/// An obligation as the store folds it out of the ledger, with the attempts pointing at
/// it. The wording is here so the tests can prove the report never copies it.
fn owes(id: &str, served_by: &[&str]) -> Requirement {
    Requirement {
        id: format!("{STORY}/{id}"),
        story: TaskId::new(STORY),
        project: "cart".into(),
        wording: "a shopper reaches the confirmation in one tap".into(),
        at: 0,
        by: "owner".into(),
        served_by: served_by.iter().map(TaskId::new).collect(),
    }
}

fn row(task: &str, action: &str, target: &str, outcome: &str) -> AuditLine {
    AuditLine {
        seq: 1,
        at: 0,
        session: "s1".into(),
        post: "cto".into(),
        agent: "claude".into(),
        human: String::new(),
        project: "cart".into(),
        task: task.into(),
        source: "supervisor".into(),
        action: action.into(),
        target: target.into(),
        outcome: outcome.into(),
        mode: String::new(),
        detail: String::new(),
    }
}

/// The state a story is in when it is genuinely finished: two obligations, an attempt
/// apiece, both landed.
fn finished() -> (Plan, Vec<Requirement>) {
    let plan = plan_of(vec![
        attempt("tap-once", TaskStatus::Done, &format!("{STORY}/FR-1")),
        attempt("hold-the-card", TaskStatus::Done, &format!("{STORY}/NFR-1")),
    ]);
    let reqs = vec![owes("FR-1", &["tap-once"]), owes("NFR-1", &["hold-the-card"])];
    (plan, reqs)
}

fn rendered(plan: &Plan, reqs: &[Requirement], ledger: &[AuditLine]) -> String {
    report::story(&story_task(), reqs, plan, ledger)
}

#[test]
fn a_story_whose_every_obligation_was_answered_closes() {
    let (plan, reqs) = finished();
    assert!(report::closes(&TaskId::new(STORY), &reqs, &plan));

    let out = rendered(&plan, &reqs, &[]);
    assert!(out.starts_with("CLOSED  one-tap-checkout — buy a basket"), "{out}");
    assert!(out.contains("owes       2 obligations, all answered"), "{out}");
    assert!(out.contains("tasks      2 done\n"), "{out}");
    // The join, and the reason the report is worth reading: the handle, then what
    // answered it, then what that attempt was held to.
    assert!(out.contains("· one-tap-checkout/FR-1    met"), "{out}");
    assert!(out.contains("tap-once             done      ✓ `cargo test --workspace` exits 0"), "{out}");
    assert!(!out.contains("not closed"), "{out}");
}

#[test]
fn the_report_names_handles_and_never_restates_a_wording() {
    // ADR-0006's fourth rule, and the whole of the drift it was written against: the
    // wording is one row, and a generated document holding a second copy of it is a copy
    // nobody can correct. The report joins ids; the contract stays where it was stated.
    let (plan, reqs) = finished();
    let out = rendered(&plan, &reqs, &[]);
    assert!(out.contains("one-tap-checkout/NFR-1"), "{out}");
    assert!(
        !out.contains("a shopper reaches the confirmation"),
        "the wording was copied into the report: {out}"
    );
}

#[test]
fn an_obligation_nothing_ever_served_holds_the_story_open() {
    // The refusal ADR-0006 asks for, and the case it exists for is this one rather than
    // an attempt still running: a story can have every task done and still owe something
    // nobody ever took a run at, and only the ledger's own rows can see it.
    let plan = plan_of(vec![attempt(
        "tap-once",
        TaskStatus::Done,
        &format!("{STORY}/FR-1"),
    )]);
    let reqs = vec![owes("FR-1", &["tap-once"]), owes("NFR-1", &[])];
    assert!(!report::closes(&TaskId::new(STORY), &reqs, &plan));

    let out = rendered(&plan, &reqs, &[]);
    assert!(out.starts_with("OPEN    one-tap-checkout"), "{out}");
    assert!(out.contains("owes       2 obligations, 1 answered"), "{out}");
    assert!(
        out.contains("not closed 1 obligation not answered: one-tap-checkout/NFR-1"),
        "{out}"
    );
    assert!(out.contains("nothing serves it"), "{out}");
}

#[test]
fn a_story_that_cannot_close_gets_the_same_document_it_would_have_got() {
    // One renderer either way, on the merge report's bargain and for its reason: a
    // refusal rendered separately is a second account of one state, and the shape of that
    // bug is a story refused for something the receipt then does not mention.
    let plan = plan_of(vec![attempt(
        "tap-once",
        TaskStatus::Running,
        &format!("{STORY}/FR-1"),
    )]);
    let reqs = vec![owes("FR-1", &["tap-once"])];
    let open = rendered(&plan, &reqs, &[]);
    let (done, done_reqs) = finished();
    let closed = rendered(&done, &done_reqs, &[]);
    for shared in ["\nsummary\n", "\nrequirements\n", "\nprovenance\n", "one-tap-checkout/FR-1"] {
        assert!(open.contains(shared), "missing from the refusal: {open}");
        assert!(closed.contains(shared), "missing from the receipt: {closed}");
    }
    // And the mark is the difference. An attempt that has not finished has passed
    // nothing, so nothing beside it may be ticked.
    assert!(open.contains("tap-once             running   · `cargo test"), "{open}");
    assert!(!open.contains('✓'), "nothing has passed yet: {open}");
}

#[test]
fn an_obligation_every_attempt_dropped_is_answered_rather_than_open() {
    // ADR-0005 makes `dropped` an end state: an obligation we decided not to serve is
    // answered, not forgotten. The evidence is the dropped attempt, which is why this is
    // not the same as the case above — there, nothing was ever decided.
    let plan = plan_of(vec![
        attempt("tap-once", TaskStatus::Done, &format!("{STORY}/FR-1")),
        attempt("hold-the-card", TaskStatus::Dropped, &format!("{STORY}/NFR-1")),
    ]);
    let reqs = vec![owes("FR-1", &["tap-once"]), owes("NFR-1", &["hold-the-card"])];
    assert!(report::closes(&TaskId::new(STORY), &reqs, &plan));

    let out = rendered(&plan, &reqs, &[]);
    assert!(out.contains("· one-tap-checkout/NFR-1   dropped"), "{out}");
    assert!(out.contains("tasks      1 done, 1 dropped"), "{out}");
    // Named with its attempt, and not ticked. A decision not to serve something is
    // evidence that it was answered, never evidence that a command passed.
    assert!(out.contains("hold-the-card        dropped   · `cargo test"), "{out}");
}

#[test]
fn a_second_attempt_still_open_puts_a_met_obligation_back() {
    // ADR-0005's reset, arriving at the far end of the work: rework must not be able to
    // land against a closed requirement, so a story with a bug open against an obligation
    // it once met does not close. The rule is core's; this is the report obeying it.
    let plan = plan_of(vec![
        attempt("tap-once", TaskStatus::Done, &format!("{STORY}/FR-1")),
        attempt("tap-twice-bug", TaskStatus::Ready, &format!("{STORY}/FR-1")),
    ]);
    let reqs = vec![owes("FR-1", &["tap-once", "tap-twice-bug"])];
    assert!(!report::closes(&TaskId::new(STORY), &reqs, &plan));
    let out = rendered(&plan, &reqs, &[]);
    assert!(out.contains("· one-tap-checkout/FR-1   open"), "{out}");
    assert!(out.contains("1 still open"), "{out}");
}

#[test]
fn an_attempt_no_longer_in_the_plan_is_not_a_claim_on_anything() {
    // `wecode task rm` erases work that never ran, and a removed attempt counted here
    // would hold an obligation open for ever — an obligation nothing could close.
    let plan = plan_of(vec![attempt(
        "tap-once",
        TaskStatus::Done,
        &format!("{STORY}/FR-1"),
    )]);
    let reqs = vec![owes("FR-1", &["tap-once", "an-attempt-somebody-deleted"])];
    assert!(report::closes(&TaskId::new(STORY), &reqs, &plan));
    let out = rendered(&plan, &reqs, &[]);
    assert!(!out.contains("an-attempt-somebody-deleted"), "{out}");
}

#[test]
fn a_story_that_stated_no_obligation_does_not_close_at_all() {
    // Not an edge case and not a gap to fill in later. An obligation is what a story is
    // for, so a container with none is one whose completion nothing here can settle —
    // core says the same thing to a planner as `StoryOwesNothing`, and what would settle
    // it is a sentence somebody has to write.
    let plan = plan_of(vec![attempt("tap-once", TaskStatus::Done, "")]);
    assert!(!report::closes(&TaskId::new(STORY), &[], &plan));

    let out = rendered(&plan, &[], &[]);
    assert!(out.starts_with("OPEN "), "{out}");
    assert!(out.contains("owes       nothing — no obligation was ever stated"), "{out}");
    assert!(out.contains("not closed this story states no obligation"), "{out}");
    assert!(!out.contains("\nrequirements\n"), "there are none: {out}");
}

#[test]
fn what_the_story_cost_and_what_was_refused_are_read_off_the_ledger() {
    // The two facts about a story that live nowhere else. A story that landed having been
    // told no twice is a different thing from one that was never told no, and no diff, no
    // plan and no agent's summary carries either number.
    let (plan, reqs) = finished();
    let ledger = vec![
        row("tap-once", "spend", "12000t/60s", "allow"),
        row("hold-the-card", "spend", "5000t/30s", "allow"),
        row("hold-the-card", "write", "src/secrets.rs", "deny"),
        // Another story's rows, in the same ledger, and none of this story's business.
        row("some-other-task", "spend", "999000t/9s", "allow"),
    ];
    let out = rendered(&plan, &reqs, &ledger);
    assert!(
        out.contains("spend      17000 tokens over 2 runs, as the harnesses reported them"),
        "{out}"
    );
    assert!(out.contains("refused    1 act the Broker denied"), "{out}");
}

#[test]
fn a_story_with_a_quiet_ledger_says_nothing_about_spend_or_refusals() {
    // Absent rather than zeroed. `0 tokens over 0 runs` reads as a measurement, and what
    // it would actually mean is that nothing has run yet.
    let (plan, reqs) = finished();
    let out = rendered(&plan, &reqs, &[]);
    assert!(!out.contains("spend"), "{out}");
    assert!(!out.contains("refused"), "{out}");
}

#[test]
fn work_under_the_story_that_answers_to_nothing_is_named_and_not_counted() {
    // A story's design task is the usual one: it proposes what the others then serve, so
    // it answers to no obligation of its own. Dropping it would say the story was smaller
    // than it was; counting it as evidence would say an obligation was met by a document.
    let mut design = Task::new("checkout-design", "cart", "decide the one-tap flow")
        .under(STORY)
        .of_kind(TaskKind::Design);
    design.status = TaskStatus::Done;
    let plan = plan_of(vec![
        attempt("tap-once", TaskStatus::Done, &format!("{STORY}/FR-1")),
        design,
    ]);
    let reqs = vec![owes("FR-1", &["tap-once"])];
    let out = rendered(&plan, &reqs, &[]);
    assert!(out.contains("tasks      2 done"), "{out}");
    assert!(out.contains("\nalso under it\n"), "{out}");
    assert!(out.contains("checkout-design      done      decide the one-tap flow"), "{out}");
    // Under the heading, and nowhere near the obligation.
    let join = out.split("\nalso under it\n").next().unwrap();
    assert!(!join.contains("checkout-design"), "{out}");
}

#[test]
fn a_persons_attempt_offers_its_signature_where_an_agents_offers_its_commands() {
    // The one piece of evidence in wecode that was never an agent's word about itself.
    // Nothing ran, so there is no command to tick — and a report that printed `none
    // declared` here would be calling the strongest evidence it holds an absence.
    let mut by_hand = Task::new("mint-the-key", "cart", "mint the payment key")
        .under(STORY)
        .serving(format!("{STORY}/FR-1"))
        .done_by(Doer::Person);
    by_hand.status = TaskStatus::Done;
    let plan = plan_of(vec![by_hand]);
    let reqs = vec![owes("FR-1", &["mint-the-key"])];
    let out = rendered(&plan, &reqs, &[]);
    assert!(out.contains("mint-the-key         done      ✓ a signature — nothing ran"), "{out}");
    assert!(!out.contains("nothing declared"), "{out}");
}
