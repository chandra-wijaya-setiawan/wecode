//! Putting the executable a merge just produced where the operator can reach it.
//!
//! `wecode approve` can be answered from a phone. Nothing else can — `board`, `verify`,
//! `task add`, `audit`, `check` and `rollback` are reachable from one directory, through
//! `./wecode`, which is `cargo run`. So the operator's reach is a property of their
//! working directory, and the `wecode` they run is whatever their checkout happens to be
//! on. A stale binary that answers confidently is worse than no binary.
//!
//! The moment the code becomes the code is the merge: the only point in the lifecycle
//! where wecode already knows a sha it is willing to stand behind. So a merge that lands
//! on the integration branch builds what that repository produces from the merge commit
//! and moves it to a path the operator named — a step after landing, like
//! [`crate::teardown::after_landing`] and like [`crate::record::keep`], reported in the
//! report and unable to fail the merge.
//!
//! Four decisions, each with a cheaper alternative that is wrong.
//!
//! **The opt-in is a destination, in `company.toml`.** See [`wecode_org::Repo::installs`]
//! for why it cannot be in the playbook. Which repo is "wecode's own" is not inferred:
//! it is the one carrying `installs`. Comparing `current_exe()`'s ancestry against the
//! repo path would break precisely when the feature works — an installed wecode's
//! `current_exe` is `~/.local/bin/wecode`, under no repository at all — and detection
//! that fails on its own success is not detection.
//!
//! **It builds; it copies nothing that already exists.** Both artefacts lying around are
//! the wrong bytes. `current_exe()` is the wecode from *before* the merge, so installing
//! it would put yesterday's code on the `PATH` and name today's sha in the report. The
//! worktree's `target/debug` is the branch tip, which is not the merge result whenever
//! the target moved since the branch was cut — and that tree came down a step earlier.
//!
//! So it compiles the integration branch through [`git::tree_for`], with
//! `CARGO_TARGET_DIR` pointed at the repository's own `target/`. A scratch worktree has a
//! cold cache and a build from zero would cost minutes and gigabytes; sharing the cache
//! makes the usual install a link rather than a compile. cargo locks the target
//! directory, so a `cargo run` from the loop blocks and neither corrupts.
//!
//! This has a side effect worth more than the feature: it is the **first thing that ever
//! compiles the merge result.** Acceptance ran on the branch, pre-merge, and both sides
//! of a merge can pass with the merge still not building. When that happens the report
//! says the integration branch does not compile, which an operator wants to know more
//! urgently than they want a new binary.
//!
//! **Debug, the same profile the loop runs**, so the installed binary is usually the
//! byte-identical artefact the cache already holds. `cargo install --path …` is the
//! idiomatic line and is refused on three counts: it forces release, so the merge path
//! pays a full rebuild in a second target directory; it installs into cargo's prefix and
//! cargo's bookkeeping rather than the path the operator named; and release code is code
//! the loop has never run.
//!
//! **The write is a rename.** Copy to a temporary name in the destination's own
//! directory, `chmod 0755`, then rename over the destination. Writing in place gives
//! `ETXTBSY` exactly when the operator is running `wecode board`; a rename swaps a
//! directory entry and leaves the running process on its old inode. A crash mid-copy
//! leaves the previous binary intact rather than a truncated one. Same directory, because
//! rename across filesystems does not work.
//!
//! # No agent installs anything
//!
//! The destination is outside every write scope by construction, and a seat that could
//! write there could replace the supervisor's own executable — arbitrary code execution
//! as the process that enforces the Broker, which is the one hole that makes every other
//! check advisory. This feature is compatible with `never_touch` because the installer is
//! the supervisor acting after the work became evidence, never a task with a widened
//! scope.

use std::path::{Path, PathBuf};
use std::process::Command;

use wecode_org::workspace::expand_home;

use crate::git;

