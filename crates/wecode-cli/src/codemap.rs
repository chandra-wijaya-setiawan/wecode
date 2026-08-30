//! Reading a repository into names, and keeping what was read.
//!
//! [`crate::map`] answers *what is this tree* — a path, a length, a file's own first
//! line. This answers the next question down: what each file defines, what it names,
//! and therefore which files sit next to the one about to change. The layer above both
//! — which component owns which paths — keeps a human author and is not generated here.
//!
//! Three decisions, and the third is the one that shapes everything else.
//!
//! - **The parse is here, the decision is not.** `wecode-map` takes bytes and returns
//!   names; this module reads the files and hands them over. The same division
//!   `wecode_core::docs` uses, and it is what keeps the C dependency six grammars wide
//!   in one crate and the I/O in another.
//! - **Content addresses content.** A cache entry is keyed on git's blob id, so it can
//!   never be wrong about the file it describes and is never invalidated — only
//!   collected. That is what makes a scan affordable at dispatch, which is what stops
//!   this being a command somebody has to remember: a map is stale exactly when nobody
//!   re-ran it.
//! - **It ranks; it never refuses.** An edge is a matched spelling, not a resolved
//!   name. So the output is an ordering for whoever declares a scope, and admission
//!   goes on comparing globs. For the same reason a row may say *references* and *is
//!   referenced by* and may not say anything stronger — that is a claim about
//!   resolution, and this data cannot support it.

use std::path::{Path, PathBuf};

use wecode_gov::glob;
use wecode_map::{Index, Language, Ranked, Ranking, Tag, TagKind};

use crate::args::Args;
use crate::commands::ctx::{Res, open, repo_path, which_project};
use crate::render::truncate_cmd;
use crate::{git, work};

/// How many ranked files the dispatch envelope carries. Short: it sits under a repo map
/// that already spends forty lines, and what an agent needs is a shortlist to open, not
/// a second listing to read.
const ENVELOPE_ROWS: usize = 12;

/// How many `wecode map` prints. An operator at a terminal is reading this on purpose
/// and can scroll; a worker is not.
const COMMAND_ROWS: usize = 30;

/// The largest file parsed. Past it the thing is generated, vendored or not source at
/// all, and its names describe nothing anybody wrote — the same cap [`crate::map`] uses
/// to decide a file has no first line worth quoting.
const READ_CAP: u64 = 512 * 1024;

/// How many cache entries survive a sweep.
///
/// A ceiling rather than an age: entries are content-addressed, so none of them is ever
/// wrong and the only reason to remove one is that the directory is large. Twenty
/// thousand blobs is several times a working repository's tracked file count and a few
/// tens of megabytes of tags.
const KEEP_ENTRIES: usize = 20_000;

/// The width the path column is padded to before the last column gives way.
const PATH_COL: usize = 46;

/// How much of the shared-name cell is printed. A column the reader scans down.
const SHARED_CAP: usize = 60;

/// What the scan met, so a thin ranking can be read as the tree's shape rather than as
/// a failure nobody mentioned.
///
/// Counted rather than logged, for the reason [`crate::map`] counts what it leaves out:
/// a map that stops quietly reads as a tree that ends there.
#[derive(Default, Debug)]
pub(crate) struct Tally {
    /// Tracked files a grammar claimed.
    pub(crate) mapped: usize,
    /// Of those, answered from the cache without parsing.
    pub(crate) cached: usize,
    /// Of those, parsed on this run.
    pub(crate) parsed: usize,
    /// Tracked files no compiled grammar claims. Most of a repository, and not a fault.
    pub(crate) unmapped: usize,
    /// Files a grammar claimed and that could not be read: too large, or gone since the
    /// index was written.
    pub(crate) unreadable: usize,
    /// Files that parsed and yielded no name at all.
    pub(crate) silent: usize,
}

/// One repository, read into names.
pub(crate) struct Scanned {
    pub(crate) index: Index,
    pub(crate) tally: Tally,
}

impl std::fmt::Debug for Scanned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Scanned").field("tally", &self.tally).finish()
    }
}

