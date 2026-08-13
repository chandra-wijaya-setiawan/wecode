# What `wecode worktree` shows, and why it stopped lying

Status: **built**.

Notes for `worktree-view`, step 3 of `worktree-provenance`. They are here rather than on
the task because a task has a title and no description field.

## What went wrong

`wecode worktree` printed 27 rows for 4 real checkouts. Two faults, and this task is the
first of them plus the display half of the second:

- the listing iterated **projects**, and `git worktree list` answers per **repository**,
  so every tree came out once per project sharing its repo
- eight of the rows were another tool's worktrees in the same repository, printed as
  `— orphan` — which reads as *we made this and lost track of it*

The second fault needed the `worktrees` registry, which `worktree-provenance` built. This
task spends it.

## The unit is the repo

The fix to the duplication is not deduplication. It is asking the right question once.

A worktree belongs to a repository. A project names a repository, and several projects
name the same one — that is normal here, and the reason the registry stores `repo` rather
than `project`. So the loop now runs over the distinct repos some project in the plan is
built from, and each `git worktree list` is asked once.

Distinct by **canonical path**, not by `[[repos]]` name: two entries can spell one
directory two ways, and the trees are a property of the directory. Named by the first
`[[repos]]` name that reached it, because a repo has one identity in the config even when
the config disagrees with itself.

Grouping the output by repo rather than adding a repo column is deliberate. It makes the
shape of the fix visible in the shape of the output — one heading per question asked, every
tree under exactly one — and it keeps the row narrow enough that the path still fits.

A repo with no trees prints no heading. Every project's repo gets asked and most have
nothing to show; a heading each would bury the rows that matter.

## Four tenants, not two

`Option<(task, status)>` could only say *a task works here* or *nothing does*, and it was
the second that did the damage. The rows split four ways now:

| tenant | how it is recognised |
| --- | --- |
| a task | the path is the one wecode computes for a live task, or a registry row names one |
| orphan | a registry row, whose task is no longer in the plan |
| merge scratch | the path is `<run root>/<org>/.merge` |
| stranger | none of the above |

The order matters, and the plan comes first for two reasons.

**It settles the ambiguous cases.** Nothing forbids a task called `.merge`, and a registry
row can name a task that still exists. Asking about tasks first means the answer an
operator can act on wins, rather than the answer that happens to be checked earlier.

**It covers what the registry cannot.** A checkout standing since before the registry
existed has no row and is never backfilled — its creation date was never observed. But its
path is still a pure function of its task's id, so for a task that is still in the plan the
derivation is sound, and the tree reads as that task's. The registry answers the direction
the derivation cannot: a path with no task at all.

That is the whole division of labour. `worktree-provenance` argued the derivation cannot
tell a stranger from an orphan, which is true and is why the last two arms need the table.
It does not follow that the derivation is useless for the first arm, where it is exact.

Only live rows are read. A tombstone says a directory *used to be* ours, and git is being
asked what is there now.

## A tally, because 27 was the symptom

The listing ends with a count: how many trees, in how many repos, and how they split
between in use, ours to clean up, and not ours. The original fault was a number nobody
could check at a glance — a repeat looked like more work, not like the same work twice. A
tally is what makes the next such fault visible in one line.

## What this leaves

`— merge scratch` is recognised but not recorded, so a merge that dies mid-flight still
leaves a tree the registry does not know about. Recognising it by name is enough to stop
the listing lying about it; giving it a row belongs with step 2, which gives every tree a
slot.

A stranger's row shows no branch, though git could say. The listing deliberately says
nothing about another tool's tree beyond that it exists and is not ours.

**The view can now name something the command cannot remove.** `wecode worktree remove`
takes a task id and looks it up in the plan, so an orphan — whose task is gone, which is
exactly what makes it an orphan — and the merge scratch are both unreachable through it.
Naming them is still the right move: `git worktree remove <path>` clears either, and a tree
you can see and must remove by hand beats one you cannot see. Making the command take a path
is `worktree-teardown`'s, not this task's — it changes what removal *is* allowed to do, and
that wants its own thinking about uncommitted work in a tree with no task to warn about.

> **Since built.** `worktree-teardown` took that on: `wecode worktree remove` now accepts a
> path as well as a task id, so both middle rows are reachable. `— not ours` still is not, and
> deliberately — the removal is refused for a directory no repository in the plan lists as a
> worktree. See `docs/wecode/worktree-teardown/design.md`.
