# tap-receipt → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  tap-receipt → master

summary
  3 files, +272 −26
  how        signed off
  unblocks   advisory-checks
  worktree   removed /home/cws/.wecode/run/cws/tap-receipt
  undo       wecode rollback tap-receipt   (was 51924fa8c)

what changed
  crates/wecode-cli/src/telegram.rs                    +141   −21
  crates/wecode-cli/tests/telegram.rs                  +85    −4
  docs/reference/config.md                             +46    −1

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/tap-receipt
  merge      c7ee2365d
  target was 51924fa8c
```
