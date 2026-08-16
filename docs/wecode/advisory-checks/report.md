# advisory-checks → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  advisory-checks → master

summary
  7 files, +604 −5
  how        signed off
  unblocks   subtask-scope
  worktree   removed /home/cws/.wecode/run/cws/advisory-checks
  undo       wecode rollback advisory-checks   (was e03dd8d22)

what changed
  crates/wecode-cli/src/commands/plan.rs               +87    −3
  crates/wecode-cli/tests/plan.rs                      +30    −0
  crates/wecode-core/src/admission.rs                  +319   −2
  crates/wecode-org/src/playbook.rs                    +53    −0
  docs/features.md                                     +28    −0
  docs/guides/playbooks.md                             +64    −0
  docs/reference/commands.md                           +23    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/advisory-checks
  merge      dabb93600
  target was e03dd8d22
```
