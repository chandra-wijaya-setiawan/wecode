# charter-guards-agent-config → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  charter-guards-agent-config → master

summary
  4 files, +281 −4
  how        signed off
  unblocks   merge-ignores-standing-order
  worktree   removed /home/cws/.wecode/run/cws/charter-guards-agent-config
  undo       wecode rollback charter-guards-agent-config   (was d748f8a9e)

what changed
  crates/wecode-cli/tests/charter.rs                   +147   −0
  crates/wecode-gov/src/lib.rs                         +48    −1
  crates/wecode-org/src/company/limits.rs              +39    −2
  docs/reference/config/company.md                     +47    −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `grep -rqE 'settings.json|playbook.toml|company.toml' crates/wecode-gov/src/lib.rs` exits 0

provenance
  branch     wecode/charter-guards-agent-config
  merge      571c457df
  target was d748f8a9e
```
