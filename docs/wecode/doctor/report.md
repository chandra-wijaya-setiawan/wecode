# doctor → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  doctor → master

summary
  8 files, +998 −0
  how        signed off
  unblocks   split-render
  worktree   removed /home/cws/.wecode/run/cws/doctor
  undo       wecode rollback doctor   (was 2edc92612)

what changed
  crates/wecode-cli/src/doctor.rs                      +605   −0
  crates/wecode-cli/src/main.rs                        +5     −0
  crates/wecode-cli/src/notify.rs                      +46    −0
  crates/wecode-cli/tests/doctor.rs                    +248   −0
  crates/wecode-org/src/company.rs                     +13    −0
  docs/features.md                                     +24    −0
  docs/reference/commands.md                           +35    −0
  docs/reference/config.md                             +22    −0

by area
  crates/wecode-cli/src    3 files, +656 −0
  crates/wecode-cli/tests  1 file, +248 −0
  docs/reference           2 files, +57 −0
  docs                     1 file, +24 −0
  crates/wecode-org/src    1 file, +13 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/doctor
  merge      00a6e6266
  target was 2edc92612
```
