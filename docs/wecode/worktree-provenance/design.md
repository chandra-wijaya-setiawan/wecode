# Worktree provenance, and where worktrees live

Status: **proposed** — awaiting approval.

Notes for `worktree-provenance`. They are here rather than on the task because a task
has a title and no description field, and the title cannot hold this: the admission gate
refuses a title that names more than one outcome, correctly.

## What went wrong

`wecode worktree` printed 27 rows for 4 real worktrees, eight of them belonging to a
different tool entirely — `treehouse`, which manages worktrees for other repositories on
this machine and keeps its own registry. wecode rendered them as `— orphan`, which reads
as *we made this and lost track of it*. The truth was *this is not ours*.

Two separate faults produced that:

- the listing iterates **projects** where the unit is the **repo**, so every worktree of
  a repo is printed once per project sharing it
- nothing records which worktrees wecode created, so anything it did not recognise was
  labelled an orphan rather than a stranger

The second is this task. The first is `worktree-view`, which depends on it — a view
cannot be honest about ownership before ownership is recorded.

## Not a column on `tasks`

The obvious shape is `tasks.worktree_path`. It is wrong three ways.

A worktree belongs to the **main** task; subtasks share their parent's. A column on
`tasks` would be NULL or duplicated for every subtask, encoding ownership at a level
that does not own anything.

It is derivable. The path is a pure function of the owning task id, and a stored copy of
a derived value is a second source of truth waiting to disagree.

It answers the wrong direction. The question that broke us is *"git reports this path —
is it ours?"* A column on `tasks` cannot answer that for a path with **no** task, which
is exactly the case that matters.

## A registry, keyed on path

```sql
CREATE TABLE worktrees (
    path       TEXT PRIMARY KEY,   -- what git reports back to us
    repo       TEXT NOT NULL,
    branch     TEXT NOT NULL,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created    INTEGER NOT NULL,
    removed    INTEGER             -- NULL while it exists
) STRICT;
```

Keyed on path because that is what git hands us and what we must match against.

`removed` is a tombstone rather than a deletion, for the reason the audit log is never
rewritten: *"we made one and tore it down"* and *"there was never one"* are different
facts, and the second must not be able to impersonate the first.

`task_executions.worktree` stays. It answers *which tree did this attempt run in*, which
is not the same question as *which trees exist and who made them*.

### The hole this closes

`start_execution` is called in exactly one place, inside `run`. So `wecode run` records
the path it worked in, and `wecode start` — which creates a worktree just the same —
records nothing at all. A worktree made by `start` is invisible the moment the command
returns. That gap cannot be closed by a column on `tasks`, because what goes unrecorded
is an **event**, not an association.

## Where worktrees live

Today: `~/.wecode/run/<org>/<task>`, one directory per main task, created on first run
and never removed.

Proposed: `~/.wecode/<org>/<project>-<repo>/<slot>` — grouped by project and repo, with
numbered slots rather than task names.

The grouping is the smaller half of the benefit. The larger half is that **a slot can be
reused**, and reuse is what makes the build cache survive.

Measured on this machine: one in-flight Rust task held 890 MB of `target/`, none of it
shared with the 2.5 GB in the main tree, recompiled from zero on every attempt. Python
paid 37 MB, and only because `~/.cache/uv` sits outside the worktree. Naming a directory
after a task guarantees a cold build every time, because the directory dies with the
task. Naming it after a slot means the next task in that project inherits a warm
`target/` and resets the branch under it.

That is a different lever from `build-cache-env`, and they compose: a shared
`CARGO_TARGET_DIR` removes duplication between concurrent trees, slot reuse removes the
cold start between sequential ones.

### What it costs

A path stops identifying its task. `run/cws/spend-real` said what it was for; `cws/
cockpit-wecode/2` does not. That is acceptable **only because the registry above
exists** — which is why these two decisions belong in one design rather than two.

Slot allocation becomes real work: pick the lowest free slot, and a crash must not leak
one. The registry answers that too — a slot is free when its row has a `removed`
timestamp or no row at all.

One collision to avoid: `~/.wecode/<org>/` sits beside `~/.wecode/workspaces/` and
`~/.wecode/run/`, so an org named `workspaces` or `run` would land on top of them.
Reject those two names at `init`, or keep a fixed parent directory.

## Order

1. the registry, written on create and on remove
2. the path layout and slot reuse, which the registry makes safe
3. `worktree-view` reads the registry instead of guessing
4. `worktree-teardown` marks `removed` rather than only calling git

Steps 3 and 4 are separate tasks and already depend on this one.
