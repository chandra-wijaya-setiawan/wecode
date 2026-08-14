# overlap-cross-project → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  overlap-cross-project → master

summary
  8 files, +587 −11
  how        signed off
  unblocks   notify-hook
  worktree   removed /home/cws/.wecode/run/cws/overlap-cross-project
  undo       wecode rollback overlap-cross-project   (was b075f0977)

what changed
  crates/wecode-cli/tests/cli.rs                       +153   −0
  crates/wecode-core/src/admission.rs                  +292   −6
  crates/wecode-core/src/project.rs                    +4     −2
  docs/design/decisions.md                             +19    −0
  docs/features.md                                     +9     −0
  docs/guides/getting-started.md                       +5     −2
  docs/reference/schema.md                             +2     −1
  docs/wecode/overlap-cross-project/design.md          +103   −0

by area
  crates/wecode-core/src   2 files, +296 −8
  crates/wecode-cli/tests  1 file, +153 −0
  docs/wecode/overlap-cross-project 1 file, +103 −0
  docs/design              1 file, +19 −0
  docs                     1 file, +9 −0
  docs/guides              1 file, +5 −2
  docs/reference           1 file, +2 −1

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/overlap-cross-project
  merge      ff0b6d8b8
  target was b075f0977
```
