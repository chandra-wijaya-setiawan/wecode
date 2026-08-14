# confirm-tasks → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  confirm-tasks → master

summary
  13 files, +667 −38
  how        signed off
  unblocks   playbook-gap
  worktree   removed /home/cws/.wecode/run/cws/confirm-tasks
  undo       wecode rollback confirm-tasks   (was 73f9d2ad9)

what changed
  crates/wecode-cli/src/commands/exec.rs               +90    −7
  crates/wecode-cli/src/commands/gov.rs                +39    −26
  crates/wecode-cli/src/ledger.rs                      +63    −0
  crates/wecode-cli/src/main.rs                        +4     −1
  crates/wecode-cli/tests/cli.rs                       +178   −0
  crates/wecode-org/src/lib.rs                         +3     −1
  crates/wecode-org/src/playbook.rs                    +93    −0
  docs/features.md                                     +17    −0
  docs/guides/playbooks.md                             +27    −0
  docs/lifecycle.md                                    +25    −2
  docs/reference/commands.md                           +14    −1
  docs/reference/config.md                             +23    −0
  docs/wecode/confirm-tasks/design.md                  +91    −0

by area
  crates/wecode-cli/tests  1 file, +178 −0
  crates/wecode-cli/src/commands 2 files, +129 −33
  crates/wecode-org/src    2 files, +96 −1
  docs/wecode/confirm-tasks 1 file, +91 −0
  crates/wecode-cli/src    2 files, +67 −1
  docs                     2 files, +42 −2
  docs/reference           2 files, +37 −1
  docs/guides              1 file, +27 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/confirm-tasks
  merge      6c3057b77
  target was 73f9d2ad9
```
