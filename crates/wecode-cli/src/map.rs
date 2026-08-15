//! The shape of a repository, read off its tree.
//!
//! An agent dropped into a checkout it has never seen spends its first minutes — and a
//! measurable part of a budget the task is held to — running `find`, `wc -l` and `head`
//! to learn what the tree is. Every one of those answers is already in the tree at the
//! moment the envelope is assembled, so this reads them once, on the way past, and
//! writes them down. It is the same principle the rest of the handoff rests on: what
//! wecode can observe, it observes, rather than asking the agent to go and look.
//!
//! Four decisions:
//!
//! - **The index, not a directory walk.** A walk finds `target/`, which is 890 MB of
//!   build state in one worktree of this repo and none of it the shape of anything. What
//!   git tracks is what the repository *is*, and it is one subprocess to ask.
//! - **Detail where the task may write, a count everywhere else.** The scope already
//!   says which part of the tree this run is about. Naming every file of a large repo
//!   would spend the instruction on directories the agent will never open, and a map
//!   that crowds out the task is worse than no map.
//! - **Each file describes itself.** The first line of a Rust module's `//!`, a
//!   document's first heading, a config's first comment. A summary wecode invented would
//!   be one more thing that can quietly stop being true; a line lifted out of the file
//!   is wrong only when the file is.
//! - **Bounded by counts, not by bytes.** How many directories, how many files, how many
//!   directories of one family — a cap applied to the text at the end would cut the tail,
//!   and the tail is not the least informative part of a tree. Whatever is left out is
//!   still counted, because a map that stops quietly reads as a tree that ends there.

use std::collections::BTreeMap;
use std::path::Path;

use wecode_gov::glob;

use crate::git;
use crate::render::truncate_cmd;

/// How many directories the map names one by one before the rest become a count.
const SHOWN_DIRS: usize = 20;

/// How many directories sharing one parent it names before that family becomes a count.
///
/// Size alone is the wrong ranking on its own: this repository keeps a directory per
/// finished task under `docs/wecode/`, and thirty-eight of them, two files each, would
/// take every row a crate wanted while saying the same thing thirty-eight times. The top
/// level is exempt — everything directly under the root is there for a different reason,
/// and that is precisely the level a shape is read at.
const SIBLINGS: usize = 3;

/// How many files it names, across every directory it opens up. Spent on the
/// directories this task may write to, the largest first.
const DETAIL_ROWS: usize = 60;

/// How much of a file's own first line to quote. A column the reader scans down, so it
/// is cut to a width rather than to a sentence.
const SUMMARY_CAP: usize = 56;

/// The widest a name is padded to before the columns after it give way. A minimum, not
/// a limit: a path an agent has to type is never truncated.
const NAME_COL: usize = 28;

/// The largest file this opens. Past it the tree is being described rather than read —
/// a checked-in binary has no first line worth quoting, and its "lines" say nothing.
const READ_CAP: u64 = 512 * 1024;

/// How far into a file a description of the file can be. A module doc is the first thing
/// in a Rust file and a heading is the first thing in a document; further down is a
/// comment about some code rather than about the whole.
const HEAD_LINES: usize = 12;

/// The files an anchor is looked for among, in the order a directory is best described.
/// A README says what a directory is for; failing that, the module that defines it.
const ANCHORS: [&str; 4] = ["README.md", "lib.rs", "mod.rs", "main.rs"];

/// One tracked file, before anything has been read.
struct Named {
    name: String,
    rel: String,
    writable: bool,
}

/// One directory of them.
struct Dir {
    path: String,
    files: Vec<Named>,
    /// Whether the task may write anywhere inside it.
    writable: bool,
    /// How many of `files` are named one by one. The rest are a count.
    shown: usize,
}

/// What was left out, so the map can say so rather than appear to end.
struct Dropped {
    dirs: usize,
    files: usize,
}

/// The map of the repository standing at `root`, as the task allowed to write `write`
/// should see it.
///
/// `None` when there is nothing to map: `root` is not a git working tree, or git is not
/// installed, or the tree is empty. The handoff omits the section rather than printing a
/// heading over an apology — an agent told the repository could not be read learns
/// nothing it cannot find out by looking.
pub(crate) fn of(root: &Path, write: &[String]) -> Option<String> {
    let tracked = git::tracked_files(root).ok()?;
    if tracked.is_empty() {
        return None;
    }
    let (dirs, dropped) = shape(&tracked, write);
    Some(render(root, &dirs, tracked.len(), &dropped))
}

