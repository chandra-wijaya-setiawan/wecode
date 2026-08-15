//! The file `wecode playbook init` writes, and the one module here that *writes*
//! configuration rather than reading it.
//!
//! What can be stated without knowing the project is decided by its language: the
//! acceptance commands, the shared build cache, the write scope a build dirties. All
//! three come from [`crate::toolchain`], which is read once, here, and never again —
//! what it produces is hand-edited from there like everything else in this crate.
//!
//! The guidance itself is left as prompts rather than invented: only whoever works on
//! this project knows how its work should be broken down.
//!
//! Nothing here consults the machine. A starter may name a command this machine does
//! not have, and saying so is [`super::Playbook::at`]'s job — `init` writes the file
//! and reports the refusal, rather than choosing commands by looking at the machine it
//! happens to be run on.

use std::fs;
use std::path::{Path, PathBuf};

use super::{PLAYBOOK_PATH, PlaybookError};
use crate::toolchain::{self, Toolchain};

/// What `init` wrote, and what it decided along the way.
///
/// Returned rather than printed here: which language was used and where it came from is
/// the part a person has to check, and this crate does not own the terminal.
#[derive(Debug)]
pub struct Written {
    pub path: PathBuf,
    /// What went into `[project] language` — given, read off the repository, or empty.
    pub language: String,
    /// The manifest the language was read from, when nobody said. `None` means the
    /// caller named it, or nothing named it.
    pub detected_from: Option<&'static str>,
    /// The toolchain the file was written for, if the language named one. `None` means
    /// the starter is the prompts-and-TODO one.
    pub toolchain: Option<&'static Toolchain>,
    /// The build cache the file declares, resolved for this repository.
    pub cache: Vec<(&'static str, String)>,
}

/// Writes a starter playbook into a repository. Refuses to overwrite.
///
/// The language decides everything that can be stated without knowing the project: the
/// acceptance commands, the shared build cache, the write scope a build dirties. It is
/// read off the repository's own manifest when the caller does not say, because the
/// repository already knows and asking twice is how `--language` gets left off.
///
/// The guidance itself is still left as prompts rather than invented: only whoever works
/// on this project knows how its work should be broken down.
pub fn init(repo: &Path, language: &str) -> Result<Written, PlaybookError> {
    let path = repo.join(PLAYBOOK_PATH);
    if path.exists() {
        return Err(PlaybookError::AlreadyExists(path));
    }
    // Nobody said is the common case, and the repository can answer it. A language that
    // *was* given wins even where it disagrees with the manifest: a repo carrying two of
    // them is exactly where a person needs the last word.
    let (language, detected_from) = match (language.trim(), toolchain::detect(repo)) {
        ("", Some((t, from))) => (t.name.to_string(), Some(from)),
        (given, _) => (given.to_string(), None),
    };
    let name = slug(repo.file_name().map_or("", |n| n.to_str().unwrap_or("")));
    let toolchain = toolchain::of(&language);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, starter(&language, &name))?;
    Ok(Written {
        path,
        language,
        detected_from,
        toolchain,
        cache: toolchain.map(|t| t.cache(&name)).unwrap_or_default(),
    })
}

/// A repository's directory name, reduced to what a path and a TOML string can both
/// hold. Empty becomes `project`, so the cache path never has an empty segment.
fn slug(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "project".to_string()
    } else {
        cleaned
    }
}

