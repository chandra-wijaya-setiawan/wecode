# mission-onboarding-docs → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  mission-onboarding-docs → master

summary
  8 files, +213 −6
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/mission-onboarding-docs
  undo       wecode rollback mission-onboarding-docs   (was db5d5b2e4)

what changed
  README.md                                            +45    −4
  docs/README.md                                       +2     −0
  docs/design/home-onboarding.md                       +82    −0
  docs/design/maturity-roadmap.md                      +18    −1
  docs/design/sdlc.md                                  +34    −0
  docs/features.md                                     +17    −0
  docs/guides/getting-started.md                       +3     −1
  plan.md                                              +12    −0

by area
  docs/design              3 files, +134 −1
  .                        2 files, +57 −4
  docs                     2 files, +19 −0
  docs/guides              1 file, +3 −1

acceptance
  ✓ `test -f docs/README.md` exits 0
  ✓ `git diff --check` exits 0
  ✓ `python3 -c 'from pathlib import Path; r=Path("README.md").read_text().lower(); assert "pre-mvp" in r; assert "sdlc" in r; assert "integration" in r; assert "conduit" in r; p=Path("docs/design/home-onboarding.md").read_text().lower(); assert "proposed" in p; assert "pre-mvp" in p'` exits 0

provenance
  branch     wecode/mission-onboarding-docs
  merge      101a10126
  target was db5d5b2e4
```
