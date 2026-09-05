//! Fixtures shared across the exec submodules' tests: a repository chain, a plan, and
//! the harness and budget a limits test is written against.

use std::path::PathBuf;

use wecode_core::{Budget, Plan, Project, Task, TaskStatus};
use wecode_org::AgentTemplate;

/// git, insisting it worked. A real repository is the only way to ask the question
/// these tests are about — git is a subprocess here, so a fake would test itself.
fn git_in(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A repository where `first` did its work on `wecode/first`, and `main` is the
/// integration branch. When `merged`, that branch landed the way `wecode merge`
/// lands one — `--no-ff`, subject `<task>: <title>` — and `main` then moved on,
/// which is what leaves the branch standing behind it.
pub(crate) fn chain_repo(name: &str, merged: bool) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wecode-exec-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for argv in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"],
        &["config", "user.name", "t"],
        &["commit", "-qm", "start", "--allow-empty"],
        &["checkout", "-q", "-b", "wecode/first"],
        &["commit", "-qm", "first: attempt 1", "--allow-empty"],
        &["checkout", "-q", "main"],
    ] {
        git_in(&dir, argv);
    }
    if merged {
        let msg = "first: lay the groundwork";
        git_in(&dir, &["merge", "-q", "--no-ff", "-m", msg, "wecode/first"]);
        // What makes the branch stale rather than merely redundant.
        git_in(&dir, &["commit", "-qm", "other: alongside", "--allow-empty"]);
    }
    dir
}

/// `second` after a done `first`, which is the whole graph these tests need.
pub(crate) fn chain() -> (Plan, Task) {
    let mut plan = Plan::new();
    plan.add_project(Project::new("caching", "cache things", "app"))
        .unwrap();
    let mut first = Task::new("first", "caching", "lay the groundwork");
    first.status = TaskStatus::Done;
    plan.add_task(first).unwrap();
    let second = Task::new("second", "caching", "build on the groundwork").after("first");
    plan.add_task(second.clone()).unwrap();
    (plan, second)
}

/// A harness with whatever clock the test is about.
pub(crate) fn harness(wall: Option<u64>, idle: Option<u64>) -> AgentTemplate {
    AgentTemplate {
        command: "sh".to_string(),
        protocol: String::new(),
        args: vec![],
        env_allowlist: vec![],
        wall_secs: wall,
        idle_secs: idle,
        models: vec![],
        model_flag: "--model".to_string(),
    }
}

pub(crate) fn budgeted(wall: Option<u64>) -> Task {
    Task::new("t", "caching", "append a marker comment to the source").budgeted(Budget {
        tokens: Some(1000),
        wall_secs: wall,
    })
}
