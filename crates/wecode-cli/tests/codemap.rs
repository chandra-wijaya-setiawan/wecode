//! The codemap as it reaches the two people who read it: the table `wecode map` prints
//! for an operator, and the section the envelope carries to a worker.
//!
//! One suite rather than three, because all of it is one ranking out of one scan — the
//! parity claim in the specification's §4b is that an operator and an agent are shown
//! the same thing, and it is only testable where both are asked in one place. The
//! drill's grammar row is here for the same reason: it answers *which languages does
//! this ranking cover*, which is a question about this and not about `doctor`.
//!
//! What this area needs that no other does is source a parser can read. The committed
//! fixture is one text file on purpose — it is what every other suite drives, and a
//! crate of Rust in it would make every repo-map assertion in the tree depend on this
//! task's fixtures. So the Rust is planted here, and committed, because the scan reads
//! git's index: the cache is keyed on a blob id, and an unstaged file has none.

mod support;

use std::path::{Path, PathBuf};

use support::Org;
use support::agent::{a_task, with_agent};
use support::playbook::with_playbook;

/// The fixture repository with three Rust files committed into it.
///
/// Three and not two: `far.rs` shares no name with anything, and a ranking that listed
/// it would be a ranking that listed the repository.
fn with_source(name: &str) -> (Org, PathBuf) {
    let (org, repo) = with_agent(name, "true");
    put(&repo, "src/seed.rs", "fn main() {\n    assemble_envelope();\n}\n");
    put(&repo, "src/near.rs", "pub fn assemble_envelope() -> u8 {\n    7\n}\n");
    put(&repo, "src/far.rs", "pub fn unrelated_thing() {}\n");
    support::git(&repo, &["add", "-A"]);
    support::git(&repo, &["commit", "-qm", "source for the map to read"]);
    (org, repo)
}

fn put(repo: &Path, rel: &str, body: &str) {
    let path = repo.join(rel);
    std::fs::create_dir_all(path.parent().expect("a parent")).unwrap();
    std::fs::write(path, body).unwrap();
}

// ------------------------------------------------------------- the operator ------

#[test]
fn an_operator_is_shown_the_files_nearest_the_path_they_name() {
    // What the command is for: a scope is declared before the work starts and frozen
    // for the whole of it, so the moment to find out what a path is coupled to is
    // before typing `--write`, not after an agent dies holding work it may not commit.
    let (org, _) = with_source("codemap-seeded");

    org.run(&["map", "caching", "--seed", "src/seed.rs"])
        .assert_ok("map --seed")
        .assert_contains("nearest what this task may write")
        .assert_contains("src/near.rs")
        // Why it is there, in the only two words a matched spelling supports.
        .assert_contains("references assemble_envelope")
        // FR-04-10. Name matching cannot support a claim about resolution, and this is
        // that rule as a property of the output rather than a note in a doc comment.
        .assert_lacks("depends on")
        // Nothing links it to the seed, so it is not a neighbour — a ranking that
        // listed every file would be the file listing the agent already has.
        .assert_lacks("far.rs");
}

#[test]
fn with_no_seed_the_table_says_which_question_it_answered() {
    // *Nearest your scope* and *what this repository names most* are two answers, and a
    // reader handed the second under the first heading would take it for the first.
    let (org, _) = with_source("codemap-unseeded");

    org.run(&["map", "caching"])
        .assert_ok("map")
        .assert_contains("no write scope to rank from")
        .assert_contains("src/near.rs")
        .assert_lacks("depends on");
}

#[test]
fn the_heading_counts_the_files_no_grammar_claims() {
    // Most of a repository, and not a fault. A thin ranking with nothing above it reads
    // as a repository with no shape, rather than as one written in Markdown.
    let (org, _) = with_source("codemap-counted");

    org.run(&["map", "caching"])
        .assert_ok("map")
        .assert_contains("3 of ")
        .assert_contains("in no compiled grammar");
}

#[test]
fn a_tree_with_nothing_to_map_says_so_rather_than_printing_an_empty_table() {
    // The toy fixture as committed: a README, a text file and a playbook. An empty
    // table under a heading is a claim about the repository that is not true of it.
    let (org, _) = with_playbook("codemap-nothing");

    let out = org.run(&["map", "caching"]);
    assert!(!out.ok(), "expected a refusal:\n{}", out.all());
    out.assert_contains("nothing to map in");
}

