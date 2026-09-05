//! The design a story was built on.
//!
//! Folded out of rows the plan already has rather than stored beside them: there is no
//! `designs` table, and [`Design`] says why.

use rusqlite::{OptionalExtension, params};
use wecode_core::{TaskId, TaskKind, TaskStatus};

use crate::{Store, StoreError};

/// The design a story governs, as the store holds it.
///
/// A digest, and never the prose. ADR-0005 settled it for decisions — "the table is the
/// index, `docs/adr/*.md` is the text" — and a design has more riding on it: argued at
/// length, reviewed as a diff, signed once. What is left for the database is the join
/// nothing else can make: *which* document this story was built on.
///
/// So there is no `designs` table. Every field is folded out of rows the plan already
/// has, except [`Design::digest`], which is deliberately not a column — a stored checksum
/// stops being true the next time somebody saves the file, with nothing in it to say so.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Design {
    /// The design task that decided it.
    pub task: TaskId,
    /// Where its document sits, repo-relative — the task's own write scope where it
    /// named a file, the convention where it named none.
    pub document: String,
    /// Whether the decision has been signed. A design is the one kind that is not
    /// finished when it passes, so this is `done` and nothing weaker.
    pub decided: bool,
    /// A checksum of what the document said, and `None` until somebody opens it: the
    /// store reads no files. [`Design::read`] is what fills it.
    pub digest: Option<String>,
}

/// FNV-1a, 64-bit — offset basis and prime.
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

impl Design {
    /// This digest with the document read: a checksum of what it says today.
    #[must_use]
    pub fn read(mut self, text: &str) -> Self {
        self.digest = Some(Self::checksum(text));
        self
    }

    /// Whether `text` is still the document this digest was taken of.
    ///
    /// `false` for a digest nobody filled, which is the honest answer rather than a
    /// missing case: reading *unchanged* out of *unrecorded* is how a drift check comes
    /// to certify drift.
    #[must_use]
    pub fn unchanged(&self, text: &str) -> bool {
        self.digest.as_deref() == Some(Self::checksum(text).as_str())
    }

    /// A checksum over a document's words.
    ///
    /// Whitespace is not content: the words are taken in order and everything between
    /// them collapses, so re-wrapping a paragraph leaves the digest where it was.
    /// `scripts/design-check.sh` normalises the same way, and for the same reason — two
    /// documents differing only in how they were wrapped are one document.
    ///
    /// FNV-1a, which tells documents apart and does not withstand somebody who wants two
    /// to collide. Nothing here is a signature: that is the ledger row, and a digest that
    /// stopped matching is the reason to go and read it.
    #[must_use]
    pub fn checksum(text: &str) -> String {
        let mut h = FNV_OFFSET;
        for byte in text
            .split_whitespace()
            .flat_map(|w| w.bytes().chain(Some(b' ')))
        {
            h ^= u64::from(byte);
            h = h.wrapping_mul(FNV_PRIME);
        }
        format!("{h:016x}")
    }
}

impl Store {
    /// The digest of the design this story governs, and `None` when no design stands
    /// behind it.
    ///
    /// *Governs* is the admission gate's own relation read from the story's end: a design
    /// **inside** it, which is what `task add <story>-design --parent <story>` makes, or
    /// one it comes **after**, which is the shape an expansion takes. Both, and
    /// transitively — a chain of steps built on one design is ordinary and only the first
    /// link names the design directly, so `wecode_core::admission` walks these same two
    /// edges in the other direction.
    ///
    /// One query rather than a walk in the caller, for [`Self::set_task_archived`]'s
    /// reason and with its termination: `UNION` and not `UNION ALL`, because `Plan`
    /// refuses a loop but anyone can open wecode.db with the sqlite3 CLI. A story holding
    /// two is answered with its own step first and then by id — deterministic rather than
    /// meaningful, since two designs behind one story is a story decomposed twice.
    pub fn design_of(&self, story: &TaskId) -> Result<Option<Design>, StoreError> {
        let found: Option<(String, String)> = self
            .conn()
            .query_row(
                "WITH RECURSIVE edge(above, below) AS (
                     SELECT parent_id, id FROM tasks WHERE parent_id IS NOT NULL
                     UNION ALL
                     SELECT task_id, prerequisite_id FROM task_depends_on
                 ),
                 governed(id) AS (
                     SELECT ?1
                     UNION
                     SELECT edge.below FROM edge JOIN governed ON edge.above = governed.id
                 )
                 SELECT t.id, t.status FROM tasks t JOIN governed ON t.id = governed.id
                 WHERE t.kind = ?2
                 ORDER BY (t.parent_id IS NOT ?1), t.id LIMIT 1",
                params![story.as_str(), TaskKind::Design.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((task, status)) = found else {
            return Ok(None);
        };
        let status = TaskStatus::parse(&status).ok_or_else(|| StoreError::Corrupt {
            what: "task status",
            value: status.clone(),
        })?;
        Ok(Some(Design {
            document: self.design_document(&task)?,
            task: TaskId::new(task),
            decided: status.is_done(),
            // Never here. The reader that wants a checksum is the one holding the file.
            digest: None,
        }))
    }

    /// Where a design task wrote, according to the task itself.
    ///
    /// Its declared write scope, because that is the one place a task states where it
    /// wrote, and globs are dropped: `docs/**` names a directory rather than a document.
    /// The fallback is the convention `playbook init` writes and the merge report lands
    /// beside. Both halves are the CLI's `handoff` rule, which asks the same question
    /// where the filesystem is.
    fn design_document(&self, task: &str) -> Result<String, StoreError> {
        Ok(self
            .scope(task)?
            .write
            .into_iter()
            .find(|w| w.ends_with(".md") && !w.contains(['*', '?', '[']))
            .unwrap_or_else(|| format!("docs/wecode/{task}/design.md")))
    }
}

#[cfg(test)]
mod tests {
    use wecode_core::{Scope, Task, TaskId, TaskKind, TaskStatus};

