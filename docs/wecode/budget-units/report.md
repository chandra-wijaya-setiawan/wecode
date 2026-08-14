# budget-units → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  budget-units → master

summary
  10 files, +265 −36
  how        signed off
  unblocks   agent-intelligence
  worktree   removed /home/cws/.wecode/run/cws/budget-units
  undo       wecode rollback budget-units   (was d2566d46f)

what changed
  crates/wecode-cli/src/render.rs                      +16    −1
  crates/wecode-cli/src/spawn.rs                       +13    −5
  crates/wecode-cli/src/usage.rs                       +154   −30
  crates/wecode-cli/tests/cli.rs                       +27    −0
  crates/wecode-gov/src/broker.rs                      +4     −0
  crates/wecode-gov/src/grant.rs                       +11    −0
  docs/features.md                                     +15    −0
  docs/guides/getting-started.md                       +8     −0
  docs/reference/config.md                             +10    −0
  docs/reference/schema.md                             +7     −0

by area
  crates/wecode-cli/src    3 files, +183 −36
  crates/wecode-cli/tests  1 file, +27 −0
  docs/reference           2 files, +17 −0
  crates/wecode-gov/src    2 files, +15 −0
  docs                     1 file, +15 −0
  docs/guides              1 file, +8 −0

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/budget-units
  merge      221dd1b71
  target was d2566d46f
```
