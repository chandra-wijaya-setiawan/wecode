# parent-empty-pass → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  parent-empty-pass → master

summary
  9 files, +2067 −544
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/parent-empty-pass
  undo       wecode rollback parent-empty-pass   (was 527214b30)

what changed
  crates/wecode-cli/src/doctor.rs                      +132   −497
  crates/wecode-cli/src/doctor/hooks.rs                +522   −0
  crates/wecode-cli/src/doctor/machine.rs              +791   −0
  crates/wecode-cli/src/main.rs                        +4     −3
  crates/wecode-cli/src/verify.rs                      +271   −27
  crates/wecode-cli/tests/doctor.rs                    +243   −1
  docs/features.md                                     +30    −1
  docs/reference/commands.md                           +45    −15
  docs/reference/config/company.md                     +29    −0

by area
  crates/wecode-cli/src/doctor 2 files, +1313 −0
  crates/wecode-cli/src    3 files, +407 −527
  crates/wecode-cli/tests  1 file, +243 −1
  docs/reference           1 file, +45 −15
  docs                     1 file, +30 −1
  docs/reference/config    1 file, +29 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/parent-empty-pass
  merge      e0ac4ff18
  target was 527214b30
```
