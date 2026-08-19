# project-purpose → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  project-purpose → master

summary
  10 files, +373 −13
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/project-purpose
  undo       wecode rollback project-purpose   (was 3d3829e67)

what changed
  crates/wecode-cli/src/commands/plan/amend.rs         +21    −4
  crates/wecode-cli/src/commands/plan/inspect.rs       +6     −1
  crates/wecode-cli/src/commands/plan/project.rs       +27    −1
  crates/wecode-cli/src/commands/plan/staff.rs         +5     −1
  crates/wecode-cli/src/commands/plan/task.rs          +15    −1
  crates/wecode-cli/tests/admission.rs                 +67    −1
  crates/wecode-core/src/admission.rs                  +101   −0
  crates/wecode-org/src/playbook/project.rs            +67    −4
  crates/wecode-org/src/template.rs                    +9     −0
  docs/reference/config/playbook.md                    +55    −0

by area
  crates/wecode-core/src   1 file, +101 −0
  crates/wecode-cli/src/commands/plan 5 files, +74 −8
  crates/wecode-org/src/playbook 1 file, +67 −4
  crates/wecode-cli/tests  1 file, +67 −1
  docs/reference/config    1 file, +55 −0
  crates/wecode-org/src    1 file, +9 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/project-purpose
  merge      3032dd427
  target was 3d3829e67
```
