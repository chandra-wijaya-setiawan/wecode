# codemap-scan → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  codemap-scan → master

summary
  16 files, +2294 −5
  how        signed off
  unblocks   components, decision-record, decision-supersede, findings-ledger, harness-contract, milestones, project-set-repo, record-not-commission, rel-dead-worker-lease, rel-dead-worker-lease-build, rel-dead-worker-lease-test, rel-recover-command, rel-recover-command-build, rel-recover-command-test, rel-transition-journal, rel-transition-journal-build, rel-transition-journal-test, reuse-dropped-id, template-number-paths, tui-agents
  worktree   kept — codemap-scan-test still working in /home/cws/.wecode/run/cws/codemap-scan
  undo       wecode rollback codemap-scan   (was d4587dfec)

what changed
  crates/wecode-cli/Cargo.toml                         +1     −0
  crates/wecode-cli/src/codemap.rs                     +660   −0
  crates/wecode-cli/src/doctor/machine.rs              +50    −0
  crates/wecode-cli/src/git.rs                         +39    −0
  crates/wecode-cli/src/handoff.rs                     +46    −5
  crates/wecode-cli/src/main.rs                        +7     −0
  crates/wecode-cli/src/work.rs                        +15    −0
  crates/wecode-cli/tests/codemap.rs                   +203   −0
  crates/wecode-map/Cargo.toml                         +21    −0
  crates/wecode-map/src/lang.rs                        +190   −0
  crates/wecode-map/src/lib.rs                         +34    −0
  crates/wecode-map/src/rank.rs                        +474   −0
  crates/wecode-map/src/tags.rs                        +275   −0
  docs/reference/commands.md                           +5     −0
  docs/wecode/codemap-scan/design.md                   +128   −0
  specs/004-codemap-scan/specification.md              +146   −0

by area
  crates/wecode-map/src    4 files, +973 −0
  crates/wecode-cli/src    5 files, +767 −5
  crates/wecode-cli/tests  1 file, +203 −0
  specs/004-codemap-scan   1 file, +146 −0
  docs/wecode/codemap-scan 1 file, +128 −0
  crates/wecode-cli/src/doctor 1 file, +50 −0
  crates/wecode-map        1 file, +21 −0
  docs/reference           1 file, +5 −0
  crates/wecode-cli        1 file, +1 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `./target/debug/wecode help | grep -qi 'map'` exits 0

provenance
  branch     wecode/codemap-scan
  merge      57568beaa
  target was d4587dfec
```
