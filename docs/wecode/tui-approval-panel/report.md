# tui-approval-panel → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  tui-approval-panel → master

summary
  3 files, +313 −10
  how        signed off
  unblocks   sweep-files-finished-work
  worktree   removed /home/cws/.wecode/run/cws/tui-approval-panel
  undo       wecode rollback tui-approval-panel   (was 5a0c97567)

what changed
  crates/wecode-cli/src/tui.rs                         +30    −10
  crates/wecode-cli/src/tui/approvals.rs               +199   −0
  docs/reference/tui.md                                +84    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `test -f crates/wecode-cli/src/tui/approvals.rs` exits 0
  ✓ `grep -rqiE 'approv' crates/wecode-cli/src/tui/approvals.rs` exits 0

provenance
  branch     wecode/tui-approval-panel
  merge      54f3f1b6c
  target was 5a0c97567
```
