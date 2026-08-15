//! `[project.build_cache]`: the directories every worktree of this project shares.
//!
//! Its own module because the three ways a declaration can fail to be shared are all
//! silent, and refusing them is most of what this block is. A worktree isolates
//! source, which is the point, and build state, which is not — the compiler output
//! belongs to the *repository*, so the declaration lives in the repository's own
//! playbook and names a directory outside every worktree.

use std::collections::BTreeMap;
use std::path::PathBuf;

use super::PlaybookError;

/// One directory this project's worktrees share, and the environment variable that
/// hands it to a toolchain.
///
/// A worktree is a fresh checkout with an empty `target/`, so every task pays for a
/// cold build twice — once for the agent, once for acceptance. Nothing about that cost
/// is per-task: the compiler output belongs to the *repository*, which is why the
/// declaration lives in the repository's own playbook and names a directory outside
/// every worktree.
///
/// Which variable does it is the project's business, not wecode's — `CARGO_TARGET_DIR`
/// for Rust, `GOCACHE` for Go, `YARN_CACHE_FOLDER` for a JS project — so this carries a
/// name rather than guessing one from `language`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CacheDir {
    pub var: String,
    /// As written, `~` and all. Resolving it is [`CacheDir::dir`]'s job, so a playbook
    /// parses the same on a machine with a different home.
    pub path: String,
}

impl CacheDir {
    /// The directory itself. Machine-dependent — `~` is this process's home — which is
    /// why it is a method rather than something `parse` settled.
    #[must_use]
    pub fn dir(&self) -> PathBuf {
        crate::workspace::expand_home(&self.path)
    }
}

/// Variables that decide *which program runs* rather than where its output goes.
///
/// A build cache names a directory. Setting one of these from a repository file would
/// be redirecting the toolchain of every agent that works on it, which is a different
/// power wearing this feature's clothes — and one the env allowlist in `company.toml`
/// exists to keep in the operator's hands.
const NOT_A_CACHE: &[&str] = &[
    "PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
];

