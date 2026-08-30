//! git as a subprocess.
//!
//! A subprocess rather than libgit2, as the architecture already specifies. It also
//! keeps `core`, `gov`, `org` and `store` pure — this is the only module in the tree
//! that executes anything, and it lives in the binary crate for that reason.
//!
//! Every call is explicit about its repository via `-C`, so nothing here depends on
//! the process's working directory.

use std::fmt;
use std::path::{Path, PathBuf};
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

/// The commit `rev` names, or `None` when git can resolve none.
///
/// `^{commit}` rather than a bare `rev-parse`: an annotated tag answers with the commit
/// it points at rather than the tag object, and a name git knows nothing about answers
/// `None` instead of failing. Both are what a caller about to cut a branch there is
/// actually asking — and the second is why the answer is an `Option` and not an error,
/// since "no such revision" is a sentence for the operator, not a git failure to relay.
pub(crate) fn commit_at(repo: &Path, rev: &str) -> Option<String> {
    let sha = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )
    .ok()?;
    (!sha.is_empty()).then_some(sha)
}

/// Creates `branch` at `base`, checking it out nowhere.
///
/// A branch without a tree, because the two are settled at different moments: where a
/// task's work starts is a planning decision, and the tree to do it in is cut when the
/// task is dispatched. [`worktree_add`] below already reuses a branch that is standing
/// and ignores the base it was handed, so a ref put here is the one preparation finds —
/// which is how a task gets a base of its own without the project-wide integration
/// branch stopping being the answer for every task that named none.
pub(crate) fn branch_at(repo: &Path, branch: &str, base: &str) -> Result<(), GitError> {
    git(repo, &["branch", branch, base])?;
    Ok(())
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

/// Every file git is tracking, relative to the top of the repository.
///
/// The index rather than a directory walk, which is what makes this cheap enough to do
/// on the way to dispatching a task: a walk descends into `target/` and `node_modules/`,
/// and would have to be taught what to ignore — a thing git already knows and is asked
/// here instead. See [`crate::map`] for what reads it.
///
/// `-z` because a path may contain anything a file name may, newlines included, and the
/// default quoting would hand back a name no reader could open. `--full-name` so the
/// answer does not depend on how far down the tree `repo` points.
pub(crate) fn tracked_files(repo: &Path) -> Result<Vec<String>, GitError> {
    let out = git(repo, &["ls-files", "-z", "--full-name"])?;
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}

/// Every tracked file with the object id git holds its content under.
///
/// The id is the cache key the codemap is built on, and it is worth being exact about
/// what it names: it is the hash of the content **in the index**, which is the content
/// on disk for every file nobody has edited since. A hash names its own content, so an
/// entry keyed on one can never be stale — it is collected, never invalidated. See
/// [`dirty_files`] for the other half of that guarantee.
///
/// `-s` puts the mode, the id and the stage before a tab and the path; `-z` keeps a path
/// containing a newline readable, as in [`tracked_files`].
pub(crate) fn tracked_blobs(repo: &Path) -> Result<Vec<(String, String)>, GitError> {
    let out = git(repo, &["ls-files", "-s", "-z", "--full-name"])?;
    Ok(out
        .split('\0')
        .filter(|e| !e.is_empty())
        .filter_map(|entry| {
            let (meta, path) = entry.split_once('\t')?;
            let oid = meta.split_whitespace().nth(1)?;
            Some((oid.to_string(), path.to_string()))
        })
        .collect())
}

/// Tracked files whose content on disk is not what the index says it is.
///
/// The exception the content-hash key needs. A file edited and not staged has an index
/// id that names the *old* bytes, so an entry stored under it would answer a later scan
/// with tags from a file that no longer exists — the one way a content-addressed cache
/// can lie. Those files are parsed every scan and cached under nothing, which is right:
/// a tree being edited is exactly the tree whose map has to be current.
pub(crate) fn dirty_files(repo: &Path) -> Result<Vec<String>, GitError> {
    let out = git(repo, &["diff", "--name-only", "-z"])?;
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
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

/// The note a verdict leaves for the commit that follows it: one refused path per line.
///
/// It lives in the tree's git metadata rather than in the tree. A note about what may
/// not be committed would otherwise be a file that could be — and `.wecode/run/` is the
/// worker's own area, which is the last place to keep a list the worker must not set.
const REFUSED: &str = "wecode-refused";

/// Where one worktree keeps its own git metadata.
///
/// Per worktree, not per repository. Linked worktrees share `refs/` and `config`, so a
/// note kept in either would be read by the task next door; each has a directory of its
/// own under `.git/worktrees/`, and that is what this answers.
fn admin_dir(worktree: &Path) -> Result<PathBuf, GitError> {
    git(worktree, &["rev-parse", "--absolute-git-dir"]).map(PathBuf::from)
}

/// Records the paths a verdict refused, so the commit that follows leaves them out.
///
/// wecode cannot intercept a write — confinement is the worktree and the scope check
/// runs afterwards — but it decides what enters history, and that is the half of it
/// that is not too late. A refused write recorded and then committed anyway is on the
/// branch, and on its way to a merge, whatever the ledger says about it.
///
/// Replaces the last verdict's answer, the empty list included: a run that refused
/// nothing must not inherit a refusal from the run before it.
pub(crate) fn refuse(worktree: &Path, paths: &[String]) -> Result<(), GitError> {
    let note = admin_dir(worktree)?.join(REFUSED);
    // A git failure because that is the only failure this module has, and the caller
    // only ever prints the sentence.
    let io = |e: std::io::Error| GitError::Failed {
        argv: format!("record refused writes in {}", worktree.display()),
        stderr: e.to_string(),
    };
    if paths.is_empty() {
        return match std::fs::remove_file(&note) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io(e)),
            _ => Ok(()),
        };
    }
    std::fs::write(&note, paths.join("\n")).map_err(io)
}

