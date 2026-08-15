# spend-split → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  spend-split → master

summary
  6 files, +392 −63
  how        signed off
  unblocks   doctor
  worktree   removed /home/cws/.wecode/run/cws/spend-split
  undo       wecode rollback spend-split   (was 62db4efe9)

what changed
  crates/wecode-cli/src/commands/exec.rs               +23    −3
  crates/wecode-cli/src/render.rs                      +71    −7
  crates/wecode-cli/tests/run.rs                       +23    −1
  crates/wecode-store/src/execution.rs                 +140   −17
  crates/wecode-store/src/schema.rs                    +92    −19
  docs/reference/schema.md                             +43    −16

by area
  crates/wecode-store/src  2 files, +232 −36
  crates/wecode-cli/src    1 file, +71 −7
  docs/reference           1 file, +43 −16
  crates/wecode-cli/src/commands 1 file, +23 −3
  crates/wecode-cli/tests  1 file, +23 −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/spend-split
  merge      04355896e
  target was 62db4efe9
```