fn is_env_name(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with(|c: char| c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Reads the shared directories, refusing the three ways one could fail to be shared.
///
/// The relative-path rule is the load-bearing one: `target/shared` looks like a cache
/// and resolves against whatever directory the toolchain was started in — which is the
/// worktree, so every task would get its own copy under a name promising the opposite.
/// A silent non-sharing cache is worse than none, because nothing about it looks wrong.
pub(super) fn parse_build_cache(
    map: &BTreeMap<String, String>,
) -> Result<Vec<CacheDir>, PlaybookError> {
    let mut out = Vec::with_capacity(map.len());
    for (var, path) in map {
        let bad = |why: String| PlaybookError::BadCache {
            var: var.clone(),
            why,
        };
        if !is_env_name(var) {
            return Err(bad(
                "not an environment variable name — letters, digits and underscore, \
                 and never a leading digit"
                    .to_string(),
            ));
        }
        if NOT_A_CACHE.contains(&var.as_str()) {
            return Err(bad(
                "decides which program runs, not where its output goes — a shared cache \
                 names a directory, and this belongs to the env allowlist in company.toml"
                    .to_string(),
            ));
        }
        if !(path.starts_with('/') || path.starts_with("~/")) {
            return Err(bad(format!(
                "`{path}` is relative, so it would resolve inside whichever worktree is \
                 running — the one place a shared cache cannot be. Give an absolute path, \
                 or one under `~/`"
            )));
        }
        out.push(CacheDir {
            var: var.clone(),
            path: path.clone(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use crate::playbook::{Playbook, SAMPLE, starter};

    #[test]
    fn a_project_declares_the_directories_its_worktrees_share() {
        let p = Playbook::parse(
            "[project.build_cache]\nCARGO_TARGET_DIR = \"~/.cache/w/target\"\nSCCACHE_DIR = \"/var/cache/sccache\"\n",
        )
        .unwrap();
        let c = &p.project.build_cache;
        assert_eq!(c.len(), 2);
        // Variable order, so two readings of one file cannot disagree about which
        // directory is reported first.
        assert_eq!(c[0].var, "CARGO_TARGET_DIR");
        assert_eq!(c[1].var, "SCCACHE_DIR");
    }

    #[test]
    fn declaring_nothing_shares_nothing() {
        // The default has to be "no cache" rather than a guessed one: a directory
        // wecode picked would be a build cache nobody asked for, in a place nobody
        // knows to clean up.
        assert!(
            Playbook::parse(SAMPLE)
                .unwrap()
                .project
                .build_cache
                .is_empty()
        );
    }

    #[test]
    fn the_home_in_a_cache_path_is_resolved_at_use_not_at_parse() {
        // Same rule as the accept check: parsing must not consult the machine, so one
        // playbook describes the same cache on two machines with different homes.
        let p =
            Playbook::parse("[project.build_cache]\nCARGO_TARGET_DIR = \"~/.cache/w\"\n").unwrap();
        let c = &p.project.build_cache[0];
        assert_eq!(c.path, "~/.cache/w", "kept as written");
        let dir = c.dir();
        assert!(dir.is_absolute(), "{dir:?}");
        assert!(!dir.to_string_lossy().contains('~'), "{dir:?}");
    }

    #[test]
    fn a_relative_cache_path_is_refused_and_says_why() {
        // The failure this rule exists for: `target/shared` resolves against the
        // running worktree, so every task would get its own copy under a name
        // promising the opposite — and nothing about it would look wrong.
        let msg = Playbook::parse("[project.build_cache]\nCARGO_TARGET_DIR = \"target/shared\"\n")
            .unwrap_err()
            .to_string();
        assert!(msg.contains("CARGO_TARGET_DIR"), "{msg}");
        assert!(msg.contains("relative"), "{msg}");
        assert!(
            msg.contains("worktree"),
            "should say where it would land: {msg}"
        );
    }

    #[test]
    fn a_key_that_is_not_an_environment_variable_is_refused() {
        let msg = Playbook::parse("[project.build_cache]\n\"cargo target\" = \"/tmp/t\"\n")
            .unwrap_err()
            .to_string();
        assert!(msg.contains("cargo target"), "{msg}");
        assert!(msg.contains("environment variable"), "{msg}");
    }

    #[test]
    fn a_variable_that_redirects_the_toolchain_is_not_a_cache() {
        // A build cache says where output goes. `PATH` says which program runs, and a
        // repository file that could set it would be choosing the toolchain for every
        // agent — which is what the env allowlist in company.toml is for.
        for var in ["PATH", "LD_PRELOAD"] {
            let msg = Playbook::parse(&format!("[project.build_cache]\n{var} = \"/tmp/t\"\n"))
                .unwrap_err()
                .to_string();
            assert!(msg.contains(var), "{msg}");
            assert!(msg.contains("which program runs"), "{msg}");
        }
    }

    #[test]
    fn a_known_toolchain_declares_its_cache_rather_than_offering_it() {
        // Live, not commented: the cost this closes is paid by the first task, which
        // starts before anybody has read far enough down the file to uncomment
        // anything. The sub-table must still sit after [project]'s scalar keys.
        let p = Playbook::parse(&starter("rust", "app")).unwrap();
        assert_eq!(p.project.build_cache.len(), 1);
        assert_eq!(p.project.build_cache[0].var, "CARGO_TARGET_DIR");
        assert_eq!(p.project.build_cache[0].path, "~/.cache/wecode/app/target");
        assert_eq!(
            p.project.language, "rust",
            "the sub-table must not swallow the keys above it"
        );
    }

    #[test]
    fn a_project_with_no_toolchain_is_offered_the_cache_commented_out() {
        // Uncommenting must work: same placement rule, and nothing is declared on a
        // project's behalf when wecode does not know what its toolchain reads.
        let text = starter("cobol", "app");
        assert!(
            Playbook::parse(&text)
                .unwrap()
                .project
                .build_cache
                .is_empty()
        );
        let live = text.replace(
            "# [project.build_cache]\n# CARGO_TARGET_DIR = \"~/.cache/wecode/this-repo/target\"",
            "[project.build_cache]\nCARGO_TARGET_DIR = \"~/.cache/wecode/this-repo/target\"",
        );
        assert_ne!(live, text, "the starter offers a build_cache example");
        let p = Playbook::parse(&live).expect("the commented example is valid TOML");
        assert_eq!(p.project.build_cache[0].var, "CARGO_TARGET_DIR");
        assert_eq!(p.project.language, "cobol");
    }
}
