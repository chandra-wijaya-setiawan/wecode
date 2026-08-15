# retry-cause → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  retry-cause → master

summary
  4 files, +291 −3
  how        signed off
  unblocks   spend-split
  worktree   removed /home/cws/.wecode/run/cws/retry-cause
  undo       wecode rollback retry-cause   (was 05dda27d4)

what changed
  crates/wecode-cli/src/commands/exec.rs               +13    −2
  crates/wecode-cli/src/spawn.rs                       +191   −1
  crates/wecode-cli/tests/run.rs                       +60    −0
  docs/features.md                                     +27    −0

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/retry-cause
  merge      2d692ff3a
  target was 05dda27d4
```
