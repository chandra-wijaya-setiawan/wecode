# board-needs-you-typed → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  board-needs-you-typed → master

summary
  3 files, +247 −21
  how        signed off
  unblocks   adr-rows-index-the-repo, cli-self-install-on-merge, components, design-lives-as-a-digest, empty-run-vs-blocked-write, harness-contract, hold-status, loop-dispatches-concurrently, report-is-generated-from-the-ledger, sweep-files-finished-work, worktree-belongs-to-the-story
  worktree   removed /home/cws/.wecode/run/cws/board-needs-you-typed
  undo       wecode rollback board-needs-you-typed   (was 9a09b5993)

what changed
  crates/wecode-cli/src/board.rs                       +119   −19
  crates/wecode-cli/tests/board.rs                     +60    −2
  docs/reference/board.md                              +68    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rq "needs human" crates/wecode-cli/src/board.rs` exits 0
  ✓ `test 0 -eq $(grep -rc "needs you" crates/wecode-cli/src/board.rs)` exits 0

provenance
  branch     wecode/board-needs-you-typed
  merge      a434212ee
  target was 9a09b5993
```
