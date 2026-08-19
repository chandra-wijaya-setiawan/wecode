# live-acceptance-tier → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  live-acceptance-tier → master

summary
  1 file, +402 −8
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/live-acceptance-tier
  undo       wecode rollback live-acceptance-tier   (was 24a2d41f9)

what changed
  crates/wecode-cli/src/verify.rs                      +402   −8

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/live-acceptance-tier
  merge      e819b23b9
  target was 24a2d41f9
```
