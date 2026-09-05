//! The plan a test starts from.
//!
//! Shared because the split below is of the writes and not of the rows: a task test
//! still needs a project to hang the task off, and two definitions of `caching` would
//! be two plans that drifted apart the first time either was edited.

use wecode_core::{Budget, Cmp, Measure, Project, Scope, Task};

use crate::Store;

pub(super) fn store() -> Store {
    Store::in_memory().unwrap()
}

pub(super) fn project() -> Project {
    Project::new("caching", "add response caching", "wecode")
        .measured(Measure::Metric {
            name: "p99_ms".into(),
            target: 500.0,
            cmp: Cmp::Lt,
        })
        .budgeted(Budget {
            tokens: Some(200_000),
            wall_secs: Some(1800),
        })
}

pub(super) fn task(id: &str) -> Task {
    Task::new(id, "caching", format!("do {id}"))
        .accepting(Measure::Command {
            cmd: "cargo test".into(),
            expect_status: 0,
        })
        .scoped(Scope::write(&["crates/export/**"]))
        .budgeted(Budget {
            tokens: Some(1000),
            wall_secs: Some(60),
        })
}
