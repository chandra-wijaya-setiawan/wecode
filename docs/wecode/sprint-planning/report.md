# sprint-planning → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  sprint-planning → master

summary
  5 files, +922 −14
  how        signed off
  unblocks   refusal-record
  worktree   removed /home/cws/.wecode/run/cws/sprint-planning
  undo       wecode rollback sprint-planning   (was c6896d6c0)

what changed
  crates/wecode-cli/src/commands/plan.rs               +205   −14
  crates/wecode-cli/tests/plan.rs                      +401   −0
  crates/wecode-core/src/plan.rs                       +182   −0
  crates/wecode-store/src/plan.rs                      +84    −0
  docs/reference/commands.md                           +50    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/sprint-planning
  merge      9903d9408
  target was c6896d6c0
```