/// What became of the attempt to install.
///
/// Three outcomes, and two of them are *not installed*. They are kept apart because the
/// operator's next move differs: an absent `installs` wants nothing said at all, and a
/// decline wants the destination named, since the next thing they will do is look there
/// and find the binary they had before.
pub(crate) enum Installed {
    /// The repo names no destination. Absent is an answer.
    Unasked,
    /// Built from `sha` and moved into place.
    Done {
        /// The destination as `company.toml` writes it, `~` and all. What the operator
        /// typed is what they can search their own file for.
        dest: String,
        sha: String,
        /// The directory to put on `PATH`, when a shell would not find the binary there.
        ///
        /// Absolute rather than as written: this goes into a shell line, and a `~` inside
        /// double quotes is a directory called `~`.
        add: Option<PathBuf>,
    },
    /// Nothing was installed, and the destination still holds whatever it held.
    Declined { dest: String, why: String },
}

/// Builds the integration branch and installs what it produced, if a destination was
/// named.
///
/// Never a `Result`, for the reason [`crate::record::keep`] never returns one: by the time
/// this runs the merge has landed, there is nothing left to undo, and telling an operator
/// their merge failed when it did not is the lie neither of them may tell. Every refusal
/// below is a line in the report.
///
/// `dest` is the `Option` itself rather than an unwrapped path, so the call site is one
/// unconditional statement — a repo that named no destination says nothing about one, and
/// there is no `if` for a later reader to hang another condition off.
pub(crate) fn after_landing(
    repo: &Path,
    scratch: &Path,
    target: &str,
    dest: Option<&str>,
    sha: &str,
) -> Installed {
    let Some(written) = dest else {
        return Installed::Unasked;
    };
    let sha = sha.chars().take(9).collect::<String>();
    let path = expand_home(written);
    let declined = |why: String| Installed::Declined {
        dest: written.to_string(),
        why,
    };

    let (dir, bin) = match (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        (Some(dir), Some(bin)) if !bin.is_empty() => (dir.to_path_buf(), bin.to_string()),
        _ => return declined(format!("{written} does not name a file to install")),
    };
    if let Err(why) = destination(&dir, &path, written) {
        return declined(why);
    }

    // The same tree the merge and the record used, dirty-tree refusal included: a build
    // of the merge result must not happen in a tree the merge itself would have refused.
    let (tree, borrowed) = match git::tree_for(repo, scratch, target) {
        Ok(t) => t,
        Err(e) => return declined(e.to_string()),
    };
    let built = build(&tree, repo, &bin, target, &sha);
    // A scratch tree goes either way, like every other borrower of it. A borrowed one is
    // the operator's and stays.
    if !borrowed {
        let _ = git::worktree_remove(repo, scratch);
    }

    match built.and_then(|artefact| place(&artefact, &path, &bin)) {
        Err(why) => declined(why),
        Ok(()) => Installed::Done {
            dest: written.to_string(),
            sha,
            // Installed anyway. Whether a shell finds it is the shell's business, and a
            // refusal here would leave the operator with neither the binary nor a way to
            // test the path.
            add: (!on_path(&dir)).then_some(dir),
        },
    }
}

/// Why this destination may not be written, if it may not.
///
/// Three refusals, and all three are *more than was asked*. Creating directories in
/// someone's home is a decision they did not delegate; renaming over a symlink replaces
/// the link rather than the file they think they installed; and a directory there means
/// the path means something other than what this would do to it.
fn destination(dir: &Path, path: &Path, written: &str) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!(
            "{} does not exist — create it, or name a destination in a directory that does",
            dir.display()
        ));
    }
    // `symlink_metadata`, not `metadata`: the question is what the directory entry *is*,
    // and following the link would answer about its target instead.
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        // Nothing there. The ordinary first install.
        return Ok(());
    };
    if meta.file_type().is_symlink() {
        return Err(format!(
            "{written} is a symlink — renaming over it would replace the link rather \
             than the file it points at"
        ));
    }
    if meta.is_dir() {
        return Err(format!("{written} is a directory, not a file to replace"));
    }
    Ok(())
}