/// The refused paths — taken, not read.
///
/// A note answers the commit it was left for and no later one. Left standing, a
/// verdict that refused a path in one attempt would keep it out of every commit after
/// it, including the attempt that was told to write there once the scope was widened.
///
/// Silent when there is no note, which is the ordinary case: a tree nobody has judged
/// has refused nothing, and the commit is the sweep it always was.
fn take_refused(worktree: &Path) -> Vec<String> {
    let Ok(dir) = admin_dir(worktree) else {
        return Vec::new();
    };
    let note = dir.join(REFUSED);
    let body = std::fs::read_to_string(&note).unwrap_or_default();
    let _ = std::fs::remove_file(&note);
    body.lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// Commits a worktree's work, minus whatever the verdict refused, and returns the sha.
///
/// `Ok(None)` when there was nothing to commit — an agent that changed nothing is a
/// fact to record, not an error to raise. A run whose *only* writes were refused ends
/// the same way, and that is the same fact: nothing it did belongs on the branch.
///
/// The refused writes are left in the tree, not deleted. They are the evidence a
/// verdict was reached on, they are what a second `wecode verify` must reach the same
/// answer about, and the retry's `git reset --hard` is what clears them — so they last
/// exactly as long as the attempt they belong to. What changes is that the branch never
/// carries them: a failed attempt is committed for the retry to learn from, and the one
/// thing it must not learn is that writing there was allowed to stand.
///
/// The author is wecode, not the agent: the commit is our account of what a run
/// produced, and attributing it to a model would make `git log` claim something the
/// design says nowhere else — that the agent's own word is evidence.
pub(crate) fn commit_all(worktree: &Path, message: &str) -> Result<Option<String>, GitError> {
    let refused = take_refused(worktree);
    git(worktree, &["add", "-A"])?;
    // `--quiet` still exits non-zero with nothing staged, so ask first rather than
    // reading failure as an outcome. Asked by name rather than for emptiness, because
    // what is staged is now also what has to be checked against the refusals.
    let staged: Vec<String> = git(worktree, &["diff", "--cached", "--name-only"])?
        .lines()
        .map(str::to_string)
        .collect();
    let (left_out, keep): (Vec<String>, Vec<String>) =
        staged.into_iter().partition(|p| refused.contains(p));
    if !left_out.is_empty() {
        // Unstaged rather than reverted: the index forgets them, the working tree does
        // not. A refusal names a path the task was not allowed to touch, never a path
        // wecode is entitled to throw away the contents of.
        let mut argv = vec!["reset", "-q", "--"];
        argv.extend(left_out.iter().map(String::as_str));
        git(worktree, &argv)?;
    }
    if keep.is_empty() {
        return Ok(None);
    }
    git(
        worktree,
        &[
            "-c",
            "user.name=wecode",
            "-c",
            "user.email=wecode@localhost",
            "commit",
            "-q",
            "-m",
            message,
        ],
    )?;
    Ok(Some(git(worktree, &["rev-parse", "--short", "HEAD"])?))
}

/// What one merge did, and what undoes it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Merged {
    /// Where the target stood before. `git reset --hard` to this undoes the merge
    /// entirely, if nothing has been pushed.
    pub(crate) was: String,
    /// The merge commit. `git revert -m 1` on this undoes it safely either way.
    pub(crate) sha: String,
    /// Files the merge brought in, with their line counts.
    pub(crate) files: Vec<(String, u32, u32)>,
}

