# criterion-cannot-run → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  criterion-cannot-run → master

summary
  2 files, +399 −1
  how        signed off
  unblocks   rel-transition-journal
  worktree   removed /home/cws/.wecode/run/cws/criterion-cannot-run
  undo       wecode rollback criterion-cannot-run   (was 3040ed95d)

what changed
  crates/wecode-gov/src/criterion.rs                   +395   −0
  crates/wecode-gov/src/lib.rs                         +4     −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/criterion-cannot-run
  merge      4b9881a85
  target was 3040ed95d
```
