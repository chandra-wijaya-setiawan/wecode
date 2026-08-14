# playbook-gap → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  playbook-gap → master

summary
  11 files, +1186 −21
  how        signed off
  unblocks   build-cache-env
  worktree   removed /home/cws/.wecode/run/cws/playbook-gap
  undo       wecode rollback playbook-gap   (was 424b6e23e)

what changed
  crates/wecode-cli/src/commands/org.rs                +138   −17
  crates/wecode-cli/src/main.rs                        +6     −0
  crates/wecode-cli/src/render.rs                      +207   −4
  crates/wecode-cli/tests/cli.rs                       +186   −0
  crates/wecode-org/src/gap.rs                         +428   −0
  crates/wecode-org/src/lib.rs                         +6     −0
  docs/features.md                                     +14    −0
  docs/guides/playbooks.md                             +44    −0
  docs/reference/commands.md                           +11    −0
  docs/reference/config.md                             +40    −0
  docs/wecode/playbook-gap/design.md                   +106   −0

by area
  crates/wecode-org/src    2 files, +434 −0
  crates/wecode-cli/src    2 files, +213 −4
  crates/wecode-cli/tests  1 file, +186 −0
  crates/wecode-cli/src/commands 1 file, +138 −17
  docs/wecode/playbook-gap 1 file, +106 −0
  docs/reference           2 files, +51 −0
  docs/guides              1 file, +44 −0
  docs                     1 file, +14 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/playbook-gap
  merge      eb7833dc7
  target was 424b6e23e
```
