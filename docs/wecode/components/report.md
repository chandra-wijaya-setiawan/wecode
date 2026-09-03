# components → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  components → master

summary
  9 files, +495 −11
  how        signed off
  unblocks   board-says-needs-human, charter-guards-agent-config, engineer-role-writes-specs, hold-status, report-is-generated-from-the-ledger, seat-spend-circuit-breaker
  worktree   removed /home/cws/.wecode/run/cws/components
  undo       wecode rollback components   (was beb46c316)

what changed
  crates/wecode-cli/tests/admission.rs                 +98    −0
  crates/wecode-org/src/lib.rs                         +2     −2
  crates/wecode-org/src/playbook.rs                    +38    −4
  crates/wecode-org/src/playbook/component.rs          +283   −0
  crates/wecode-org/src/playbook/kind.rs               +7     −1
  crates/wecode-org/src/playbook/project.rs            +10    −1
  crates/wecode-org/src/playbook/starter.rs            +8     −0
  crates/wecode-org/src/playbook/subtask.rs            +11    −2
  docs/reference/config/playbook.md                    +38    −1

by area
  crates/wecode-org/src/playbook 5 files, +319 −4
  crates/wecode-cli/tests  1 file, +98 −0
  crates/wecode-org/src    2 files, +40 −6
  docs/reference/config    1 file, +38 −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/components
  merge      d136bed74
  target was beb46c316
```
