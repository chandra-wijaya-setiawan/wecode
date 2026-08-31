//! The freshness gate, end to end: a page that declares what it governs, a diff that
//! left it behind, and the same verdict taken twice over a branch that moved in between.
//!
//! The join itself is unit-tested where it lives — `wecode_core::docs` is pure and has no
//! tree to need. What cannot be tested there is the half `verify` owns: **which** pages
//! are joined, and **as of when**. `verify::governing` reads them at the revision the
//! run's own attempt froze, so the claim is that a commit landing on the branch afterwards
//! changes nothing about a verdict already earned — in either direction. Proving that
//! needs a real branch, a real attempt commit, and the real command run twice over them,
//! which is this file and not a unit test.

mod support;

use std::path::{Path, PathBuf};

use support::Org;
use support::agent::with_agent;
use support::git;
use support::playbook::with_playbook;

/// A page declaring a subject, in the front-matter `docs/reference/front-matter.md`
/// documents. `hand-tended` is the default and is written out anyway: the class is what
/// decides whether the page is joined at all, and a test that left it implicit would
/// still pass with the parser reading nothing.
fn page(subject: &str) -> String {
    format!("---\nclass: hand-tended\nsubject: [{subject}]\n---\n\nthe cache\n")
}

/// Puts the page on the branch under a hand that is not wecode's.
///
/// Which is the whole apparatus of this file. `verify` rebuilds a run's diff out of the
/// commits wecode itself made, so a commit by anybody else is on the branch and outside
/// the run — exactly the thing that must not be able to move a verdict. Named paths
/// rather than `add -A`, so a worktree carrying a worker's leftovers commits the page and
/// nothing beside it.
fn commit_page(tree: &Path, subject: &str, why: &str) {
    std::fs::create_dir_all(tree.join("docs")).unwrap();
    std::fs::write(tree.join("docs/cache.md"), page(subject)).unwrap();
    git(tree, &["add", "docs/cache.md"]);
    git(tree, &["commit", "-qm", why]);
}

/// A task with the write scope the test needs, and acceptance that always passes.
///
/// Green acceptance is the shape of the failure this gate exists for: a repository's own
/// suite says nothing about whether a page was opened, so a stale finding has to be able
/// to fail a task every check of which is a tick.
fn a_task(org: &Org, id: &str, write: &[&str]) {
    let mut argv = vec![
        "task",
        "add",
        id,
        "--project",
        "caching",
        "--kind",
        "chore",
        "trim the cache",
        "--accept-cmd",
        "true",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ];
    for glob in write {
        argv.push("--write");
        argv.push(glob);
    }
    org.run(&argv).assert_ok("task add");
}

/// The tree wecode cut for a task, where `WECODE_CONFIG` puts it for a test.
fn worktree(org: &Org, name: &str, id: &str) -> PathBuf {
    org.path("config/run")
        .join(format!("wecode-e2e-{name}"))
        .join(id)
}

// ------------------------------------------------ the join, over a real tree ------

#[test]
fn a_diff_that_left_its_governing_document_behind_is_refused_and_says_which() {
    // The whole point. The page named `src/**`, the work changed `src/cache.rs`, and
    // nobody opened the page. Both halves are reported, because *edit the page* is not
    // actionable without the change that implicated it.
    let (org, repo) = with_playbook("doc-gate-stale");
    commit_page(&repo, "src/**", "the page, before anybody moved it");
    a_task(&org, "t", &["src/**"]);
    std::fs::write(repo.join("src/cache.rs"), "fn evict() {}\n").unwrap();

    org.run(&["verify", "t"])
        .assert_ok("verify runs")
        .assert_contains("docs/cache.md did not move with src/cache.rs")
        .assert_contains("there is no waiver")
        .assert_contains("failed")
        // Nothing was written where it was forbidden. A stale page is a finding beside a
        // scope violation and not one of them, and it earns no denial.
        .assert_lacks("outside scope");
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_lacks("docs/cache.md");
}

#[test]
fn moving_the_document_with_it_is_all_that_is_asked() {
    // The other half, and the whole modesty of the gate: a one-word edit satisfies it.
    // Form is `design-check.sh`'s business and substance is a signature's; what is left
    // for a machine is the join.
    let (org, repo) = with_playbook("doc-gate-fresh");
    commit_page(&repo, "src/**", "the page, before anybody moved it");
    a_task(&org, "t", &["src/**", "docs/**"]);
    std::fs::write(repo.join("src/cache.rs"), "fn evict() {}\n").unwrap();
    std::fs::write(
        repo.join("docs/cache.md"),
        format!("{}\nand what it evicts.\n", page("src/**")),
    )
    .unwrap();

    org.run(&["verify", "t"])
        .assert_ok("verify runs")
        .assert_lacks("did not move")
        .assert_lacks("there is no waiver");
}

// ------------------------------------------- the verdict, asked twice ------

#[test]
fn a_subject_widened_after_the_run_cannot_refuse_it() {
    // A run is refusable only for coupling that run created — the property the diff form
    // was chosen for, and the one a document side read live off the disk gives away. Here
    // the page governed only itself while the run happened, and somebody widened it onto
    // `src/**` afterwards. The verdict was already earned; asking again must not overturn
    // it on the strength of a claim that did not exist at the time.
    let (org, repo) = with_agent("doc-gate-widened", "echo '// evicts' >> src/cache.rs");
    commit_page(&repo, "docs/**", "the page, governing only itself");
    a_task(&org, "t", &["src/**"]);

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("✓ passed");

    // Somebody else's commit, on the branch the run left behind it.
    commit_page(
        &worktree(&org, "doc-gate-widened", "t"),
        "src/**",
        "the page now claims the source too",
    );

    org.run(&["verify", "t"])
        .assert_ok("verify again")
        .assert_contains("✓ passed")
        .assert_lacks("did not move");
}

#[test]
fn a_subject_narrowed_after_the_run_cannot_excuse_it() {
    // The same freeze, seen from the side that matters more. Narrowing a `subject:` is one
    // of the two answers to a finding, and it is not a waiver — it is the page telling the
    // truth about what it governs, said *in the run's own diff*. Narrowed by a commit
    // outside the run, it says nothing about the run, and the finding stands.
    let (org, repo) = with_agent("doc-gate-narrowed", "echo '// evicts' >> src/cache.rs");
    commit_page(&repo, "src/**", "the page, governing the source");
    a_task(&org, "t", &["src/**"]);

    org.run(&["run", "t"])
        .assert_contains("docs/cache.md did not move with src/cache.rs");

    commit_page(
        &worktree(&org, "doc-gate-narrowed", "t"),
        "nothing/**",
        "the page gives the claim up",
    );

    org.run(&["verify", "t"])
        .assert_ok("verify again")
        .assert_contains("docs/cache.md did not move with src/cache.rs");
}
