//! The cockpit as an operator away from their desk gets it: `wecode board`, piped.
//!
//! board.rs unit-tests the cell against a hand-built `Plan`. What that cannot reach is
//! the plan a real workspace stores — where the tasks were added by the CLI, finished
//! by the CLI, and counted from what SQLite gave back — and whether the number this
//! board prints is the number the other views print for the same project.
//!
//! Also where the two forms are held apart. `wecode tui` is the live one and cannot run
//! here at all — a test harness has no terminal, which is exactly the condition the
//! snapshot exists for — so what a test binary can check about it is the contract
//! between them: that it refuses politely, names `board` as what to run instead, and
//! answers to the name the muscle memory already has.

mod support;

use support::Org;

/// A board snapshot, checked to have been produced at all.
fn board(org: &Org, args: &[&str]) -> String {
    let r = org.run(args);
    r.assert_ok("board");
    r.stdout
}

/// The project row of a board snapshot, so an assertion says which line it means.
fn project_row(out: &str) -> String {
    out.lines()
        .find(|l| l.contains("PROJECT caching"))
        .unwrap_or_else(|| panic!("no project row in:\n{out}"))
        .to_string()
}

/// Every heading the board divides itself with, in the order it must draw them.
const HEADS: [&str; 5] = ["NEEDS YOU", "MOVING", "NEXT", "LANDED", "PORTFOLIO"];

/// The rows of one attention group: what lies between its heading and the next one.
///
/// Sliced by the headings rather than by counting lines, so a test says *this row is in
/// this group* — which is the whole claim the grouping makes, and the one a test that
/// only searched the whole snapshot for a word would pass without checking.
fn group(out: &str, title: &str) -> Vec<String> {
    let rows: Vec<String> = out
        .lines()
        .skip_while(|l| !l.contains(title))
        .skip(1)
        .take_while(|l| !HEADS.iter().any(|h| l.contains(h)))
        .map(str::to_string)
        .collect();
    assert!(out.contains(title), "no `{title}` group in:\n{out}");
    rows
}

/// A group row's own name for a task — the `what` cell, project included.
///
/// Matched on rather than on the bare id, because the cells these tests read say things
/// like `after cache-tests`: a row is found by what it *is*, never by a task it mentions.
fn label(id: &str) -> String {
    format!("caching/{id}")
}

/// The one row in `title` naming `id`, with the group asserted to hold exactly one.
fn row_in(out: &str, title: &str, id: &str) -> String {
    let mut found: Vec<String> = group(out, title)
        .into_iter()
        .filter(|l| l.contains(&label(id)))
        .collect();
    assert_eq!(found.len(), 1, "`{id}` in `{title}` of:\n{out}");
    found.remove(0)
}

#[test]
fn the_board_opens_with_the_four_questions_and_not_with_the_tree() {
    // The headline: a person opening this from a phone is asking *what is mine to do*,
    // and a tree answers *how is this organised*. The tree is still the second half of
    // the view — but it is the second half, and what it is under is a heading.
    let org = Org::new("board-attention", "software-company");
    org.seed();
    let out = board(&org, &["board"]);

    let heads: Vec<&str> = out
        .lines()
        .filter(|l| HEADS.iter().any(|h| l.contains(h)))
        .collect();
    assert_eq!(heads.len(), 5, "{out}");
    for (drawn, want) in heads.iter().zip(HEADS) {
        assert!(drawn.contains(want), "out of order at `{want}`:\n{out}");
    }

    // The acceptance for the eye. Nothing about the plan's shape may come first.
    let first = out
        .lines()
        .find(|l| l.contains("caching") || HEADS.iter().any(|h| l.contains(h)))
        .expect("a first row");
    assert!(first.contains("NEEDS YOU"), "the board opens on: {first}");
    assert!(!first.contains("PROJECT"), "{first}");
}

