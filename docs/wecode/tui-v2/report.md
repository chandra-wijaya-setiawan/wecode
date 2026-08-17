# tui-v2 → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  tui-v2 → master

summary
  3 files, +663 −528
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/tui-v2
  undo       wecode rollback tui-v2   (was d974c336d)

what changed
  crates/wecode-cli/src/board.rs                       +70    −70
  crates/wecode-cli/src/tui.rs                         +547   −458
  docs/reference/commands.md                           +46    −0

by area
  crates/wecode-cli/src    2 files, +617 −528
  docs/reference           1 file, +46 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/tui-v2
  merge      59f126f91
  target was d974c336d
```
