# split-tests → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  split-tests → master

summary
  17 files, +6363 −6210
  how        signed off
  unblocks   archive-hidden
  worktree   removed /home/cws/.wecode/run/cws/split-tests
  undo       wecode rollback split-tests   (was 143daccfb)

what changed
  crates/wecode-cli/tests/cli.rs                       +0     −6210
  crates/wecode-cli/tests/expand.rs                    +359   −0
  crates/wecode-cli/tests/guard.rs                     +205   −0
  crates/wecode-cli/tests/handoff.rs                   +463   −0
  crates/wecode-cli/tests/merge.rs                     +472   −0
  crates/wecode-cli/tests/notify.rs                    +415   −0
  crates/wecode-cli/tests/plan.rs                      +759   −0
  crates/wecode-cli/tests/playbook.rs                  +482   −0
  crates/wecode-cli/tests/project.rs                   +317   −0
  crates/wecode-cli/tests/run.rs                       +623   −0
  crates/wecode-cli/tests/support/agent.rs             +79    −0
  crates/wecode-cli/tests/support/merge.rs             +47    −0
  crates/wecode-cli/tests/support/mod.rs               +374   −0
  crates/wecode-cli/tests/support/playbook.rs          +65    −0
  crates/wecode-cli/tests/telegram.rs                  +588   −0
  crates/wecode-cli/tests/workspace.rs                 +647   −0
  crates/wecode-cli/tests/worktree.rs                  +468   −0

by area
  crates/wecode-cli/tests  13 files, +5798 −6210
  crates/wecode-cli/tests/support 4 files, +565 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/split-tests
  merge      1491f277c
  target was 143daccfb
```