impl Merged {
    pub(crate) fn insertions(&self) -> u32 {
        self.files.iter().map(|(_, a, _)| a).sum()
    }

    pub(crate) fn deletions(&self) -> u32 {
        self.files.iter().map(|(_, _, d)| d).sum()
    }
}

/// Where `branch` is checked out, if anywhere.
///
/// git refuses to check one branch out twice, and the integration branch is usually
/// the one the operator is standing on — so this is the normal case, not an edge.
pub(crate) fn checked_out_at(repo: &Path, branch: &str) -> Option<PathBuf> {
    let out = git(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let mut dir: Option<&str> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            dir = Some(p);
        } else if line.strip_prefix("branch refs/heads/") == Some(branch) {
            return dir.map(PathBuf::from);
        }
    }
    None
}

/// Whether a tree has uncommitted work.
pub(crate) fn is_dirty(dir: &Path) -> bool {
    !changed_files(dir).unwrap_or_default().is_empty()
}

/// Merges `branch` into `target`.
///
/// In a scratch worktree when it can, so the operator's checkout is untouched. When
/// the target is already checked out — usually because they are standing on it — the
/// merge happens there, because git will not check a branch out twice and moving the
/// ref underneath a live tree would leave their `git status` showing the change in
/// reverse. A dirty tree is refused rather than merged into.
///
/// Always `--no-ff`. A fast-forward leaves no merge commit, and then there is no single
/// thing to revert; forcing one means every merge is exactly one commit you can undo.
pub(crate) fn merge_into(
    repo: &Path,
    scratch: &Path,
    target: &str,
    branch: &str,
    message: &str,
) -> Result<Merged, GitError> {
    if !branch_exists(repo, target) {
        return Err(GitError::Failed {
            argv: format!("merge into {target}"),
            stderr: format!("no branch `{target}` — nothing to merge into"),
        });
    }
    let (dir, borrowed) = tree_for(repo, scratch, target)?;

    let outcome = (|| -> Result<Merged, GitError> {
        let dir = dir.as_path();
        let was = git(dir, &["rev-parse", "HEAD"])?;
        git(
            dir,
            &[
                "-c",
                "user.name=wecode",
                "-c",
                "user.email=wecode@localhost",
                "merge",
                "--no-ff",
                "-m",
                message,
                branch,
            ],
        )?;
        let sha = git(dir, &["rev-parse", "HEAD"])?;
        if sha == was {
            // `git merge --no-ff` on an already-merged branch says "Already up to
            // date" and creates nothing. Reporting that as a merge of zero files
            // would be a lie of omission, and it is exactly what happens after a
            // rollback: reverting a merge does not un-merge the branch, so git still
            // considers it merged. Restoring the work means reverting the revert.
            return Err(GitError::Failed {
                argv: format!("merge {branch} into {target}"),
                stderr: format!(
                    "`{branch}` is already merged into `{target}`, so nothing happened.\n                       If it was rolled back, git still counts it as merged — restore it by\n                       reverting the revert, not by merging again."
                ),
            });
        }
        let files = numstat(dir, &was, &sha)?;
        Ok(Merged { was, sha, files })
    })();

    // A scratch tree goes whether the merge worked or not; a conflicted one left
    // behind would block the next attempt with a confusing error. A borrowed one is
    // the operator's and stays.
    if !borrowed {
        let _ = worktree_remove(repo, scratch);
    }
    outcome
}

