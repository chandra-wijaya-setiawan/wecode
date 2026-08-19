# task-teardown-hook → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  task-teardown-hook → master

summary
  1 file, +457 −1
  how        signed off
  unblocks   live-acceptance-tier
  worktree   removed /home/cws/.wecode/run/cws/task-teardown-hook
  undo       wecode rollback task-teardown-hook   (was 0a51bbcd4)

what changed
  crates/wecode-cli/src/teardown.rs                    +457   −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/task-teardown-hook
  merge      0bbd4d925
  target was 0a51bbcd4
```
