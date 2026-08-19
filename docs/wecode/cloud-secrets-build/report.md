# cloud-secrets-build → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  cloud-secrets-build → master

summary
  2 files, +728 −6
  how        signed off
  unblocks   secret-ttl-precheck
  worktree   removed /home/cws/.wecode/run/cws/cloud-secrets-build
  undo       wecode rollback cloud-secrets-build   (was ffee43623)

what changed
  crates/wecode-cli/src/spawn.rs                       +130   −4
  crates/wecode-org/src/company.rs                     +598   −2

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `cargo clippy --all-targets -- -D warnings` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0

provenance
  branch     wecode/cloud-secrets-build
  merge      c603c10f9
  target was ffee43623
```
