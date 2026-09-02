# heartbeat-sweep → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  heartbeat-sweep → master

summary
  9 files, +836 −56
  how        signed off
  unblocks   cli-self-install-on-merge, close-story, components, empty-run-vs-blocked-write, harness-contract, hold-status, one-project-per-repo, stalled-worker-leaves-task-working
  worktree   removed /home/cws/.wecode/run/cws/heartbeat-sweep
  undo       wecode rollback heartbeat-sweep   (was 28e0a7f2a)

what changed
  crates/wecode-cli/src/claim.rs                       +310   −0
  crates/wecode-cli/src/commands/exec.rs               +18    −52
  crates/wecode-cli/src/main.rs                        +4     −0
  crates/wecode-cli/src/scheduler.rs                   +141   −1
  crates/wecode-cli/tests/sweep.rs                     +101   −0
  crates/wecode-store/src/execution.rs                 +243   −2
  docs/design/liveness.md                              +7     −0
  docs/reference/commands.md                           +3     −0
  docs/reference/schema.md                             +9     −1

by area
  crates/wecode-cli/src    3 files, +455 −1
  crates/wecode-store/src  1 file, +243 −2
  crates/wecode-cli/tests  1 file, +101 −0
  crates/wecode-cli/src/commands 1 file, +18 −52
  docs/reference           2 files, +12 −1
  docs/design              1 file, +7 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -q 'struct Beat' crates/wecode-cli/src/claim.rs` exits 0
  ✓ `grep -rq 'stale' crates/wecode-cli/src/scheduler.rs` exits 0

provenance
  branch     wecode/heartbeat-sweep
  merge      becac8c93
  target was 28e0a7f2a
```
