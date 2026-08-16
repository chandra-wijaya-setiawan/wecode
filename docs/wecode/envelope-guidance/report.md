# envelope-guidance → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  envelope-guidance → master

summary
  3 files, +89 −0
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/envelope-guidance
  undo       wecode rollback envelope-guidance   (was 2cc798886)

what changed
  crates/wecode-cli/tests/handoff.rs                   +34    −0
  crates/wecode-org/src/template.rs                    +32    −0
  docs/reference/config.md                             +23    −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/envelope-guidance
  merge      ef3b83636
  target was 2cc798886
```