/// Writes one generated file onto `target` and commits it, returning the new sha.
///
/// A commit of its own, rather than something folded into the merge. The file this
/// carries names the merge commit's sha, and no commit can contain its own name — so
/// the record necessarily lands *after* the thing it records.
///
/// Only that one path is staged. `commit_all` sweeps a whole tree, which is right for
/// an agent's attempt and wrong here: the target may be the operator's own checkout,
/// and a stray untracked file of theirs is not part of this record.
///
/// `Ok(None)` when the file was already byte-for-byte this, so git found nothing to
/// commit. The caller decides whether that is a failure; here it is just an outcome.
pub(crate) fn commit_file(
    repo: &Path,
    scratch: &Path,
    target: &str,
    rel: &str,
    contents: &str,
    message: &str,
) -> Result<Option<String>, GitError> {
    let (dir, borrowed) = tree_for(repo, scratch, target)?;
    let outcome = (|| -> Result<Option<String>, GitError> {
        let dir = dir.as_path();
        let path = dir.join(rel);
        // Reported as a git failure because that is the only failure this module has,
        // and the caller only ever prints the sentence. `Unavailable` would be a lie:
        // git started fine, the disk did not cooperate.
        let io = |e: std::io::Error| GitError::Failed {
            argv: format!("write {rel} on {target}"),
            stderr: e.to_string(),
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        std::fs::write(&path, contents).map_err(io)?;
        git(dir, &["add", "--", rel])?;
        if git(dir, &["diff", "--cached", "--name-only"])?.is_empty() {
            return Ok(None);
        }
        git(
            dir,
            &[
                "-c",
                "user.name=wecode",
                "-c",
                "user.email=wecode@localhost",
                "commit",
                "-q",
                "-m",
                message,
            ],
        )?;
        Ok(Some(git(dir, &["rev-parse", "--short", "HEAD"])?))
    })();
    if !borrowed {
        let _ = worktree_remove(repo, scratch);
    }
    outcome
}

/// A directory with `target` checked out, and whether it belongs to the operator.
fn tree_for(repo: &Path, scratch: &Path, target: &str) -> Result<(PathBuf, bool), GitError> {
    if let Some(theirs) = checked_out_at(repo, target) {
        if is_dirty(&theirs) {
            return Err(GitError::Failed {
                argv: format!("merge into {target}"),
                stderr: format!(
                    "{} has uncommitted changes on `{target}` — commit or stash them first",
                    theirs.display()
                ),
            });
        }
        return Ok((theirs, true));
    }
    let _ = worktree_remove(repo, scratch);
    if let Some(parent) = scratch.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    git(
        repo,
        &["worktree", "add", &scratch.to_string_lossy(), target],
    )?;
    Ok((scratch.to_path_buf(), false))
}

/// Per-file insertions and deletions between two revisions.
fn numstat(dir: &Path, from: &str, to: &str) -> Result<Vec<(String, u32, u32)>, GitError> {
    let out = git(dir, &["diff", "--numstat", from, to])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let add = f.next()?;
            let del = f.next()?;
            let path = f.next()?;
            // A binary file reports `-` rather than a count.
            Some((
                path.to_string(),
                add.parse().unwrap_or(0),
                del.parse().unwrap_or(0),
            ))
        })
        .collect())
}

