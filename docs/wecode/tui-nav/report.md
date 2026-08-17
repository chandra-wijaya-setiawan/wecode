# tui-nav → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  tui-nav → master

summary
  5 files, +965 −470
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/tui-nav
  undo       wecode rollback tui-nav   (was 8c44173d3)

what changed
  crates/wecode-cli/src/commands/view.rs               +496   −6
  crates/wecode-cli/src/main.rs                        +12    −4
  crates/wecode-cli/src/tui.rs                         +366   −455
  crates/wecode-cli/tests/board.rs                     +52    −0
  docs/reference/commands.md                           +39    −5

by area
  crates/wecode-cli/src    2 files, +378 −459
  crates/wecode-cli/src/commands 1 file, +496 −6
  crates/wecode-cli/tests  1 file, +52 −0
  docs/reference           1 file, +39 −5

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/tui-nav
  merge      f8d6e86d6
  target was 8c44173d3
```
