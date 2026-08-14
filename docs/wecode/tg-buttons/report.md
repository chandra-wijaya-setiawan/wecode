# tg-buttons → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  tg-buttons → master

summary
  4 files, +722 −66
  how        signed off
  unblocks   notify-design
  worktree   removed /home/cws/.wecode/run/cws/tg-buttons
  undo       wecode rollback tg-buttons   (was a8aea6c7c)

what changed
  crates/wecode-cli/src/telegram.rs                    +340   −45
  crates/wecode-cli/tests/cli.rs                       +223   −0
  crates/wecode-org/src/company.rs                     +95    −20
  docs/reference/config.md                             +64    −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/tg-buttons
  merge      4e2175aa8
  target was a8aea6c7c
```
