//! Putting the executable a merge just produced where the operator can reach it.
//!
//! The unit tests inside `install.rs` cover each refusal in isolation; what needs the
//! whole pipeline is the wiring — that a merge with `installs` named actually builds
//! the merge result and moves it into place, that a decline is a line in a report the
//! merge still commits, and that `wecode install` is the same step run by hand.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use support::merge::{landed_task, mergeable};
use support::playbook::with_playbook;
use support::{Org, git, git_out};

/// Names where the `app` repo's executable goes, in the one file that may say so.
///
/// Edited the way an operator edits it — a line in the `[[repos]]` block — rather than
/// through any command, because no command exists on purpose: the destination is an
/// authority to write outside every repository, and only a hand-edited file carries it.
fn installs_to(org: &Org, dest: &Path) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let replaced = text.replace(
        "name = \"app\"\n",
        &format!("name = \"app\"\ninstalls = \"{}\"\n", dest.display()),
    );
    assert_ne!(replaced, text, "the app repo block was not found");
    std::fs::write(&conf, replaced).unwrap();
}

/// Turns the fixture repo into a crate that produces a binary called `app`, on both
/// `main` and `dev` — the integration branch has to carry the crate, because the
/// integration branch is what gets built.
fn producing(repo: &Path, main_rs: &str) {
    std::fs::write(
        repo.join("Cargo.toml"),
        "[package]\nname = \"app\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[workspace]\n",
    )
    .unwrap();
    std::fs::write(repo.join("src/main.rs"), main_rs).unwrap();
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-qm", "the repo produces an executable"]);
    git(repo, &["branch", "-f", "dev"]);
}

/// A mergeable workspace whose repo builds a real binary and names a real destination.
fn installable(name: &str) -> (Org, PathBuf, PathBuf) {
    let (org, repo) = mergeable(name, "auto");
    producing(&repo, "fn main() { println!(\"made by the merge\"); }\n");
    std::fs::create_dir_all(org.path("bin")).unwrap();
    let dest = org.path("bin/app");
    installs_to(&org, &dest);
    (org, repo, dest)
}

/// What the installed binary says when run — the only proof the bytes are real.
fn runs(dest: &Path) -> String {
    let out = Command::new(dest).output().expect("the installed binary runs");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

// ------------------------------------------------------------ after a merge ------

#[test]
fn a_merge_that_landed_installs_what_the_repository_produces() {
    let (org, repo, dest) = installable("install-merge");
    landed_task(&org, "t");

    let r = org.run(&["merge", "t"]);
    r.assert_ok("merge")
        .assert_contains("MERGED  t → dev")
        .assert_contains(&format!("install    {} ← ", dest.display()))
        .assert_contains("(debug)")
        // Installed anyway, with the line to add: whether a shell finds it is the
        // shell's business, and a refusal would leave the operator with neither the
        // binary nor a way to test the path.
        .assert_contains("export PATH=\"");

    // Built from the merge commit — the sha in the line is the merge's, not the
    // branch tip's and not whatever wecode itself was compiled from.
    let merge_sha = git_out(&repo, &["rev-parse", "dev~1"]);
    r.assert_contains(&format!("← {}", &merge_sha[..9]));

    // The binary is really there, really executable, and really the merged code.
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o755, "0o{mode:o}");
    assert!(runs(&dest).contains("made by the merge"));
    // The temporary name is a step, not an artefact.
    assert!(!org.path("bin/.app.wecode-new").exists());

    // And the committed report carries the same line: the file *is* the report.
    let file = git_out(&repo, &["show", "dev:docs/wecode/t/report.md"]);
    assert!(
        file.contains(&format!("install    {} ← ", dest.display())),
        "{file}"
    );
}

#[test]
fn an_install_that_declines_cannot_fail_the_merge_and_names_the_retry() {
    // The destination's directory does not exist, and creating directories in
    // someone's home is more than was asked. The merge has already landed by the time
    // this is known, so the only honest outcome is a merge that stands and says so.
    let (org, repo) = mergeable("install-retry", "auto");
    producing(&repo, "fn main() { println!(\"made by the merge\"); }\n");
    let dest = org.path("nowhere/bin/app");
    installs_to(&org, &dest);
    landed_task(&org, "t");

    org.run(&["merge", "t"])
        .assert_ok("a decline is a line, never a failed merge")
        .assert_contains("MERGED  t → dev")
        .assert_contains(&format!("not installed to {}", dest.display()))
        .assert_contains("does not exist")
        // Which retry matters: re-merging is the one response that makes it worse.
        .assert_contains("retry with `wecode install`, never by merging again");
    assert!(!dest.exists(), "nothing may appear at a declined destination");

    // The decline is on the record, where the operator a week later reads it.
    let file = git_out(&repo, &["show", "dev:docs/wecode/t/report.md"]);
    assert!(file.contains("not installed to"), "{file}");

    // The named retry works: fix what was refused, run the command the report gave.
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    org.run(&["install"])
        .assert_ok("the retry")
        .assert_contains(&format!("install    {} ← ", dest.display()));
    assert!(runs(&dest).contains("made by the merge"));
}

