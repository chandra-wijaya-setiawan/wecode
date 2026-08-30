//! The codemap: what each file defines, what it names, and what sits next to a scope.
//!
//! A design step names the files its build will touch, and until this existed it named
//! them by reading the tree and guessing. The guess is what the write scope is made of,
//! and a wrong one is not recoverable: scope is frozen at creation, so a task that
//! declared too little dies holding work it may not commit, and one that declared too
//! much collides at admission and serialises against every neighbour in the crate.
//!
//! Three layers describe a repository, and this crate is only the middle one.
//!
//! | layer | unit | where it comes from |
//! |---|---|---|
//! | file | path, length, first line | the git index — `wecode-cli`'s `map` module |
//! | **symbol** | **a definition or a reference, by name and line** | **here** |
//! | component | a named responsibility owning paths | a person, in `docs/architecture.md` |
//!
//! The component layer keeps its author. A responsibility is a claim about intent, and
//! a cluster label a machine invented is a label nobody reviews and everybody inherits.
//!
//! **This crate opens no files.** The caller reads bytes and hands them in — the same
//! division `wecode_core::docs` already uses — which is what keeps the C dependency and
//! the I/O in separate crates, and what lets every test here run on a string.
//!
//! What it deliberately cannot do is refuse anything. See [`rank`] for why: an edge is
//! a matched spelling, and a scope refused because two identifiers happened to be
//! spelled alike would be unrepairable inside a run that cannot widen its own scope.

mod lang;
mod rank;
mod tags;

pub use lang::Language;
pub use rank::{Index, Ranked, Ranking, rank};
pub use tags::{Tag, TagKind, tags};
