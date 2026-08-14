# agent-intelligence → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  agent-intelligence → master

summary
  11 files, +855 −23
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/agent-intelligence
  undo       wecode rollback agent-intelligence   (was 422c04047)

what changed
  crates/wecode-cli/src/commands/exec.rs               +8     −2
  crates/wecode-cli/src/render.rs                      +107   −6
  crates/wecode-cli/src/spawn.rs                       +74    −13
  crates/wecode-cli/tests/cli.rs                       +19    −0
  crates/wecode-org/src/company.rs                     +466   −0
  crates/wecode-org/src/lib.rs                         +2     −1
  crates/wecode-org/src/template.rs                    +60    −0
  docs/concepts.md                                     +8     −0
  docs/features.md                                     +23    −0
  docs/reference/config.md                             +45    −0
  docs/wecode/agent-intelligence/design.md             +43    −1

by area
  crates/wecode-org/src    3 files, +528 −1
  crates/wecode-cli/src    2 files, +181 −19
  docs/reference           1 file, +45 −0
  docs/wecode/agent-intelligence 1 file, +43 −1
  docs                     2 files, +31 −0
  crates/wecode-cli/tests  1 file, +19 −0
  crates/wecode-cli/src/commands 1 file, +8 −2

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/agent-intelligence
  merge      c233e7efa
  target was 422c04047
```
