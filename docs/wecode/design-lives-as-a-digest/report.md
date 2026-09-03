# design-lives-as-a-digest → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  design-lives-as-a-digest → master

summary
  3 files, +406 −0
  how        signed off
  unblocks   board-says-needs-human, hold-status
  worktree   removed /home/cws/.wecode/run/cws/design-lives-as-a-digest
  undo       wecode rollback design-lives-as-a-digest   (was 60b97b501)

what changed
  crates/wecode-cli/tests/design.rs                    +140   −0
  crates/wecode-store/src/plan.rs                      +240   −0
  docs/reference/schema.md                             +26    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rq 'digest' crates/wecode-store/src/plan.rs` exits 0

provenance
  branch     wecode/design-lives-as-a-digest
  merge      8cfa05e91
  target was 60b97b501
```
