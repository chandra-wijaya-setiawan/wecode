# refusal-record → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  refusal-record → master

summary
  4 files, +403 −38
  how        signed off
  unblocks   scope-commit
  worktree   removed /home/cws/.wecode/run/cws/refusal-record
  undo       wecode rollback refusal-record   (was d7598f55b)

what changed
  crates/wecode-cli/src/telegram.rs                    +87    −15
  crates/wecode-cli/tests/telegram.rs                  +138   −0
  crates/wecode-gov/src/broker.rs                      +151   −17
  docs/reference/config.md                             +27    −6

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/refusal-record
  merge      d1ca66231
  target was d7598f55b
```
