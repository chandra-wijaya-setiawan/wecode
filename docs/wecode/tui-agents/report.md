# tui-agents → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  tui-agents → master

summary
  1 file, +200 −19
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/tui-agents
  undo       wecode rollback tui-agents   (was dd71f5857)

what changed
  crates/wecode-cli/src/tui.rs                         +200   −19

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `grep -q 'ACTIVE AGENTS' crates/wecode-cli/src/tui.rs` exits 0

provenance
  branch     wecode/tui-agents
  merge      e98cd27ec
  target was dd71f5857
```
