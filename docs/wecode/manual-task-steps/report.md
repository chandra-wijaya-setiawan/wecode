# manual-task-steps → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  manual-task-steps → master

summary
  9 files, +925 −31
  how        signed off
  unblocks   project-purpose
  worktree   removed /home/cws/.wecode/run/cws/manual-task-steps
  undo       wecode rollback manual-task-steps   (was e691c0e70)

what changed
  crates/wecode-cli/src/commands/plan/task.rs          +168   −1
  crates/wecode-cli/src/notify.rs                      +104   −5
  crates/wecode-cli/tests/notify.rs                    +111   −0
  crates/wecode-cli/tests/steps.rs                     +196   −0
  crates/wecode-store/src/plan.rs                      +134   −0
  crates/wecode-store/src/schema.rs                    +68    −5
  docs/reference/commands.md                           +35    −16
  docs/reference/config/notify.md                      +55    −0
  docs/reference/schema.md                             +54    −4

by area
  crates/wecode-cli/tests  2 files, +307 −0
  crates/wecode-store/src  2 files, +202 −5
  crates/wecode-cli/src/commands/plan 1 file, +168 −1
  crates/wecode-cli/src    1 file, +104 −5
  docs/reference           2 files, +89 −20
  docs/reference/config    1 file, +55 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/manual-task-steps
  merge      c00ddfb92
  target was e691c0e70
```