/// The merge commit that landed a task on `target`, if one did.
///
/// Found in git rather than stored: the merge message names the task, and git is
/// already the record of what happened. A second copy in the database could disagree
/// with it.
pub(crate) fn merge_commit_for(repo: &Path, target: &str, task: &str) -> Option<String> {
    let out = git(
        repo,
        &[
            "log",
            target,
            "--merges",
            "--grep",
            &format!("^{task}: "),
            "--format=%H",
            "-n",
            "1",
        ],
    )
    .ok()?;
    (!out.is_empty()).then_some(out)
}

/// Undoes a merge by reverting it. Safe whether or not the branch has been shared,
/// which `reset --hard` is not.
pub(crate) fn revert_merge(
    repo: &Path,
    scratch: &Path,
    target: &str,
    sha: &str,
) -> Result<String, GitError> {
    let (dir, borrowed) = tree_for(repo, scratch, target)?;
    let outcome = (|| -> Result<String, GitError> {
        let dir = dir.as_path();
        git(
            dir,
            &[
                "-c",
                "user.name=wecode",
                "-c",
                "user.email=wecode@localhost",
                "revert",
                "--no-edit",
                "-m",
                "1",
                sha,
            ],
        )?;
        git(dir, &["rev-parse", "--short", "HEAD"])
    })();
    if !borrowed {
        let _ = worktree_remove(repo, scratch);
    }
    outcome
}

/// The files one commit touched, and the diff, capped.
///
/// Used to build a handoff: what a predecessor produced is read out of git rather
/// than asked of the agent that produced it.
pub(crate) fn commit_summary(
    worktree: &Path,
    sha: &str,
    max_diff: usize,
) -> Result<(Vec<String>, String), GitError> {
    let files = git(
        worktree,
        &["show", "--name-only", "--format=", "--no-renames", sha],
    )?
    .lines()
    .filter(|l| !l.is_empty())
    .map(str::to_string)
    .collect();
    let diff = git(worktree, &["show", "--format=", "--no-color", sha])?;
    let diff = if diff.len() <= max_diff {
        diff
    } else {
        let cut: String = diff.chars().take(max_diff).collect();
        format!("{cut}\n… truncated, {} bytes in full", diff.len())
    };
    Ok((files, diff))
}

