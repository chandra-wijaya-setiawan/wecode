# short-numbers → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  short-numbers → master

summary
  25 files, +1407 −140
  how        signed off
  unblocks   notify-artifact
  worktree   removed /home/cws/.wecode/run/cws/short-numbers
  undo       wecode rollback short-numbers   (was 09c5e3cdf)

what changed
  crates/wecode-cli/src/board.rs                       +76    −16
  crates/wecode-cli/src/commands/ctx.rs                +71    −10
  crates/wecode-cli/src/commands/exec.rs               +8     −19
  crates/wecode-cli/src/commands/gov.rs                +21    −18
  crates/wecode-cli/src/commands/org.rs                +2     −6
  crates/wecode-cli/src/commands/plan.rs               +54    −36
  crates/wecode-cli/src/main.rs                        +6     −0
  crates/wecode-cli/src/notify.rs                      +16    −0
  crates/wecode-cli/src/render.rs                      +99    −14
  crates/wecode-cli/src/telegram.rs                    +103   −5
  crates/wecode-cli/src/tui.rs                         +16    −2
  crates/wecode-cli/tests/cli.rs                       +212   −0
  crates/wecode-core/src/lib.rs                        +2     −0
  crates/wecode-core/src/plan.rs                       +71    −0
  crates/wecode-core/src/project.rs                    +6     −0
  crates/wecode-core/src/short.rs                      +184   −0
  crates/wecode-core/src/task.rs                       +5     −0
  crates/wecode-store/src/lib.rs                       +2     −0
  crates/wecode-store/src/plan.rs                      +47    −7
  crates/wecode-store/src/schema.rs                    +105   −5
  crates/wecode-store/src/short.rs                     +171   −0
  docs/features.md                                     +1     −0
  docs/reference/commands.md                           +42    −0
  docs/reference/config.md                             +21    −1
  docs/reference/schema.md                             +66    −1

by area
  crates/wecode-cli/src    6 files, +316 −37
  crates/wecode-store/src  4 files, +325 −12
  crates/wecode-core/src   5 files, +268 −0
  crates/wecode-cli/src/commands 5 files, +156 −89
  crates/wecode-cli/tests  1 file, +212 −0
  docs/reference           3 files, +129 −2
  docs                     1 file, +1 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/short-numbers
  merge      61c333b33
  target was 09c5e3cdf
```
