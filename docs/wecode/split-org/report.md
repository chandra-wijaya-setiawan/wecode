# split-org → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  split-org → master

summary
  13 files, +3261 −2857
  how        signed off
  unblocks   maxlines-gate
  worktree   removed /home/cws/.wecode/run/cws/split-org
  undo       wecode rollback split-org   (was c28c9cdaf)

what changed
  crates/wecode-org/src/company.rs                     +74    −1320
  crates/wecode-org/src/company/agent.rs               +462   −0
  crates/wecode-org/src/company/chart.rs               +257   −0
  crates/wecode-org/src/company/limits.rs              +179   −0
  crates/wecode-org/src/company/reach.rs               +343   −0
  crates/wecode-org/src/company/role.rs                +235   −0
  crates/wecode-org/src/lib.rs                         +16    −0
  crates/wecode-org/src/playbook.rs                    +73    −1537
  crates/wecode-org/src/playbook/cache.rs              +227   −0
  crates/wecode-org/src/playbook/kind.rs               +202   −0
  crates/wecode-org/src/playbook/project.rs            +205   −0
  crates/wecode-org/src/playbook/starter.rs            +619   −0
  crates/wecode-org/src/playbook/subtask.rs            +369   −0

by area
  crates/wecode-org/src    3 files, +163 −2857
  crates/wecode-org/src/playbook 5 files, +1622 −0
  crates/wecode-org/src/company 5 files, +1476 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/split-org
  merge      f85711562
  target was c28c9cdaf
```
