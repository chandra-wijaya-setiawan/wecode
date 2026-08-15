//! The repository guidance a task is admitted against, and the workspaces built
//! on top of it.

use std::path::PathBuf;

use super::Org;

/// Guidance with everything a test might lean on, stated explicitly.
pub(crate) const PLAYBOOK: &str = r#"
[project]
language = "rust"

[bug]
worktree = true
assign_to = "impl"
accept = ["true"]
tokens = 1000
wall_secs = 60
guidance = "Reproduce first, then a failing test, then the fix."

[chore]
worktree = true
assign_to = "impl"
accept = ["true"]
tokens = 1000
wall_secs = 60
guidance = "Uses a worktree, like most work here."

[docs]
worktree = false
assign_to = "impl"
accept = ["true"]
tokens = 1000
wall_secs = 60
guidance = "Single task, no worktree."
"#;

/// A workspace with a real repo and a playbook in it.
pub(crate) fn with_playbook(name: &str) -> (Org, PathBuf) {
    with_playbook_body(name, PLAYBOOK)
}

/// The same, with guidance the test states itself — for the settings the shared
/// constant deliberately does not carry.
pub(crate) fn with_playbook_body(name: &str, body: &str) -> (Org, PathBuf) {
    let org = Org::new(name, "solo");
    let repo = org.repo();
    org.playbook(&repo, body);
    org.run(&[
        "project",
        "add",
        "caching",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "1000",
        "--wall",
        "60",
    ])
    .assert_ok("add project");
    (org, repo)
}
