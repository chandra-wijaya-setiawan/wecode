# task-onto-branch / task-issue-link — the GitLab shape, specifically

The consuming repo is ste-p2: primary branch `develop`, branch-per-issue, merge
requests, remote `gitlab.aisingapore.net`. What the pair must make true:

- `wecode task add fix-ingest --onto issue/142-dq-checks` cuts the worktree from that
  ref (creating it off the project's merge_to — `develop` here — when new), and the
  task's merges land back on it, not on `develop` directly. The MR from that branch to
  `develop` is then the human's act (a #224 manual task, once it exists).
- the issue reference is a field (`--issue gitlab#142`), shown by `show`/`board` and
  in the report — never encoded in the task id, which stays a name.
- nothing assumes GitHub: the reference is an opaque string with a display form.
