//! What `company.toml` refuses, refused where the operator is standing.
//!
//! The unit tests in `wecode-org` cover each incoherence against a fixture file. What
//! needs the binary is that the refusal reaches a person at all: the file is loaded
//! before any command does anything, so a company that does not resolve has to fail the
//! next thing typed, with the line to edit named — not on the run that eventually trips
//! over it.

mod support;

use support::Org;

/// Adds a second `[[repos]]` block, the way an operator adds one: by hand, in the only
/// file that declares where code lives.
fn also_declaring(org: &Org, name: &str, path: &str) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[[repos]]\nname = \"{name}\"\npath = \"{path}\"\n"),
    )
    .unwrap();
}

#[test]
fn two_repos_under_one_name_are_refused_with_both_paths_named() {
    // The fault this catches is a rename left half-done: the old block stays, the new
    // one is added, and both answer to `app`. Nothing downstream can tell them apart —
    // a project owns a repository by name — so the work would be done in whichever was
    // typed first and the other path would read as configured forever.
    let org = Org::new("repo-name-clash", "solo");
    also_declaring(&org, "app", "~/projects/app-moved");

    let r = org.run(&["company", "show"]);
    assert!(!r.ok(), "a company that does not resolve must not load");
    r.assert_contains("two [[repos]] are named `app`")
        // Both paths, because the repair is choosing between them and the operator is
        // looking at a message rather than at the file.
        .assert_contains("~/projects/your-repo")
        .assert_contains("~/projects/app-moved");

    // And it is the file being refused, not one command's reading of it: defining work
    // against the name fails the same way, before anything is written down.
    let bad = org.run(&["project", "add", "v", "cache the export", "--repo", "app"]);
    assert!(!bad.ok(), "work must not be defined against it either");
    bad.assert_contains("two [[repos]] are named `app`");
}

#[test]
fn two_names_for_one_path_still_load() {
    // The neighbouring case, and legal: a monorepo two projects work in different parts
    // of, or one checkout reached under an old name and a new one. It resolves in the
    // direction anything actually asks — name to path — so there is nothing to refuse.
    let org = Org::new("repo-path-shared", "solo");
    also_declaring(&org, "web", "~/projects/your-repo");
    org.run(&["company", "show"])
        .assert_ok("two names over one path")
        .assert_contains("web");
}
