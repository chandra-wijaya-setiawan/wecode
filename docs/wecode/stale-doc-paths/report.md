# stale-doc-paths → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  stale-doc-paths → master

summary
  3 files, +11 −4
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/stale-doc-paths
  undo       wecode rollback stale-doc-paths   (was 353d09703)

what changed
  crates/wecode-cli/src/commands/gov.rs                +1     −1
  crates/wecode-cli/src/doctor.rs                      +6     −2
  crates/wecode-cli/tests/doctor.rs                    +4     −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/stale-doc-paths
  merge      31955c15e
  target was 353d09703
```