    use crate::Store;
    use crate::plan::fixtures::{project, store, task};

    use super::Design;

    /// A story, saved. Aggregating kinds carry no scope and no acceptance of their own.
    fn story(id: &str) -> Task {
        Task::new(id, "caching", format!("one capability: {id}")).of_kind(TaskKind::Story)
    }

    /// A design task writing one named document.
    fn design(id: &str, document: &str) -> Task {
        Task::new(id, "caching", format!("decide {id}"))
            .of_kind(TaskKind::Design)
            .scoped(Scope::write(&[document]))
    }

    /// The story `cache`, with `cache-design` inside it writing `document`.
    fn governed(document: &str) -> Store {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&story("cache")).unwrap();
        s.save_task(&design("cache-design", document).under("cache"))
            .unwrap();
        s
    }

    #[test]
    fn a_story_is_governed_by_the_design_step_inside_it() {
        // The ordinary shape: the story contains its own design, and the build step
        // beside it is not what the question was about.
        let s = governed("docs/wecode/cache/design.md");
        s.save_task(&task("cache-build").under("cache")).unwrap();

        let d = s.design_of(&"cache".into()).unwrap().expect("its design");
        assert_eq!(d.task, TaskId::new("cache-design"));
        assert_eq!(d.document, "docs/wecode/cache/design.md");
        assert!(!d.decided, "written is not signed");
        assert_eq!(d.digest, None, "the store opened no file");

        // A design is finished when somebody signs it, so `done` is the whole test.
        s.set_task_status(&"cache-design".into(), TaskStatus::Done).unwrap();
        assert!(s.design_of(&"cache".into()).unwrap().unwrap().decided);
    }

    #[test]
    fn a_design_the_story_comes_after_governs_it_through_the_chain() {
        // The expansion's shape, and transitively: only the first link names the design,
        // and a story two steps downstream of it is built on it just the same.
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&design("keys-design", "docs/wecode/keys/design.md"))
            .unwrap();
        s.save_task(&task("keys-spike").after("keys-design")).unwrap();
        s.save_task(&story("keys").after("keys-spike")).unwrap();

        let d = s.design_of(&"keys".into()).unwrap().expect("its design");
        assert_eq!(d.task, TaskId::new("keys-design"));
    }

    #[test]
    fn a_story_with_nothing_decided_behind_it_says_so() {
        let s = store();
        s.save_project(&project()).unwrap();
        s.save_task(&story("cache")).unwrap();
        s.save_task(&task("cache-build").under("cache")).unwrap();
        assert_eq!(s.design_of(&"cache".into()).unwrap(), None);
        assert_eq!(s.design_of(&"no-such-story".into()).unwrap(), None);
    }

    #[test]
    fn a_design_that_named_no_document_falls_back_to_the_convention() {
        // A glob names a directory rather than a document, so choosing a file out of it
        // would be a second convention nobody declared.
        let s = governed("docs/**");
        assert_eq!(
            s.design_of(&"cache".into()).unwrap().unwrap().document,
            "docs/wecode/cache-design/design.md"
        );
    }

    #[test]
    fn a_digest_is_of_what_a_document_said_and_not_of_how_it_was_wrapped() {
        let one = "# Keys\n\nThe key is the URL and the vary header.\n";
        let rewrapped = "# Keys\n\nThe key is the URL\nand the vary header.";
        assert_eq!(Design::checksum(one), Design::checksum(rewrapped));
        assert_ne!(Design::checksum(one), Design::checksum("# Keys\n\nThe key is the URL.\n"));
        // Nothing said, however much whitespace it was said in.
        assert_eq!(Design::checksum(""), Design::checksum(" \n\n\t"));
    }

    #[test]
    fn a_digest_nobody_took_certifies_nothing() {
        // Reading *unchanged* out of *unrecorded* is how a drift check comes to certify
        // drift, so the store's own answer — digest `None` — matches no document at all.
        let s = governed("docs/wecode/cache/design.md");
        let text = "# Cache\n\nEvict on write.\n";
        let d = s.design_of(&"cache".into()).unwrap().unwrap();
        assert!(!d.unchanged(text));

        let read = d.clone().read(text);
        assert!(read.unchanged(text));
        assert!(!read.unchanged("# Cache\n\nEvict on read.\n"));
        assert_eq!(read.task, d.task, "reading the file moves nothing else");
    }
}
