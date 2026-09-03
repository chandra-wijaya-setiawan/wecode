# engineer-role-writes-specs → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  engineer-role-writes-specs → master

summary
  3 files, +115 −3
  how        signed off
  unblocks   charter-guards-agent-config, planning-lifecycle-stages-build, seat-spend-circuit-breaker
  worktree   removed /home/cws/.wecode/run/cws/engineer-role-writes-specs
  undo       wecode rollback engineer-role-writes-specs   (was fbcfc548c)

what changed
  crates/wecode-org/src/template.rs                    +13    −2
  crates/wecode-org/tests/template.rs                  +85    −0
  docs/reference/config/company.md                     +17    −1

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `grep -q 'specs/\*\*' crates/wecode-org/src/template.rs` exits 0

provenance
  branch     wecode/engineer-role-writes-specs
  merge      a47f7cbb3
  target was fbcfc548c
```
