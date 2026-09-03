# worktree-belongs-to-the-story → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  worktree-belongs-to-the-story → master

summary
  3 files, +235 −10
  how        signed off
  unblocks   board-says-needs-human, report-is-generated-from-the-ledger
  worktree   removed /home/cws/.wecode/run/cws/worktree-belongs-to-the-story
  undo       wecode rollback worktree-belongs-to-the-story   (was 87448a352)

what changed
  crates/wecode-cli/src/work.rs                        +88    −7
  crates/wecode-cli/tests/worktree.rs                  +55    −0
  crates/wecode-store/src/worktree.rs                  +92    −3

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rqE 'story|aggregat' crates/wecode-store/src/worktree.rs` exits 0

provenance
  branch     wecode/worktree-belongs-to-the-story
  merge      15229cf2c
  target was 87448a352
```
