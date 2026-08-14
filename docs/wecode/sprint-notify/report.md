# sprint-notify → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  sprint-notify → master

summary
  4 files, +628 −25
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/sprint-notify
  undo       wecode rollback sprint-notify   (was d41728f78)

what changed
  crates/wecode-cli/src/notify.rs                      +403   −19
  crates/wecode-cli/tests/cli.rs                       +161   −4
  crates/wecode-org/src/company.rs                     +34    −1
  docs/reference/config.md                             +30    −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/sprint-notify
  merge      24603657e
  target was d41728f78
```
