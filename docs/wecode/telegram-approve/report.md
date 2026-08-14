# telegram-approve → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  telegram-approve → master

summary
  21 files, +2043 −23
  how        signed off
  unblocks   tui-depth
  worktree   removed /home/cws/.wecode/run/cws/telegram-approve
  undo       wecode rollback telegram-approve   (was 5281a63cf)

what changed
  crates/wecode-cli/src/commands/ctx.rs                +17    −0
  crates/wecode-cli/src/commands/exec.rs               +34    −7
  crates/wecode-cli/src/commands/gov.rs                +75    −8
  crates/wecode-cli/src/main.rs                        +5     −0
  crates/wecode-cli/src/notify.rs                      +7     −2
  crates/wecode-cli/src/render.rs                      +25    −0
  crates/wecode-cli/src/telegram.rs                    +804   −0
  crates/wecode-cli/tests/cli.rs                       +356   −0
  crates/wecode-org/src/company.rs                     +188   −0
  crates/wecode-org/src/lib.rs                         +1     −1
  crates/wecode-org/src/template.rs                    +16    −0
  crates/wecode-store/src/inbox.rs                     +103   −0
  crates/wecode-store/src/lib.rs                       +1     −0
  crates/wecode-store/src/schema.rs                    +63    −4
  docs/features.md                                     +38    −0
  docs/guides/getting-started.md                       +30    −0
  docs/lifecycle.md                                    +7     −0
  docs/reference/commands.md                           +3     −0
  docs/reference/config.md                             +76    −0
  docs/reference/schema.md                             +21    −1
  docs/wecode/telegram-approve/design.md               +173   −0

by area
  crates/wecode-cli/src    4 files, +841 −2
  crates/wecode-cli/tests  1 file, +356 −0
  crates/wecode-org/src    3 files, +205 −1
  docs/wecode/telegram-approve 1 file, +173 −0
  crates/wecode-store/src  3 files, +167 −4
  crates/wecode-cli/src/commands 3 files, +126 −15
  docs/reference           3 files, +100 −1
  docs                     2 files, +45 −0
  docs/guides              1 file, +30 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/telegram-approve
  merge      feabda1cc
  target was 5281a63cf
```
