# channel-answers-questions → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  channel-answers-questions → master

summary
  5 files, +616 −54
  how        signed off
  unblocks   merge-ignores-standing-order
  worktree   removed /home/cws/.wecode/run/cws/channel-answers-questions
  undo       wecode rollback channel-answers-questions   (was 6583cc5c3)

what changed
  crates/wecode-cli/src/commands/gov.rs                +177   −1
  crates/wecode-cli/src/telegram.rs                    +231   −34
  crates/wecode-cli/tests/telegram.rs                  +167   −4
  docs/design/telegram-orchestration.md                +36    −14
  docs/reference/config/company.md                     +5     −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -qE 'status|board|why|agents' crates/wecode-cli/src/telegram.rs` exits 0
  ✓ `grep -rqiE 'refus|not a plan|planning' crates/wecode-cli/src/telegram.rs` exits 0

provenance
  branch     wecode/channel-answers-questions
  merge      8e2792481
  target was 6583cc5c3
```
