# adr-rows-index-the-repo → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  adr-rows-index-the-repo → master

summary
  4 files, +578 −4
  how        signed off
  unblocks   board-says-needs-human
  worktree   removed /home/cws/.wecode/run/cws/adr-rows-index-the-repo
  undo       wecode rollback adr-rows-index-the-repo   (was 81ad6e64b)

what changed
  crates/wecode-cli/src/ledger.rs                      +8     −0
  crates/wecode-cli/tests/adr.rs                       +148   −0
  crates/wecode-store/src/audit.rs                     +354   −4
  docs/reference/adr.md                                +68    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -rqi 'adr' crates/wecode-cli/src/ledger.rs` exits 0

provenance
  branch     wecode/adr-rows-index-the-repo
  merge      da17d19dc
  target was 81ad6e64b
```
