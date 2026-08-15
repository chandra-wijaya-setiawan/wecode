//! Workspaces whose work can actually be landed.

use std::path::PathBuf;

use super::agent::with_agent;
use super::{Org, git};

/// A workspace whose repo has a `dev` branch and the given merge policy.
pub(crate) fn mergeable(name: &str, policy: &str) -> (Org, PathBuf) {
    let (org, repo) = with_agent(name, "echo landed >> src/app.txt");
    org.playbook(
        &repo,
        &format!(
            "[project]\nlanguage = \"text\"\nmerge_to = \"dev\"\nmerge = \"{policy}\"\n\n\
             [chore]\nworktree = true\nassign_to = \"impl\"\naccept = [\"true\"]\n\
             tokens = 100\nwall_secs = 30\nguidance = \"x\"\n"
        ),
    );
    git(&repo, &["branch", "dev"]);
    // The chief already carries `merge_to` from the template: landing work is its job.
    (org, repo)
}

pub(crate) fn landed_task(org: &Org, id: &str) {
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
        "src/**",
        "--accept-cmd",
        "grep -q landed src/app.txt",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("task add");
    org.run(&["run", id]).assert_contains("passed");
}
