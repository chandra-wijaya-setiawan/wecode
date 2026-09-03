//! The design digest, against this repository's own designs.
//!
//! The store's unit tests cover the fold on stories written for them. This covers the
//! designs that exist — every `docs/wecode/*/design.md`, exactly as somebody typed it.
//! That is a different kind of check, and the same one `tests/adr.rs` makes about the ADR
//! index: a digest is worth nothing unless it tells *this* repository's documents apart,
//! and the way it stops doing so is not a broken hash but a convention that moved.
//!
//! It also reconciles the two ends, in Martraire's sense — the path the store derives
//! from a task's write scope against the file that is actually there. The derivation and
//! the convention agree only while somebody keeps them agreeing, which is a thing a test
//! can hold and a comment cannot.
//!
//! No workspace and no binary here, so `support` is not pulled in: the subject is the
//! store's fold over documents this repository already contains.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use wecode_core::{Project, Scope, Task, TaskKind};
use wecode_store::Store;
use wecode_store::plan::Design;

fn wecode_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/wecode")
}

/// Every `docs/wecode/<task>/design.md` as `(task, text)`, by task — the directory name
/// is the task the design was written for, which is what the convention is made of.
fn designs() -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = std::fs::read_dir(wecode_dir())
        .expect("docs/wecode exists")
        .map(|e| e.expect("readable entry").path())
        .filter_map(|dir| {
            let text = std::fs::read_to_string(dir.join("design.md")).ok()?;
            let task = dir.file_name()?.to_string_lossy().into_owned();
            Some((task, text))
        })
        .collect();
    found.sort();
    assert!(found.len() > 1, "this repository has designs to digest");
    found
}

/// A store holding one story, with one design task under it writing `document`.
fn story_governed_by(task: &str, document: &str) -> Store {
    let store = Store::in_memory().expect("a store");
    store
        .save_project(&Project::new("wecode", "run agents as staff", "wecode"))
        .expect("a project");
    store
        .save_task(&Task::new("cap", "wecode", "one user-visible capability").of_kind(TaskKind::Story))
        .expect("a story");
    let mut design = Task::new(task, "wecode", format!("decide {task}"))
        .of_kind(TaskKind::Design)
        .under("cap");
    if !document.is_empty() {
        design = design.scoped(Scope::write(&[document]));
    }
    store.save_task(&design).expect("a design");
    store
}

#[test]
fn every_design_this_repository_holds_digests_to_its_own_checksum() {
    // The property the digest is for. A design pasted from next door and retitled would
    // land here as two tasks with one checksum, which is `design-check.sh`'s finding
    // stated in the store's terms.
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    for (task, text) in designs() {
        let sum = Design::checksum(&text);
        if let Some(first) = seen.insert(sum.clone(), task.clone()) {
            panic!("{task} and {first} are the same document ({sum})");
        }
    }
    assert!(seen.len() > 1);
}

#[test]
fn the_store_names_the_document_the_story_was_built_on() {
    // The derivation, against every design in the tree: the path comes out of the design
    // task's own write scope, and what is at that path is what the digest is taken of.
    for (task, text) in designs() {
        let document = format!("docs/wecode/{task}/design.md");
        let store = story_governed_by(&format!("{task}-design"), &document);
        let d = store
            .design_of(&"cap".into())
            .expect("readable")
            .expect("the story's design");

        assert_eq!(d.document, document, "{task}");
        assert_eq!(d.digest, None, "the store opens no files");
        assert!(!d.decided, "{task}: written is not signed");

        let read = d.read(&text);
        assert!(read.unchanged(&text), "{task}");
        assert_eq!(read.digest.as_deref(), Some(Design::checksum(&text).as_str()));
    }
}

#[test]
fn the_convention_the_store_falls_back_to_is_the_one_this_repository_keeps() {
    // A design that declared no document is answered with `docs/wecode/<task>/design.md`,
    // and this is the claim that fallback rests on: that is where the documents are. It
    // is checked against the tree rather than against a string, because the fallback is
    // only worth having while the convention is still true.
    for (task, _) in designs() {
        let store = story_governed_by(&task, "");
        let d = store
            .design_of(&"cap".into())
            .expect("readable")
            .expect("the story's design");
        assert_eq!(d.document, format!("docs/wecode/{task}/design.md"));
        assert!(
            wecode_dir().join(&task).join("design.md").is_file(),
            "{}: the derived path is where the document is",
            d.document
        );
    }
}

#[test]
fn a_design_edited_after_it_was_digested_stops_matching() {
    // What the digest exists to catch: a document signed once and saved again since.
    // Re-wrapping is not an edit — whitespace is not content — and a sentence is.
    let (task, text) = designs().pop().expect("a design");
    let store = story_governed_by(&format!("{task}-design"), &format!("docs/wecode/{task}/design.md"));
    let signed = store
        .design_of(&"cap".into())
        .expect("readable")
        .expect("the story's design")
        .read(&text);

    let rewrapped = text.split_whitespace().collect::<Vec<_>>().join("\n");
    assert!(signed.unchanged(&rewrapped), "{task}: rewrapped is the same document");
    assert!(
        !signed.unchanged(&format!("{text}\n\nOne more decision nobody signed.\n")),
        "{task}: an added decision is a changed document"
    );
}
