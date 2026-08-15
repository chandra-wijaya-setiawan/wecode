# archive-hidden → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  archive-hidden → master

summary
  4 files, +269 −20
  how        signed off
  unblocks   budget-amend
  worktree   removed /home/cws/.wecode/run/cws/archive-hidden
  undo       wecode rollback archive-hidden   (was 7a0173321)

what changed
  crates/wecode-cli/src/render.rs                      +177   −12
  crates/wecode-cli/tests/project.rs                   +76    −0
  crates/wecode-cli/tests/scratch_repro.rs             +0     −0
  docs/reference/commands.md                           +16    −8

by area
  crates/wecode-cli/src    1 file, +177 −12
  crates/wecode-cli/tests  2 files, +76 −0
  docs/reference           1 file, +16 −8

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/archive-hidden
  merge      7e9f63b40
  target was 7a0173321
```
