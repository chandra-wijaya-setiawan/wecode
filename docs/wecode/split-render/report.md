# split-render → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  split-render → master

summary
  17 files, +3753 −3633
  how        signed off
  unblocks   split-org
  worktree   removed /home/cws/.wecode/run/cws/split-render
  undo       wecode rollback split-render   (was 8e83d6a50)

what changed
  crates/wecode-cli/src/commands/exec.rs               +16    −16
  crates/wecode-cli/src/commands/gov.rs                +6     −6
  crates/wecode-cli/src/commands/org.rs                +10    −10
  crates/wecode-cli/src/commands/plan.rs               +18    −18
  crates/wecode-cli/src/handoff.rs                     +426   −0
  crates/wecode-cli/src/main.rs                        +7     −6
  crates/wecode-cli/src/record.rs                      +226   −1
  crates/wecode-cli/src/render.rs                      +36    −3573
  crates/wecode-cli/src/render/gov.rs                  +271   −0
  crates/wecode-cli/src/render/org.rs                  +445   −0
  crates/wecode-cli/src/render/plan.rs                 +963   −0
  crates/wecode-cli/src/render/playbook.rs             +524   −0
  crates/wecode-cli/src/spawn.rs                       +220   −1
  crates/wecode-cli/src/teardown.rs                    +184   −0
  crates/wecode-cli/src/usage.rs                       +97    −0
  crates/wecode-cli/src/verify.rs                      +115   −1
  crates/wecode-cli/src/work.rs                        +189   −1

by area
  crates/wecode-cli/src    9 files, +1500 −3583
  crates/wecode-cli/src/render 4 files, +2203 −0
  crates/wecode-cli/src/commands 4 files, +50 −50

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/split-render
  merge      5a31a727c
  target was 8e83d6a50
```