#[test]
fn a_merge_result_that_does_not_compile_is_reported_rather_than_installed() {
    // Acceptance ran on the branch, pre-merge; both sides of a merge can pass with the
    // merge result still not building. This step is the first thing that ever compiles
    // it, and when that fails the report matters more than the binary.
    let (org, _repo) = mergeable("install-broken", "auto");
    producing(&_repo, "fn main() { this does not compile }\n");
    std::fs::create_dir_all(org.path("bin")).unwrap();
    let dest = org.path("bin/app");
    std::fs::write(&dest, "the old binary").unwrap();
    installs_to(&org, &dest);
    landed_task(&org, "t");

    org.run(&["merge", "t"])
        .assert_ok("the merge stands")
        .assert_contains("MERGED  t → dev")
        .assert_contains(&format!("not installed to {}", dest.display()))
        .assert_contains("`dev` does not compile");
    org.run(&["show", "t"]).assert_contains("status     done");

    // The destination still holds what it held: yesterday's binary, not a broken one.
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "the old binary");
}

#[test]
fn a_repo_that_names_no_destination_hears_nothing_about_installs() {
    // Absent is an answer. A merge without `installs` must not say a word about it —
    // a line about a destination nobody named is noise in every report forever.
    let (org, _) = mergeable("merge-no-dest", "auto");
    landed_task(&org, "t");
    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_lacks("install    ")
        .assert_lacks("not installed");
}

// ------------------------------------------------------------ wecode install ------

#[test]
fn the_first_install_needs_no_merge() {
    // Bootstrapping reach out of a merge you must already be at a terminal to run is
    // circular, so `wecode install` builds the integration branch as it stands.
    let (org, _repo, dest) = installable("install-bootstrap");

    org.run(&["install"])
        .assert_ok("install")
        .assert_contains(&format!("install    {} ← ", dest.display()))
        .assert_contains("(debug)");
    assert!(runs(&dest).contains("made by the merge"));
}

#[test]
fn an_install_that_was_typed_exits_nonzero_when_nothing_was_installed() {
    // The merge path may only report; the typed path is scripted against, so it owes
    // an exit code — and no advice to run the command that was just run.
    let (org, repo) = mergeable("install-typed-decline", "auto");
    producing(&repo, "fn main() {}\n");
    let dest = org.path("nowhere/app");
    installs_to(&org, &dest);

    let r = org.run(&["install"]);
    assert!(!r.ok(), "nothing was installed, so the exit says so");
    r.assert_contains(&format!("nothing was installed to {}", dest.display()))
        .assert_contains("still holds what it held before")
        .assert_lacks("wecode install");
}

#[test]
fn installing_needs_a_destination_and_says_which_file_names_one() {
    let (org, _) = mergeable("install-unnamed", "auto");

    // No repo opts in: the answer is where the opt-in lives, not a guess.
    let r = org.run(&["install"]);
    assert!(!r.ok());
    r.assert_contains("no [[repos]] block names an `installs` destination");

    // A repo the company does not have.
    let r = org.run(&["install", "--repo", "ghost"]);
    assert!(!r.ok());
    r.assert_contains("no repo `ghost`").assert_contains("have: app");

    // Named explicitly and still declined: the destination *is* the opt-in, and
    // installing somewhere this file does not say would be wecode choosing a path in
    // the operator's home.
    let r = org.run(&["install", "--repo", "app"]);
    assert!(!r.ok());
    r.assert_contains("repo `app` names no destination")
        .assert_contains("installs = \"~/.local/bin/app\"");
}

#[test]
fn two_installing_repos_are_refused_until_one_is_named() {
    let (org, _) = mergeable("install-two-repos", "auto");
    installs_to(&org, &org.path("nowhere/app"));
    let conf = org.path("company.toml");
    let mut text = std::fs::read_to_string(&conf).unwrap();
    text.push_str(
        "\n[[repos]]\nname = \"tools\"\npath = \"~/projects/tools\"\n\
         installs = \"~/.local/bin/tools\"\n",
    );
    std::fs::write(&conf, text).unwrap();

    // Guessing would make which binary the operator has depend on file order.
    let r = org.run(&["install"]);
    assert!(!r.ok());
    r.assert_contains("several repos install an executable")
        .assert_contains("--repo: app, tools");

    // Naming one selects it: what declines next is app's own destination.
    let r = org.run(&["install", "--repo", "app"]);
    assert!(!r.ok());
    r.assert_contains("nothing was installed to")
        .assert_contains("nowhere");
}

#[test]
fn a_repo_whose_projects_name_no_integration_branch_is_refused() {
    // Installing from anything but `merge_to` would put code on the operator's PATH
    // that no merge ever landed — and the shared playbook deliberately has none.
    let (org, _repo) = with_playbook("install-no-merge-to");
    installs_to(&org, &org.path("bin/app"));

    let r = org.run(&["install"]);
    assert!(!r.ok());
    r.assert_contains("declares `merge_to`");
}

#[test]
fn an_integration_branch_git_does_not_know_is_one_sentence_not_a_cargo_failure() {
    // The playbook says `dev`; git has never heard of it. Resolved before the build,
    // so the answer is a sentence about the branch rather than a compile error.
    let (org, repo) = mergeable("install-no-branch", "auto");
    installs_to(&org, &org.path("bin/app"));
    git(&repo, &["branch", "-D", "dev"]);

    let r = org.run(&["install"]);
    assert!(!r.ok());
    r.assert_contains("nothing to install from");
}
