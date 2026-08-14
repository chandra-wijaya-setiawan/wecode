# build-cache-env → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  build-cache-env → master

summary
  14 files, +861 −21
  how        signed off
  unblocks   starter-per-language
  worktree   removed /home/cws/.wecode/run/cws/build-cache-env
  undo       wecode rollback build-cache-env   (was 45354d9b1)

what changed
  crates/wecode-cli/src/cache.rs                       +109   −0
  crates/wecode-cli/src/commands/exec.rs               +36    −3
  crates/wecode-cli/src/main.rs                        +1     −0
  crates/wecode-cli/src/render.rs                      +36    −0
  crates/wecode-cli/src/spawn.rs                       +71    −7
  crates/wecode-cli/src/verify.rs                      +66    −8
  crates/wecode-cli/tests/cli.rs                       +104   −1
  crates/wecode-org/src/lib.rs                         +2     −1
  crates/wecode-org/src/playbook.rs                    +218   −0
  docs/features.md                                     +22    −0
  docs/guides/playbooks.md                             +33    −0
  docs/reference/commands.md                           +7     −1
  docs/reference/config.md                             +40    −0
  docs/wecode/build-cache-env/design.md                +116   −0

by area
  crates/wecode-cli/src    5 files, +283 −15
  crates/wecode-org/src    2 files, +220 −1
  docs/wecode/build-cache-env 1 file, +116 −0
  crates/wecode-cli/tests  1 file, +104 −1
  docs/reference           2 files, +47 −1
  crates/wecode-cli/src/commands 1 file, +36 −3
  docs/guides              1 file, +33 −0
  docs                     1 file, +22 −0

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0

provenance
  branch     wecode/build-cache-env
  merge      2df2213c2
  target was 45354d9b1
```
