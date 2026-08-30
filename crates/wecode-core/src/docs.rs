//! What a document says it governs, and the join that catches a diff without it.
//!
//! Martraire's *reconciliation*: a mechanical comparison between a document and its
//! subject. Here the document names its own subject, in front-matter, in the same glob
//! language a write scope is written in — so a `subject:` line means exactly what a
//! scope line means and nobody learns a second dialect.
//!
//! The comparison is over one diff and never over the tree's history. A join against
//! last-commit timestamps would fail a task for staleness that existed before it
//! started; over a diff, a run can only be refused for coupling that run created, which
//! is why this ships enforcing on the day it lands with no threshold and no idle period.
//!
//! Pure, like the rest of this crate. A document is somebody else's repository's file,
//! so the caller opens it and hands the text over — the idiom
//! [`crate::admission::check_refusals`] already uses for a list it never read. The
//! matcher comes in the same way, which is what lets the glob language live in
//! `wecode-gov` while the join lives here.

/// How a page is kept true — the classification in `docs/design/living-docs.md`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Class {
    /// Rebuilt from its source of truth. A generator's output moving is the generator's
    /// problem, and joining it would fail a task for a file it never opened.
    Generated,
    /// It runs, so drift already fails a gate of its own.
    Executable,
    /// Append-only and dated. Never edited, so *did not move* is the correct state here
    /// and the gate that eventually watches these is the opposite one.
    Record,
    /// States slow truths only.
    Evergreen,
    /// Nothing keeps this true but somebody opening it. The class this join exists for,
    /// and what a page declaring a subject and no class is taken to be.
    #[default]
    HandTended,
}

impl Class {
    /// The word a page wrote, or [`Class::HandTended`] for anything else.
    ///
    /// An unrecognised word is *watched* rather than exempt. The exemptions are what
    /// this gate's silence is made of, and a misspelling must not be able to buy one.
    #[must_use]
    pub fn named(word: &str) -> Self {
        match word.trim() {
            "generated" => Self::Generated,
            "executable" => Self::Executable,
            "record" => Self::Record,
            "evergreen" => Self::Evergreen,
            _ => Self::HandTended,
        }
    }

    /// Whether a page of this class is joined against a diff at all.
    #[must_use]
    pub fn watched(self) -> bool {
        matches!(self, Self::Evergreen | Self::HandTended)
    }
}

/// A document, and the paths it says it governs.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Doc {
    /// Where the document is, spelled as the diff spells it.
    pub path: String,
    /// The globs it governs. Empty is the ordinary case and means *governs nothing*:
    /// absence of a declaration is what makes coverage something that ratchets rather
    /// than a threshold somebody has to pick.
    pub subject: Vec<String>,
    pub class: Class,
}

/// One document that did not move with the code it governs.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Stale {
    pub doc: String,
    /// A changed path this document governs — one of them, not all. The finding is
    /// answered by opening the page, and a second example does not change what to do.
    pub because: String,
}

/// The front-matter key naming what a document governs.
const SUBJECT: &str = "subject";
/// The front-matter key naming how the page is kept true — see [`Class`].
const CLASS: &str = "class";
/// The fence a front-matter block opens and closes with.
const FENCE: &str = "---";

