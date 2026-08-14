//! Core domain types: what a company is trying to do, and how it is broken down.
//!
//! Two levels of work, not four. A **project** owns one repository and carries its
//! own objective; a **task** is the executable unit. Vision and mission live on the
//! company, an objective lives on the project — neither was ever executable, and
//! both cost a level of tree.
//!
//! Tasks carry two independent relations: `parent` (is part of) and `depends_on`
//! (must come after). Conflating them is the classic modelling error here, so they
//! are checked separately and mean different things.
//!
//! This crate is pure: no I/O, no async. Everything is decidable by inspecting
//! values, which is what makes the admission gate deterministic.

pub mod admission;
pub mod common;
pub mod execution;
pub mod id;
pub mod plan;
pub mod project;
pub mod short;
pub mod task;

pub use admission::{Admission, Defect, Waiver};
pub use common::{Budget, Cmp, Measure, ProjectStatus, Scope, TaskStatus, WORKER_DIR};
pub use execution::ExecutionStatus;
pub use id::{ProjectId, TaskId};
pub use short::Number;
pub use plan::{Blocker, Plan, PlanError};
pub use project::Project;
pub use task::{Task, TaskKind};