/// Every tracked source file in `root`, parsed or recalled.
///
/// `None` when there is nothing to scan — not a git working tree, git is not installed,
/// or the index is empty. The envelope drops the section rather than printing a heading
/// over an apology, exactly as the repo map above it does.
pub(crate) fn scan(root: &Path) -> Option<Scanned> {
    scan_into(root, &cache_dir(root))
}

/// The scan, against a named cache directory.
///
/// The seam exists so the incrementality can be proven: [`cache_dir`] is derived from an
/// environment variable an operator owns, and a test that had to set one would be
/// setting it for every other test in the process. Nothing outside this module chooses
/// the directory.
fn scan_into(root: &Path, dir: &Path) -> Option<Scanned> {
    let blobs = git::tracked_blobs(root).ok()?;
    if blobs.is_empty() {
        return None;
    }
    // A file edited and not staged has an index id naming the bytes it *used* to hold,
    // so it is the one case a content key would answer wrongly. Those are parsed every
    // scan and stored under nothing.
    let dirty = git::dirty_files(root).unwrap_or_default();

    let mut out = Scanned {
        index: Index::new(),
        tally: Tally::default(),
    };
    let mut wrote = 0usize;
    for (oid, rel) in blobs {
        let Some(lang) = Language::of_path(&rel) else {
            out.tally.unmapped += 1;
            continue;
        };
        out.tally.mapped += 1;
        let key = (!dirty.contains(&rel)).then_some(oid.as_str());

        if let Some(tags) = key.and_then(|k| recall(dir, k)) {
            out.tally.cached += 1;
            note(&mut out, rel, &tags);
            continue;
        }
        let Some(bytes) = readable(&root.join(&rel)) else {
            out.tally.unreadable += 1;
            continue;
        };
        let tags = wecode_map::tags(lang, &bytes);
        out.tally.parsed += 1;
        if let Some(k) = key {
            wrote += usize::from(keep(dir, k, &tags));
        }
        note(&mut out, rel, &tags);
    }
    if wrote > 0 {
        sweep(dir, KEEP_ENTRIES);
    }
    Some(out)
}

/// Files the file layer already describes and this one cannot: a file that parsed and
/// said nothing is still a file, and the index keeps it so the counts agree with git.
fn note(out: &mut Scanned, rel: String, tags: &[Tag]) {
    if tags.is_empty() {
        out.tally.silent += 1;
    }
    out.index.insert(rel, tags);
}

fn readable(path: &Path) -> Option<Vec<u8>> {
    std::fs::metadata(path)
        .ok()
        .filter(|m| m.len() <= READ_CAP)?;
    std::fs::read(path).ok()
}

// ----------------------------------------------------------------- the cache ------

/// Where one repository's tags are kept.
///
/// Under the disposable cache root and never in the workspace or the ledger: this is
/// derived data, and deleting the whole directory has to cost a re-scan and nothing
/// else. Named after the repository's own directory, which is for a human reading `du`
/// — entries are keyed by content, so two repositories sharing a name would share
/// correct answers rather than collide.
fn cache_dir(root: &Path) -> PathBuf {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string());
    work::cache_root().join("codemap").join(name)
}

/// Fanned out two characters deep, so a repository of ten thousand blobs is not ten
/// thousand entries in one directory — which several filesystems handle badly and every
/// `ls` handles worse.
fn entry_path(dir: &Path, oid: &str) -> Option<PathBuf> {
    let head = oid.get(..2)?;
    (oid.len() > 2 && oid.chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| dir.join(head).join(oid))
}

/// One tag per line: what it is, where it is, what it is called.
///
/// A text format on purpose. It is greppable when a ranking looks wrong, it has no
/// version to migrate, and a torn or truncated entry decodes to fewer tags rather than
/// to an error — which for a cache is the right failure.
fn encode(tags: &[Tag]) -> String {
    tags.iter()
        .map(|t| format!("{}\t{}\t{}\n", t.kind.mark(), t.line, t.name))
        .collect()
}

fn decode(text: &str) -> Vec<Tag> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let kind = TagKind::of_mark(parts.next()?.chars().next()?)?;
            let at = parts.next()?.parse().ok()?;
            let name = parts.next()?;
            (!name.is_empty()).then(|| Tag {
                kind,
                name: name.to_string(),
                line: at,
            })
        })
        .collect()
}

