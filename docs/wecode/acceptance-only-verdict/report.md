# acceptance-only-verdict → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  acceptance-only-verdict → master

summary
  4 files, +876 −440
  how        signed off
  unblocks   discovery-cost, harness-contract, milestones, rel-transition-journal
  worktree   removed /home/cws/.wecode/run/cws/acceptance-only-verdict
  undo       wecode rollback acceptance-only-verdict   (was 79abfcf0d)

what changed
  crates/wecode-cli/src/verify.rs                      +445   −440
  crates/wecode-cli/tests/support/mod.rs               +17    −0
  crates/wecode-cli/tests/verify.rs                    +224   −0
  docs/wecode/acceptance-only-verdict/design.md        +190   −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/acceptance-only-verdict
  merge      568e15228
  target was 79abfcf0d
```
