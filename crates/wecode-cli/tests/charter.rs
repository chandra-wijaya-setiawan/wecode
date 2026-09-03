//! The one invariant nobody writes: no seat edits the files that configure agents.
//!
//! End to end rather than in `wecode-gov`, because the property is about the whole
//! path — a `company.toml` on disk, parsed into a charter, handed to a Broker, asked
//! about a real path. A unit test could only assert that a list built from a constant
//! contains the constant.

mod support;

use support::Org;

/// The seat that does the work, under the software company's own charter: it may write
/// `src/**` and `crates/**`, and it is the seat an agent is actually dispatched as.
const IMPL: &[&str] = &["guard", "impl", "write"];

fn writes(org: &Org, path: &str) -> support::Run {
    let mut argv = IMPL.to_vec();
    argv.extend_from_slice(&[path, "--task", "cache-tests"]);
    org.run(&argv)
}

#[test]
fn no_seat_may_write_the_files_that_configure_agents() {
    let org = Org::new("charter-agent-config", "software-company");
    org.seed();
    for path in [
        "company.toml",
        ".wecode/playbook.toml",
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".claude/agents/reviewer.md",
        ".mcp.json",
    ] {
        writes(&org, path)
            .assert_contains("ALARM")
            .assert_contains("never_touch");
    }
}

#[test]
fn the_guard_holds_wherever_in_the_tree_the_file_sits() {
    // A monorepo is the case that matters: the task works in one package and the
    // settings deciding what it may do sit two directories up, or beside a sibling.
    let org = Org::new("charter-nested", "software-company");
    org.seed();
    for path in [
        "packages/api/.claude/settings.json",
        "vendor/tool/company.toml",
        "services/web/.wecode/playbook.toml",
    ] {
        writes(&org, path).assert_contains("ALARM");
    }
}

#[test]
fn no_grant_reaches_it_however_wide() {
    // The whole point of it being an invariant rather than a scope. The seat here holds
    // `write = ["**"]` — wider than any shipped role — and the invariant is judged
    // before the grant, so there is no seat to be promoted into.
    let org = Org::new("charter-root", "software-company");
    org.seed();
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    // By shape, not by literal: the engineer is the seat whose scope starts at `src/**`,
    // and adding a glob to the shipped template must not quietly stop widening it.
    let widened: String = text
        .lines()
        .map(|l| {
            if l.starts_with("write = [\"src/") {
                "write = [\"**\"]".to_string()
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert_ne!(widened, text, "the engineer's write glob was not widened");
    std::fs::write(&conf, widened).unwrap();

    // Wide enough to prove the grant is what changed: this used to be out of scope.
    writes(&org, "docs/README.md")
        .assert_ok("guard")
        .assert_contains("allowed");
    writes(&org, "company.toml")
        .assert_contains("ALARM")
        .assert_contains("never_touch");
}

#[test]
fn a_company_that_forbids_nothing_still_forbids_this() {
    // The failure mode this exists for. An operator can empty `[invariants]`, and an
    // agent that reached the file could empty it for them — and neither removes the
    // guard, because it comes from nowhere in the file.
    let org = Org::new("charter-empty", "solo");
    org.seed();
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let stripped: String = text
        .lines()
        .map(|l| {
            if l.starts_with("never_touch") {
                "never_touch = []".to_string()
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert_ne!(stripped, text, "the fixture had a never_touch to empty");
    std::fs::write(&conf, stripped).unwrap();

    // The operator's own protections are gone — this is the same charter, minus them.
    writes(&org, "deploy/key.pem")
        .assert_ok("guard")
        .assert_lacks("ALARM");
    writes(&org, "company.toml").assert_contains("ALARM");
}

#[test]
fn guidance_is_not_configuration() {
    // The line the list is drawn on, asserted so widening it is a deliberate act. An
    // agent rewriting what it was told is doing ordinary work; an agent rewriting what
    // it is permitted has granted itself something.
    let org = Org::new("charter-guidance", "software-company");
    org.seed();
    for path in ["CLAUDE.md", "docs/README.md", "crates/export/settings.json"] {
        writes(&org, path).assert_ok("guard").assert_lacks("ALARM");
    }
    // And the last of those is inside the engineer's scope, so it is not merely
    // unalarmed — it goes through, which is what says the guard did not widen to the
    // filename rather than the file.
    writes(&org, "crates/export/settings.json").assert_contains("allowed");
}

#[test]
fn the_seat_is_told_before_it_is_refused() {
    // Enforcement is the guarantee; the briefing is what stops a task discovering it
    // halfway through. Both are derived from the one charter, so they cannot disagree.
    let org = Org::new("charter-brief", "software-company");
    org.seed();
    org.run(&["company", "show"])
        .assert_ok("company show")
        .assert_contains("company.toml");
    org.run(&["brief"])
        .assert_ok("brief")
        .assert_contains(".claude/settings.json");
}
