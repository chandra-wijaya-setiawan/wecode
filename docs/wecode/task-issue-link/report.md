# task-issue-link → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  task-issue-link → master

summary
  1 file, +184 −0
  how        signed off
  unblocks   run-deny-rules
  worktree   removed /home/cws/.wecode/run/cws/task-issue-link
  undo       wecode rollback task-issue-link   (was 1f8608d9b)

what changed
  crates/wecode-core/src/project.rs                    +184   −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/task-issue-link
  merge      86b251745
  target was 1f8608d9b
```
