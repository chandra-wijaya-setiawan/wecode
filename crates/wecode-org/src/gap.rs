//! Gaps: what a playbook did not say, written down by whoever found out.
//!
//! A playbook is hand-edited and in no role's write scope, deliberately — something
//! that can rewrite the guidance it was given is not governed by it. That leaves a
//! hole on the other side. An orchestrator reads `wecode playbook <kind>`, plans
//! against it, and discovers only afterwards that the guidance was missing something:
//! a trap, a seam, a file that always moves with another. It has nowhere to put that,
//! so the next planner rediscovers it the same expensive way. This repo learned one
//! trap three tasks in a row before anybody wrote it down.
//!
//! A gap is the **note, not the edit**. It is appended here, carried to the next
//! reader of the playbook, and folded into the playbook by a person — who is also the
//! one who deletes it. Nothing branches on a gap: like `guidance`, wecode only carries
//! it. That is precisely what makes it safe for an agent to append. A wrong note can
//! mislead a reader, which the prose beside it could already do; it cannot widen a
//! scope, raise a budget or switch off a gate.
//!
//! It lives in the **workspace**, not in the repository the playbook sits in, for one
//! reason: verification judges a task from the repository's own diff, and a kind whose
//! playbook asks for no worktree is judged in the main checkout. A file appearing
//! there while such a task ran would be reported as that task's scope violation —
//! recording a gap would fail somebody else's work. The workspace is never diffed.
//!
//! The file is appended to, never rewritten, so hand-written comments and hand-made
//! corrections survive being written next to.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use wecode_core::TaskKind;

/// Where the record sits inside the workspace, beside `company.toml`.
pub const GAPS_PATH: &str = "gaps.toml";

/// The header a new file gets, so whoever opens it knows what it is and what to do
/// with it. Written once, on the first record.
const HEADER: &str = "\
# Gaps found in the projects' playbooks: what the guidance did not say, and who
# found out. Appended by `wecode playbook gap`, read back by `wecode playbook`.
#
# A gap is a note, not a change. Nothing acts on one — fold it into the project's
# .wecode/playbook.toml, then delete the entry here. That deletion is the only way
# one goes away, which is the point: it stays in front of the next planner until a
# person has done something about it.
";

#[derive(Debug)]
pub enum GapError {
    Parse(toml::de::Error),
    Render(toml::ser::Error),
    Io(io::Error),
    /// A `kind` that is not a task kind.
    BadKind {
        value: String,
        known: String,
    },
    /// A note with nothing in it. Refused rather than stored: an empty gap is a row
    /// that says a planner had a thought, which is worse than no row.
    Empty,
}

impl fmt::Display for GapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(e) => write!(f, "{GAPS_PATH}: {e}"),
            Self::Render(e) => write!(f, "{GAPS_PATH}: {e}"),
            Self::Io(e) => write!(f, "{GAPS_PATH}: {e}"),
            Self::BadKind { value, known } => {
                write!(f, "{GAPS_PATH}: kind `{value}` is not one of {known}")
            }
            Self::Empty => write!(f, "a gap needs a note — say what the playbook does not"),
        }
    }
}

impl std::error::Error for GapError {}

impl From<toml::de::Error> for GapError {
    fn from(e: toml::de::Error) -> Self {
        Self::Parse(e)
    }
}

impl From<io::Error> for GapError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

// ------------------------------------------------------------------ wire ------

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
struct Wire {
    #[serde(default)]
    gap: Vec<Block>,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct Block {
    project: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    task: Option<String>,
    #[serde(default)]
    by: String,
    #[serde(default)]
    at: u64,
    note: String,
}

// ---------------------------------------------------------------- domain ------

/// One finding about one project's guidance.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Gap {
    pub project: String,
    /// The kind whose guidance is short. `None` means the finding is about the
    /// project's planning as a whole, and it is shown against every kind — a gap
    /// filed under nothing is a gap nobody reads.
    pub kind: Option<TaskKind>,
    /// The task it was found on, when there was one. Attribution, not a relation:
    /// the gap outlives the task and is about the playbook.
    pub task: Option<String>,
    /// The post that recorded it.
    pub by: String,
    /// Seconds since the epoch, passed in by the caller. Nothing in this crate reads
    /// a clock — `org` is hand-edited config, and a function that quietly consults
    /// the machine cannot be tested by stating its inputs.
    pub at: u64,
    pub note: String,
}

impl Gap {
    /// Whether this gap is worth showing to someone reading that kind's guidance.
    #[must_use]
    pub fn applies_to(&self, kind: TaskKind) -> bool {
        self.kind.is_none_or(|k| k == kind)
    }

