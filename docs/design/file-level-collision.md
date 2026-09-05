---
class: hand-tended-state
subject:
  - "crates/wecode-core/src/admission.rs"
  - "crates/wecode-cli/src/scheduler.rs"
  - "crates/wecode-cli/src/commands/exec.rs"
---
# Collision is per file, not per glob

Multi-agent does not work yet, and this is why: two tasks that both declare
`crates/**` are treated as colliding even when one edits `telegram.rs` and the
other `plan.rs`. The whole of 4–5 Sep was spent hand-sequencing tasks that never
actually conflicted. Fixed in three legs.

## Leg 1 — the check compares files
`admission::overlap` compares write **globs** for intersection. Replace with a
file-set comparison:

- a scope resolves to a **set of paths** — a file list directly, or a glob expanded
  against the repo's tracked files (git ls-files), minus append-only paths
  (docs/**, specs/**, .max-lines — landed in append-only-paths-never-collide).
- two tasks collide iff their resolved sets **intersect**. `crates/**` vs
  `crates/wecode-cli/src/telegram.rs` collides; `telegram.rs` vs `plan.rs` does not.
- a glob that resolves to hundreds of files is a smell, not a collision: the check
  stays correct, but `wecode map` should let planning emit the files it will touch
  so scopes are narrow by construction.

## Leg 2 — files are cohesive enough to lock precisely
File-level locking is only as good as the files. `exec.rs` (1682 lines) holds
prepare, the queue, dispatch, judging and a view — five reasons to change, so five
kinds of task lock the one file. Split `commands/exec.rs` into
`commands/exec/{prepare,queue,dispatch,judge,view}.rs`, each owning one decision,
each carrying its own rendering (render.rs co-changed in 20 of the last 38 exec
commits — a false boundary). Test of success: a typical change touches ONE file.

## Leg 3 — the loop dispatches a conflict-free set
Even with leg 1, if the scheduler offers two file-colliding tasks it dispatches one
and the other fails admission — the churn seen all night. `scheduler::dispatchable`
must return a **maximal set whose resolved file-sets are pairwise disjoint**, up to
the slot count. Greedy by priority is enough: walk ready tasks, take one if its
files don't intersect any already taken.

## What this is not
Not a lock held across a run in the store (that is the worktree, already per-task).
This is the *admission and dispatch* decision — who may start alongside whom —
computed from declared scopes, not a runtime mutex.
