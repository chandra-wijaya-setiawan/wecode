# step-not-landing → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  step-not-landing → master

summary
  8 files, +273 −32
  how        signed off
  unblocks   budget-units
  worktree   removed /home/cws/.wecode/run/cws/step-not-landing
  undo       wecode rollback step-not-landing   (was 03ca4e474)

what changed
  crates/wecode-cli/src/commands/exec.rs               +27    −16
  crates/wecode-cli/src/commands/gov.rs                +23    −6
  crates/wecode-cli/src/render.rs                      +23    −2
  crates/wecode-cli/src/teardown.rs                    +7     −5
  crates/wecode-cli/tests/cli.rs                       +170   −0
  docs/features.md                                     +1     −1
  docs/guides/playbooks.md                             +6     −0
  docs/lifecycle.md                                    +16    −2

by area
  crates/wecode-cli/tests  1 file, +170 −0
  crates/wecode-cli/src/commands 2 files, +50 −22
  crates/wecode-cli/src    2 files, +30 −7
  docs                     2 files, +17 −3
  docs/guides              1 file, +6 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/step-not-landing
  merge      05f300950
  target was 03ca4e474
```
