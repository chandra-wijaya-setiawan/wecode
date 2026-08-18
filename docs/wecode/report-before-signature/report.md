# report-before-signature → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  report-before-signature → master

summary
  4 files, +537 −75
  how        signed off
  unblocks   digest
  worktree   removed /home/cws/.wecode/run/cws/report-before-signature
  undo       wecode rollback report-before-signature   (was 23b1991dd)

what changed
  crates/wecode-cli/src/notify.rs                      +148   −19
  crates/wecode-cli/src/record.rs                      +260   −40
  crates/wecode-cli/tests/notify.rs                    +56    −4
  docs/reference/config/notify.md                      +73    −12

by area
  crates/wecode-cli/src    2 files, +408 −59
  docs/reference/config    1 file, +73 −12
  crates/wecode-cli/tests  1 file, +56 −4

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/report-before-signature
  merge      1304c303b
  target was 23b1991dd
```