/// The commits wecode made on this branch, newest first, as `(sha, subject)`.
///
/// Filtered by author because only wecode commits here — the agent is told not to,
/// and anything else on the branch came from the base and is not this task's work.
pub(crate) fn attempts_on(worktree: &Path) -> Result<Vec<(String, String)>, GitError> {
    let out = git(
        worktree,
        &[
            "log",
            "--author=wecode@localhost",
            "--format=%h\t%s",
            "--max-count=20",
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(a, b)| (a.to_string(), b.to_string()))
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
    fn a_revision_resolves_to_a_commit_or_to_nothing() {
        let r = repo("revparse");
        assert_eq!(commit_at(&r, "main"), commit_at(&r, "HEAD"));
        assert_eq!(commit_at(&r, "no-such-branch"), None);
        // An annotated tag answers with the commit, not with the tag object — otherwise
        // a branch cut there would start at something git cannot check out.
        git(&r, &["tag", "-a", "v1", "-m", "one"]).unwrap();
        assert_eq!(commit_at(&r, "v1"), commit_at(&r, "main"));
    }

    #[test]
    fn a_branch_cut_ahead_of_time_is_what_the_worktree_lands_on() {
        // The whole of `--onto`: the base is settled when the task is declared, and
        // `worktree_add` reuses a branch that is standing rather than cutting a new one
        // from whatever base it was handed at dispatch.
        let r = repo("branch-at");
        git(&r, &["checkout", "-q", "-b", "release"]).unwrap();
        fs::write(r.join("a.txt"), "on release\n").unwrap();
        git(&r, &["commit", "-qam", "release only"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();

        branch_at(&r, "wecode/t1", "release").unwrap();
        let wt = r.parent().unwrap().join("wecode-git-branch-at-wt");
        let _ = fs::remove_dir_all(&wt);
        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();

        assert_eq!(
            fs::read_to_string(wt.join("a.txt")).unwrap(),
            "on release\n",
            "the declared base won, not the one dispatch offered"
        );
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
    fn a_commit_captures_the_work_and_reports_its_sha() {
        let r = repo("commit");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        fs::write(r.join("new.txt"), "added\n").unwrap();

        let sha = commit_all(&r, "attempt 1")
            .unwrap()
            .expect("something to commit");
        assert!(!sha.is_empty());
        // Nothing left behind: a retry resetting this tree would destroy nothing.
        assert!(changed_files(&r).unwrap().is_empty());

        let mut files = git(&r, &["show", "--name-only", "--format=", &sha])
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        files.sort();
        assert_eq!(files, vec!["a.txt", "new.txt"]);
    }

    #[test]
    fn committing_nothing_is_reported_rather_than_failing() {
        // An agent that changed nothing is a fact for the verdict to weigh, not an
        // error — and `git commit` exits non-zero on an empty index.
        let r = repo("commit-empty");
        assert_eq!(commit_all(&r, "attempt 1").unwrap(), None);
    }

    #[test]
    fn a_refused_write_does_not_enter_the_commit() {
        // The whole point. The scope check happens after the writes, so the only place
        // left to say no is the commit — and a refused write that is committed anyway
        // is on the branch, waiting for a merge, however loudly the verdict said no.
        let r = repo("commit-refused");
        fs::write(r.join("a.txt"), "in scope\n").unwrap();
        fs::write(r.join("Cargo.toml"), "[package]\n").unwrap();

        refuse(&r, &["Cargo.toml".to_string()]).unwrap();
        let sha = commit_all(&r, "t1: attempt 1").unwrap().unwrap();

        let files = git(&r, &["show", "--name-only", "--format=", &sha]).unwrap();
        assert_eq!(files, "a.txt", "the refused path is not in the commit");
        // Still on disk, and still visible to the next verdict: the file is evidence,
        // and only the retry's reset is entitled to clear it.
        assert_eq!(changed_files(&r).unwrap(), vec!["Cargo.toml"]);
    }

    #[test]
    fn a_refused_edit_to_a_tracked_file_leaves_the_branch_where_it_was() {
        // The other shape of a refusal: not a new file, an edit to one that was already
        // there. Unstaged, never reverted — the branch keeps what it had, the tree keeps
        // what the agent wrote, and neither is thrown away by us.
        let r = repo("commit-refused-tracked");
        fs::write(r.join("a.txt"), "out of scope\n").unwrap();
        fs::write(r.join("new.txt"), "in scope\n").unwrap();

        refuse(&r, &["a.txt".to_string()]).unwrap();
        commit_all(&r, "t1: attempt 1").unwrap().unwrap();

        assert_eq!(git(&r, &["show", "HEAD:a.txt"]).unwrap(), "one");
        assert_eq!(
            fs::read_to_string(r.join("a.txt")).unwrap(),
            "out of scope\n"
        );
    }

    #[test]
    fn an_attempt_that_wrote_nothing_but_refused_paths_commits_nothing() {
        // Reported the same way as an agent that changed no files, because it is the
        // same fact: nothing this run did belongs on the branch.
        let r = repo("commit-all-refused");
        fs::write(r.join("Cargo.toml"), "[package]\n").unwrap();
        refuse(&r, &["Cargo.toml".to_string()]).unwrap();
        assert_eq!(commit_all(&r, "t1: attempt 1").unwrap(), None);
    }

    #[test]
    fn a_refusal_answers_one_commit_and_not_the_next() {
        // Left standing, one attempt's refusal would keep that path out of every commit
        // after it — including the attempt told to write there once the scope was widened.
        let r = repo("commit-refused-once");
        fs::write(r.join("Cargo.toml"), "[package]\n").unwrap();
        refuse(&r, &["Cargo.toml".to_string()]).unwrap();
        assert_eq!(commit_all(&r, "t1: attempt 1").unwrap(), None);

        let sha = commit_all(&r, "t1: attempt 2").unwrap().unwrap();
        let files = git(&r, &["show", "--name-only", "--format=", &sha]).unwrap();
        assert_eq!(files, "Cargo.toml", "the note was answered, not kept");
    }

    #[test]
    fn a_verdict_that_refused_nothing_clears_the_one_before_it() {
        let r = repo("commit-refused-cleared");
        fs::write(r.join("Cargo.toml"), "[package]\n").unwrap();
        refuse(&r, &["Cargo.toml".to_string()]).unwrap();
        refuse(&r, &[]).unwrap();

        let sha = commit_all(&r, "t1: attempt 1").unwrap().unwrap();
        let files = git(&r, &["show", "--name-only", "--format=", &sha]).unwrap();
        assert_eq!(files, "Cargo.toml");
    }

    #[test]
    fn a_tree_nobody_judged_is_committed_whole() {
        // No note, no change: `commit_all` is the sweep it has always been.
        let r = repo("commit-unjudged");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        fs::write(r.join("Cargo.toml"), "[package]\n").unwrap();
        let sha = commit_all(&r, "t1: attempt 1").unwrap().unwrap();
        let mut files = git(&r, &["show", "--name-only", "--format=", &sha])
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        files.sort();
        assert_eq!(files, vec!["Cargo.toml", "a.txt"]);
    }

    #[test]
    fn the_commit_is_authored_by_wecode_not_by_the_agent() {
        // git log must not imply the agent vouched for anything. The commit is our
        // record of what a run produced.
        let r = repo("commit-author");
        fs::write(r.join("a.txt"), "x\n").unwrap();
        commit_all(&r, "attempt 1").unwrap();
        let who = git(&r, &["log", "-1", "--format=%an <%ae>"]).unwrap();
        assert_eq!(who, "wecode <wecode@localhost>");
    }

    #[test]
    fn a_commits_files_and_diff_can_be_read_back() {
        let r = repo("summary");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        let sha = commit_all(&r, "attempt 1").unwrap().unwrap();

        let (files, diff) = commit_summary(&r, &sha, 10_000).unwrap();
        assert_eq!(files, vec!["a.txt"]);
        assert!(diff.contains("changed"), "{diff}");
    }

    #[test]
    fn a_huge_diff_is_capped_but_says_how_big_it_really_was() {
        // An envelope is a prompt. An unbounded diff would crowd out the instruction.
        let r = repo("summary-big");
        fs::write(r.join("big.txt"), "x".repeat(5000)).unwrap();
        let sha = commit_all(&r, "big").unwrap().unwrap();
        let (_, diff) = commit_summary(&r, &sha, 500).unwrap();
        assert!(diff.len() < 700, "{}", diff.len());
        assert!(diff.contains("bytes in full"), "{diff}");
    }

    #[test]
    fn only_wecodes_own_commits_count_as_attempts() {
        // Commits inherited from the base branch are not this task's work.
        let r = repo("attempts");
        // Distinct content each time: the fixture already holds "one", and writing it
        // again would stage nothing and commit nothing.
        fs::write(r.join("a.txt"), "first try\n").unwrap();
        assert!(commit_all(&r, "t: attempt 1").unwrap().is_some());
        fs::write(r.join("a.txt"), "second try\n").unwrap();
        assert!(commit_all(&r, "t: attempt 2").unwrap().is_some());

        let a = attempts_on(&r).unwrap();
        assert_eq!(a.len(), 2, "the base commit is not ours: {a:?}");
        assert!(a[0].1.contains("attempt 2"), "newest first: {a:?}");
    }

    #[test]
    fn a_merge_lands_the_work_and_reports_what_undoes_it() {
        let r = repo("merge");
        let wt = r.parent().unwrap().join("wecode-git-merge-wt");
        let scratch = r.parent().unwrap().join("wecode-git-merge-scratch");
        let _ = fs::remove_dir_all(&wt);

        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();
        fs::write(wt.join("a.txt"), "from the task\n").unwrap();
        commit_all(&wt, "t1: attempt 1").unwrap();

        let m = merge_into(&r, &scratch, "main", "wecode/t1", "merge t1").unwrap();
        assert_eq!(m.files.len(), 1);
        assert_eq!(m.files[0].0, "a.txt");
        assert_eq!(m.insertions(), 1);
        assert_eq!(m.deletions(), 1);

        // main really moved, and the scratch tree is gone.
        let on_main = git(&r, &["show", "main:a.txt"]).unwrap();
        assert_eq!(on_main, "from the task");
        assert!(!scratch.exists(), "scratch worktree left behind");
    }

    #[test]
    fn the_merge_is_never_a_fast_forward() {
        // Without a merge commit there is no single thing to revert.
        let r = repo("merge-noff");
        let wt = r.parent().unwrap().join("wecode-git-noff-wt");
        let scratch = r.parent().unwrap().join("wecode-git-noff-scratch");
        let _ = fs::remove_dir_all(&wt);
        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();
        fs::write(wt.join("a.txt"), "x\n").unwrap();
        commit_all(&wt, "t1: attempt 1").unwrap();

        let m = merge_into(&r, &scratch, "main", "wecode/t1", "merge t1").unwrap();
        let parents = git(&r, &["rev-list", "--parents", "-n", "1", &m.sha]).unwrap();
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "a merge commit has two parents: {parents}"
        );
    }

    #[test]
    fn a_merge_can_be_reverted() {
        let r = repo("merge-revert");
        let wt = r.parent().unwrap().join("wecode-git-revert-wt");
        let scratch = r.parent().unwrap().join("wecode-git-revert-scratch");
        let _ = fs::remove_dir_all(&wt);
        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();
        fs::write(wt.join("a.txt"), "unwanted\n").unwrap();
        commit_all(&wt, "t1: attempt 1").unwrap();

        let m = merge_into(&r, &scratch, "main", "wecode/t1", "merge t1").unwrap();
        assert_eq!(git(&r, &["show", "main:a.txt"]).unwrap(), "unwanted");

        revert_merge(&r, &scratch, "main", &m.sha).unwrap();
        assert_eq!(
            git(&r, &["show", "main:a.txt"]).unwrap(),
            "one",
            "the file is back to where it started"
        );
    }

    #[test]
    fn merging_a_branch_that_is_already_in_says_so_rather_than_reporting_nothing() {
        // The trap after a rollback: git still counts the branch as merged, so a
        // second merge is a silent no-op that reads like success.
        let r = repo("merge-again");
        let wt = r.parent().unwrap().join("wecode-git-again-wt");
        let scratch = r.parent().unwrap().join("wecode-git-again-scratch");
        let _ = fs::remove_dir_all(&wt);
        worktree_add(&r, &wt, "wecode/t1", Some("main")).unwrap();
        fs::write(wt.join("a.txt"), "x\n").unwrap();
        commit_all(&wt, "t1: attempt 1").unwrap();
        merge_into(&r, &scratch, "main", "wecode/t1", "merge t1").unwrap();

        let e = merge_into(&r, &scratch, "main", "wecode/t1", "merge t1").unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("already merged"), "{msg}");
        assert!(msg.contains("reverting the revert"), "{msg}");
    }

    #[test]
    fn merging_into_a_branch_that_does_not_exist_says_so() {
        let r = repo("merge-nobranch");
        let scratch = r.parent().unwrap().join("wecode-git-nb-scratch");
        let e = merge_into(&r, &scratch, "dev", "main", "x").unwrap_err();
        assert!(e.to_string().contains("no branch `dev`"), "{e}");
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