fn recall(dir: &Path, oid: &str) -> Option<Vec<Tag>> {
    let text = std::fs::read_to_string(entry_path(dir, oid)?).ok()?;
    Some(decode(&text))
}

/// Writes an entry, and says whether it wrote one.
///
/// Through a temporary name carrying the process id, then renamed. Two scans of the
/// same repository run concurrently under `wecode loop`, and a reader that met a
/// half-written entry would take a truncated file for a file with fewer names in it —
/// the one way a cache whose keys cannot be wrong still answers wrongly.
fn keep(dir: &Path, oid: &str, tags: &[Tag]) -> bool {
    let Some(path) = entry_path(dir, oid) else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    let tmp = parent.join(format!(".{oid}.{}", std::process::id()));
    if std::fs::write(&tmp, encode(tags)).is_err() {
        return false;
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

/// Keeps the newest `keep` entries and deletes the rest.
///
/// Collection, not invalidation — nothing here can decide an entry is wrong, only that
/// the directory is large. Run after a scan that wrote something, which is the only
/// moment the directory can have grown, and never on a warm scan.
fn sweep(dir: &Path, keep: usize) {
    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let Ok(shards) = std::fs::read_dir(dir) else {
        return;
    };
    for shard in shards.flatten() {
        let Ok(files) = std::fs::read_dir(shard.path()) else {
            continue;
        };
        for f in files.flatten() {
            let when = f
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            entries.push((when, f.path()));
        }
    }
    if entries.len() <= keep {
        return;
    }
    entries.sort_by_key(|b| std::cmp::Reverse(b.0));
    for (_, path) in entries.into_iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
}

// ------------------------------------------------------------------ the view ------

/// The ranked neighbours of `write`, rendered — the section the envelope carries and
/// the table `wecode map` prints, from one ranking.
///
/// `None` when there is nothing to say: no repository, or a tree in which no file any
/// grammar claims shares a name with any other.
pub(crate) fn ranked(root: &Path, write: &[String], budget: usize) -> Option<String> {
    let scanned = scan(root)?;
    let seeds: Vec<String> = scanned
        .index
        .paths()
        .filter(|p| glob::any_matches(write, p))
        .map(str::to_string)
        .collect();
    let ranking = wecode_map::rank(&scanned.index, &seeds, budget);
    (!ranking.rows.is_empty()).then(|| render(&ranking, &scanned))
}

/// What put a file on the list, in the only two words this data supports.
fn shared(r: &Ranked) -> String {
    let mut parts = Vec::new();
    if !r.provides.is_empty() {
        parts.push(format!("references {}", r.provides.join(", ")));
    }
    if !r.uses.is_empty() {
        parts.push(format!("referenced by {}", r.uses.join(", ")));
    }
    if r.more > 0 {
        parts.push(format!("+{} more", r.more));
    }
    truncate_cmd(&parts.join(" · "), SHARED_CAP)
}

fn render(ranking: &Ranking, scanned: &Scanned) -> String {
    let t = &scanned.tally;
    let mut out = format!(
        "  {} of {} tracked files read into {} names{}\n  {}\n",
        t.mapped,
        t.mapped + t.unmapped,
        scanned.index.names(),
        skipped(t),
        if ranking.seeded {
            "nearest what this task may write — names matched between files, never resolved"
        } else {
            "no write scope to rank from — the names the rest of the tree uses most"
        }
    );
    out.push_str(&format!("  {:>6}  {:<PATH_COL$}{}\n", "near", "file", "why"));
    for r in &ranking.rows {
        let line = format!("  {:>6.2}  {:<PATH_COL$}{}", r.score, r.path, shared(r));
        out.push_str(line.trim_end());
        out.push('\n');
    }
    if ranking.dropped > 0 {
        out.push_str(&format!(
            "  … {} more ranked file{} not shown\n",
            ranking.dropped,
            if ranking.dropped == 1 { "" } else { "s" }
        ));
    }
    out
}

/// The part of the tree this could not speak for, said out loud.
///
/// A ranking is read as the whole answer unless something says what it left out, and
/// the three reasons are acted on differently: a language with no grammar is a `wecode
/// doctor` finding, an unreadable file is usually a vendored blob, and a file that
/// parsed silently is one whose names this grammar's query does not extract.
fn skipped(t: &Tally) -> String {
    let mut notes = Vec::new();
    if t.unmapped > 0 {
        notes.push(format!("{} in no compiled grammar", t.unmapped));
    }
    if t.unreadable > 0 {
        notes.push(format!("{} unreadable", t.unreadable));
    }
    if t.silent > 0 {
        notes.push(format!("{} with no names", t.silent));
    }
    if notes.is_empty() {
        String::new()
    } else {
        format!("; {}", notes.join(", "))
    }
}

/// `wecode map <project> [--seed <glob>…]`.
///
/// The same ranking the envelope carries, from the same function, because a table an
/// operator reads and a section a worker is handed that could disagree would be two
/// maps of one repository.
pub(crate) fn command(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let plan = store.load_plan()?;
    let project = match a.cmd(1) {
        "" => which_project(a, &plan)?,
        named => crate::commands::ctx::the_project(&plan, named)?.clone(),
    };
    let root = repo_path(&company, &project)?;
    if !git::is_repo(&root) {
        return Err(format!("{} is not a git working tree", root.display()).into());
    }
    let seeds: Vec<String> = a.all("seed").iter().map(|s| (*s).to_string()).collect();
    let body = ranked(&root, &seeds, COMMAND_ROWS)
        .ok_or_else(|| format!("nothing to map in {}", root.display()))?;
    Ok(format!("{}  {}\n{body}", project.id, root.display()))
}

/// The section the dispatch envelope carries, seeded from the task's write scope.
pub(crate) fn envelope_section(root: &Path, write: &[String]) -> Option<String> {
    ranked(root, write, ENVELOPE_ROWS)
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;

    fn tag(mark: TagKind, name: &str, line: usize) -> Tag {
        Tag {
            kind: mark,
            name: name.to_string(),
            line,
        }
    }

    fn scanned(rows: &[(&str, Vec<Tag>)], tally: Tally) -> Scanned {
        let mut index = Index::new();
        for (path, tags) in rows {
            index.insert(*path, tags);
        }
        Scanned { index, tally }
    }

    #[test]
    fn an_entry_survives_being_written_down_and_read_back() {
        let tags = vec![
            tag(TagKind::Definition, "assemble", 12),
            tag(TagKind::Reference, "render", 40),
        ];
        assert_eq!(decode(&encode(&tags)), tags);
    }

    #[test]
    fn a_truncated_entry_decodes_to_fewer_tags_rather_than_to_an_error() {
        // What a cache is allowed to do when it is damaged. An error here would take
        // down a dispatch for a file nobody is reading.
        let whole = encode(&[
            tag(TagKind::Definition, "assemble", 12),
            tag(TagKind::Reference, "render", 40),
        ]);
        // Cut inside the second row's fields, which is what a torn write leaves.
        let cut = &whole[..whole.len() - "40\trender\n".len()];
        assert_eq!(decode(cut), vec![tag(TagKind::Definition, "assemble", 12)]);
        assert!(decode("").is_empty());
        // A line that is not a tag at all is dropped, not decoded into a name.
        assert!(decode("nonsense\nx\ty\tz\n").is_empty());
    }

    #[test]
    fn an_entry_is_keyed_by_its_content_and_nothing_else() {
        let dir = Path::new("/tmp/wecode-codemap");
        let path = entry_path(dir, "0abc123").expect("a plausible oid");
        assert_eq!(path, dir.join("0a").join("0abc123"));
        // Anything that is not an object id is refused rather than joined into a path:
        // this string reaches the filesystem.
        assert_eq!(entry_path(dir, "../../etc/passwd"), None);
        assert_eq!(entry_path(dir, ""), None);
        assert_eq!(entry_path(dir, "ab"), None);
    }

    #[test]
    fn a_row_says_references_and_referenced_by_and_never_more_than_that() {
        // FR-04-10 as a property of the render. Name matching cannot support a claim
        // about resolution, and a note in a doc comment is not a thing that stays true.
        let s = scanned(
            &[
                ("seed.rs", vec![tag(TagKind::Reference, "assemble", 1)]),
                ("near.rs", vec![tag(TagKind::Definition, "assemble", 1)]),
            ],
            Tally {
                mapped: 2,
                parsed: 2,
                ..Tally::default()
            },
        );
        let r = wecode_map::rank(&s.index, &["seed.rs".to_string()], 10);
        let out = render(&r, &s);
        assert!(out.contains("references assemble"), "{out}");
        assert!(!out.contains("depends on"), "{out}");
    }

    #[test]
    fn what_the_scan_could_not_speak_for_is_named_in_the_heading() {
        // A ranking with nothing above it reads as the whole repository.
        let t = Tally {
            mapped: 3,
            unmapped: 40,
            unreadable: 1,
            silent: 2,
            ..Tally::default()
        };
        let note = skipped(&t);
        assert!(note.contains("40 in no compiled grammar"), "{note}");
        assert!(note.contains("1 unreadable"), "{note}");
        assert!(note.contains("2 with no names"), "{note}");
        assert!(skipped(&Tally::default()).is_empty());
    }

    #[test]
    fn a_ranking_with_no_seed_says_which_question_it_answered() {
        // The two headings are not decoration: *nearest your scope* and *what this
        // repository names most* are different answers, and a reader given the second
        // under the first heading would take it for the first.
        let s = scanned(
            &[
                ("hub.rs", vec![tag(TagKind::Definition, "central", 1)]),
                ("a.rs", vec![tag(TagKind::Reference, "central", 1)]),
            ],
            Tally::default(),
        );
        let out = render(&wecode_map::rank(&s.index, &[], 10), &s);
        assert!(out.contains("no write scope to rank from"), "{out}");
        let seeded = render(&wecode_map::rank(&s.index, &["a.rs".to_string()], 10), &s);
        assert!(seeded.contains("nearest what this task may write"), "{seeded}");
    }

    #[test]
    fn a_sweep_keeps_the_newest_and_deletes_nothing_it_does_not_have_to() {
        let dir = std::env::temp_dir().join("wecode-codemap-sweep");
        let _ = std::fs::remove_dir_all(&dir);
        for i in 0..5u32 {
            let oid = format!("{i:040x}");
            assert!(keep(&dir, &oid, &[tag(TagKind::Definition, "x", 1)]));
        }
        // Under the ceiling nothing goes.
        sweep(&dir, 10);
        assert_eq!(recall(&dir, &format!("{0:040x}", 0)).map(|t| t.len()), Some(1));
        sweep(&dir, 2);
        let left = (0..5u32)
            .filter(|i| recall(&dir, &format!("{i:040x}")).is_some())
            .count();
        assert_eq!(left, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------------------------------------------------- scanning a tree ------

    /// A scratch repository with source in it, and a cache directory of its own.
    ///
    /// Real git, because the cache key is git's own blob id and the dirty set is git's
    /// own answer: a fake index would be a test of this module's opinion of git rather
    /// than of git. Real source, because the toy fixture the end-to-end suite drives is
    /// one text file and no grammar claims it.
    fn planted(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("wecode-codemap-{name}"));
        let cache = std::env::temp_dir().join(format!("wecode-codemap-{name}-cache"));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&cache);
        std::fs::create_dir_all(&root).expect("a scratch repository");

        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            git_in(&root, &args);
        }
        put(&root, "src/seed.rs", "fn main() {\n    assemble();\n}\n");
        put(&root, "src/near.rs", "pub fn assemble() -> u8 {\n    7\n}\n");
        // Error-tolerant on purpose: a worktree mid-edit is exactly when somebody wants
        // to know what is next to what, and exactly when nothing compiles.
        put(&root, "src/torn.rs", "fn kept() {}\nfn broken( { ) nonsense\n");
        // Parsed, and it names nothing. A fact about the file, not a failure.
        put(&root, "src/quiet.rs", "// nothing but a sentence.\n");
        // Most of a repository: no grammar claims it.
        put(&root, "notes.md", "# notes\n");
        git_in(&root, &["add", "-A"]);
        git_in(&root, &["commit", "-qm", "source"]);
        (root, cache)
    }

    fn put(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a directory");
        std::fs::write(path, body).expect("a file");
    }

    fn git_in(root: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    #[test]
    fn a_tree_is_read_into_names_and_what_it_could_not_read_is_counted() {
        // FR-04-03. A file no grammar claims and a file that does not compile are both
        // ordinary, and the difference between them is only visible if both are counted:
        // a scan that dropped either would report a smaller repository than git has.
        let (root, cache) = planted("counted");
        let s = scan_into(&root, &cache).expect("a repository with an index");
        assert_eq!(s.tally.mapped, 4, "{:?}", s.tally);
        assert_eq!(s.tally.unmapped, 1, "{:?}", s.tally);
        assert_eq!(s.tally.silent, 1, "{:?}", s.tally);
        assert_eq!(s.tally.unreadable, 0, "{:?}", s.tally);
        // Every file a grammar claimed is in the index, the silent one included.
        assert_eq!(s.index.files(), 4);
        let paths: Vec<&str> = s.index.paths().collect();
        assert!(paths.contains(&"src/quiet.rs"), "{paths:?}");
        // The half of the broken file that parsed is still a name.
        assert!(s.index.names() >= 3, "{:?}", s.tally);
    }

    #[test]
    fn a_second_scan_of_an_unchanged_tree_parses_nothing() {
        // NFR-04-PER-01, and the whole reason the scan can run at dispatch rather than
        // being a command somebody has to remember: a map is stale exactly when nobody
        // re-ran it. The counter is the assertion — wall time would measure the machine.
        let (root, cache) = planted("warm");
        let cold = scan_into(&root, &cache).expect("a cold scan");
        assert_eq!(cold.tally.parsed, 4, "{:?}", cold.tally);
        assert_eq!(cold.tally.cached, 0, "{:?}", cold.tally);

        let warm = scan_into(&root, &cache).expect("a warm scan");
        assert_eq!(warm.tally.parsed, 0, "{:?}", warm.tally);
        assert_eq!(warm.tally.cached, cold.tally.mapped, "{:?}", warm.tally);
        // And answers the same, which is the half a counter alone does not prove.
        assert_eq!(warm.index.names(), cold.index.names());
        assert_eq!(warm.index.files(), cold.index.files());
        assert_eq!(warm.tally.silent, cold.tally.silent);
    }

    #[test]
    fn a_file_edited_since_the_index_is_parsed_rather_than_recalled() {
        // The one case a content key would answer wrongly: git's id names the bytes the
        // file *used* to hold, so an entry stored under it would describe a file that no
        // longer exists. A tree being edited is the tree whose map has to be current.
        let (root, cache) = planted("dirty");
        let seeds = vec!["src/near.rs".to_string()];
        let cold = scan_into(&root, &cache).expect("a cold scan");
        let before = wecode_map::rank(&cold.index, &seeds, 10);
        assert_eq!(before.rows[0].path, "src/seed.rs", "{:?}", before.rows);

        put(&root, "src/near.rs", "pub fn assemble_renamed() {}\n");
        let after = scan_into(&root, &cache).expect("a scan of the edited tree");
        // Only the edited file is re-read; the other three still answer from the cache.
        assert_eq!(after.tally.parsed, 1, "{:?}", after.tally);
        assert_eq!(after.tally.cached, 3, "{:?}", after.tally);

        // And the map is of the tree as it is now: nothing calls the renamed function,
        // so the caller that was its neighbour a moment ago is no longer one.
        let now = wecode_map::rank(&after.index, &seeds, 10);
        assert!(now.seeded);
        assert!(now.rows.is_empty(), "{:?}", now.rows);
    }

    #[test]
    fn a_directory_that_is_not_a_repository_is_not_scanned() {
        // The envelope drops the section rather than printing a heading over an apology.
        let dir = std::env::temp_dir().join("wecode-codemap-notrepo");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        assert!(scan_into(&dir, &dir.join("cache")).is_none());
    }
}
