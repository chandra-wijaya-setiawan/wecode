# manual-task-kind → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  manual-task-kind → master

summary
  10 files, +624 −36
  how        signed off
  unblocks   task-onto-branch
  worktree   removed /home/cws/.wecode/run/cws/manual-task-kind
  undo       wecode rollback manual-task-kind   (was 86f605cb9)

what changed
  crates/wecode-cli/src/board.rs                       +1     −1
  crates/wecode-cli/src/commands/exec.rs               +19    −1
  crates/wecode-cli/src/render.rs                      +58    −1
  crates/wecode-cli/src/render/plan.rs                 +61    −0
  crates/wecode-cli/src/scheduler.rs                   +113   −0
  crates/wecode-core/src/admission.rs                  +32    −33
  crates/wecode-core/src/task.rs                       +169   −0
  docs/concepts.md                                     +30    −0
  docs/features.md                                     +19    −0
  docs/wecode/manual-task-kind/design.md               +122   −0

by area
  crates/wecode-core/src   2 files, +201 −33
  crates/wecode-cli/src    3 files, +172 −2
  docs/wecode/manual-task-kind 1 file, +122 −0
  crates/wecode-cli/src/render 1 file, +61 −0
  docs                     2 files, +49 −0
  crates/wecode-cli/src/commands 1 file, +19 −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/manual-task-kind
  merge      f084211e5
  target was 86f605cb9
```
