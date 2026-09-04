# tui-dashboard-is-the-front-page → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  tui-dashboard-is-the-front-page → master

summary
  7 files, +1189 −102
  how        signed off
  unblocks   tui-dependency-graph
  worktree   removed /home/cws/.wecode/run/cws/tui-dashboard-is-the-front-page
  undo       wecode rollback tui-dashboard-is-the-front-page   (was 0c6dd9329)

what changed
  crates/wecode-cli/src/tui.rs                         +93    −95
  crates/wecode-cli/src/tui/agents.rs                  +57    −0
  crates/wecode-cli/src/tui/approvals.rs               +6     −2
  crates/wecode-cli/src/tui/dashboard.rs               +857   −0
  crates/wecode-cli/tests/tui.rs                       +119   −0
  docs/design/tui-dashboard.md                         +24    −0
  docs/reference/tui.md                                +33    −5

by area
  crates/wecode-cli/src/tui 3 files, +920 −2
  crates/wecode-cli/src    1 file, +93 −95
  crates/wecode-cli/tests  1 file, +119 −0
  docs/reference           1 file, +33 −5
  docs/design              1 file, +24 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `test -f crates/wecode-cli/src/tui/dashboard.rs` exits 0
  ✓ `grep -qE 'Need you|Blocked|Roadmap' crates/wecode-cli/src/tui/dashboard.rs` exits 0
  ✓ `grep -qE 'v-d|v-a|v-y|v-g|v-r' crates/wecode-cli/src/tui/dashboard.rs` exits 0

provenance
  branch     wecode/tui-dashboard-is-the-front-page
  merge      32f48717b
  target was 0c6dd9329
```
