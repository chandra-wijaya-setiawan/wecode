# template-number → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  template-number → master

summary
  4 files, +189 −4
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/template-number
  undo       wecode rollback template-number   (was 592f87554)

what changed
  crates/wecode-cli/tests/expand.rs                    +69    −0
  crates/wecode-org/src/playbook/kind.rs               +17    −1
  crates/wecode-org/src/playbook/subtask.rs            +88    −3
  docs/reference/config/playbook.md                    +15    −0

by area
  crates/wecode-org/src/playbook 2 files, +105 −4
  crates/wecode-cli/tests  1 file, +69 −0
  docs/reference/config    1 file, +15 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/template-number
  merge      2c6a59891
  target was 592f87554
```
