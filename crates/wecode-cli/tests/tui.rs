//! The cockpit, from outside it.
//!
//! Two things a unit test in `src/tui/` structurally cannot hold.
//!
//! The first is the **seam**: `wecode tui` needs a terminal, and the suite has none. What
//! it does instead is the whole of what a scripted or piped invocation ever sees, so the
//! refusal is the feature — and it has to name the command that does answer.
//!
//! The second is `docs/design/tui-dashboard.md`, which is `hand-tended-state` over
//! `crates/wecode-cli/src/tui/**` and is therefore the drawing the code is supposed to
//! be. Two statements of one fact, mechanically compared, in Martraire's sense: the page
//! names six panes and six keys, the module names the same six, and the two agree only
//! while somebody keeps them agreeing. A drawing nothing checks is a drawing that goes
//! quietly stale, which is the defect `docs/design/living-docs.md` is about.
//!
//! No workspace for the second half, so `support` is pulled in for the first alone.

use std::path::{Path, PathBuf};

mod support;
use support::Org;

fn docs() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs")
}

fn page(rel: &str) -> String {
    let at = docs().join(rel);
    std::fs::read_to_string(&at).unwrap_or_else(|e| panic!("reading {}: {e}", at.display()))
}

fn module(name: &str) -> String {
    let at = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tui").join(name);
    std::fs::read_to_string(&at).unwrap_or_else(|e| panic!("reading {}: {e}", at.display()))
}

#[test]
fn the_cockpit_refuses_a_pipe_and_names_the_command_that_answers_one() {
    // The one thing a script, a log or a CI job ever gets from `wecode tui`. A refusal
    // that only said *needs a terminal* would leave the person who typed it with the
    // question they started with, so it carries the snapshot's name.
    let org = Org::new("tui-no-terminal", "solo");
    let out = org.run(&["tui"]);
    assert!(!out.ok(), "a pipe is not a terminal:\n{}", out.all());
    out.assert_contains("needs a terminal");
    out.assert_contains("wecode board");

    // And the snapshot it names actually runs here, which is what makes the sentence a
    // way out rather than a second dead end.
    org.run(&["board"]).assert_ok("the snapshot the refusal names");

    // `up` and `cockpit` are older spellings of the same command, and refuse the same
    // way: a spelling that got a different answer would read as a different command.
    for spelling in ["up", "cockpit"] {
        org.run(&[spelling]).assert_contains("needs a terminal");
    }
}

#[test]
fn every_pane_and_key_the_drawing_names_is_one_the_module_draws() {
    // `docs/design/tui-dashboard.md` is the front page's specification, and the six rules
    // under the drawing are what it fixes. Each is checkable, so each is checked here
    // rather than left to whoever reads the page next.
    let design = page("design/tui-dashboard.md");
    let dash = module("dashboard.rs");

    // Rule 1 and rule 2: six panes, and every title carries its count. The titles are
    // the drawing's own words, and the count is `{count}` in the one format string that
    // builds every title — so a pane added without one cannot compile past this.
    for pane in ["Agent", "Need you", "Blocked", "Roadmap"] {
        assert!(design.contains(pane), "the drawing names `{pane}`");
        assert!(dash.contains(pane), "the module draws `{pane}`");
    }
    assert!(dash.contains(r#"title(format!(" {title}({count}) "))"#), "counts in titles");

    // Rule 3: every pane names the key that opens it, in the pane. The bar at the foot
    // is the same list read the other way round, and `KEYS` is the only copy of it.
    for key in ["v-d", "v-a", "v-y", "v-g", "v-r", "v-h"] {
        assert!(design.contains(key), "the drawing names `{key}`");
        assert!(dash.contains(key), "the module names `{key}`");
    }
    assert!(dash.contains("detail: press {key}"), "the key is printed in the pane");

    // Rule 4: the summary is a synthesised sentence naming the cause, not a status word.
    assert!(dash.contains("no agents are running due to"), "the sentence names a cause");
    assert!(dash.contains("fn cause("), "and one ranked function decides which");

    // Rule 5: both shape questions open as diagrams rather than as a second list.
    assert!(dash.contains("fn blocked_dag("), "blocked opens as a shape");
    assert!(dash.contains("fn roadmap_dag("), "and so does the roadmap");

    // Rule 6: `wecode tui` opens here. The stack's bottom is the front page, which is
    // the only place that decision is written down.
    let tui = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tui.rs"),
    )
    .expect("tui.rs");
    assert!(
        tui.contains("std::iter::once(Screen::Dash(dashboard::Panel::Dashboard))"),
        "the cockpit opens on the dashboard, with the board one key away"
    );
}

#[test]
fn the_reference_page_and_the_design_page_agree_about_the_keys() {
    // `docs/reference/tui.md` is what an operator reads; the design page is what the
    // owner drew. A key in one and not the other is a cockpit somebody was taught wrong
    // about — the failure that makes a reference worth less than no reference at all.
    let reference = page("reference/tui.md");
    for key in ["v d", "v a", "v y", "v g", "v r", "v h"] {
        assert!(reference.contains(key), "the reference does not teach `{key}`");
    }
    for screen in ["DASHBOARD", "NEED YOU", "BLOCKED", "ROADMAP"] {
        assert!(reference.contains(screen), "the reference does not name `{screen}`");
    }
    // And it says which screen a bare `wecode tui` lands on, because that is the one
    // sentence a reader who has never run it needs.
    assert!(reference.contains("opens on"), "{reference}");
}
