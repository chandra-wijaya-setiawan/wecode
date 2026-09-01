# req-rows → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  req-rows → master

summary
  1 file, +1 −1
  how        signed off
  unblocks   cli-self-install-on-merge, cli-self-install-on-merge-build, cli-self-install-on-merge-test, components, heartbeat-cleans-stalled-agents-build, heartbeat-cleans-stalled-agents-test, one-project-per-repo
  worktree   removed /home/cws/.wecode/run/cws/req-rows
  undo       wecode rollback req-rows   (was 3518d8ed3)

what changed
  .max-lines                                           +1     −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rqi 'requirement' crates/wecode-store/src/` exits 0

provenance
  branch     wecode/req-rows
  merge      702549fbd
  target was 3518d8ed3
```
