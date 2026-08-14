# tui-depth → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  tui-depth → master

summary
  7 files, +532 −144
  how        signed off
  unblocks   design-handoff
  worktree   removed /home/cws/.wecode/run/cws/tui-depth
  undo       wecode rollback tui-depth   (was 44e1d02b5)

what changed
  crates/wecode-cli/src/board.rs                       +86    −28
  crates/wecode-cli/src/main.rs                        +2     −1
  crates/wecode-cli/src/tui.rs                         +291   −112
  docs/features.md                                     +34    −1
  docs/guides/getting-started.md                       +6     −1
  docs/reference/commands.md                           +2     −1
  docs/wecode/tui-depth/design.md                      +111   −0

by area
  crates/wecode-cli/src    3 files, +379 −141
  docs/wecode/tui-depth    1 file, +111 −0
  docs                     1 file, +34 −1
  docs/guides              1 file, +6 −1
  docs/reference           1 file, +2 −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/tui-depth
  merge      e42304b49
  target was 44e1d02b5
```
