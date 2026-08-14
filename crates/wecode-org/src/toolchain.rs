//! The toolchains a starter can be written for.
//!
//! `wecode playbook init --language rust` used to write the same TODO template whatever
//! it was passed: the word landed in one field and changed nothing else. Every new
//! project therefore began with `accept = []`, no shared build cache, and a subtask
//! example whose write scope named `src/**` and nothing a build touches. The first task
//! paid for all three — and one repository acquired `python -m pytest` on a machine with
//! no `python`, which is the same mistake from the other end: a command nobody had run.
//!
//! This is the table that fixes it, and its shape is deliberate:
//!
//! - **It is read once, while a file is being written.** Nothing at run time consults a
//!   `Toolchain`. What it produces is ordinary playbook text, hand-editable and
//!   committed, so being wrong about a language costs an edit rather than a behaviour.
//! - **A language it does not have is not an error.** The starter falls back to the
//!   prompts it always wrote, and says so in the file. Four entries is not a claim about
//!   which languages matter; it is what could be stated accurately without guessing.
//! - **It never gets a say over what runs.** The commands it writes still face the
//!   load-time check in [`crate::playbook`] — a starter naming a program this machine
//!   lacks is refused like any other playbook, which is why `playbook init` reports that
//!   fact while the fix is still one edit.

use std::path::Path;

/// One language's toolchain, as far as writing a starter needs to know it.
///
/// Every field exists because a real task paid for its absence. `accept` is the command
/// nobody had run; `writes` is the lock file a build rewrites, which cost a task its
/// scope check; `caches` is the directory a worktree would otherwise rebuild from cold.
#[derive(Debug)]
pub struct Toolchain {
    /// What goes into `[project] language`, and what `--language` is matched against.
    pub name: &'static str,
    /// Other spellings that mean this one.
    aliases: &'static [&'static str],
    /// Files whose presence in a repository means this toolchain. Detection order is
    /// the table's; see [`detect`].
    manifests: &'static [&'static str],
    /// The acceptance commands for the kinds that change code: the suite, then the
    /// check that would fail review anyway. Written in full, because a command that has
    /// to be completed by hand is a command nobody has run.
    pub accept: &'static [&'static str],
    /// Variable and directory leaf for `[project.build_cache]`. Only caches that are
    /// safe to share between checkouts of one repository are listed — a package cache
    /// or a compiler output directory, never an environment a task could be resolving
    /// while another reads it.
    caches: &'static [(&'static str, &'static str)],
    /// Tracked files a build rewrites. These are what a write scope forgets.
    pub writes: &'static [&'static str],
    /// The write scope a code task usually needs here, for the subtask example.
    pub sources: &'static [&'static str],
    /// One line for the reader of `wecode playbook feature`: how work splits in this
    /// toolchain, or what its test command actually does. Prose, carried and not parsed.
    pub note: &'static str,
    /// A comment for whoever edits the file, where the usual commands have a common
    /// alternative worth naming. Rendered verbatim near the top, `#` and all; empty
    /// where there is nothing honest to say.
    pub hint: &'static str,
}

impl Toolchain {
    /// Whether this is the toolchain `language` names, in any of its usual spellings.
    fn answers_to(&self, language: &str) -> bool {
        let want = language.trim().to_ascii_lowercase();
        self.name == want || self.aliases.contains(&want.as_str())
    }

    /// The shared build cache to declare, as variable and path.
    ///
    /// Keyed on the repository's directory name rather than its full path: two
    /// worktrees of one repository must land on the same directory, and they differ in
    /// exactly that path. The consequence — two unrelated repositories with the same
    /// directory name share a cache — costs a rebuild and no correctness, and the
    /// starter says in the file which line to change.
    #[must_use]
    pub fn cache(&self, repo: &str) -> Vec<(&'static str, String)> {
        self.caches
            .iter()
            .map(|(var, leaf)| (*var, format!("~/.cache/wecode/{repo}/{leaf}")))
            .collect()
    }

