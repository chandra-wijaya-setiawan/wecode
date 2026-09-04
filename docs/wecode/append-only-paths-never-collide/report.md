# append-only-paths-never-collide → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  append-only-paths-never-collide → master

summary
  2 files, +115 −100
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/append-only-paths-never-collide
  undo       wecode rollback append-only-paths-never-collide   (was a31b09731)

what changed
  crates/wecode-core/src/admission.rs                  +98    −100
  docs/design/overlap-is-not-conflict.md               +17    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `grep -rqiE 'append_only|append-only' crates/wecode-core/src/admission.rs` exits 0

provenance
  branch     wecode/append-only-paths-never-collide
  merge      ce3316e82
  target was a31b09731
```
