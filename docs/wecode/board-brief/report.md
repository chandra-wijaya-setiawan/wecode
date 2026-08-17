# board-brief → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  board-brief → master

summary
  3 files, +951 −300
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/board-brief
  undo       wecode rollback board-brief   (was 1ddeb0c19)

what changed
  crates/wecode-cli/src/board.rs                       +591   −300
  crates/wecode-cli/tests/board.rs                     +351   −0
  docs/wecode/board-brief/brief.md                     +9     −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/board-brief
  merge      9960ff729
  target was 1ddeb0c19
```
