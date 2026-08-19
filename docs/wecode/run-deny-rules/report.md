# run-deny-rules → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  run-deny-rules → master

summary
  2 files, +202 −8
  how        signed off
  unblocks   charter-exception
  worktree   removed /home/cws/.wecode/run/cws/run-deny-rules
  undo       wecode rollback run-deny-rules   (was 3f8399fba)

what changed
  crates/wecode-gov/src/glob.rs                        +93    −2
  crates/wecode-gov/src/grant.rs                       +109   −6

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/run-deny-rules
  merge      395b777df
  target was 3f8399fba
```
