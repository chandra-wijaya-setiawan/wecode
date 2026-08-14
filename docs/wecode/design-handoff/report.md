# design-handoff → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  design-handoff → master

summary
  7 files, +512 −38
  how        signed off
  unblocks   step-not-landing
  worktree   removed /home/cws/.wecode/run/cws/design-handoff
  undo       wecode rollback design-handoff   (was 174ab6ef7)

what changed
  crates/wecode-cli/src/commands/exec.rs               +7     −2
  crates/wecode-cli/src/render.rs                      +203   −30
  crates/wecode-cli/tests/cli.rs                       +109   −0
  docs/features.md                                     +22    −1
  docs/lifecycle.md                                    +12    −2
  docs/reference/config.md                             +4     −3
  docs/wecode/design-handoff/design.md                 +155   −0

by area
  crates/wecode-cli/src    1 file, +203 −30
  docs/wecode/design-handoff 1 file, +155 −0
  crates/wecode-cli/tests  1 file, +109 −0
  docs                     2 files, +34 −3
  crates/wecode-cli/src/commands 1 file, +7 −2
  docs/reference           1 file, +4 −3

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/design-handoff
  merge      0066e07b0
  target was 174ab6ef7
```
