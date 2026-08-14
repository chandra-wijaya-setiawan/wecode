# notify-hook → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  notify-hook → master

summary
  15 files, +1084 −8
  how        signed off
  unblocks   telegram-approve
  worktree   removed /home/cws/.wecode/run/cws/notify-hook
  undo       wecode rollback notify-hook   (was fa163ad97)

what changed
  crates/wecode-cli/src/commands/exec.rs               +37    −3
  crates/wecode-cli/src/commands/gov.rs                +14    −2
  crates/wecode-cli/src/commands/plan.rs               +12    −2
  crates/wecode-cli/src/main.rs                        +1     −0
  crates/wecode-cli/src/notify.rs                      +423   −0
  crates/wecode-cli/src/render.rs                      +10    −0
  crates/wecode-cli/tests/cli.rs                       +216   −0
  crates/wecode-org/src/company.rs                     +118   −0
  crates/wecode-org/src/lib.rs                         +3     −1
  crates/wecode-org/src/template.rs                    +13    −0
  docs/features.md                                     +23    −0
  docs/guides/getting-started.md                       +15    −0
  docs/lifecycle.md                                    +6     −0
  docs/reference/config.md                             +46    −0
  docs/wecode/notify-hook/design.md                    +147   −0

by area
  crates/wecode-cli/src    3 files, +434 −0
  crates/wecode-cli/tests  1 file, +216 −0
  docs/wecode/notify-hook  1 file, +147 −0
  crates/wecode-org/src    3 files, +134 −1
  crates/wecode-cli/src/commands 3 files, +63 −7
  docs/reference           1 file, +46 −0
  docs                     2 files, +29 −0
  docs/guides              1 file, +15 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/notify-hook
  merge      bee33a36a
  target was fa163ad97
```
