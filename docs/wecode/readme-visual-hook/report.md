# readme-visual-hook → master

Written by wecode when the merge landed, from git and its own record of the
run. Generated, never authored: an agent's account of its own work is
inadmissible, and a file it could have written would be too.

```text
MERGED  readme-visual-hook → master

summary
  2 files, +21 −3
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/readme-visual-hook
  undo       wecode rollback readme-visual-hook   (was a3bd984f5)

what changed
  README.md                                            +17    −0
  docs/design/home-onboarding.md                       +4     −3

acceptance
  ✓ `python3 -c "from pathlib import Path; r=Path('README.md').read_text(); assert 'mermaid' in r and ('graph' in r or 'flowchart' in r); h=Path('docs/design/home-onboarding.md').read_text(); assert ('mermaid' in h or '┌' in h) and ('context' in h.lower() or 'architecture' in h.lower())"` exits 0
  ✓ `git diff --check` exits 0

provenance
  branch     wecode/readme-visual-hook
  merge      4617770ee
  target was a3bd984f5
```
