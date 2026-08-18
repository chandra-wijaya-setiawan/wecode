# manual-task-store → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  manual-task-store → master

summary
  3 files, +271 −13
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/manual-task-store
  undo       wecode rollback manual-task-store   (was 1ef9de0fe)

what changed
  crates/wecode-store/src/plan.rs                      +120   −7
  crates/wecode-store/src/schema.rs                    +93    −5
  docs/reference/schema.md                             +58    −1

by area
  crates/wecode-store/src  2 files, +213 −12
  docs/reference           1 file, +58 −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/manual-task-store
  merge      d242502ab
  target was 1ef9de0fe
```
