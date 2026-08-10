//! Core domain types for wecode: the intent ontology, its grammar, and the
//! admission gate that decides whether an intent is well enough formed to be
//! assigned.
//!
//! This crate is pure: no I/O, no async, no process spawning. Everything here is
//! decidable by inspecting values, which is what makes admission deterministic.

pub mod admission;
pub mod id;
pub mod intent;
pub mod tree;

pub use admission::{Admission, Defect, Waiver};
pub use id::IntentId;
pub use intent::{
    Budget, Cmp, Horizon, Intent, IntentKind, Link, Measure, Polarity, Scope, Sphere,
    StandaloneReason, Status,
};
pub use tree::{IntentTree, TreeError};
