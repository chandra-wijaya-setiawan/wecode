//! git as a subprocess.
//!
//! A subprocess rather than libgit2, as the architecture already specifies. It also
//! keeps `core`, `gov`, `org` and `store` pure — this is the only module in the tree
//! that executes anything, and it lives in the binary crate for that reason.
//!
//! Every call is explicit about its repository via `-C`, so nothing here depends on
//! the process's working directory.

use std::fmt;
use std::path::Path;
use std::process::Command;

#[derive(Debug)]
pub(crate) enum GitError {
    /// git ran and refused. `stderr` is the only useful part.
    Failed { argv: String, stderr: String },
    /// git could not be started at all.
    Unavailable(std::io::Error),
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed { argv, stderr } => {
                write!(f, "git {argv} failed: {}", stderr.trim())
            }
            Self::Unavailable(e) => write!(f, "cannot run git: {e}"),
        }
    }
}

impl std::error::Error for GitError {}

/// Runs git in `repo` and returns trimmed stdout.
fn git(repo: &Path, args: &[&str]) -> Result<String, GitError> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(GitError::Unavailable)?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(GitError::Failed {
            argv: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

/// Whether `path` is inside a git working tree.
pub(crate) fn is_repo(repo: &Path) -> bool {
    git(repo, &["rev-parse", "--git-dir"]).is_ok()
}

/// The branch currently checked out, or `None` on a detached head.
pub(crate) fn current_branch(repo: &Path) -> Result<Option<String>, GitError> {
    let name = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    Ok((name != "HEAD").then_some(name))
}

pub(crate) fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}

/// Adds a worktree for `branch`, creating the branch at `base` if it does not exist.
///
/// Splitting on `branch_exists` matters: `git worktree add -b` fails outright if the
/// branch is already there, which is exactly the case when a task is picked back up.
pub(crate) fn worktree_add(
    repo: &Path,
    path: &Path,
    branch: &str,
    base: Option<&str>,
) -> Result<(), GitError> {
    let dir = path.to_string_lossy().into_owned();
    if branch_exists(repo, branch) {
        git(repo, &["worktree", "add", &dir, branch])?;
    } else {
        let mut args = vec!["worktree", "add", "-b", branch, &dir];
        if let Some(b) = base {
            args.push(b);
        }
        git(repo, &args)?;
    }
    Ok(())
}

/// Discards everything uncommitted in a worktree, so a retry starts clean.
pub(crate) fn reset_hard(worktree: &Path) -> Result<(), GitError> {
    git(worktree, &["reset", "--hard"])?;
    git(worktree, &["clean", "-fd"])?;
    Ok(())
}

/// Removes a worktree and prunes the administrative entry.
///
/// The prune is not optional. Without it a stale entry survives in
/// `.git/worktrees/`, git keeps treating the branch as checked out, and deleting that
/// branch then fails for no visible reason.
pub(crate) fn worktree_remove(repo: &Path, path: &Path) -> Result<(), GitError> {
    let dir = path.to_string_lossy().into_owned();
    let removed = git(repo, &["worktree", "remove", "--force", &dir]);
    // Prune regardless: the directory may already have been deleted by hand, which is
    // precisely the case that leaves a stale entry behind.
    git(repo, &["worktree", "prune"])?;
    removed.map(|_| ())
}

/// Registered worktree paths, main tree excluded.
pub(crate) fn worktree_list(repo: &Path) -> Result<Vec<String>, GitError> {
    let out = git(repo, &["worktree", "list", "--porcelain"])?;
    let main = git(repo, &["rev-parse", "--show-toplevel"]).unwrap_or_default();
    Ok(out
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .map(str::to_string)
        .filter(|p| *p != main)
        .collect())
}

/// Paths changed in a worktree against its branch point — uncommitted work included.
pub(crate) fn changed_files(worktree: &Path) -> Result<Vec<String>, GitError> {
    let tracked = git(worktree, &["diff", "--name-only", "HEAD"])?;
    let untracked = git(worktree, &["ls-files", "--others", "--exclude-standard"])?;
    let mut all: Vec<String> = tracked
        .lines()
        .chain(untracked.lines())
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    all.sort();
    all.dedup();
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A real repository. git is a subprocess, so faking it would test nothing.
    fn repo(name: &str) -> PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-git-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        git(&dir, &["config", "user.email", "t@t"]).unwrap();
        git(&dir, &["config", "user.name", "t"]).unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(&dir, &["commit", "-qm", "first"]).unwrap();
        dir
    }

    #[test]
    fn a_fresh_repo_reports_its_branch() {
        let r = repo("branch");
        assert!(is_repo(&r));
        assert_eq!(current_branch(&r).unwrap().as_deref(), Some("main"));
        assert!(branch_exists(&r, "main"));
        assert!(!branch_exists(&r, "nope"));
    }

    #[test]
    fn a_directory_that_is_not_a_repo_says_so() {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join("wecode-git-notrepo");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(!is_repo(&dir));
    }

    #[test]
    fn adding_a_worktree_creates_the_branch_and_the_directory() {
        let r = repo("add");
        let wt = r.parent().unwrap().join("wecode-git-add-wt");
        let _ = fs::remove_dir_all(&wt);

        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();
        assert!(wt.join("a.txt").is_file());
        assert!(branch_exists(&r, "wecode/t1"));
        assert_eq!(worktree_list(&r).unwrap().len(), 1);
    }

    #[test]
    fn a_worktree_can_be_re_added_for_an_existing_branch() {
        // The retry path: `worktree add -b` would fail here, so the branch must be
        // reused rather than recreated.
        let r = repo("readd");
        let wt = r.parent().unwrap().join("wecode-git-readd-wt");
        let _ = fs::remove_dir_all(&wt);

        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();
        worktree_remove(&r, &wt).unwrap();
        worktree_add(&r, &wt, "wecode/t1", Some("main")).expect("branch already exists");
        assert!(wt.join("a.txt").is_file());
    }

    #[test]
    fn removing_a_worktree_leaves_the_branch_deletable() {
        // The whole reason `worktree_remove` prunes: a stale entry blocks this.
        let r = repo("remove");
        let wt = r.parent().unwrap().join("wecode-git-remove-wt");
        let _ = fs::remove_dir_all(&wt);

        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();
        worktree_remove(&r, &wt).unwrap();

        assert!(worktree_list(&r).unwrap().is_empty());
        git(&r, &["branch", "-D", "wecode/t1"]).expect("branch must be deletable");
    }

    #[test]
    fn a_hand_deleted_worktree_is_still_pruned() {
        let r = repo("handdel");
        let wt = r.parent().unwrap().join("wecode-git-handdel-wt");
        let _ = fs::remove_dir_all(&wt);

        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();
        fs::remove_dir_all(&wt).unwrap();
        // `worktree remove` fails on a missing directory; the prune must still run.
        let _ = worktree_remove(&r, &wt);
        assert!(worktree_list(&r).unwrap().is_empty());
        git(&r, &["branch", "-D", "wecode/t1"]).expect("branch must be deletable");
    }

    #[test]
    fn reset_discards_uncommitted_work() {
        let r = repo("reset");
        let wt = r.parent().unwrap().join("wecode-git-reset-wt");
        let _ = fs::remove_dir_all(&wt);
        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();

        fs::write(wt.join("a.txt"), "changed\n").unwrap();
        fs::write(wt.join("new.txt"), "junk\n").unwrap();
        assert_eq!(changed_files(&wt).unwrap(), vec!["a.txt", "new.txt"]);

        reset_hard(&wt).unwrap();
        assert!(changed_files(&wt).unwrap().is_empty());
        assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "one\n");
    }

    #[test]
    fn changed_files_sees_tracked_edits_and_new_files() {
        let r = repo("changed");
        fs::write(r.join("a.txt"), "edited\n").unwrap();
        fs::write(r.join("b.txt"), "added\n").unwrap();
        assert_eq!(changed_files(&r).unwrap(), vec!["a.txt", "b.txt"]);
    }

    #[test]
    fn a_failure_carries_the_stderr_git_printed() {
        let r = repo("err");
        let msg = git(&r, &["checkout", "no-such-branch"])
            .unwrap_err()
            .to_string();
        assert!(msg.contains("checkout"), "{msg}");
        assert!(msg.to_lowercase().contains("no-such-branch"), "{msg}");
    }
}
