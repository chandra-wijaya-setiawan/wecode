//! Standing a shell script in for a coding CLI, and the tasks to point it at.

use std::path::PathBuf;

use super::Org;
use super::playbook::{PLAYBOOK, with_playbook};

/// A workspace whose `impl` post is a shell script rather than a coding CLI.
pub(crate) fn with_agent(name: &str, script: &str) -> (Org, PathBuf) {
    let (org, repo) = with_playbook(name);
    org.agent(script);
    (org, repo)
}

pub(crate) fn a_task(org: &Org, id: &str, glob: &str, accept: &str) {
    org.run(&[
        "task",
        "add",
        id,
        "--project",
        "caching",
        "--kind",
        "chore",
        "append a marker comment to the source",
        "--write",
        glob,
        "--write",
        ".wecode/run/**",
        "--accept-cmd",
        accept,
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("task add");
}

/// A workspace whose project will not dispatch a task until someone signs for it.
pub(crate) fn signs_first(name: &str, script: &str) -> Org {
    let (org, repo) = with_agent(name, script);
    org.playbook(
        &repo,
        &PLAYBOOK.replace(
            "language = \"rust\"",
            "language = \"rust\"\ndispatch = \"approved\"",
        ),
    );
    org
}

/// A task inside the engineer's own write scope, so naming the post actually hands it
/// over: [`a_task`]'s narrower globs leave it a draft, and the scheduler never offers a
/// draft to anything.
pub(crate) fn a_task_in_src(org: &Org, id: &str, glob: &str, accept: &str) {
    org.run(&[
        "task",
        "add",
        id,
        "--project",
        "caching",
        "--kind",
        "chore",
        "append a marker comment to the source",
        "--write",
        glob,
        "--accept-cmd",
        accept,
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("task add");
}
