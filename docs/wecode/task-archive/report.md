# task-archive → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  task-archive → master

summary
  7 files, +867 −48
  how        signed off
  undo       wecode rollback task-archive   (was ec4841d7b)

what changed
  crates/wecode-cli/src/board.rs                       +170   −19
  crates/wecode-cli/src/commands/plan.rs               +276   −2
  crates/wecode-cli/src/tui.rs                         +122   −11
  crates/wecode-core/src/task.rs                       +35    −0
  crates/wecode-store/src/plan.rs                      +160   −5
  crates/wecode-store/src/schema.rs                    +67    −9
  docs/reference/commands.md                           +37    −2

by area
  crates/wecode-cli/src    2 files, +292 −30
  crates/wecode-cli/src/commands 1 file, +276 −2
  crates/wecode-store/src  2 files, +227 −14
  docs/reference           1 file, +37 −2
  crates/wecode-core/src   1 file, +35 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/task-archive
  merge      8980df297
  target was ec4841d7b
```
