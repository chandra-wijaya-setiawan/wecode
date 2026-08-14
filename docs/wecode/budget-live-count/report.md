# budget-live-count → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  budget-live-count → master

summary
  4 files, +181 −3
  how        signed off
  unblocks   split-tests
  undo       wecode rollback budget-live-count   (was 09be46dd7)

what changed
  crates/wecode-cli/src/spawn.rs                       +36    −3
  crates/wecode-cli/src/usage.rs                       +101   −0
  crates/wecode-cli/tests/cli.rs                       +31    −0
  docs/features.md                                     +13    −0

by area
  crates/wecode-cli/src    2 files, +137 −3
  crates/wecode-cli/tests  1 file, +31 −0
  docs                     1 file, +13 −0

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/budget-live-count
  merge      35e4e4463
  target was 09be46dd7
```