/// Compiles `bin` from the integration branch, and answers with the artefact.
///
/// `--bin <name>` where the name is the destination's own file name, so this module names
/// no package and no repository. The consequence is worth stating: renaming the
/// destination renames the target cargo is asked for, and cargo says so.
///
/// The build's output streams to wecode's own streams rather than being captured. A
/// compile error on the integration branch is the most valuable thing this function can
/// produce, and no line written here could summarise it better than rustc already did.
fn build(tree: &Path, repo: &Path, bin: &str, target: &str, sha: &str) -> Result<PathBuf, String> {
    // The repository's own, never the scratch tree's: a cold cache here would cost the
    // merge path the full build this feature is only affordable without.
    let out = repo.join("target");
    let ran = Command::new("cargo")
        .args(["build", "--bin", bin])
        .current_dir(tree)
        .env("CARGO_TARGET_DIR", &out)
        .status();
    match ran {
        // No exit code to read, so this is the loudest of them: nothing was compiled and
        // nothing said why.
        Err(e) => Err(format!("cargo never ran — {e}")),
        Ok(s) if !s.success() => Err(format!(
            "cargo build --bin {bin} failed ({}) on {sha} — `{target}` does not compile",
            s.code()
                .map_or_else(|| "killed".to_string(), |c| format!("exit {c}"))
        )),
        Ok(_) => {
            let artefact = out.join("debug").join(bin);
            if artefact.is_file() {
                Ok(artefact)
            } else {
                Err(format!(
                    "cargo build --bin {bin} succeeded and {} is not there",
                    artefact.display()
                ))
            }
        }
    }
}

/// Copies the artefact beside the destination, makes it executable, and renames it over.
///
/// The temporary name is in the destination's *own* directory because rename across
/// filesystems does not work, and the whole value of this function is that the last step
/// is one atomic rename: the operator either has the old binary or the new one, never a
/// half-written file, and a `wecode board` running from that path keeps its own inode.
fn place(artefact: &Path, dest: &Path, bin: &str) -> Result<(), String> {
    let tmp = dest.with_file_name(format!(".{bin}.wecode-new"));
    let failed = |what: &str, e: std::io::Error| {
        let _ = std::fs::remove_file(&tmp);
        format!("{what} — {e}")
    };
    std::fs::copy(artefact, &tmp).map_err(|e| failed("could not copy the binary", e))?;
    // Before the rename, so nothing is ever visible at the destination without its
    // executable bit. `fs::copy` carries the mode over on Unix, but the artefact's mode
    // is cargo's business and this one is a promise.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| failed("could not make it executable", e))?;
    std::fs::rename(&tmp, dest).map_err(|e| failed("could not move it into place", e))
}

/// Whether a shell would find a binary in `dir`.
///
/// wecode's own `PATH`, which is the only one it can read — the operator's interactive
/// shell may differ, and this is why the report says the line rather than claiming the
/// binary is unreachable. Canonicalised on both sides so a trailing slash or a symlinked
/// home does not read as a different directory.
fn on_path(dir: &Path) -> bool {
    let real = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let want = real(dir);
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).any(|d| real(&d) == want)
}

/// The one line a merge says about the binary it installed.
///
/// In the summary rather than a section of its own, beside the other fact a merge creates
/// about the machine it ran on. `wecode install` prints this same line from this same
/// function: the escape hatch after a decline must not be a second account of what
/// happened.
///
/// Nothing at all when no destination was named, for the reason
/// [`crate::teardown::teardown_line`] says nothing about a worktree that never existed.
#[must_use]
pub(crate) fn install_line(i: &Installed) -> String {
    match i {
        Installed::Unasked => String::new(),
        Installed::Done { dest, sha, add } => {
            let mut out = format!("  install    {dest} ← {sha} (debug)\n");
            if let Some(dir) = add {
                out.push_str(&format!(
                    "             not on PATH — export PATH=\"{}:$PATH\"\n",
                    dir.display()
                ));
            }
            out
        }
        // Named by destination, because the operator's next move is to look there and
        // find the old binary. And the retry is named, because *which* retry matters:
        // re-merging is the one response that makes things worse — git counts the branch
        // merged and the second attempt lands nothing.
        Installed::Declined { dest, why } => format!(
            "  install    not installed to {dest}\n             {why}\n             \
             the merge stands — retry with `wecode install`, never by merging again\n"
        ),
    }
}

