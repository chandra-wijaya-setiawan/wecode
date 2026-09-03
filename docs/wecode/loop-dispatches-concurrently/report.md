# loop-dispatches-concurrently → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  loop-dispatches-concurrently → master

summary
  3 files, +419 −93
  how        signed off
  unblocks   board-says-needs-human, hold-status, report-is-generated-from-the-ledger
  worktree   removed /home/cws/.wecode/run/cws/loop-dispatches-concurrently
  undo       wecode rollback loop-dispatches-concurrently   (was 042132014)

what changed
  crates/wecode-cli/src/commands/exec.rs               +213   −91
  crates/wecode-cli/tests/loop.rs                      +162   −0
  docs/design/concurrency.md                           +44    −2

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rqE 'thread::spawn|JoinHandle|scope' crates/wecode-cli/src/commands/exec.rs` exits 0

provenance
  branch     wecode/loop-dispatches-concurrently
  merge      85ef823df
  target was 042132014
```
