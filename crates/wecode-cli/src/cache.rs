//! The build cache a project's worktrees share.
//!
//! A worktree is a clean checkout, so its `target/` starts empty and every task pays
//! for a cold build — twice, since the agent builds while it works and acceptance
//! builds again to judge it. None of that output is per-task: it belongs to the
//! repository, and a repository is what several worktrees are checkouts *of*.
//!
//! So a project names the directories its worktrees share, in the playbook that
//! describes that repository, and wecode sets them on both processes it starts. What
//! the variables mean is the toolchain's business — wecode only carries a name and a
//! path, which is what keeps this from being a list of languages wecode has heard of.
//!
//! Two consequences worth stating plainly, because both are real:
//!
//! - **Sharing serialises.** cargo takes an exclusive lock on its target directory, so
//!   two tasks building at once queue instead of building twice. That is the trade: a
//!   wait against a rebuild, and the rebuild is the more expensive of the two.
//! - **The directory outlives the worktree.** Tearing a tree down does not touch the
//!   cache — which is the point, and also why nothing here ever deletes one.

use std::path::PathBuf;

use wecode_org::Playbook;

/// A variable and the directory it hands over, resolved for this machine.
pub(crate) type Shared = Vec<(String, PathBuf)>;

/// What a project shares. A project with no playbook, or one that declares nothing,
/// shares nothing — and nothing is what every project had before this existed.
#[must_use]
pub(crate) fn shared(pb: Option<&Playbook>) -> Shared {
    pb.map(|p| {
        p.project
            .build_cache
            .iter()
            .map(|c| (c.var.clone(), c.dir()))
            .collect()
    })
    .unwrap_or_default()
}

/// Creates the directories before anything is told to use them.
///
/// A hard error rather than a shrug, and deliberately: a toolchain handed an
/// uncreatable path either fails obscurely or quietly falls back to the worktree's own
/// `target/`. The second is worse — the build succeeds, the cache is not shared, and
/// nothing says so.
pub(crate) fn ensure(dirs: &[(String, PathBuf)]) -> Result<(), Box<dyn std::error::Error>> {
    for (var, dir) in dirs {
        std::fs::create_dir_all(dir).map_err(|e| {
            format!(
                "cannot create the shared build cache {var}={}: {e}\n  \
                 it is declared in [project.build_cache] in the project's playbook",
                dir.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn playbook(text: &str) -> Playbook {
        Playbook::parse(text).expect("valid playbook")
    }

    #[test]
    fn a_project_without_a_playbook_shares_nothing() {
        assert!(shared(None).is_empty());
        assert!(shared(Some(&playbook("[bug]\nworktree = true\n"))).is_empty());
    }

    #[test]
    fn a_declared_cache_arrives_resolved() {
        let pb = playbook("[project.build_cache]\nCARGO_TARGET_DIR = \"~/.cache/w/target\"\n");
        let out = shared(Some(&pb));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "CARGO_TARGET_DIR");
        // Resolved here rather than passed through: a `~` reaching a subprocess is a
        // literal directory called `~`, created in whatever the working directory is.
        assert!(out[0].1.is_absolute(), "{:?}", out[0].1);
    }

    #[test]
    fn the_directories_are_made_before_anything_is_pointed_at_them() {
        let root = std::env::temp_dir().join("wecode-cache-ensure");
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("nested/target");
        ensure(&[("CARGO_TARGET_DIR".to_string(), dir.clone())]).unwrap();
        assert!(dir.is_dir());
        // Idempotent: every task prepared against this project runs it again.
        ensure(&[("CARGO_TARGET_DIR".to_string(), dir.clone())]).unwrap();
    }

    #[test]
    fn a_cache_that_cannot_be_created_names_itself_and_where_it_was_declared() {
        // Silently carrying on would leave a build that works, a cache that is not
        // shared, and nothing anywhere saying which.
        let file = std::env::temp_dir().join("wecode-cache-not-a-dir");
        std::fs::write(&file, "x").unwrap();
        let e = ensure(&[("CARGO_TARGET_DIR".to_string(), file.join("under"))])
            .unwrap_err()
            .to_string();
        assert!(e.contains("CARGO_TARGET_DIR"), "{e}");
        assert!(e.contains("build_cache"), "{e}");
    }
}