    /// The sentence every code kind's guidance carries.
    ///
    /// This is the one fact from this table that reaches a planner rather than a
    /// machine, and it is the expensive one: a build rewrites a lock file, the task that
    /// added a dependency did not name it in its write scope, and verification reports
    /// the work as reaching outside — after the budget is spent.
    #[must_use]
    pub fn dirt(&self) -> String {
        format!(
            "A build rewrites {} — a task that adds or updates a dependency must name {} \
             in its write scope, or verification reports the change as outside it.",
            self.writes.join(" and "),
            if self.writes.len() == 1 { "it" } else { "them" }
        )
    }
}

/// The table. Order is detection order, and detection stops at the first match.
static TOOLCHAINS: &[Toolchain] = &[
    Toolchain {
        name: "rust",
        aliases: &["rs"],
        manifests: &["Cargo.toml"],
        accept: &[
            "cargo test --workspace",
            "cargo clippy --all-targets -- -D warnings",
        ],
        caches: &[("CARGO_TARGET_DIR", "target")],
        writes: &["Cargo.lock"],
        sources: &["crates/**", "src/**", "Cargo.toml", "Cargo.lock"],
        note: "Work splits along crate boundaries, and the split is ordered: a type in \
               one crate and its use in another is two subtasks in that order.",
        hint: "",
    },
    Toolchain {
        name: "go",
        aliases: &["golang"],
        manifests: &["go.mod"],
        accept: &["go test ./...", "go vet ./..."],
        caches: &[("GOCACHE", "go-build"), ("GOMODCACHE", "go-mod")],
        writes: &["go.mod", "go.sum"],
        sources: &["**/*.go", "go.mod", "go.sum"],
        note: "`go test ./...` compiles every package, so a task that breaks one it \
               never opened fails here rather than in somebody else's task.",
        hint: "",
    },
    Toolchain {
        name: "python",
        aliases: &["py", "python3"],
        // `pyproject.toml` first: a repo carrying both it and a `requirements.txt` is a
        // project that has moved, and the newer file is the one describing it.
        manifests: &["pyproject.toml", "setup.py", "requirements.txt"],
        accept: &["uv run pytest -q", "uv run ruff check ."],
        caches: &[("UV_CACHE_DIR", "uv")],
        writes: &["uv.lock"],
        sources: &["src/**", "tests/**", "pyproject.toml", "uv.lock"],
        note: "`uv run` uses the project's own locked environment, so a task that needs \
               a new dependency adds it with `uv add` and never installs anything \
               globally.",
        // The one entry where the usual commands are a real guess: a project on pip or
        // poetry has no `uv` and would be refused at load, saying so.
        hint: "# Not a uv project? `python -m pytest -q` and whatever linter it uses. An\n\
               # accept line naming a program this machine does not have refuses the\n\
               # playbook at load, which is where that mistake is cheap to find.\n",
    },
    Toolchain {
        name: "node",
        aliases: &["js", "javascript", "ts", "typescript", "nodejs"],
        manifests: &["package.json"],
        accept: &["npm test"],
        caches: &[("npm_config_cache", "npm")],
        writes: &["package-lock.json"],
        sources: &["src/**", "package.json", "package-lock.json"],
        note: "`npm test` runs whatever the `test` script says — read it before \
               trusting it, since a placeholder script passes every task.",
        hint: "# On pnpm or yarn? Change the accept line and the cache variable together\n\
               # — `pnpm test` with `npm_config_cache` set is half a setting.\n",
    },
];

/// Every toolchain a starter can be written for.
#[must_use]
pub fn all() -> &'static [Toolchain] {
    TOOLCHAINS
}

/// The toolchain a language names, if this table has it.
///
/// An unknown language is `None` rather than an error: the starter still gets written,
/// with the prompts it always had, and a project whose language wecode has never heard
/// of is not a project wecode should refuse to scaffold.
#[must_use]
pub fn of(language: &str) -> Option<&'static Toolchain> {
    TOOLCHAINS.iter().find(|t| t.answers_to(language))
}

/// What a repository says it is, read off the manifest at its root, with the file that
/// decided it.
///
/// Shallow on purpose — the root only. Walking the tree would find the `package.json`
/// of a docs site inside a Rust workspace and call the project TypeScript, and a wrong
/// answer here is a starter full of commands for the wrong language.
///
/// The first match in table order wins, so a repository carrying two manifests gets the
/// compiled one. That is a guess, which is why `playbook init` reports which file it
/// read and `--language` overrides it.
#[must_use]
pub fn detect(repo: &Path) -> Option<(&'static Toolchain, &'static str)> {
    TOOLCHAINS.iter().find_map(|t| {
        t.manifests
            .iter()
            .find(|m| repo.join(m).is_file())
            .map(|m| (t, *m))
    })
}

