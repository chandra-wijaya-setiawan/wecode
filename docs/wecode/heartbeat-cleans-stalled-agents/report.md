# heartbeat-cleans-stalled-agents → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  heartbeat-cleans-stalled-agents → master

summary
  14 files, +1437 −7
  how        signed off
  unblocks   stalled-worker-leaves-task-working
  worktree   kept — heartbeat-cleans-stalled-agents-test still working in /home/cws/.wecode/run/cws/heartbeat-cleans-stalled-agents
  undo       wecode rollback heartbeat-cleans-stalled-agents   (was 1013f6ab0)

what changed
  crates/wecode-cli/src/commands/gov.rs                +16    −1
  crates/wecode-cli/src/commands/org.rs                +127   −2
  crates/wecode-cli/src/doctor/machine.rs              +4     −0
  crates/wecode-cli/src/git.rs                         +10    −1
  crates/wecode-cli/src/install.rs                     +498   −0
  crates/wecode-cli/src/main.rs                        +7     −0
  crates/wecode-cli/src/record.rs                      +13    −0
  crates/wecode-org/src/company/chart.rs               +33    −0
  crates/wecode-store/src/schema.rs                    +34    −3
  docs/reference/commands.md                           +5     −0
  docs/wecode/cli-self-install-on-merge/design.md      +169   −0
  docs/wecode/heartbeat-cleans-stalled-agents/design.… +159   −0
  specs/008-cli-self-install-on-merge/specification.md +178   −0
  specs/011-heartbeat/specification.md                 +184   −0

by area
  crates/wecode-cli/src    4 files, +528 −1
  specs/011-heartbeat      1 file, +184 −0
  specs/008-cli-self-install-on-merge 1 file, +178 −0
  docs/wecode/cli-self-install-on-merge 1 file, +169 −0
  docs/wecode/heartbeat-cleans-stalled-agents 1 file, +159 −0
  crates/wecode-cli/src/commands 2 files, +143 −3
  crates/wecode-store/src  1 file, +34 −3
  crates/wecode-org/src/company 1 file, +33 −0
  docs/reference           1 file, +5 −0
  crates/wecode-cli/src/doctor 1 file, +4 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -q 'stale\|lease' crates/wecode-store/src/execution.rs` exits 0

provenance
  branch     wecode/heartbeat-cleans-stalled-agents
  merge      5712ea1e7
  target was 1013f6ab0
```