#[test]
fn every_group_answers_the_question_its_own_rows_raise() {
    // Why grouping is not sorting: `> running` is a fact four rows share, and the four
    // groups each ask something the status word cannot answer on its own.
    let org = Org::new("board-groups", "software-company");
    org.seed();

    // NEXT — what would move this, for work that is not moving. Both halves: nobody
    // owns the first, and the second is behind it whoever owns them.
    let out = board(&org, &["board"]);
    assert!(row_in(&out, "NEXT", "cache-tests").contains("unassigned"), "{out}");
    assert!(row_in(&out, "NEXT", "bench").contains("after cache-tests"), "{out}");
    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign");
    let out = board(&org, &["board"]);
    assert!(row_in(&out, "NEXT", "cache-tests").contains("queued for test"), "{out}");

    // MOVING — what it is doing, which is the question `running` leaves open. Read off
    // the ledger, because every act an agent takes passes the Broker to get there.
    org.run(&["status", "cache-tests", "running"]).assert_ok("run");
    org.run(&["guard", "impl", "write", "tests/cache_spec.rs", "--task", "cache-tests"])
        .assert_ok("guard");
    let out = board(&org, &["board"]);
    let moving = row_in(&out, "MOVING", "cache-tests");
    assert!(moving.contains("write tests/cache_spec.rs"), "{moving}");

    // NEEDS YOU — what is wanted, in the words the row already computed.
    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("hold");
    let out = board(&org, &["board"]);
    assert!(row_in(&out, "NEEDS YOU", "cache-tests").contains("needs-approval"), "{out}");

    // LANDED — what landed, in the words somebody wrote when they asked for it. The
    // cost is the spend cell, which every row already carries.
    org.run(&["status", "cache-tests", "done"]).assert_ok("done");
    let out = board(&org, &["board"]);
    let landed = row_in(&out, "LANDED", "cache-tests");
    assert!(landed.contains("cover the cache layer"), "{landed}");
}

#[test]
fn a_row_is_in_exactly_one_group_at_a_time() {
    // What makes four groups readable rather than four filters: somebody reading them
    // is counting, and work in two of them is counted twice. Asserted as the state
    // moves, because every move is a chance to leave a copy behind in the old group.
    let org = Org::new("board-partition", "software-company");
    org.seed();
    for status in ["ready", "running", "needs-input", "done", "dropped"] {
        org.run(&["status", "cache-tests", status])
            .assert_ok(status);
        let out = board(&org, &["board"]);
        let held: Vec<&str> = HEADS
            .iter()
            .take(4)
            .filter(|h| group(&out, h).iter().any(|l| l.contains(&label("cache-tests"))))
            .copied()
            .collect();
        // Dropped is in none of them: not waiting, not moving, and it did not land.
        let want = usize::from(status != "dropped");
        assert_eq!(held.len(), want, "`{status}` sat in {held:?}:\n{out}");
    }
}

#[test]
fn a_group_shows_a_handful_and_says_how_many_it_stood_down() {
    // The ceiling the company already declares for itself — `[attention]
    // max_open_items` — applied to the eye rather than to the scheduler. A group that
    // rendered its whole tail would push the other three off a phone screen, which is
    // the failure this view exists to fix.
    let org = Org::new("board-ceiling", "software-company");
    org.seed();
    for n in 0..6 {
        // Scopes that overlap nothing, here and with each other: two tasks that could
        // write the same file are a defect, and an undeclared one would leave this
        // measuring admission rather than the ceiling.
        org.run(&[
            "task",
            "add",
            &format!("extra-{n}"),
            "another piece of the caching work",
            "--project",
            "caching",
            "--accept-cmd",
            "cargo test",
            "--write",
            &format!("src/extra-{n}/**"),
            "--tokens",
            "1000",
        ])
        .assert_ok("add task")
        .assert_lacks("not saved");
    }

    let out = board(&org, &["board"]);
    let next = group(&out, "NEXT");
    // Five rows and the count. Eight tasks are open, so three are stood down.
    assert_eq!(next.len(), 6, "five rows and one tail line:\n{out}");
    assert!(next[5].contains("… and 3 more"), "{out}");
    // And what it stood down is still reachable — the tree below drew all of them.
    assert!(out.contains("extra-5"), "{out}");
}

