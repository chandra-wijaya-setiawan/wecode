//! One module per group of commands.
//!
//! `main.rs` keeps only the dispatch table. Before this split every CLI change edited
//! the same file, so the admission gate reported a scope conflict between any two of
//! them — the check was right about the shape of the code, and this is the fix.

pub(crate) mod ctx;
pub(crate) mod exec;
pub(crate) mod gov;
pub(crate) mod org;
pub(crate) mod plan;
pub(crate) mod trees;
pub(crate) mod view;
