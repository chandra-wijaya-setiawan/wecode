# one-project-per-repo → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  one-project-per-repo → master

summary
  4 files, +210 −2
  how        signed off
  unblocks   components, harness-contract, sweep-files-finished-work
  worktree   removed /home/cws/.wecode/run/cws/one-project-per-repo
  undo       wecode rollback one-project-per-repo   (was d22ed34c9)

what changed
  .max-lines                                           +2     −2
  crates/wecode-cli/tests/plan.rs                      +28    −0
  crates/wecode-core/src/admission.rs                  +85    −0
  specs/010-one-project-per-repo/specification.md      +95    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rqi 'RepoAlreadyHasProject\|repo_already' crates/wecode-core/src/admission.rs` exits 0

provenance
  branch     wecode/one-project-per-repo
  merge      b1b810d3e
  target was d22ed34c9
```
