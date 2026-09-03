# cli-self-install-on-merge → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  cli-self-install-on-merge → master

summary
  3 files, +192 −10
  how        signed off
  unblocks   adr-rows-index-the-repo, design-lives-as-a-digest, harness-contract, report-is-generated-from-the-ledger, worktree-belongs-to-the-story
  worktree   removed /home/cws/.wecode/run/cws/cli-self-install-on-merge
  undo       wecode rollback cli-self-install-on-merge   (was 2c5bb1995)

what changed
  .wecode/playbook.toml                                +14    −9
  crates/wecode-cli/tests/merge.rs                     +152   −1
  docs/reference/commands.md                           +26    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -q 'install' crates/wecode-cli/tests/merge.rs` exits 0

provenance
  branch     wecode/cli-self-install-on-merge
  merge      f1cf9212f
  target was 2c5bb1995
```
