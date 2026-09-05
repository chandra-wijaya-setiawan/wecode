# sweep-files-finished-work → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  sweep-files-finished-work → master

summary
  5 files, +440 −3
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/sweep-files-finished-work
  undo       wecode rollback sweep-files-finished-work   (was 92413aafb)

what changed
  crates/wecode-cli/src/commands/plan.rs               +2     −2
  crates/wecode-cli/src/commands/plan/filing.rs        +166   −1
  crates/wecode-cli/src/main.rs                        +5     −0
  crates/wecode-cli/tests/sweep-cmd.rs                 +227   −0
  docs/reference/commands.md                           +40    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `./target/debug/wecode help | grep -q sweep` exits 0
  ✓ `./target/debug/wecode sweep --dry-run` exits 0

provenance
  branch     wecode/sweep-files-finished-work
  merge      acc5e187f
  target was 92413aafb
```
