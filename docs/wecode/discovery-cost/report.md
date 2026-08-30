# discovery-cost → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  discovery-cost → master

summary
  13 files, +712 −20
  how        signed off
  unblocks   codemap-scan, harness-contract, milestones, project-set-repo, record-not-commission, rel-transition-journal, reuse-dropped-id, template-number-paths
  worktree   removed /home/cws/.wecode/run/cws/discovery-cost
  undo       wecode rollback discovery-cost   (was 4646158dd)

what changed
  crates/wecode-cli/src/commands/cost.rs               +226   −0
  crates/wecode-cli/src/commands/mod.rs                +1     −0
  crates/wecode-cli/src/commands/plan.rs               +1     −1
  crates/wecode-cli/src/commands/plan/amend.rs         +5     −1
  crates/wecode-cli/src/commands/view.rs               +14    −3
  crates/wecode-cli/src/handoff.rs                     +8     −1
  crates/wecode-cli/src/main.rs                        +7     −0
  crates/wecode-cli/src/scheduler.rs                   +1     −0
  crates/wecode-cli/src/usage.rs                       +70    −2
  crates/wecode-store/src/execution.rs                 +226   −2
  crates/wecode-store/src/schema.rs                    +76    −9
  docs/reference/commands.md                           +41    −0
  docs/reference/schema.md                             +36    −1

by area
  crates/wecode-store/src  2 files, +302 −11
  crates/wecode-cli/src/commands 4 files, +242 −4
  crates/wecode-cli/src    4 files, +86 −3
  docs/reference           2 files, +77 −1
  crates/wecode-cli/src/commands/plan 1 file, +5 −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/discovery-cost
  merge      4084f0642
  target was 4646158dd
```
