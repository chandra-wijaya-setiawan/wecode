# promotion-notifies → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  promotion-notifies → master

summary
  3 files, +133 −7
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/promotion-notifies
  undo       wecode rollback promotion-notifies   (was 058bec170)

what changed
  crates/wecode-cli/src/commands/exec.rs               +33    −1
  crates/wecode-cli/src/scheduler.rs                   +9     −0
  crates/wecode-cli/tests/notify.rs                    +91    −6

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/promotion-notifies
  merge      277a477b0
  target was 058bec170
```
