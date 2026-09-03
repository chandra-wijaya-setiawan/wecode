# standing-merge-policy → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  standing-merge-policy → master

summary
  6 files, +554 −15
  how        signed off
  unblocks   components, engineer-role-writes-specs
  worktree   removed /home/cws/.wecode/run/cws/standing-merge-policy
  undo       wecode rollback standing-merge-policy   (was da2bfc9c4)

what changed
  crates/wecode-cli/tests/merge-policy.rs              +155   −0
  crates/wecode-gov/src/broker.rs                      +49    −12
  crates/wecode-gov/src/lib.rs                         +4     −1
  crates/wecode-gov/src/standing.rs                    +189   −0
  crates/wecode-org/src/company/limits.rs              +94    −2
  docs/reference/config/company.md                     +63    −0

by area
  crates/wecode-gov/src    3 files, +242 −13
  crates/wecode-cli/tests  1 file, +155 −0
  crates/wecode-org/src/company 1 file, +94 −2
  docs/reference/config    1 file, +63 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `grep -rqi 'auto_merge\|standing' crates/wecode-org/src/company/limits.rs` exits 0

provenance
  branch     wecode/standing-merge-policy
  merge      f1a335c41
  target was da2bfc9c4
```
