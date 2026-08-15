# run-dir → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  run-dir → master

summary
  1 file, +75 −1
  how        signed off
  unblocks   retry-cause
  worktree   removed /home/cws/.wecode/run/cws/run-dir
  undo       wecode rollback run-dir   (was e536e73e3)

what changed
  crates/wecode-cli/src/commands/exec.rs               +75    −1

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/run-dir
  merge      20a121226
  target was e536e73e3
```