/// The same decline as an error, for the caller an operator typed.
///
/// `wecode install` has to exit non-zero when nothing was installed, and a merge must
/// not — so the frame differs and the sentence does not. `why` is written once, where the
/// refusal happened, which is what keeps the report and the refusal from drifting the way
/// two renderers would. No retry line: whoever reads this just typed it.
#[must_use]
pub(crate) fn refusal(i: &Installed) -> Option<String> {
    match i {
        Installed::Declined { dest, why } => Some(format!(
            "nothing was installed to {dest}\n  {why}\n  \
             the destination still holds what it held before"
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory for a destination to live in.
    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wecode-install-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    #[test]
    fn a_repo_that_named_no_destination_installs_nothing_and_says_nothing() {
        // Absent is an answer, and a line about a destination nobody named is noise.
        let nothing = after_landing(
            Path::new("/run/cws/repo"),
            Path::new("/run/cws/.merge"),
            "master",
            None,
            "4e5f6a70f",
        );
        assert!(matches!(nothing, Installed::Unasked));
        assert_eq!(install_line(&nothing), "");
        assert!(refusal(&nothing).is_none());
    }

    #[test]
    fn a_destination_whose_directory_is_not_there_declines_before_anything_is_built() {
        // Creating directories in someone's home is more than was asked — and this has to
        // be answered before the build, which is the expensive half.
        let out = after_landing(
            Path::new("/run/cws/repo"),
            Path::new("/run/cws/.merge"),
            "master",
            Some("/run/cws/nowhere/bin/wecode"),
            "4e5f6a70f",
        );
        let line = install_line(&out);
        assert!(
            line.contains("not installed to /run/cws/nowhere/bin/wecode"),
            "{line}"
        );
        assert!(line.contains("/run/cws/nowhere/bin does not exist"), "{line}");
        // The report names the retry that works, and never the one that makes it worse.
        assert!(line.contains("retry with `wecode install`"), "{line}");
        // And the typed caller gets the same sentence with a non-zero exit around it, and
        // no advice to run what they just ran.
        let refused = refusal(&out).expect("a decline");
        assert!(refused.contains("/run/cws/nowhere/bin does not exist"), "{refused}");
        assert!(!refused.contains("wecode install"), "{refused}");
    }

    #[test]
    fn a_symlink_at_the_destination_is_named_rather_than_replaced() {
        // Renaming over a link replaces the link, not the file the operator thinks they
        // installed — so the one thing they would not notice is the one thing refused.
        let home = dir("symlink");
        let real = home.join("elsewhere");
        std::fs::write(&real, "the real one").expect("a file to point at");
        let dest = home.join("wecode");
        std::os::unix::fs::symlink(&real, &dest).expect("a link");

        let why = destination(&home, &dest, "~/.local/bin/wecode").unwrap_err();
        assert!(why.contains("is a symlink"), "{why}");
        assert!(why.contains("replace the link"), "{why}");
    }

    #[test]
    fn a_directory_at_the_destination_is_not_something_to_rename_over() {
        let home = dir("isdir");
        let dest = home.join("wecode");
        std::fs::create_dir(&dest).expect("a directory in the way");
        let why = destination(&home, &dest, "~/bin/wecode").unwrap_err();
        assert!(why.contains("is a directory"), "{why}");
    }

    #[test]
    fn an_empty_destination_and_a_free_one_are_told_apart() {
        let home = dir("free");
        // Nothing there is the ordinary first install.
        assert!(destination(&home, &home.join("wecode"), "~/bin/wecode").is_ok());
        // A plain file there is what every install after the first replaces.
        let dest = home.join("wecode");
        std::fs::write(&dest, "the previous binary").expect("a previous install");
        assert!(destination(&home, &dest, "~/bin/wecode").is_ok());
    }

    #[test]
    fn the_write_is_a_rename_and_the_result_is_executable() {
        use std::os::unix::fs::PermissionsExt;
        let home = dir("rename");
        let artefact = home.join("built");
        std::fs::write(&artefact, "new bytes").expect("something to install");
        let dest = home.join("wecode");
        std::fs::write(&dest, "old bytes").expect("a previous install");

        place(&artefact, &dest, "wecode").expect("the install lands");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new bytes");
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755, "0o{mode:o}");
        // Nothing left beside it: the temporary name is a step, not an artefact.
        assert!(!home.join(".wecode.wecode-new").exists());
    }

    #[test]
    fn a_copy_that_could_not_happen_leaves_the_previous_binary_alone() {
        // The whole reason for copying to a temporary name first. A truncated wecode on
        // the PATH is worse than yesterday's wecode on the PATH.
        let home = dir("kept");
        let dest = home.join("wecode");
        std::fs::write(&dest, "old bytes").expect("a previous install");
        let why = place(&home.join("never-built"), &dest, "wecode").unwrap_err();
        assert!(why.starts_with("could not copy the binary"), "{why}");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old bytes");
        assert!(!home.join(".wecode.wecode-new").exists(), "and no leftovers");
    }

    #[test]
    fn a_merge_says_what_it_installed_and_from_which_sha() {
        let line = install_line(&Installed::Done {
            dest: "~/.local/bin/wecode".into(),
            sha: "4e5f6a70f".into(),
            add: None,
        });
        assert_eq!(line, "  install    ~/.local/bin/wecode ← 4e5f6a70f (debug)\n");
    }

    #[test]
    fn a_binary_a_shell_would_not_find_is_installed_and_says_so() {
        // The install worked; whether a shell finds it is the shell's business. Refusing
        // would leave the operator with neither the binary nor a way to test the path.
        let line = install_line(&Installed::Done {
            dest: "~/.local/bin/wecode".into(),
            sha: "4e5f6a70f".into(),
            add: Some(PathBuf::from("/home/cws/.local/bin")),
        });
        assert!(line.contains("← 4e5f6a70f (debug)"), "{line}");
        assert!(
            line.contains("export PATH=\"/home/cws/.local/bin:$PATH\""),
            "the line to add, not a complaint: {line}"
        );
    }

    #[test]
    fn a_merge_result_that_does_not_compile_is_the_report_worth_more_than_the_binary() {
        // Acceptance ran on the branch, pre-merge. Both sides can pass and the merge
        // still not build, and this is the first thing that ever compiles it.
        let why = build(
            Path::new("/run/cws/no-such-tree"),
            Path::new("/run/cws/repo"),
            "wecode",
            "master",
            "4e5f6a70f",
        )
        .unwrap_err();
        assert!(why.contains("4e5f6a70f") || why.contains("cargo never ran"), "{why}");

        let line = install_line(&Installed::Declined {
            dest: "~/.local/bin/wecode".into(),
            why: "cargo build --bin wecode failed (exit 101) on 4e5f6a70f — \
                  `master` does not compile"
                .into(),
        });
        assert!(line.contains("not installed to ~/.local/bin/wecode"), "{line}");
        assert!(line.contains("`master` does not compile"), "{line}");
    }

    #[test]
    fn the_directory_wecode_itself_runs_from_is_on_its_own_path() {
        // A property of every machine this runs on, and the only way to exercise the
        // canonicalisation without writing to the ambient environment.
        let first = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .find(|d| d.is_dir());
        if let Some(d) = first {
            assert!(on_path(&d), "{}", d.display());
            // A trailing slash is the same directory.
            assert!(on_path(&d.join("")), "{}", d.display());
        }
        assert!(!on_path(Path::new("/run/cws/definitely-not-on-path")));
    }
}