    /// Whether these two say the same thing about the same guidance.
    ///
    /// The task is deliberately not part of it. The same trap found twice is one gap
    /// found twice, and a loop that plans the same work every hour would otherwise
    /// fill the file with copies of one sentence.
    #[must_use]
    fn same_as(&self, other: &Self) -> bool {
        self.project == other.project
            && self.kind == other.kind
            && self.note.trim() == other.note.trim()
    }
}

/// Reads every gap recorded in a workspace, oldest first.
///
/// A workspace with no file yet has no gaps, which is not an error: the file is
/// created by the first record and deleted by hand when the last one is folded in.
pub fn at(root: &Path) -> Result<Vec<Gap>, GapError> {
    match fs::read_to_string(root.join(GAPS_PATH)) {
        Ok(text) => parse(&text),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(GapError::Io(e)),
    }
}

pub fn parse(text: &str) -> Result<Vec<Gap>, GapError> {
    let w: Wire = toml::from_str(text)?;
    w.gap
        .into_iter()
        .map(|b| {
            let kind = match &b.kind {
                None => None,
                Some(k) => Some(TaskKind::parse(k).ok_or_else(|| {
                    GapError::BadKind {
                        value: k.clone(),
                        known: TaskKind::all()
                            .iter()
                            .map(|k| k.as_str())
                            .collect::<Vec<_>>()
                            .join(", "),
                    }
                })?),
            };
            Ok(Gap {
                project: b.project,
                kind,
                task: b.task,
                by: b.by,
                at: b.at,
                note: b.note.trim().to_string(),
            })
        })
        .collect()
}

/// Appends a gap, unless the same thing is already recorded.
///
/// `Ok(false)` means it was already there and nothing was written — not a failure.
/// Recording is the cheap end of this feature and something will do it in a loop; a
/// duplicate should cost a sentence, not an error and not a second entry.
///
/// Appends text rather than re-serialising the file, so comments and any hand
/// correction survive. The same care the playbook gets, for the same reason: this is
/// a file a person edits.
pub fn record(root: &Path, gap: &Gap) -> Result<bool, GapError> {
    if gap.note.trim().is_empty() {
        return Err(GapError::Empty);
    }
    let path = root.join(GAPS_PATH);
    let mut text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => HEADER.to_string(),
        Err(e) => return Err(GapError::Io(e)),
    };
    if parse(&text)?.iter().any(|g| g.same_as(gap)) {
        return Ok(false);
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&entry(gap)?);
    fs::write(&path, text)?;
    Ok(true)
}

/// The file a workspace's gaps are in, whether or not it exists yet. For messages
/// that tell a reader where to go and delete one.
#[must_use]
pub fn path(root: &Path) -> PathBuf {
    root.join(GAPS_PATH)
}

