# up-groups → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  up-groups → master

summary
  2 files, +412 −270
  how        signed off
  unblocks   tui-nav
  worktree   removed /home/cws/.wecode/run/cws/up-groups
  undo       wecode rollback up-groups   (was 9ab320a33)

what changed
  crates/wecode-cli/src/board.rs                       +62    −62
  crates/wecode-cli/src/tui.rs                         +350   −208

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/up-groups
  merge      f7bd41f75
  target was 9ab320a33
```
