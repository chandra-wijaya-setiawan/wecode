# decision-supersede → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  decision-supersede → master

summary
  1 file, +99 −4
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/decision-supersede
  undo       wecode rollback decision-supersede   (was 6f5f1bebb)

what changed
  crates/wecode-store/src/audit.rs                     +99    −4

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/decision-supersede
  merge      22bfd6943
  target was 6f5f1bebb
```
