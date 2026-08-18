# digest → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  digest → master

summary
  3 files, +237 −24
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/digest
  undo       wecode rollback digest   (was f5caff2e6)

what changed
  crates/wecode-cli/src/commands/exec.rs               +21    −4
  crates/wecode-cli/src/notify.rs                      +121   −17
  crates/wecode-cli/tests/notify.rs                    +95    −3

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/digest
  merge      40328d79b
  target was f5caff2e6
```
