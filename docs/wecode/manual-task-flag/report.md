# manual-task-flag → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  manual-task-flag → master

summary
  4 files, +111 −55
  how        signed off
  unblocks   project-purpose
  worktree   removed /home/cws/.wecode/run/cws/manual-task-flag
  undo       wecode rollback manual-task-flag   (was 183501704)

what changed
  crates/wecode-cli/src/commands/plan/task.rs          +35    −0
  crates/wecode-cli/src/main.rs                        +3     −0
  crates/wecode-cli/tests/plan.rs                      +46    −55
  docs/reference/commands.md                           +27    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/manual-task-flag
  merge      6c3cb1abf
  target was 183501704
```
