# scope-commit → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  scope-commit → master

summary
  2 files, +317 −31
  how        signed off
  unblocks   run-dir
  worktree   removed /home/cws/.wecode/run/cws/scope-commit
  undo       wecode rollback scope-commit   (was 612a807a7)

what changed
  crates/wecode-cli/src/git.rs                         +181   −4
  crates/wecode-cli/src/verify.rs                      +136   −27

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/scope-commit
  merge      09c7087c6
  target was 612a807a7
```
