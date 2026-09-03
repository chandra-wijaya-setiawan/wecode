# harness-contract → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  harness-contract → master

summary
  4 files, +373 −56
  how        signed off
  unblocks   board-says-needs-human, hold-status, repo-names-are-unique
  worktree   removed /home/cws/.wecode/run/cws/harness-contract
  undo       wecode rollback harness-contract   (was bc13e1399)

what changed
  crates/wecode-cli/src/usage.rs                       +131   −36
  crates/wecode-cli/tests/run.rs                       +60    −12
  crates/wecode-org/src/company.rs                     +123   −0
  docs/reference/config/company.md                     +59    −8

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/harness-contract
  merge      a04de8f40
  target was bc13e1399
```