#[test]
fn the_board_says_how_far_a_project_has_got() {
    // The gap this closes: `> active` is a fact about intent — the project is open for
    // work — and it reads the same on the day the project is opened and on the day its
    // last task lands. Somebody answering wecode from a phone is asking the other
    // question.
    let org = Org::new("board-standing", "software-company");
    org.seed();

    let before = project_row(&board(&org, &["board"]));
    assert!(before.contains("0/2"), "nothing done yet: {before}");

    org.run(&["status", "cache-tests", "done"]).assert_ok("done");
    let after = project_row(&board(&org, &["board"]));
    assert!(after.contains("1/2"), "one of two: {after}");
    // Beside the declared state, never instead of it. A project can be finished and
    // still open, or open and untouched, and the row has to be able to say which.
    assert!(after.contains("draft"), "the declared state stays: {after}");
}

#[test]
fn the_standing_is_on_the_focused_project_too() {
    // Descending is what an operator does after the portfolio row catches their eye,
    // and landing on a view that dropped the number they came for sends them back up.
    let org = Org::new("board-standing-focus", "software-company");
    org.seed();
    org.run(&["status", "cache-tests", "done"]).assert_ok("done");

    let out = board(&org, &["board", "caching"]);
    assert!(out.contains("L1 · caching"), "{out}");
    assert!(project_row(&out).contains("1/2"), "{out}");
}

#[test]
fn the_board_counts_what_the_other_views_count() {
    // One workspace, three surfaces, one answer. The board is the one people read
    // fastest, so it is the one that must not be the odd number out — a cockpit that
    // disagrees with `wecode show` about how much is left is a cockpit nobody believes
    // the second time.
    let org = Org::new("board-standing-agrees", "software-company");
    org.seed();
    org.run(&["status", "cache-tests", "done"]).assert_ok("done");

    org.run(&["show", "caching"])
        .assert_ok("show")
        .assert_contains("1 of 2 done");
    assert!(project_row(&board(&org, &["board"])).contains("1/2"));

    // And where the two could most easily part company: work nobody will do. Dropping
    // a task is a decision to record, not a way for a project to reach the end of
    // itself — so the denominator keeps it, here as everywhere else.
    org.run(&["status", "bench", "dropped"]).assert_ok("drop");
    org.run(&["show", "caching"])
        .assert_ok("show")
        .assert_contains("1 of 2 done");
    let row = project_row(&board(&org, &["board"]));
    assert!(row.contains("1/2"), "the dropped task is still counted: {row}");
}

#[test]
fn the_board_says_how_much_of_the_work_nobody_has_been_handed() {
    // The half the fraction cannot say. `draft 0/2` reads the same whether two agents
    // are mid-run and whether nothing owns the work at all — and it is the second that
    // never resolves on its own, because a task only leaves `draft` once it names a
    // post and the loop only ever dispatches one that has.
    let org = Org::new("board-unowned", "software-company");
    org.seed();

    let before = project_row(&board(&org, &["board"]));
    assert!(before.contains("2 to assign"), "{before}");

    // And it comes down as the work is handed over, one post at a time. A count that
    // only ever went up would be a banner, and people stop reading banners.
    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign");
    let after = project_row(&board(&org, &["board"]));
    assert!(after.contains("1 to assign"), "{after}");

    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign");
    let staffed = project_row(&board(&org, &["board"]));
    assert!(!staffed.contains("to assign"), "nothing left to say: {staffed}");
}

#[test]
fn a_project_whose_work_has_all_landed_asks_to_be_closed() {
    // Where the standing runs out. `2/2` beside `draft` is the whole plan finished
    // under a project nothing will ever close by itself — and an operator reading this
    // from a phone is the only one who can.
    let org = Org::new("board-closable", "software-company");
    org.seed();
    for t in ["cache-tests", "bench"] {
        org.run(&["status", t, "done"]).assert_ok("done");
    }

    let row = project_row(&board(&org, &["board"]));
    assert!(row.contains("2/2"), "{row}");
    assert!(row.contains("ready to close"), "{row}");

    // Once they have, the row goes quiet. A closed project still asking to be closed is
    // what teaches somebody the cell is decoration.
    org.run(&["status", "caching", "done"]).assert_ok("close");
    let closed = project_row(&board(&org, &["board"]));
    assert!(!closed.contains("ready to close"), "{closed}");
    assert!(closed.contains("done 2/2"), "the reading stays: {closed}");
}