/// Wraps generated prose to the width the rest of the file is written at.
///
/// The toolchain table states each sentence as one line, because a table is not the
/// place to decide line breaks. Pasted in unbroken they would be the only 150-column
/// lines in a file whose whole purpose is being read and edited by hand.
fn wrap(text: &str, width: usize) -> String {
    let mut out = String::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > width {
            out.push_str(&line);
            out.push('\n');
            line.clear();
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    out.push_str(&line);
    out
}

/// One TOML list of strings. The values come from this crate's own table and from a
/// directory name that [`slug`] has already reduced, so there is nothing here to escape.
fn toml_list(items: &[&str]) -> String {
    format!(
        "[{}]",
        items
            .iter()
            .map(|i| format!("\"{i}\""))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// The `[project.build_cache]` block a toolchain gets: live, not commented.
///
/// Commented-out would have been the timid choice and the wrong one — the cost this
/// closes is paid by the *first* task, before anyone has read far enough down the file
/// to uncomment anything. A project that would rather have cold builds deletes two
/// lines, and the block says so.
fn cache_block(t: &Toolchain, repo: &str) -> String {
    let mut out = String::from(
        "# Directories every worktree of this project shares, so a task is not a cold
# build. Each key is the environment variable a toolchain reads; each value is a
# directory outside every worktree. wecode creates them and sets them on the agent and
# on the acceptance commands alike, since both build.
#
# The path is keyed on this repository's directory name: change it if two repositories
# here share one, and delete the block to give every worktree its own build from
# scratch.

[project.build_cache]
",
    );
    for (var, dir) in t.cache(repo) {
        out.push_str(&format!("{var} = \"{dir}\"\n"));
    }
    out
}

/// The commented example a project with no known toolchain gets instead.
fn cache_example() -> String {
    String::from(
        "# Directories every worktree of this project shares, so a task does not pay for a cold
# build. Each key is the environment variable a toolchain reads; each value is a
# directory outside every worktree — absolute, or under `~/`. Set on the agent and on
# the acceptance commands alike, since both build.
#
# [project.build_cache]
# CARGO_TARGET_DIR = \"~/.cache/wecode/this-repo/target\"
",
    )
}

/// The starter file. Kept as one string so `init` and the tests agree by
/// construction.
///
/// `language` decides which toolchain's commands are written; `repo` is the repository's
/// directory name, which the shared cache path is keyed on. A language no toolchain
/// answers to gets the prompts-and-TODO file this always wrote, and a line at the top
/// saying which languages would have got more.
#[must_use]
pub fn starter(language: &str, repo: &str) -> String {
    let tc = toolchain::of(language);
    let repo = slug(repo);

    let header = match tc {
        Some(t) => format!(
            "# The accept lines below are {}'s usual commands rather than this project's:\n\
             # run them once before you trust them, and change whatever this repo does\n\
             # differently.\n{}",
            t.name, t.hint
        ),
        None if language.trim().is_empty() => format!(
            "# No language was given and none could be read off this repository, so the\n\
             # accept lines are empty and every guidance is TODO. wecode can write a\n\
             # starter that knows: {}.\n",
            toolchain::known()
        ),
        None => format!(
            "# wecode has no toolchain for `{language}`, so the accept lines are empty and\n\
             # every guidance is TODO. It knows: {}.\n",
            toolchain::known()
        ),
    };
    let accept = tc.map_or_else(
        || "accept    = []            # e.g. [\"cargo test --workspace\"]".to_string(),
        |t| format!("accept    = {}", toml_list(t.accept)),
    );
    let cache = tc.map_or_else(cache_example, |t| cache_block(t, &repo));
    // The dirt line goes in every kind that changes code, because a planner reads one
    // kind and not the file. The seam note goes only where decomposition is decided.
    let dirt = tc.map_or_else(String::new, |t| format!("\n{}\n", wrap(&t.dirt(), 85)));
    let note = tc.map_or_else(String::new, |t| {
        format!("\n{}\n{}\n", wrap(&t.dirt(), 85), wrap(t.note, 85))
    });
    let sources = tc.map_or_else(|| toml_list(&["src/**"]), |t| toml_list(t.sources));

    format!(
        r#"# How work is broken down in this project.
#
# Read by whoever decomposes a request into tasks — usually an orchestrator agent,
# via `wecode playbook <kind>`. It is guidance, not a workflow anything runs: the
# tasks it produces are still checked by the admission gate.
#
# Committed to the repo on purpose, so it is versioned with the code it describes.
# `.wecode/run/` is the worker-writable area and should be gitignored; this file
# should not be.
#
{header}
[project]
language = "{language}"
# The integration branch. Task branches are cut from it, and merge back into it.
# merge_to = "dev"
#
# Whether verified work lands by itself. `approved` (the default) waits for a
# signature; `auto` merges and reports what it did. The charter still outranks this —
# a branch it protects needs a signature whatever this says.
# merge = "approved"
#
# Whether a task may be dispatched before anyone signs for it. `auto` (the default)
# lets the admission gate be the only door; `approved` means no agent is spawned until
# a holder signs — `wecode approve admission --task <id>`. Turn it on where the work is
# planned by an agent, so a person sees each task before its budget is spent.
# dispatch = "approved"

{cache}
[feature]
worktree  = true
# Refuse a feature at admission unless a `design` task stands before it. A design
# waits for a signature once it passes, so nothing is built until a person signs.
# design_required = true
assign_to = "impl"
tokens    = 120000
wall_secs = 5400
{accept}
guidance  = """
TODO: how should a feature be broken down here?
Acceptance must be an executable command, never a description.
{note}"""
# The decomposition `wecode task add <id> ... --expand` emits. Uncomment to use it;
# without `subtasks` there is nothing to expand and the flag is refused.
#
# Order is this list. Every name needs a block, and each block states only what
# makes that step different — kind, accept, budget and assignee otherwise fall
# through to the playbook for the step's own kind, as a hand-written task would.
# `{{{{task}}}}` is the main task's id and `{{{{title}}}}` its title.
#
# subtasks = ["design", "build", "docs"]
#
# [feature.design]
# kind   = "design"                 # not finished when it passes: it waits for a signature
# write  = ["docs/wecode/{{{{task}}}}/design.md"]
# accept = ["test -f docs/wecode/{{{{task}}}}/design.md"]
#
# [feature.build]
# after  = ["design"]               # sibling names, not task ids
# write  = {sources}
#
# [feature.docs]
# after  = ["build"]
# kind   = "docs"
# write  = ["README.md", "docs/**"]

[bug]
worktree  = true
assign_to = "impl"
tokens    = 60000
wall_secs = 2700
{accept}
guidance  = """
TODO. A shape that works well: reproduce first, then a failing regression test,
then the fix. One cause per task. If the cause is unclear, make a spike subtask
first — a spike needs no write scope.
{dirt}"""

[refactor]
worktree  = true
assign_to = "impl"
tokens    = 90000
wall_secs = 3600
{accept}
guidance  = """
TODO. Behaviour must not change, so the acceptance is the existing suite passing
unchanged. Needing to edit a test means this is not a refactor.
{dirt}"""

[chore]
worktree  = true
assign_to = "impl"
tokens    = 40000
wall_secs = 1800
{accept}
guidance  = """
TODO.
{dirt}"""

[spike]
worktree  = false
assign_to = "impl"
tokens    = 30000
wall_secs = 1800
guidance  = """
TODO. A spike answers a question and needs no write scope. Say where the answer
should be written down.
"""

[design]
worktree  = false
assign_to = "impl"
tokens    = 40000
wall_secs = 1800
accept    = ["test -f docs/wecode/{{{{task}}}}/design.md"]
guidance  = """
TODO. A design proposes a change and writes no code. It is the only kind that is not
finished when it passes: it goes to needs-approval and waits for a signature, because
whether a design is right is the part no command can check.

Say what a design here must decide before anyone builds against it.
"""

[docs]
worktree  = false
assign_to = "impl"
tokens    = 30000
wall_secs = 1800
guidance  = "TODO."
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::TaskKind;

    use crate::playbook::{Playbook, program_of, temp, with_the_template_live};

    /// Every language the starter is written for, plus one it is not.
    fn languages() -> Vec<&'static str> {
        let mut all: Vec<&str> = toolchain::all().iter().map(|t| t.name).collect();
        all.push("cobol");
        all
    }

    #[test]
    fn init_writes_a_file_that_parses_and_refuses_to_overwrite() {
        let repo = temp("init");
        let w = init(&repo, "rust").unwrap();
        assert!(w.path.ends_with(PLAYBOOK_PATH));

        // The starter must be valid, or adoption fails at the first step. Parsed rather
        // than loaded: whether this machine has `cargo` is a separate question, and the
        // one `playbook init` reports rather than decides.
        let loaded = Playbook::parse(&fs::read_to_string(&w.path).unwrap())
            .expect("the written playbook parses");
        assert_eq!(loaded.project.language, "rust");
        assert!(loaded.for_kind(TaskKind::Bug).unwrap().worktree);
        assert!(!loaded.for_kind(TaskKind::Docs).unwrap().worktree);

        assert!(matches!(
            init(&repo, "rust").unwrap_err(),
            PlaybookError::AlreadyExists(_)
        ));
    }

    #[test]
    fn every_starter_kind_carries_a_budget() {
        // Without one the gate refuses the task, and the starter would produce
        // nothing admissible. Checked for every toolchain and for none of them, since
        // the file is now assembled differently in each case.
        for language in languages() {
            let p = Playbook::parse(&starter(language, "app")).unwrap();
            for (kind, k) in p.kinds() {
                assert!(
                    k.tokens.is_some(),
                    "{language}: {kind:?} has no token budget"
                );
                assert!(
                    k.wall_secs.is_some(),
                    "{language}: {kind:?} has no wall budget"
                );
            }
        }
    }

    #[test]
    fn the_starter_ships_the_template_commented_out() {
        // Uncommenting it must work: the example sits after `guidance`, so the
        // sub-tables it introduces do not swallow the fields above them.
        for language in languages() {
            let text = starter(language, "app");
            let p =
                Playbook::parse(&with_the_template_live(&text)).expect("the example is valid TOML");
            let k = p.for_kind(TaskKind::Feature).unwrap();
            assert_eq!(k.subtasks.len(), 3, "{language}");
            assert!(
                !k.guidance.is_empty(),
                "{language}: uncommenting must not move guidance into a sub-table"
            );
            assert_eq!(
                k.expand(TaskKind::Feature, "retry", "a title")[0].write,
                vec!["docs/wecode/retry/design.md".to_string()]
            );
        }
    }

    #[test]
    fn the_starter_covers_every_kind() {
        // A kind added to core without a starter section would silently get no
        // guidance in every new project — in any language.
        for language in languages() {
            let p = Playbook::parse(&starter(language, "app")).unwrap();
            for k in TaskKind::all() {
                assert!(
                    p.for_kind(*k).is_some(),
                    "{language}: {k:?} missing from the starter"
                );
            }
        }
    }

    #[test]
    fn a_known_language_arrives_with_the_commands_that_judge_it() {
        // The gap this closes: `accept = []` in every new project, so the first task
        // of every kind was accepted by nothing until somebody typed a command in.
        let p = Playbook::parse(&starter("rust", "app")).unwrap();
        for kind in [
            TaskKind::Feature,
            TaskKind::Bug,
            TaskKind::Refactor,
            TaskKind::Chore,
        ] {
            assert_eq!(
                p.for_kind(kind).unwrap().accept,
                vec![
                    "cargo test --workspace".to_string(),
                    "cargo clippy --all-targets -- -D warnings".to_string(),
                ],
                "{kind:?}"
            );
        }
        // A design is judged by its file existing, whatever the language is.
        assert_eq!(
            p.for_kind(TaskKind::Design).unwrap().accept,
            vec!["test -f docs/wecode/{{task}}/design.md".to_string()]
        );
    }

    #[test]
    fn an_unknown_language_gets_the_file_it_always_got_and_says_so() {
        let text = starter("cobol", "app");
        let p = Playbook::parse(&text).unwrap();
        assert_eq!(p.project.language, "cobol");
        assert!(p.for_kind(TaskKind::Bug).unwrap().accept.is_empty());
        assert!(p.project.build_cache.is_empty());
        // And the file names what it could have written instead, since a person who
        // mistyped `rsut` has no other way to find out.
        assert!(text.contains("no toolchain for `cobol`"), "{text}");
        assert!(text.contains("rust"), "{text}");
    }

    #[test]
    fn every_toolchain_writes_a_playbook_that_parses_whole() {
        // One table row with a stray quote or a relative cache path would produce a
        // file that refuses itself, in a repository that has nothing else yet.
        for t in toolchain::all() {
            let p = Playbook::parse(&starter(t.name, "app"))
                .unwrap_or_else(|e| panic!("{}: {e}", t.name));
            assert_eq!(p.project.language, t.name);
            assert_eq!(p.for_kind(TaskKind::Feature).unwrap().accept, t.accept);
            assert_eq!(p.project.build_cache.len(), t.cache("app").len());
        }
    }

    #[test]
    fn every_accept_command_a_starter_writes_can_be_checked_against_the_machine() {
        // The load-time check reads a line's first word and stays silent where it
        // cannot. A table entry it could not read would be a command promising a
        // toolchain with nothing verifying the machine has it.
        for t in toolchain::all() {
            for cmd in t.accept {
                assert!(
                    program_of(cmd).is_some(),
                    "{}: `{cmd}` is not readable by the machine check",
                    t.name
                );
            }
        }
    }

    /// Guidance as one line, so an assertion is about the words and not about where
    /// the wrapping happened to break them.
    fn flat(text: &str) -> String {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn a_code_kind_says_what_a_build_rewrites() {
        // The trap that cost a task: `uv.lock` changed by the build, no such glob in
        // the write scope, and the work reported as reaching outside it. The planner
        // reads one kind, so the sentence goes in each kind that changes code.
        let p = Playbook::parse(&starter("python", "app")).unwrap();
        for kind in [TaskKind::Feature, TaskKind::Bug, TaskKind::Chore] {
            let g = flat(&p.for_kind(kind).unwrap().guidance);
            assert!(g.contains("rewrites uv.lock"), "{kind:?}: {g}");
            assert!(g.contains("write scope"), "{kind:?}: {g}");
        }
        // And where the decomposition is decided, how the work splits.
        assert!(flat(&p.for_kind(TaskKind::Feature).unwrap().guidance).contains("uv add"));
    }

    #[test]
    fn generated_prose_is_wrapped_to_the_width_the_file_is_written_at() {
        // A 150-column line in a file whose whole purpose is being read and edited by
        // hand. The table states each sentence as one line; the wrapping is here.
        for language in languages() {
            for line in starter(language, "app").lines() {
                assert!(
                    line.chars().count() <= 100,
                    "{language}: {} columns: {line}",
                    line.chars().count()
                );
            }
        }
    }

    #[test]
    fn init_reads_the_language_off_the_repository_when_nobody_says() {
        let repo = temp("init-detect");
        fs::write(repo.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();

        let w = init(&repo, "").unwrap();
        assert_eq!(w.language, "rust");
        assert_eq!(w.detected_from, Some("Cargo.toml"));
        assert_eq!(w.toolchain.map(|t| t.name), Some("rust"));
        assert_eq!(w.cache[0].0, "CARGO_TARGET_DIR");
        // The cache is keyed on the repository's directory name, so two projects on
        // this machine do not queue behind one another's build lock for no reason.
        assert!(
            w.cache[0].1.ends_with("/wecode-pb-init-detect/target"),
            "{:?}",
            w.cache
        );
    }

    #[test]
    fn a_language_that_was_given_beats_the_one_that_can_be_seen() {
        // A repository carrying two manifests is exactly where a person needs the last
        // word, and saying it must not be silently overruled by a file.
        let repo = temp("init-override");
        fs::write(repo.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();

        let w = init(&repo, "python").unwrap();
        assert_eq!(w.language, "python");
        assert_eq!(w.detected_from, None, "nothing was detected — it was told");
        assert_eq!(
            Playbook::parse(&fs::read_to_string(&w.path).unwrap())
                .unwrap()
                .for_kind(TaskKind::Bug)
                .unwrap()
                .accept[0],
            "uv run pytest -q"
        );
    }

    #[test]
    fn a_repository_that_names_no_language_still_gets_a_playbook() {
        let repo = temp("init-nothing");
        let w = init(&repo, "").unwrap();
        assert!(w.language.is_empty());
        assert!(w.toolchain.is_none());
        assert!(w.cache.is_empty());

        // And it loads, because nothing in it names a program: the TODO file is the
        // one that could never be refused by the machine check.
        let loaded = Playbook::at(&repo).unwrap().expect("the starter loads");
        assert!(
            loaded
                .for_kind(TaskKind::Feature)
                .unwrap()
                .accept
                .is_empty()
        );
    }

    #[test]
    fn a_repository_name_that_is_not_a_path_segment_is_reduced_to_one() {
        // The cache path is a directory and a TOML string at once. A repo called
        // `my repo "2"` must break neither.
        let repo = temp("init slug \"x\"");
        let w = init(&repo, "rust").unwrap();
        assert_eq!(
            w.cache[0].1,
            "~/.cache/wecode/wecode-pb-init-slug--x-/target"
        );
        Playbook::parse(&fs::read_to_string(&w.path).unwrap()).expect("still valid TOML");
    }
}
