# merge-ignores-standing-order → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  merge-ignores-standing-order → master

summary
  2 files, +27 −0
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/merge-ignores-standing-order
  undo       wecode rollback merge-ignores-standing-order   (was 18c0c84aa)

what changed
  crates/wecode-cli/tests/merge-policy.rs              +21    −0
  docs/reference/config/company.md                     +6     −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo test -p wecode-cli --test merge-policy` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/merge-ignores-standing-order
  merge      fc82208fc
  target was 18c0c84aa
```
