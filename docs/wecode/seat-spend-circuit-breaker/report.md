# seat-spend-circuit-breaker → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  seat-spend-circuit-breaker → master

summary
  7 files, +437 −5
  how        signed off
  unblocks   charter-guards-agent-config, idle-board-hides-binding-cause, merge-ignores-standing-order
  worktree   removed /home/cws/.wecode/run/cws/seat-spend-circuit-breaker
  undo       wecode rollback seat-spend-circuit-breaker   (was f7c649833)

what changed
  crates/wecode-cli/src/scheduler.rs                   +114   −0
  crates/wecode-cli/src/usage.rs                       +169   −0
  crates/wecode-cli/tests/spend.rs                     +76    −0
  crates/wecode-org/src/company/limits.rs              +42    −5
  docs/design/concurrency.md                           +4     −0
  docs/design/liveness.md                              +4     −0
  docs/reference/config/company.md                     +28    −0

by area
  crates/wecode-cli/src    2 files, +283 −0
  crates/wecode-cli/tests  1 file, +76 −0
  crates/wecode-org/src/company 1 file, +42 −5
  docs/reference/config    1 file, +28 −0
  docs/design              2 files, +8 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `grep -rqiE 'circuit|per_hour|spike' crates/wecode-cli/src/usage.rs` exits 0

provenance
  branch     wecode/seat-spend-circuit-breaker
  merge      f76823729
  target was f7c649833
```