/// The languages this table has, for a message that would otherwise say only "no".
#[must_use]
pub fn known() -> String {
    TOOLCHAINS
        .iter()
        .map(|t| t.name)
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-tc-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_language_is_found_by_name_or_by_the_way_people_write_it() {
        assert_eq!(of("rust").unwrap().name, "rust");
        assert_eq!(of("Rust").unwrap().name, "rust");
        assert_eq!(of("  rs ").unwrap().name, "rust");
        assert_eq!(of("typescript").unwrap().name, "node");
        assert_eq!(of("golang").unwrap().name, "go");
    }

    #[test]
    fn a_language_the_table_does_not_have_is_none_and_not_an_error() {
        // The fallback the whole design rests on: a starter is still written, with the
        // prompts it always had.
        assert!(of("cobol").is_none());
        assert!(of("").is_none());
    }

    #[test]
    fn a_repository_is_read_off_its_manifest_and_says_which_one() {
        let repo = temp("detect-rust");
        std::fs::write(repo.join("Cargo.toml"), "[package]\n").unwrap();
        let (t, from) = detect(&repo).unwrap();
        assert_eq!(t.name, "rust");
        assert_eq!(from, "Cargo.toml");
    }

    #[test]
    fn a_repository_that_names_nothing_is_not_guessed_at() {
        assert!(detect(&temp("detect-nothing")).is_none());
    }

    #[test]
    fn two_manifests_take_the_first_in_table_order() {
        // A Rust workspace with a docs site in it is still a Rust workspace. The guess
        // is reported by `playbook init`, and `--language` overrides it.
        let repo = temp("detect-both");
        std::fs::write(repo.join("Cargo.toml"), "[package]\n").unwrap();
        std::fs::write(repo.join("package.json"), "{}\n").unwrap();
        assert_eq!(detect(&repo).unwrap().0.name, "rust");
    }

    #[test]
    fn a_manifest_is_a_file_at_the_root_and_not_a_directory_named_like_one() {
        let repo = temp("detect-dir");
        std::fs::create_dir(repo.join("go.mod")).unwrap();
        assert!(detect(&repo).is_none());
    }

    #[test]
    fn every_toolchain_states_the_four_things_a_starter_needs() {
        // A row added with a field left empty would write a starter that is silently
        // back to the TODO template for that half of it.
        for t in all() {
            assert!(!t.accept.is_empty(), "{} has no accept", t.name);
            assert!(!t.caches.is_empty(), "{} shares nothing", t.name);
            assert!(!t.writes.is_empty(), "{} dirties nothing", t.name);
            assert!(!t.sources.is_empty(), "{} has no write scope", t.name);
            assert!(!t.note.is_empty(), "{} says nothing", t.name);
            assert!(!t.manifests.is_empty(), "{} is undetectable", t.name);
        }
    }

    #[test]
    fn a_cache_path_lands_outside_every_worktree_and_names_the_repository() {
        // Under `~/`, or the playbook refuses it — the rule that keeps a "shared" cache
        // from resolving inside whichever worktree is running.
        for t in all() {
            for (var, dir) in t.cache("app") {
                assert!(dir.starts_with("~/"), "{var} = {dir}");
                assert!(dir.contains("/app/"), "{var} = {dir}");
            }
        }
    }

    #[test]
    fn the_dirt_line_names_the_files_a_build_rewrites() {
        let rust = of("rust").unwrap().dirt();
        assert!(rust.contains("Cargo.lock"), "{rust}");
        assert!(rust.contains("write scope"), "{rust}");

        // Plural where there are two, because the sentence is read by a person.
        let go = of("go").unwrap().dirt();
        assert!(go.contains("go.mod and go.sum"), "{go}");
        assert!(go.contains("name them"), "{go}");
    }

    #[test]
    fn known_lists_what_can_be_written_for() {
        let k = known();
        for t in all() {
            assert!(k.contains(t.name), "{k}");
        }
    }
}
