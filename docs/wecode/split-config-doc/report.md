# split-config-doc → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  split-config-doc → master

summary
  12 files, +843 −807
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/split-config-doc
  undo       wecode rollback split-config-doc   (was 77b7e2cda)

what changed
  docs/README.md                                       +1     −1
  docs/concepts.md                                     +1     −1
  docs/guides/getting-started.md                       +3     −3
  docs/reference/commands.md                           +3     −3
  docs/reference/config.md                             +0     −798
  docs/reference/config/README.md                      +55    −0
  docs/reference/config/company.md                     +156   −0
  docs/reference/config/envelope.md                    +48    −0
  docs/reference/config/notify.md                      +153   −0
  docs/reference/config/playbook.md                    +182   −0
  docs/reference/config/telegram.md                    +240   −0
  docs/reference/schema.md                             +1     −1

by area
  docs/reference/config    6 files, +834 −0
  docs/reference           3 files, +4 −802
  docs/guides              1 file, +3 −3
  docs                     2 files, +2 −2

acceptance
  ✓ `cargo test --workspace` exits 0
  ✓ `bash scripts/max-lines.sh` exits 0
  ✓ `test ! -f docs/reference/config.md` exits 0

provenance
  branch     wecode/split-config-doc
  merge      63384fe50
  target was 77b7e2cda
```
