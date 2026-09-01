# req-rows → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  req-rows → master

summary
  8 files, +705 −30
  how        signed off
  unblocks   cli-self-install-on-merge, cli-self-install-on-merge-build, cli-self-install-on-merge-test, components, heartbeat-cleans-stalled-agents-build, heartbeat-cleans-stalled-agents-test, one-project-per-repo
  worktree   kept — 1 uncommitted change the merge did not take, in /home/cws/.wecode/run/cws/req-rows
  undo       wecode rollback req-rows   (was 67938aa82)

what changed
  .max-lines                                           +2     −2
  crates/wecode-cli/src/commands/plan.rs               +249   −3
  crates/wecode-cli/tests/plan.rs                      +92    −0
  crates/wecode-core/src/admission.rs                  +25    −25
  crates/wecode-core/src/lib.rs                        +1     −0
  crates/wecode-core/src/requirement.rs                +64    −0
  crates/wecode-store/src/audit.rs                     +243   −0
  docs/reference/commands.md                           +29    −0

by area
  crates/wecode-cli/src/commands 1 file, +249 −3
  crates/wecode-store/src  1 file, +243 −0
  crates/wecode-core/src   3 files, +90 −25
  crates/wecode-cli/tests  1 file, +92 −0
  docs/reference           1 file, +29 −0
  .                        1 file, +2 −2

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rqi 'requirement' crates/wecode-store/src/` exits 0

provenance
  branch     wecode/req-rows
  merge      53441bf6f
  target was 67938aa82
```
