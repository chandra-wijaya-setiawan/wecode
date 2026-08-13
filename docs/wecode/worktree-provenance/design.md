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
and never removed. `run/` and `workspaces/` are siblings.

Proposed: **inside the workspace**, grouped by project and repo, with numbered slots
rather than task names.

```
~/.wecode/
  current
  workspaces/
    cws/
      company.toml
      wecode.db
      worktrees/
        cockpit-wecode/1
        wemail-ingest-wemail/1
```

`run/` disappears and everything belonging to an org lives under one directory. A
first draft put these at `~/.wecode/<org>/`, which would collide with `workspaces/` and
`run/` for an org unlucky enough to be named either; nesting under the workspace makes
the question moot, because `<org>` is already namespaced there.

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

It changes what a workspace directory *is*. Today `workspaces/cws/` is 2.9 MB of
hand-edited, backup-worthy state — the sort of thing you copy without thinking. With
worktrees inside, one active Rust task turns it into ~900 MB of regenerable build output
wrapped around a 217 KB database, and any backup or sync needs an exclude rule to stay
sensible. The `worktrees/` subdirectory is there so that rule is a single line, and so
the split between precious and regenerable stays visible at a glance.

Two things in the tree state the opposite today and must be changed deliberately rather
than discovered:

- `work::run_root`'s doc comment argues worktrees sit *beside* the workspace, not inside
  it, for glob hygiene — while conceding in the same breath that it is *"hygiene, not a
  boundary"*, since the Broker is what actually refuses a write. That reasoning does not
  survive contact with the benefit above, but the comment should be corrected, not left
  contradicting the code.
- `the_worktree_path_sits_under_the_run_root_not_the_workspace` asserts the path contains
  no `workspaces` component. It encodes the old decision faithfully and has to be
  rewritten to encode this one — the worktree is inside the workspace and under
  `worktrees/`, and `company.toml` is not reachable without leaving that subtree.

## Siblings share a tree, and nothing says so

Found running the wemail expansions. A worktree belongs to the **main** task, so the
four subtasks of one feature resolve to one owner and one checkout. Dispatch two of
them at once — `test` and `docs` are unordered siblings with disjoint scopes, so
admission sees no conflict — and two agents write the same directory at the same time.

The overlap check cannot catch it, and correctly so: it asks whether two tasks claim
the same *paths*, and these do not. The collision is over the *tree*, which is a
different resource and currently modelled nowhere. The operator avoided it eight times
today by dispatching one subtask at a time and remembering why.

The registry answers it. A worktree row already names its `task_id`; the tasks sharing
that tree are that task's descendants, so "is this tree busy" becomes a lookup rather
than a thing the dispatcher has to know. Two rules follow:

- a task whose owning tree has a `running` occupant is not dispatchable
- an expanded parent is never dispatchable while it has open subtasks — it is a
  container, and running it would have an agent redo work its children own

Both belong with the registry rather than with the scope check, because both are
questions about occupancy rather than about paths.

## Order

1. the registry, written on create and on remove
2. the path layout and slot reuse, which the registry makes safe
3. `worktree-view` reads the registry instead of guessing
4. `worktree-teardown` marks `removed` rather than only calling git

Steps 3 and 4 are separate tasks and already depend on this one.