/// Which directories the map names, which of them it opens up, and how far.
///
/// Pure, and separate from the reading below, because this is the half with a decision
/// in it: everything about what a repository looks like from outside is here, and
/// nothing here touches a disk.
fn shape(tracked: &[String], write: &[String]) -> (Vec<Dir>, Dropped) {
    let mut ranked = grouped(tracked, write);

    // Ranked by weight before anything is cut, so what survives a cap is the part of the
    // tree there is most of. A directory the task may write to wins a tie: between two
    // of the same size, the one the work is in is the one worth naming.
    ranked.sort_by(|a, b| {
        b.files
            .len()
            .cmp(&a.files.len())
            .then(b.writable.cmp(&a.writable))
            .then(a.path.cmp(&b.path))
    });

    let (mut dirs, dropped) = select(ranked);

    // The file-by-file budget, spent in that same order and only on what this task may
    // write. Elsewhere a count is the whole of what a reader needs.
    let mut budget = DETAIL_ROWS;
    for d in dirs.iter_mut().filter(|d| d.writable) {
        d.shown = d.files.len().min(budget);
        budget -= d.shown;
    }

    // Printed as a tree is read, whatever the ranking decided.
    dirs.sort_by(|a, b| a.path.cmp(&b.path));
    for d in &mut dirs {
        d.files.sort_by(|a, b| a.name.cmp(&b.name));
    }
    (dirs, dropped)
}

/// Every tracked file under the directory holding it, and whether the task may write it.
fn grouped(tracked: &[String], write: &[String]) -> Vec<Dir> {
    let mut by_dir: BTreeMap<String, Vec<Named>> = BTreeMap::new();
    for rel in tracked {
        let (dir, name) = split(rel);
        by_dir.entry(dir).or_default().push(Named {
            name,
            rel: rel.clone(),
            writable: glob::any_matches(write, rel),
        });
    }
    by_dir
        .into_iter()
        .map(|(path, files)| Dir {
            writable: files.iter().any(|f| f.writable),
            path,
            files,
            shown: 0,
        })
        .collect()
}

/// The directories the map names, taken in rank order, and the count of what it does not.
///
/// Two rules, and the second is the one that earns its keep: [`SHOWN_DIRS`] bounds the
/// whole map, and [`SIBLINGS`] bounds one family of it. Without the family rule, ranking
/// by size alone gave this repository's own map five directories of finished-task notes
/// and left a whole crate out of it.
fn select(ranked: Vec<Dir>) -> (Vec<Dir>, Dropped) {
    let mut dropped = Dropped { dirs: 0, files: 0 };
    let mut family: BTreeMap<String, usize> = BTreeMap::new();
    let mut kept: Vec<Dir> = Vec::new();
    for d in ranked {
        let parent = split(&d.path).0;
        let seen = family.entry(parent.clone()).or_insert(0);
        if kept.len() < SHOWN_DIRS && (parent == "." || *seen < SIBLINGS) {
            *seen += 1;
            kept.push(d);
        } else {
            dropped.dirs += 1;
            dropped.files += d.files.len();
        }
    }
    (kept, dropped)
}

/// A path split into the directory that holds it and the name inside it. `.` for the
/// root, so files at the top of a repository group like any others.
fn split(rel: &str) -> (String, String) {
    match rel.rsplit_once('/') {
        Some((dir, name)) => (dir.to_string(), name.to_string()),
        None => (".".to_string(), rel.to_string()),
    }
}

fn render(root: &Path, dirs: &[Dir], files: usize, dropped: &Dropped) -> String {
    let writable = dirs.iter().any(|d| d.writable);
    // No heading of its own: where this lands in the instruction is the template's
    // call, exactly as it is for the handoff's artifacts, and a section title written
    // here would be a second one under whatever the template already said.
    let mut out = format!(
        "  {files} files in {} directories, as git had them at dispatch\n  \
         the number beside a file is its lines{}\n\n",
        dirs.len() + dropped.dirs,
        if writable {
            "; ✍ marks what this task may write"
        } else {
            ""
        }
    );

    for d in dirs {
        let head = format!("{}{}", d.path, if d.writable { " ✍" } else { "" });
        let count = format!("{} file{}", d.files.len(), plural(d.files.len()));
        // A directory nobody is going to open says what it is through the file that
        // best describes it; one that is about to be listed says it file by file.
        let summary = if d.shown == 0 {
            anchor(d)
                .and_then(|f| describe(root, &f.rel).1)
                .map(|s| format!("  {s}"))
                .unwrap_or_default()
        } else {
            String::new()
        };
        row(&mut out, &format!("  {head:<40} {count:>9}{summary}"));

        for f in d.files.iter().take(d.shown) {
            let (lines, summary) = describe(root, &f.rel);
            row(
                &mut out,
                &format!(
                    "      {}{:<NAME_COL$}{:>6}  {}",
                    if f.writable { "✍ " } else { "  " },
                    f.name,
                    lines.map(|n| n.to_string()).unwrap_or_default(),
                    summary.unwrap_or_default(),
                ),
            );
        }
        if d.shown > 0 && d.shown < d.files.len() {
            let rest = d.files.len() - d.shown;
            row(&mut out, &format!("        … {rest} more file{}", plural(rest)));
        }
    }

    if dropped.dirs > 0 {
        row(
            &mut out,
            &format!(
                "  … {} more director{}, {} file{}",
                dropped.dirs,
                if dropped.dirs == 1 { "y" } else { "ies" },
                dropped.files,
                plural(dropped.files)
            ),
        );
    }
    out
}

