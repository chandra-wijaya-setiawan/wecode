# req-link → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  req-link → master

summary
  9 files, +639 −88
  how        signed off
  unblocks   cli-self-install-on-merge, cli-self-install-on-merge-build, cli-self-install-on-merge-test, close-story, components, harness-contract, heartbeat-cleans-stalled-agents, heartbeat-cleans-stalled-agents-build, heartbeat-cleans-stalled-agents-test, one-project-per-repo, stalled-worker-leaves-task-working
  worktree   removed /home/cws/.wecode/run/cws/req-link
  undo       wecode rollback req-link   (was c1e3d1d68)

what changed
  crates/wecode-cli/src/commands/plan.rs               +20    −5
  crates/wecode-cli/tests/requirements.rs              +124   −0
  crates/wecode-core/src/requirement.rs                +17    −11
  crates/wecode-core/src/task.rs                       +35    −0
  crates/wecode-store/src/audit.rs                     +154   −45
  crates/wecode-store/src/plan.rs                      +115   −6
  crates/wecode-store/src/schema.rs                    +132   −10
  docs/reference/commands.md                           +19    −10
  docs/reference/schema.md                             +23    −1

by area
  crates/wecode-store/src  3 files, +401 −61
  crates/wecode-cli/tests  1 file, +124 −0
  crates/wecode-core/src   2 files, +52 −11
  docs/reference           2 files, +42 −11
  crates/wecode-cli/src/commands 1 file, +20 −5

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rq 'requirement_id\|requirement_of' crates/wecode-store/src/` exits 0

provenance
  branch     wecode/req-link
  merge      d2fe0a4e3
  target was c1e3d1d68
```