// --------------------------------------------------------------- the worker ------

#[test]
fn a_worker_is_told_which_files_share_names_with_what_it_may_write() {
    // The repo map above this says what the tree is; this says which of it to open. It
    // is seeded from the write scope because the scope is where the task is about to be.
    let (org, _) = with_source("codemap-envelope");
    a_task(&org, "t", "src/seed.rs", "true");

    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_contains("NEAREST THE WRITE SCOPE")
        .assert_contains("nearest what this task may write")
        .assert_contains("src/near.rs")
        .assert_contains("references assemble_envelope")
        .assert_lacks("depends on");
}

#[test]
fn the_ranking_reaches_a_remote_agent_as_an_artifact() {
    // The prompt and the JSON are two renderings of one record. A ranking that existed
    // only in the prose would be a section a remote harness never sees.
    let (org, _) = with_source("codemap-envelope-json");
    a_task(&org, "t", "src/seed.rs", "true");

    let r = org.run(&["start", "t", "--json"]);
    r.assert_ok("start --json");
    let v: serde_json::Value = serde_json::from_str(&r.stdout).expect("valid JSON");
    let artifacts = v["artifacts"].as_array().expect("artifacts");
    let map = artifacts
        .iter()
        .find(|a| a["artifactId"] == "codemap")
        .expect("the codemap is an artifact of the instruction");
    let text = map["parts"][0]["text"].as_str().expect("a text part");
    assert!(text.contains("src/near.rs"), "{text}");

    // Under the repo map and never above it: the tree is what an agent orients on, and
    // a shortlist read before the thing it is a shortlist of is a set of bare paths.
    let at = |id: &str| {
        artifacts
            .iter()
            .position(|a| a["artifactId"] == id)
            .unwrap_or_else(|| panic!("no {id} artifact in {artifacts:?}"))
    };
    assert!(at("repo-map") < at("codemap"), "{artifacts:?}");
}

#[test]
fn one_ranking_reaches_the_operator_and_the_worker() {
    // §4b, and the reason `wecode map` calls the function the envelope calls rather
    // than one of its own: two maps of one repository that could disagree would send
    // the person declaring the scope and the agent working in it to different files.
    let (org, _) = with_source("codemap-parity");
    a_task(&org, "t", "src/seed.rs", "true");

    let worker = org.run(&["start", "t"]).assert_ok("start").all();
    let operator = org
        .run(&["map", "caching", "--seed", "src/seed.rs"])
        .assert_ok("map --seed")
        .all();

    let row = |text: &str| {
        text.lines()
            .find(|l| l.contains("src/near.rs"))
            .unwrap_or_else(|| panic!("no row for src/near.rs in:\n{text}"))
            .trim()
            .to_string()
    };
    assert_eq!(row(&worker), row(&operator));
}

// ---------------------------------------------------------------- the drill ------

#[test]
fn a_project_whose_language_has_no_grammar_is_named_by_the_drill() {
    // The toy fixture's playbook says `text`. The operator learns it here; the agent
    // learns the same thing from the scan's counted-skips line in its envelope.
    let org = Org::new("codemap-doctor-unmapped", "solo");
    org.repo();

    org.run(&["doctor"])
        .assert_contains("codemap grammars")
        .assert_contains("app says `text`")
        // And what it costs, which is a ranking and nothing else.
        .assert_contains("stay at the file layer")
        // Never a failure: the map ranks and never refuses, so a language wecode cannot
        // parse must not put `wecode doctor && wecode loop` behind a grammar nobody's
        // work depends on.
        .assert_lacks("✗ codemap grammars");
}

#[test]
fn a_language_wecode_can_parse_is_reported_as_sound_with_the_whole_set() {
    // The set is worth printing whichever way the row goes: a project that declares one
    // of the six wants to know the other five exist before it adds a second repo.
    let (org, _) = with_playbook("codemap-doctor-mapped");

    org.run(&["doctor"])
        .assert_contains("✓ codemap grammars")
        .assert_contains("rust, python, typescript, tsx, javascript, go");
}
