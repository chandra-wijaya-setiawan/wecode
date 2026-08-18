# decided-everywhere → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  decided-everywhere → master

summary
  3 files, +242 −21
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/decided-everywhere
  undo       wecode rollback decided-everywhere   (was 0f0af046e)

what changed
  crates/wecode-cli/src/commands/gov.rs                +32    −4
  crates/wecode-cli/src/telegram.rs                    +111   −14
  crates/wecode-cli/tests/telegram.rs                  +99    −3

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/decided-everywhere
  merge      6aca97bb3
  target was 0f0af046e
```
