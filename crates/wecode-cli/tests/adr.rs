//! The ADR index, against this repository's own decisions.
//!
//! The store's unit tests cover the fold on ADRs written for them. This covers the ones
//! that exist — every file under `docs/adr/`, exactly as somebody typed it. That is a
//! different kind of check and it is the point of the feature: an index of decisions is
//! worth nothing unless it holds *every* decision, and the way it stops doing so is not a
//! broken fold but a new ADR whose first lines nobody thought about.
//!
//! It also reconciles the index against `docs/adr/README.md`, in Martraire's sense: two
//! statements of one fact, mechanically compared. The README table is hand-tended and the
//! index is minted from the files, so the two agree only while somebody keeps them
//! agreeing — which is exactly the thing a test can hold and a convention cannot.
//!
//! No workspace and no binary here, so `support` is not pulled in: the subject is the
//! store's fold over text this repository already contains.

use std::path::{Path, PathBuf};

use wecode_core::ProjectId;
use wecode_store::Store;
use wecode_store::audit::{Adr, AdrHead, By};

fn adr_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/adr")
}

/// Every `docs/adr/*.md` as `(file name, text)`, by name — which for a four-digit
/// prefix is by number.
fn pages() -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = std::fs::read_dir(adr_dir())
        .expect("docs/adr exists")
        .map(|e| e.expect("readable entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "md"))
        .map(|p| {
            let name = p.file_name().expect("a named file").to_string_lossy().into_owned();
            (name, std::fs::read_to_string(&p).expect("readable page"))
        })
        .collect();
    found.sort();
    assert!(found.len() > 1, "the directory is not empty");
    found
}

/// The whole directory, indexed into a fresh store, as the index reads it back.
fn indexed() -> Vec<Adr> {
    let store = Store::in_memory().expect("a store");
    let by = By {
        session: "s-1",
        post: "lead",
        agent: "claude-code",
        human: "Chandra",
    };
    let project = ProjectId::new("wecode");
    for (name, text) in pages() {
        if let Some(head) = AdrHead::parse(&text) {
            store
                .record_adr(by, &project, &head)
                .unwrap_or_else(|e| panic!("indexing {name}: {e}"));
        }
    }
    store.adrs().expect("the index")
}

#[test]
fn every_adr_the_repository_has_decided_is_in_the_index() {
    // The count is the assertion. A page with a heading this cannot read is a decision
    // that silently stops being indexed, and nothing else in the tree would notice.
    let decisions: Vec<(String, String)> = pages()
        .into_iter()
        .filter(|(name, _)| name != "README.md")
        .collect();
    let found = indexed();

    assert_eq!(
        found.len(),
        decisions.len(),
        "{} decisions on disk, {} in the index: {:?}",
        decisions.len(),
        found.len(),
        found.iter().map(|a| &a.id).collect::<Vec<_>>()
    );
    for ((name, _), adr) in decisions.iter().zip(&found) {
        // The number in the id names the file, which is why the index carries no path.
        let number = name.split('-').next().expect("a numbered file");
        assert_eq!(adr.id, format!("ADR-{number}"), "{name} indexed as {}", adr.id);
        assert!(!adr.title.is_empty(), "{name} indexed without its title");
    }
}

#[test]
fn the_index_agrees_with_the_table_a_reader_arrives_at() {
    // docs/adr/README.md is hand-tended; the index is minted from the files. Two
    // statements of one fact, so compare them rather than trusting whoever edited last.
    let readme = std::fs::read_to_string(adr_dir().join("README.md")).expect("the README");
    for adr in indexed() {
        let number = adr.id.trim_start_matches("ADR-");
        let row = readme
            .lines()
            .find(|l| l.starts_with(&format!("| [{number}]")))
            .unwrap_or_else(|| panic!("{} is decided but the README lists no row for it", adr.id));
        assert!(
            row.contains(&adr.title),
            "{}: the README calls it something else\n  index:  {}\n  README: {row}",
            adr.id,
            adr.title
        );
        let superseded = row.contains("superseded");
        assert_eq!(
            superseded,
            adr.superseded_by.is_some(),
            "{}: the README says {}, the index says {}",
            adr.id,
            if superseded { "superseded" } else { "accepted" },
            adr.status()
        );
    }
}

#[test]
fn a_supersession_is_stated_from_both_ends_and_the_two_ends_agree() {
    // Nygard-form: the replacement names what it replaces, and the replaced page keeps
    // pointing forward for a reader who arrived at it from an old citation. Either
    // sentence alone would leave the index right and one of the two files misleading.
    let heads: Vec<AdrHead> = pages()
        .iter()
        .filter_map(|(_, text)| AdrHead::parse(text))
        .collect();
    let mut checked = 0;
    for head in &heads {
        if let Some(old) = &head.supersedes {
            let back = heads.iter().find(|h| &h.id == old).unwrap_or_else(|| {
                panic!("{} supersedes {old}, which is not in docs/adr", head.id)
            });
            assert_eq!(
                back.superseded_by.as_ref(),
                Some(&head.id),
                "{old} does not say it was superseded by {}",
                head.id
            );
            checked += 1;
        }
    }
    assert!(checked > 0, "the repository has superseded a decision, so this is not vacuous");
    // And the fold agrees with both halves.
    let index = indexed();
    let replaced: Vec<&Adr> = index.iter().filter(|a| a.superseded_by.is_some()).collect();
    assert_eq!(replaced.len(), checked, "one superseded row per supersession");
}
