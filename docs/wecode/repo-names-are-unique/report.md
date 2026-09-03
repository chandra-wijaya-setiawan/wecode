# repo-names-are-unique → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  repo-names-are-unique → master

summary
  4 files, +140 −4
  how        signed off
  unblocks   board-says-needs-human, hold-status, standing-merge-policy
  worktree   removed /home/cws/.wecode/run/cws/repo-names-are-unique
  undo       wecode rollback repo-names-are-unique   (was 003849184)

what changed
  crates/wecode-cli/tests/org.rs                       +59    −0
  crates/wecode-org/src/company.rs                     +18    −0
  crates/wecode-org/src/company/chart.rs               +47    −3
  docs/reference/config/company.md                     +16    −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `grep -rqiE 'duplicate|already named|twice' crates/wecode-org/src/company/chart.rs` exits 0

provenance
  branch     wecode/repo-names-are-unique
  merge      2e879d111
  target was 003849184
```