/// Reads a document's declaration. `path` is how a diff names the file, `text` is what
/// is in it.
///
/// Front-matter is a leading [`FENCE`] and `key: value` lines under it, `subject:`
/// taking a bracketed list, a single glob, or `- ` items on the lines below. Read only
/// at the head of the file, so a `---` rule in prose stays prose.
///
/// A file that opens with anything else declares nothing, which is the state every page
/// in a tree starts in — and it is what keeps this convention from colliding with
/// `design-check.sh`, which reads a design record's first line as its title.
#[must_use]
pub fn parse(path: &str, text: &str) -> Doc {
    let mut doc = Doc {
        path: path.to_string(),
        subject: Vec::new(),
        class: Class::default(),
    };
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some(FENCE) {
        return doc;
    }
    let mut key = String::new();
    for line in lines {
        let line = line.trim();
        if line == FENCE {
            break;
        }
        if let Some(item) = line.strip_prefix("- ") {
            if key == SUBJECT {
                doc.subject.push(unquote(item));
            }
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        key = k.trim().to_string();
        match key.as_str() {
            SUBJECT => doc.subject.extend(values(v)),
            CLASS => doc.class = Class::named(v),
            _ => {}
        }
    }
    doc
}

/// The values on one `key:` line: a bracketed list, a lone value, or nothing at all
/// when the items are on the lines beneath it.
fn values(v: &str) -> Vec<String> {
    let v = v.trim();
    let inner = v
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(v);
    inner
        .split(',')
        .map(unquote)
        .filter(|s| !s.is_empty())
        .collect()
}

/// One value, with the quotes a glob is often written inside taken off.
fn unquote(s: &str) -> String {
    s.trim().trim_matches(['"', '\'']).trim().to_string()
}

/// The documents `changed` left behind.
///
/// A document is stale when a changed path matches one of its subjects and its own path
/// is not in the same list. That is the whole test: not a size floor, not a similarity
/// measure, not a judgement about whether the edit was any good — a one-word change
/// satisfies it. Form is `design-check.sh`'s business and substance is an owner's; what
/// is left for a machine is the join, and the claim it enforces is only that whoever
/// changed the subject had the page open while they still knew what changed.
///
/// `matches` is the caller's matcher, so this crate stays dependency-free while the
/// globs mean what `wecode_gov::glob::any_matches` says they mean.
///
/// There is no waiver here and no override to pass in. The two answers to a finding are
/// *edit the page* or *narrow its `subject:`*, and the second is not an escape hatch —
/// it is the page telling the truth about what it governs.
#[must_use]
pub fn stale(
    docs: &[Doc],
    changed: &[String],
    matches: &dyn Fn(&[String], &str) -> bool,
) -> Vec<Stale> {
    docs.iter()
        .filter(|d| d.class.watched() && !d.subject.is_empty())
        .filter(|d| !changed.iter().any(|p| p == &d.path))
        .filter_map(|d| {
            changed
                .iter()
                .find(|p| matches(&d.subject, p))
                .map(|p| Stale {
                    doc: d.path.clone(),
                    because: p.clone(),
                })
        })
        .collect()
}

/// How many of `docs` declare a subject at all, and are therefore joined.
///
/// The reach of the check, for whoever has to trust its silence — the same reason
/// `max-lines.sh` prints the number it would allow on the way past. A check nobody can
/// see the coverage of is a check nobody believes when it says nothing.
#[must_use]
pub fn governed(docs: &[Doc]) -> usize {
    docs.iter()
        .filter(|d| d.class.watched() && !d.subject.is_empty())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The matcher the caller supplies, in the one shape these tests need: prefix
    /// containment, which is all the fixtures below ask of it. The real one is
    /// `wecode_gov::glob::any_matches`, and it cannot be reached from a crate with no
    /// dependencies — which is the same fact that makes it a parameter.
    fn like(subject: &[String], path: &str) -> bool {
        subject
            .iter()
            .any(|s| path.starts_with(s.trim_end_matches("**").trim_end_matches('/')))
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    fn page(body: &str) -> Doc {
        parse("docs/cache.md", body)
    }

    #[test]
    fn a_page_with_no_front_matter_governs_nothing() {
        // The state every page in a tree starts in, and the reason coverage ratchets
        // instead of being a threshold: silence is a legal answer.
        let d = page("# The cache\n\nHow it evicts.\n");
        assert!(d.subject.is_empty());
        assert!(stale(&[d], &paths(&["src/cache.rs"]), &like).is_empty());
    }

    #[test]
    fn a_rule_in_the_prose_is_not_front_matter() {
        // Read only at the head of the file. A `---` further down is a horizontal rule,
        // and treating it as a fence would let body text declare a subject.
        let d = page("# The cache\n\n---\nsubject: [src/**]\n---\n");
        assert!(d.subject.is_empty(), "{d:?}");
    }

    #[test]
    fn a_subject_is_read_as_a_list_however_it_was_written() {
        for body in [
            "---\nsubject: [src/cache.rs, \"src/evict.rs\"]\n---\n",
            "---\nsubject:\n  - src/cache.rs\n  - 'src/evict.rs'\n---\n",
        ] {
            assert_eq!(page(body).subject, paths(&["src/cache.rs", "src/evict.rs"]));
        }
        assert_eq!(page("---\nsubject: src/cache.rs\n---\n").subject, ["src/cache.rs"]);
    }

    #[test]
    fn a_document_the_diff_left_behind_is_named_with_what_implicated_it() {
        // The finding this module exists for. *Edit this page* is not actionable
        // without the change that asked for it.
        let d = page("---\nsubject: [src/**]\n---\n");
        let found = stale(&[d], &paths(&["Cargo.toml", "src/cache.rs"]), &like);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].doc, "docs/cache.md");
        assert_eq!(found[0].because, "src/cache.rs");
    }

    #[test]
    fn a_document_that_moved_with_its_subject_is_not_stale() {
        // The other half, or the gate would be one no diff could satisfy. A one-word
        // change satisfies it: the join is over presence in the diff and nothing else.
        let d = page("---\nsubject: [src/**]\n---\n");
        let changed = paths(&["docs/cache.md", "src/cache.rs"]);
        assert!(stale(&[d], &changed, &like).is_empty());
    }

    #[test]
    fn a_diff_that_never_reached_the_subject_asks_nothing_of_the_page() {
        let d = page("---\nsubject: [src/**]\n---\n");
        assert!(stale(&[d], &paths(&["README.md"]), &like).is_empty());
    }

    #[test]
    fn generated_and_record_pages_are_never_joined() {
        // A generator's output moving is the generator's problem, and an ADR edited
        // after the fact is the defect rather than the cure — the gate that watches
        // records is the opposite one.
        for class in ["generated", "record", "executable"] {
            let d = page(&format!("---\nclass: {class}\nsubject: [src/**]\n---\n"));
            assert!(stale(&[d], &paths(&["src/cache.rs"]), &like).is_empty(), "{class}");
        }
    }

    #[test]
    fn evergreen_and_hand_tended_pages_are() {
        for class in ["evergreen", "hand-tended", "sombrero", ""] {
            let d = page(&format!("---\nclass: {class}\nsubject: [src/**]\n---\n"));
            assert_eq!(stale(&[d], &paths(&["src/cache.rs"]), &like).len(), 1, "{class}");
        }
    }

    #[test]
    fn an_unrecognised_class_is_watched_rather_than_exempt() {
        // Said twice on purpose. The exemptions are what this gate's silence is made
        // of, so a typo must fail loudly rather than quietly buy one.
        assert_eq!(Class::named("genarated"), Class::HandTended);
        assert!(Class::named("genarated").watched());
        assert!(!Class::named("generated").watched());
    }

    #[test]
    fn the_reach_of_the_check_is_countable() {
        // So the silence can be trusted: a gate nobody can see the coverage of is a
        // gate nobody believes when it reports nothing.
        let docs = vec![
            page("---\nsubject: [src/**]\n---\n"),
            page("---\nclass: generated\nsubject: [src/**]\n---\n"),
            page("# no front matter\n"),
        ];
        assert_eq!(governed(&docs), 1);
    }
}
