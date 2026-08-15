# repo-map → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  repo-map → master

summary
  9 files, +651 −13
  how        signed off
  unblocks   tap-receipt
  worktree   removed /home/cws/.wecode/run/cws/repo-map
  undo       wecode rollback repo-map   (was 7f6f04410)

what changed
  crates/wecode-cli/src/git.rs                         +19    −0
  crates/wecode-cli/src/handoff.rs                     +62    −6
  crates/wecode-cli/src/main.rs                        +1     −0
  crates/wecode-cli/src/map.rs                         +461   −0
  crates/wecode-cli/tests/handoff.rs                   +40    −0
  docs/features.md                                     +27    −0
  docs/lifecycle.md                                    +28    −6
  docs/reference/commands.md                           +6     −0
  docs/reference/config.md                             +7     −1

by area
  crates/wecode-cli/src    4 files, +543 −6
  docs                     2 files, +55 −6
  crates/wecode-cli/tests  1 file, +40 −0
  docs/reference           2 files, +13 −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/repo-map
  merge      d4d3cf112
  target was 7f6f04410
```
