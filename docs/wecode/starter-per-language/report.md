# starter-per-language → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  starter-per-language → master

summary
  12 files, +1275 −81
  how        signed off
  unblocks   overlap-cross-project
  worktree   removed /home/cws/.wecode/run/cws/starter-per-language
  undo       wecode rollback starter-per-language   (was fbb2b4b36)

what changed
  crates/wecode-cli/src/commands/org.rs                +15    −7
  crates/wecode-cli/src/main.rs                        +5     −1
  crates/wecode-cli/src/render.rs                      +139   −0
  crates/wecode-cli/tests/cli.rs                       +86    −3
  crates/wecode-org/src/lib.rs                         +9     −1
  crates/wecode-org/src/playbook.rs                    +487   −66
  crates/wecode-org/src/toolchain.rs                   +314   −0
  docs/features.md                                     +15    −0
  docs/guides/playbooks.md                             +35    −2
  docs/reference/commands.md                           +19    −1
  docs/reference/config.md                             +6     −0
  docs/wecode/starter-per-language/design.md           +145   −0

by area
  crates/wecode-org/src    3 files, +810 −67
  crates/wecode-cli/src    2 files, +144 −1
  docs/wecode/starter-per-language 1 file, +145 −0
  crates/wecode-cli/tests  1 file, +86 −3
  docs/guides              1 file, +35 −2
  docs/reference           2 files, +25 −1
  crates/wecode-cli/src/commands 1 file, +15 −7
  docs                     1 file, +15 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/starter-per-language
  merge      26625256f
  target was fbb2b4b36
```
