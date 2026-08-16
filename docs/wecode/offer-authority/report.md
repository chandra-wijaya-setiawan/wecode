# offer-authority → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  offer-authority → master

summary
  3 files, +332 −8
  how        signed off
  unblocks   envelope-guidance
  worktree   removed /home/cws/.wecode/run/cws/offer-authority
  undo       wecode rollback offer-authority   (was c010c2bdb)

what changed
  crates/wecode-cli/src/notify.rs                      +204   −2
  crates/wecode-cli/tests/notify.rs                    +72    −0
  docs/reference/config.md                             +56    −6

acceptance
  ✓ `cargo test --workspace` exits 0

provenance
  branch     wecode/offer-authority
  merge      7fee20790
  target was c010c2bdb
```
