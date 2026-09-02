# tui-crash-hook → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  tui-crash-hook → master

summary
  2 files, +90 −0
  how        signed off
  unblocks   close-story, hold-status, one-project-per-repo, stalled-worker-leaves-task-working
  worktree   removed /home/cws/.wecode/run/cws/tui-crash-hook
  undo       wecode rollback tui-crash-hook   (was dcf1803c5)

what changed
  crates/wecode-cli/src/tui.rs                         +4     −0
  crates/wecode-cli/src/tui/crash.rs                   +86    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -q 'set_hook' crates/wecode-cli/src/tui.rs` exits 0

provenance
  branch     wecode/tui-crash-hook
  merge      9523b7bf6
  target was dcf1803c5
```