/// One `[[gap]]` block, rendered.
///
/// Through the TOML serialiser rather than by hand: a note is prose and will contain
/// quotes, backslashes and newlines sooner rather than later, and hand-rolled
/// escaping is how a file stops parsing three months after anyone looked at it.
fn entry(g: &Gap) -> Result<String, GapError> {
    let mut t = toml::Table::new();
    // A clock that outruns i64 is not a problem this file has, but a timestamp that
    // wrapped negative would sort before everything ever recorded.
    t.insert(
        "at".into(),
        toml::Value::Integer(i64::try_from(g.at).unwrap_or(i64::MAX)),
    );
    t.insert("project".into(), toml::Value::String(g.project.clone()));
    if let Some(k) = g.kind {
        t.insert("kind".into(), toml::Value::String(k.as_str().to_string()));
    }
    if let Some(task) = &g.task {
        t.insert("task".into(), toml::Value::String(task.clone()));
    }
    if !g.by.is_empty() {
        t.insert("by".into(), toml::Value::String(g.by.clone()));
    }
    t.insert(
        "note".into(),
        toml::Value::String(g.note.trim().to_string()),
    );
    let body = toml::to_string(&t).map_err(GapError::Render)?;
    Ok(format!("\n[[gap]]\n{body}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gap(note: &str) -> Gap {
        Gap {
            project: "caching".into(),
            kind: Some(TaskKind::Bug),
            task: Some("cache-layer".into()),
            by: "chief".into(),
            at: 1_700_000_000,
            note: note.into(),
        }
    }

    fn temp(name: &str) -> PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-gap-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_recorded_gap_reads_back_whole() {
        let root = temp("roundtrip");
        assert!(record(&root, &gap("tests live beside the code")).unwrap());

        let all = at(&root).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].project, "caching");
        assert_eq!(all[0].kind, Some(TaskKind::Bug));
        assert_eq!(all[0].task.as_deref(), Some("cache-layer"));
        assert_eq!(all[0].by, "chief");
        assert_eq!(all[0].at, 1_700_000_000);
        assert_eq!(all[0].note, "tests live beside the code");
    }

    #[test]
    fn a_workspace_with_no_file_has_no_gaps() {
        // The common case, and the one that must not be an error: the file exists
        // only once something has been found.
        assert!(at(&temp("absent")).unwrap().is_empty());
    }

    #[test]
    fn prose_that_would_break_toml_survives_the_trip() {
        // Notes are quotations of what went wrong, so they carry quotes, paths and
        // line breaks. Hand-rolled escaping is what this test exists to forbid.
        let root = temp("escaping");
        let nasty = "verify said \"outside scope\": crates\\x, and\nthe next line too";
        record(&root, &gap(nasty)).unwrap();
        assert_eq!(at(&root).unwrap()[0].note, nasty);
    }

    #[test]
    fn the_same_finding_twice_is_recorded_once() {
        let root = temp("dedup");
        assert!(record(&root, &gap("put the test file in the write scope")).unwrap());
        assert!(!record(&root, &gap("put the test file in the write scope")).unwrap());
        assert_eq!(at(&root).unwrap().len(), 1);
    }

    #[test]
    fn the_same_note_found_on_another_task_is_still_the_same_gap() {
        // What a loop does: plan, hit the trap, record, repeat tomorrow. The trap is
        // one fact about the playbook however many tasks meet it.
        let root = temp("dedup-task");
        record(&root, &gap("declare docs/** — the reference is generated")).unwrap();
        let mut again = gap("declare docs/** — the reference is generated");
        again.task = Some("other-task".into());
        again.at = 1_700_009_999;
        assert!(!record(&root, &again).unwrap());
        assert_eq!(at(&root).unwrap().len(), 1);
    }

    #[test]
    fn the_same_note_about_another_kind_is_another_gap() {
        let root = temp("dedup-kind");
        record(&root, &gap("declare the test file")).unwrap();
        let mut refactor = gap("declare the test file");
        refactor.kind = Some(TaskKind::Refactor);
        assert!(record(&root, &refactor).unwrap());
        assert_eq!(at(&root).unwrap().len(), 2);
    }

    #[test]
    fn a_gap_about_no_kind_applies_to_every_kind() {
        let mut g = gap("this project has no integration branch");
        g.kind = None;
        assert!(g.applies_to(TaskKind::Bug));
        assert!(g.applies_to(TaskKind::Docs));

        assert!(gap("x").applies_to(TaskKind::Bug));
        assert!(!gap("x").applies_to(TaskKind::Docs));
    }

    #[test]
    fn recording_appends_and_leaves_what_is_already_there_alone() {
        // A person will edit this file — that is how a gap goes away. Rewriting it
        // from the parsed form would eat their comments the next time an agent
        // recorded anything.
        let root = temp("append");
        record(&root, &gap("first")).unwrap();
        let path = path(&root);
        let text = fs::read_to_string(&path).unwrap();
        fs::write(
            &path,
            format!("{text}\n# folded the first one in already\n"),
        )
        .unwrap();

        record(&root, &gap("second")).unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(
            after.contains("# folded the first one in already"),
            "{after}"
        );
        assert!(
            after.contains("Gaps found in the projects' playbooks"),
            "{after}"
        );
        let all = at(&root).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].note, "first", "oldest first, in file order");
        assert_eq!(all[1].note, "second");
    }

    #[test]
    fn an_empty_note_is_refused() {
        let root = temp("empty");
        assert!(matches!(
            record(&root, &gap("   \n ")).unwrap_err(),
            GapError::Empty
        ));
        assert!(!path(&root).exists(), "nothing is created for a refusal");
    }

    #[test]
    fn a_kind_that_is_not_a_kind_is_refused_by_name() {
        let err = parse("[[gap]]\nproject = \"p\"\nkind = \"buld\"\nnote = \"x\"\n").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("buld"), "{msg}");
        assert!(msg.contains("refactor"), "should list the kinds: {msg}");
    }

    #[test]
    fn a_misspelled_field_is_refused_rather_than_dropped() {
        // A `not = "..."` silently ignored would be a finding that never reaches
        // anyone, which is the one failure this whole file exists to prevent.
        let err = parse("[[gap]]\nproject = \"p\"\nnote = \"x\"\nnots = \"y\"\n").unwrap_err();
        assert!(err.to_string().contains("nots"), "{err}");
    }

    #[test]
    fn an_empty_file_parses_to_nothing() {
        assert!(parse("").unwrap().is_empty());
        assert!(parse(HEADER).unwrap().is_empty());
    }
}