#[test]
fn a_board_of_a_workspace_that_is_moving_says_nothing_about_time() {
    // The half of the silence rule only a real workspace can prove. `quiet 3d` is worth
    // reading because it is rare, and a cell that told every operator on earth their live
    // workspace had gone quiet is the first one they would learn to skip. Here the times
    // are the ones the store actually wrote, against the threshold as it actually is —
    // where a unit or a sign the wrong way round shows up as a row shouting on day one.
    //
    // The other half — that the words do appear once a day has passed — cannot be
    // reached from here, because nothing in a test can make a stored workspace old.
    // board.rs unit-tests that against a ledger it hands its own times to.
    let org = Org::new("board-quiet", "software-company");
    org.seed();
    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign");
    org.run(&["status", "cache-tests", "done"]).assert_ok("done");

    let out = board(&org, &["board"]);
    assert!(!out.contains("quiet"), "a workspace that just moved: {out}");
    let down = board(&org, &["board", "caching"]);
    assert!(!down.contains("quiet"), "nor on the way down: {down}");
}

#[test]
fn the_live_cockpit_answers_to_tui_and_to_the_name_it_had_before() {
    // One entry point, and the old spelling kept: a rename that breaks muscle memory is
    // a tax with no revenue. Both must reach the same command, which with no terminal
    // attached means both must fail the same way — a spelling that fell through to
    // `unknown command` would be the regression this is here to catch.
    let org = Org::new("tui-names", "software-company");
    org.seed();
    for name in ["tui", "up", "cockpit"] {
        let r = org.run(&[name]);
        assert!(!r.ok(), "`{name}` should refuse without a terminal:\n{}", r.all());
        r.assert_lacks("unknown command");
        // And it says where to go instead. A cockpit that only said *no* to a cron job,
        // a pipe or an ssh session left the operator with nothing to run.
        r.assert_contains("needs a terminal");
        r.assert_contains("wecode board");
    }
}

#[test]
fn the_snapshot_is_the_form_that_works_where_the_cockpit_cannot() {
    // The other half of the same contract: what `tui` points at has to be there. The
    // suite has no tty, so this is the one of the two forms an operator on a phone, in a
    // log, or at the end of a pipe actually gets — and it prints the same state.
    let org = Org::new("tui-fallback", "software-company");
    org.seed();
    let out = board(&org, &["board"]);
    assert!(out.contains("NEEDS YOU"), "{out}");
    assert!(out.contains("PROJECT caching"), "{out}");
}

#[test]
fn naming_a_screen_does_not_make_it_a_different_command() {
    // `wecode tui <id>` chooses the screen it opens on; it is still `wecode tui`. Here
    // that shows as the refusal being unchanged by the id — the terminal is what the
    // command needs, and no positional makes it need one less. `wecode board <id>` is
    // the one that *does* answer with something in a pipe, because printing is what it
    // is for; the two must not swap places.
    let org = Org::new("tui-opening", "software-company");
    org.seed();
    for named in ["caching", "cache-tests", "no-such-thing"] {
        org.run(&["tui", named]).assert_contains("needs a terminal");
    }
    assert!(board(&org, &["board", "caching"]).contains("caching"));
}

#[test]
fn a_project_with_nothing_planned_yet_reports_no_standing() {
    // `0/0` is arithmetic about nothing. The needs-you cell already has the sentence.
    let org = Org::new("board-standing-bare", "software-company");
    org.run(&[
        "project",
        "add",
        "bare",
        "get the export endpoint under a second",
        "--repo",
        "app",
        "--measure-cmd",
        "cargo test",
        "--tokens",
        "1000",
        "--wall",
        "60",
    ])
    .assert_ok("add project");

    let out = board(&org, &["board"]);
    let row = out
        .lines()
        .find(|l| l.contains("PROJECT bare"))
        .unwrap_or_else(|| panic!("no project row in:\n{out}"));
    assert!(!row.contains("0/0"), "no fraction to print: {row}");
    assert!(row.contains("no tasks"), "the sentence instead: {row}");
}
