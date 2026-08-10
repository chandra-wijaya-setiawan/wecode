//! Persistence. The event log is authoritative; everything else is a fold over it.

pub mod audit;
pub mod codec;

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use wecode_core::{Intent, IntentTree, TreeError};
use wecode_gov::Record;

pub use audit::{AuditLine, decode_record, encode_record};
pub use codec::{
    CodecError, decode_intent, encode_intent, horizon_from_str, intent_kind_from_str,
    standalone_reason_from_str,
};

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    Codec { line: usize, source: CodecError },
    Tree { line: usize, source: TreeError },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Codec { line, source } => write!(f, "line {line}: {source}"),
            Self::Tree { line, source } => write!(f, "line {line}: {source}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Where state lives. Outside the repository, so a worktree cannot reach it:
/// a post's cwd is its worktree, and `..` must not lead to authority data.
#[derive(Clone, Debug)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// Opens (creating if needed) a store rooted at `root`.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    /// Resolves the state root: `$WECODE_HOME`, else `$XDG_STATE_HOME/wecode`,
    /// else `$HOME/.local/state/wecode`.
    #[must_use]
    pub fn default_root() -> PathBuf {
        if let Ok(dir) = std::env::var("WECODE_HOME") {
            return PathBuf::from(dir);
        }
        if let Ok(dir) = std::env::var("XDG_STATE_HOME") {
            return Path::new(&dir).join("wecode");
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        Path::new(&home).join(".local/state/wecode")
    }

    #[must_use]
    pub fn intents_path(&self) -> PathBuf {
        self.root.join("intents.log")
    }

    #[must_use]
    pub fn audit_path(&self) -> PathBuf {
        self.root.join("audit.log")
    }

    /// Appends one intent. The log is the record; the tree is a fold over it.
    pub fn append_intent(&self, intent: &Intent) -> Result<(), StoreError> {
        self.append_line(&self.intents_path(), &encode_intent(intent))
    }

    /// Appends a pre-encoded audit line.
    pub fn append_audit(&self, line: &str) -> Result<(), StoreError> {
        self.append_line(&self.audit_path(), line)
    }

    /// The highest sequence number in the ledger, or 0 if it is empty.
    pub fn last_seq(&self) -> Result<u64, StoreError> {
        Ok(self.load_audit()?.iter().map(|l| l.seq).max().unwrap_or(0))
    }

    /// Appends every record a Broker accumulated, renumbering from the ledger's
    /// tail.
    ///
    /// A Broker counts from 1 within its own lifetime, which is right for a Broker
    /// and wrong for the ledger: sequence must be monotonic across every process
    /// that ever appends, or ordering and causal chains are meaningless. The
    /// ledger owns the numbering because the ledger is what persists.
    pub fn append_records(&self, records: &[Record]) -> Result<(), StoreError> {
        let mut seq = self.last_seq()?;
        for r in records {
            seq += 1;
            let mut renumbered = r.clone();
            renumbered.seq = seq;
            self.append_audit(&encode_record(&renumbered))?;
        }
        Ok(())
    }

    /// Reads the ledger. Unparseable lines are skipped rather than fatal: the
    /// ledger is evidence, and losing all of it because one line is malformed
    /// would be the worse failure.
    pub fn load_audit(&self) -> Result<Vec<AuditLine>, StoreError> {
        let path = self.audit_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        Ok(fs::read_to_string(&path)?
            .lines()
            .filter_map(decode_record)
            .collect())
    }

    fn append_line(&self, path: &Path, line: &str) -> Result<(), StoreError> {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(f, "{line}")?;
        Ok(())
    }

    /// Rebuilds the tree by replaying the log.
    ///
    /// Later records win, so an amended intent is written again rather than edited
    /// in place. Insertion is retried until it converges, because a child may be
    /// logged before its parent.
    pub fn load_tree(&self) -> Result<IntentTree, StoreError> {
        let path = self.intents_path();
        if !path.exists() {
            return Ok(IntentTree::new());
        }
        let text = fs::read_to_string(&path)?;
        let mut latest: Vec<(usize, Intent)> = Vec::new();

        for (n, line) in text.lines().enumerate() {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }
            let intent = decode_intent(line).map_err(|source| StoreError::Codec {
                line: n + 1,
                source,
            })?;
            if let Some(slot) = latest.iter_mut().find(|(_, i)| i.id == intent.id) {
                slot.1 = intent;
            } else {
                latest.push((n + 1, intent));
            }
        }

        let mut tree = IntentTree::new();
        let mut pending: Vec<(usize, Intent)> = latest;
        while !pending.is_empty() {
            let before = pending.len();
            let mut still: Vec<(usize, Intent)> = Vec::new();
            let mut deferred_error = None;

            for (line, intent) in pending {
                match tree.insert(intent.clone()) {
                    Ok(()) => {}
                    Err(TreeError::MissingParent(_)) => still.push((line, intent)),
                    Err(source) => {
                        deferred_error = Some(StoreError::Tree { line, source });
                    }
                }
            }
            if let Some(e) = deferred_error {
                return Err(e);
            }
            if still.len() == before {
                // Nothing inserted this pass: the remaining parents never arrive.
                let (line, intent) = still.remove(0);
                return Err(StoreError::Tree {
                    line,
                    source: TreeError::MissingParent(
                        intent.parent.clone().unwrap_or_else(|| intent.id.clone()),
                    ),
                });
            }
            pending = still;
        }
        Ok(tree)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{IntentKind, Link};

    fn temp_root(name: &str) -> PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn empty_store_yields_an_empty_tree() {
        let s = Store::open(temp_root("empty")).unwrap();
        assert!(s.load_tree().unwrap().is_empty());
    }

    #[test]
    fn appends_and_reloads() {
        let s = Store::open(temp_root("reload")).unwrap();
        s.append_intent(&Intent::new("vis", IntentKind::Vision, "be excellent"))
            .unwrap();
        s.append_intent(
            &Intent::new("goal", IntentKind::Goal, "cut latency").under("vis", Link::Requires),
        )
        .unwrap();

        let tree = s.load_tree().unwrap();
        assert_eq!(tree.len(), 2);
        assert_eq!(tree.children(&"vis".into()).count(), 1);
    }

    #[test]
    fn a_child_logged_before_its_parent_still_loads() {
        let s = Store::open(temp_root("order")).unwrap();
        // Deliberately reversed.
        s.append_intent(
            &Intent::new("goal", IntentKind::Goal, "cut latency").under("vis", Link::Requires),
        )
        .unwrap();
        s.append_intent(&Intent::new("vis", IntentKind::Vision, "be excellent"))
            .unwrap();

        let tree = s.load_tree().unwrap();
        assert_eq!(tree.len(), 2);
    }

    #[test]
    fn later_records_win() {
        let s = Store::open(temp_root("amend")).unwrap();
        s.append_intent(&Intent::new("v", IntentKind::Vision, "first wording"))
            .unwrap();
        s.append_intent(&Intent::new("v", IntentKind::Vision, "second wording"))
            .unwrap();

        let tree = s.load_tree().unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree.get(&"v".into()).unwrap().statement, "second wording");
    }

    #[test]
    fn a_dangling_parent_is_an_error_not_a_hang() {
        let s = Store::open(temp_root("dangling")).unwrap();
        s.append_intent(
            &Intent::new("t", IntentKind::Task, "orphan").under("nope", Link::Requires),
        )
        .unwrap();
        let err = s.load_tree().unwrap_err();
        assert!(matches!(err, StoreError::Tree { .. }), "got {err:?}");
    }

    #[test]
    fn a_corrupt_line_names_its_line_number() {
        let s = Store::open(temp_root("corrupt")).unwrap();
        s.append_intent(&Intent::new("v", IntentKind::Vision, "ok"))
            .unwrap();
        s.append_audit("").unwrap(); // separate file, must not matter
        fs::OpenOptions::new()
            .append(true)
            .open(s.intents_path())
            .unwrap()
            .write_all(b"intent\tkind=task\n")
            .unwrap();

        match s.load_tree().unwrap_err() {
            StoreError::Codec { line, .. } => assert_eq!(line, 2),
            other => panic!("expected codec error, got {other:?}"),
        }
    }

    fn record(seq: u64, path: &str) -> Record {
        use wecode_gov::{Action, Decision, Effective, Grant, Session, Source};
        let s = Session::new(
            "s",
            "impl",
            "claude-code",
            "p".into(),
            Effective::of(vec![Grant::root()]),
        );
        Record {
            seq,
            session: s.id,
            post: s.post,
            occupant: s.occupant,
            intent: s.intent,
            action: Action::Write {
                path: path.to_string(),
            },
            decision: Decision::Allow,
            source: Source::Broker,
        }
    }

    #[test]
    fn audit_sequence_is_monotonic_across_processes() {
        let s = Store::open(temp_root("seq")).unwrap();
        assert_eq!(s.last_seq().unwrap(), 0);

        // Two separate "processes", each numbering from 1 internally.
        s.append_records(&[record(1, "a"), record(2, "b")]).unwrap();
        s.append_records(&[record(1, "c")]).unwrap();

        let seqs: Vec<u64> = s.load_audit().unwrap().iter().map(|l| l.seq).collect();
        assert_eq!(
            seqs,
            vec![1, 2, 3],
            "ledger must renumber, not trust the Broker"
        );
        assert_eq!(s.last_seq().unwrap(), 3);
    }

    #[test]
    fn a_malformed_audit_line_is_skipped_not_fatal() {
        let s = Store::open(temp_root("audit-junk")).unwrap();
        s.append_records(&[record(1, "a")]).unwrap();
        s.append_audit("this is not a record").unwrap();
        s.append_records(&[record(1, "b")]).unwrap();
        // Losing the whole ledger because one line is bad is the worse failure.
        assert_eq!(s.load_audit().unwrap().len(), 2);
    }

    #[test]
    fn audit_and_intents_are_separate_files() {
        let s = Store::open(temp_root("split")).unwrap();
        s.append_intent(&Intent::new("v", IntentKind::Vision, "ok"))
            .unwrap();
        s.append_audit("audit\tseq=1\taction=write").unwrap();
        assert_eq!(s.load_tree().unwrap().len(), 1);
        assert!(
            fs::read_to_string(s.audit_path())
                .unwrap()
                .contains("seq=1")
        );
    }
}