/// One line of the map, without the padding it did not need. A file with nothing to say
/// about itself leaves the last column empty, and trailing spaces in a prompt are one
/// more thing for a reader to wonder about.
fn row(out: &mut String, line: &str) {
    out.push_str(line.trim_end());
    out.push('\n');
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// The file that speaks for a directory, if one of them does.
fn anchor(d: &Dir) -> Option<&Named> {
    ANCHORS
        .iter()
        .find_map(|a| d.files.iter().find(|f| f.name == *a))
}

/// How long a file is, and what it says about itself.
///
/// Both `None` for anything this cannot read: a binary, a file larger than [`READ_CAP`],
/// one that vanished between the index and here. A blank column is honest about that in
/// a way a `0` would not be.
fn describe(root: &Path, rel: &str) -> (Option<usize>, Option<String>) {
    let path = root.join(rel);
    let readable = std::fs::metadata(&path).is_ok_and(|m| m.len() <= READ_CAP);
    if !readable {
        return (None, None);
    }
    match std::fs::read_to_string(&path) {
        Ok(text) => (Some(text.lines().count()), summary(rel, &text)),
        Err(_) => (None, None),
    }
}

/// The one line a file offers about itself, in its own words.
///
/// By extension, because the convention differs and every one of them is a convention
/// somebody follows deliberately: `//!` is a Rust module's own description of itself, a
/// markdown heading is a document's title, and a leading `#` comment is how a config
/// file explains what it configures. Anything else says nothing rather than something
/// invented — the first line of a data file is data.
fn summary(rel: &str, text: &str) -> Option<String> {
    let head = || text.lines().take(HEAD_LINES);
    let ext = Path::new(rel).extension().and_then(|e| e.to_str());
    let found = match ext {
        Some("rs") => head().find_map(|l| l.trim_start().strip_prefix("//!")),
        Some("md") => head()
            .find_map(|l| l.trim_start().strip_prefix("# "))
            .or_else(|| head().find(|l| !l.trim().is_empty())),
        Some("toml" | "yaml" | "yml" | "sh" | "py" | "cfg" | "conf") => head()
            .take_while(|l| l.trim().is_empty() || l.trim_start().starts_with('#'))
            .find_map(|l| l.trim_start().strip_prefix("# ")),
        _ => None,
    }?;
    let line = found.trim();
    (!line.is_empty()).then(|| truncate_cmd(line, SUMMARY_CAP))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracked(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| (*p).to_string()).collect()
    }

    fn scope(globs: &[&str]) -> Vec<String> {
        globs.iter().map(|g| (*g).to_string()).collect()
    }

    #[test]
    fn files_group_under_the_directory_that_holds_them() {
        // The root included: a file at the top of a repository is as much a part of its
        // shape as one three levels down, and dropping it would lose the manifest.
        let (dirs, dropped) = shape(&tracked(&["Cargo.toml", "src/lib.rs", "src/a/b.rs"]), &[]);
        let paths: Vec<&str> = dirs.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, vec![".", "src", "src/a"]);
        assert_eq!(dropped.dirs, 0);
    }

    #[test]
    fn only_what_the_task_may_write_is_listed_file_by_file() {
        // The whole reason the map fits in a prompt. A repository's other directories
        // are still named — the agent has to know they exist — but naming every file in
        // them would spend the instruction on code this task will not open.
        let (dirs, _) = shape(
            &tracked(&["src/a.rs", "src/b.rs", "vendor/x.rs", "vendor/y.rs"]),
            &scope(&["src/**"]),
        );
        let shown: Vec<(&str, usize)> = dirs.iter().map(|d| (d.path.as_str(), d.shown)).collect();
        assert_eq!(shown, vec![("src", 2), ("vendor", 0)]);
    }

    #[test]
    fn the_file_the_scope_names_is_the_one_marked() {
        // A directory is writable because something in it is. Which something is the
        // question the agent actually has, and a mark on the directory alone would
        // answer a wider one than the Broker will.
        let (dirs, _) = shape(&tracked(&["src/a.rs", "src/b.rs"]), &scope(&["src/a.rs"]));
        let marked: Vec<&str> = dirs[0]
            .files
            .iter()
            .filter(|f| f.writable)
            .map(|f| f.name.as_str())
            .collect();
        assert_eq!(marked, vec!["a.rs"]);
        assert!(dirs[0].writable);
    }

    #[test]
    fn a_tree_too_deep_to_name_keeps_its_largest_parts_and_counts_the_rest() {
        // What a cap must not do is stop quietly. This repository keeps a directory per
        // finished task under docs/wecode; before the family rule, five of them took the
        // rows a crate wanted, and the map of a five-crate workspace named two of them.
        let mut paths: Vec<String> = (0..40).map(|i| format!("docs/d{i}/report.md")).collect();
        paths.push("src/lib.rs".into());
        paths.push("src/main.rs".into());

        let (dirs, dropped) = shape(&paths, &scope(&[]));
        let kept: Vec<&str> = dirs.iter().map(|d| d.path.as_str()).collect();
        assert!(kept.contains(&"src"), "the largest was dropped: {kept:?}");
        assert_eq!(
            kept.iter().filter(|p| p.starts_with("docs/")).count(),
            SIBLINGS
        );
        // And what was left out is still counted, rather than the map appearing to end.
        assert_eq!(dropped.dirs, 40 - SIBLINGS);
        assert_eq!(dropped.files, 40 - SIBLINGS);
    }

    #[test]
    fn a_tree_too_wide_to_name_is_capped_at_the_top_level_too() {
        // The family rule exempts the root — everything directly under it is there for
        // a different reason — so the count is what bounds a repository of many.
        let paths: Vec<String> = (0..30).map(|i| format!("pkg{i}/lib.rs")).collect();
        let (dirs, dropped) = shape(&paths, &scope(&[]));
        assert_eq!(dirs.len(), SHOWN_DIRS);
        assert_eq!(dropped.dirs, 30 - SHOWN_DIRS);
    }

    #[test]
    fn the_file_budget_runs_out_rather_than_over() {
        // A scope covering the whole tree must not turn the instruction into a listing.
        let paths: Vec<String> = (0..200).map(|i| format!("src/f{i}.rs")).collect();
        let (dirs, _) = shape(&paths, &scope(&["**"]));
        assert_eq!(dirs[0].shown, DETAIL_ROWS);
        assert_eq!(dirs[0].files.len(), 200);
    }

    #[test]
    fn a_rust_module_is_described_by_its_own_doc_comment() {
        assert_eq!(
            summary("src/spawn.rs", "//! Running an agent, and stopping it.\n\nuse x;\n"),
            Some("Running an agent, and stopping it.".to_string())
        );
        // An inner attribute above the doc is ordinary; a `//` comment about a line of
        // code is not the file describing itself.
        assert_eq!(
            summary("m.rs", "#![allow(dead_code)]\n//! The fixtures.\n"),
            Some("The fixtures.".to_string())
        );
        assert_eq!(summary("m.rs", "// a note\nfn main() {}\n"), None);
    }

    #[test]
    fn a_document_is_described_by_its_heading_and_a_config_by_its_comment() {
        assert_eq!(
            summary("docs/x.md", "# wecode\n\nRun coding agents as staff.\n"),
            Some("wecode".to_string())
        );
        // No heading: the first thing it says is still better than nothing.
        assert_eq!(
            summary("docs/x.md", "\nRun coding agents as staff.\n"),
            Some("Run coding agents as staff.".to_string())
        );
        assert_eq!(
            summary("p.toml", "# How work is broken down.\n[project]\n"),
            Some("How work is broken down.".to_string())
        );
        // A `#` further down is a comment about a setting, not about the file.
        assert_eq!(summary("p.toml", "[project]\n# the branch\n"), None);
    }

    #[test]
    fn a_file_kind_with_no_convention_is_left_undescribed() {
        // The first line of a data file is data. Quoting it would fill the column with
        // noise that reads exactly like a description.
        assert_eq!(summary("src/app.txt", "v1\n"), None);
        assert_eq!(summary("logo.png", "\u{89}PNG\r\n"), None);
    }
}
