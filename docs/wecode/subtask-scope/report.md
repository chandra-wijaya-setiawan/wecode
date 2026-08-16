# subtask-scope → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  subtask-scope → master

summary
  3 files, +308 −8
  how        signed off
  unblocks   offer-authority
  worktree   removed /home/cws/.wecode/run/cws/subtask-scope
  undo       wecode rollback subtask-scope   (was 9672faeac)

what changed
  crates/wecode-cli/src/commands/plan/task.rs          +56    −7
  crates/wecode-cli/tests/expand.rs                    +108   −0
  crates/wecode-org/src/playbook/subtask.rs            +144   −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/subtask-scope
  merge      6a8ab1a44
  target was 9672faeac
```
