# charter-exception → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  charter-exception → master

summary
  1 file, +495 −2
  how        signed off
  unblocks   cloud-secrets-design
  worktree   removed /home/cws/.wecode/run/cws/charter-exception
  undo       wecode rollback charter-exception   (was bfe9d1160)

what changed
  crates/wecode-gov/src/broker.rs                      +495   −2

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/charter-exception
  merge      30e1836a2
  target was bfe9d1160
```
