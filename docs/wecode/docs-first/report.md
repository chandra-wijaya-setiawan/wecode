# docs-first → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  docs-first → master

summary
  7 files, +840 −101
  how        signed off
  unblocks   codemap-scan, components, harness-contract, milestones, record-not-commission, rel-transition-journal
  worktree   kept — docs-first-test still working in /home/cws/.wecode/run/cws/docs-first
  undo       wecode rollback docs-first   (was 66b095815)

what changed
  crates/wecode-cli/src/verify.rs                      +99    −99
  crates/wecode-core/src/common.rs                     +104   −0
  crates/wecode-core/src/docs.rs                       +322   −0
  crates/wecode-core/src/lib.rs                        +6     −2
  docs/reference/front-matter.md                       +78    −0
  docs/wecode/docs-first/design.md                     +96    −0
  specs/006-docs-first/specification.md                +135   −0

by area
  crates/wecode-core/src   3 files, +432 −2
  crates/wecode-cli/src    1 file, +99 −99
  specs/006-docs-first     1 file, +135 −0
  docs/wecode/docs-first   1 file, +96 −0
  docs/reference           1 file, +78 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rqi 'DocStale\|doc_stale' crates/` exits 0

provenance
  branch     wecode/docs-first
  merge      108405d78
  target was 66b095815
```
