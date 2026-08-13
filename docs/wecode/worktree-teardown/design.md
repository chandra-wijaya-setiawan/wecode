# Taking a worktree down

Status: **built**.

Notes for `worktree-teardown`, step 4 of `worktree-provenance`. They are here rather than on
the task because a task has a title and no description field.

## What went wrong

Nothing removed a worktree. `wecode start` and `wecode run` make one, `wecode merge` lands
what it produced, and then the directory stands there — holding a checkout of work that is
now on the integration branch, plus whatever `target/` grew while the agent worked. Four such
trees on the workspace that found this, every one of them for a task that was done. One
in-flight Rust task measured 890 MB of build output; done tasks hold the same.

A command to remove one already existed. What was missing is the *moment* — and, for two of
the four rows the listing prints, a way to name the thing at all.

## Landing is the moment

The instant a `--no-ff` merge lands, every commit in the tree is reachable from the
integration branch. Up to then the directory is the only copy of the work; after, it is a
copy. That is the whole argument, and it is why teardown hangs off `merge` rather than off
`verify` or the `done` transition:

- **`verify` is too early.** Passing acceptance is not landing — that is already why a task
  with a worktree goes to `needs-approval` rather than `done`. The branch is still the only
  place the work exists.
- **`done` is not a place.** It is set by `merge`, by `approve design`, and by hand. Hanging
  teardown on the status would fire on a design that never had a tree and on an operator
  typing `wecode status x done` to tidy the board, which is not a statement about a directory.

So it is one call at the end of `merge_task`, after the status transition and reading a
plan reloaded across it — the merged task is the commonest occupant of its own tree, and the
in-memory plan predates its own transition to `done`.

## Three ways to decline

Teardown nobody typed has to be able to say no. Each of these leaves the tree exactly where
it was and puts a line in the merge report saying so.

**A task sharing it has not finished.** The branch belongs to the **main** task, so merging a
*subtask* lands the whole tree's work while its siblings still have somewhere to be. Removing
the tree there would take the directory out from under a running agent. Occupancy is asked
through `work::owner` — the same function `prepare` uses to decide where a task works —
because a second traversal here would be a second answer to one question, and the two
disagreeing is exactly the failure. Closed covers `dropped` as well as `done`: abandoned work
is not coming back to the directory.

**It holds uncommitted work.** The merge took what was committed. Anything else is work no
merge has seen, and automatic teardown does not get to decide it was worthless. `--force`
exists on the command for when a person decides that; nothing reaches it on its own.

**git refused.** Then the registry is not touched either, because the tree is still there.

## The branch is always kept

After a `--no-ff` merge the branch is redundant — every commit on it is reachable from the
target. Keeping it anyway is what makes teardown *cheap to be wrong about*: `wecode start` on
the same task cuts the tree again at the branch tip, so the worst a premature removal costs is
a rebuild, never work. That closes the one hole a merge can still leave, since `rollback`
returns a task to `needs-approval` with its tree gone.

It also keeps two existing behaviours honest. `predecessor_branch` looks the branch up by
name so a dependent task starts from its predecessor's work, and merging twice is refused by
git noticing the branch is already merged — both would change meaning if the ref disappeared.

Deleting merged branches is a real piece of hygiene and a different one. It is a decision
about refs, not about directories, and it wants its own thinking about what `git branch -d`
being refused actually tells you.

## Removal by path

`worktree-view` made the listing honest about four kinds of tenant and left this behind: two
of the four are unreachable by a command that takes a task id. An orphan has no task in the
plan — that is what makes it an orphan — and the merge scratch never had one. A tree you can
see and cannot remove is a worse place to be than one you cannot see.

So `wecode worktree remove` takes either. They are told apart **by shape, before the plan is
consulted**: a task id is a kebab-case slug, `TaskId::new` strips everything else, so a `/`
or a leading `~` cannot occur in one. Trying the plan first would have been the obvious order
and is wrong — a mistyped path was slugified into a plausible id and refused as *no such
task*, which names the wrong problem and sends the reader looking for a typo in the wrong
half of the command.

A path names no project, so the repository is found by asking git: the tree comes down under
whichever repo in the plan lists it. Two consequences, both wanted.

`git worktree remove` is a command against a *repository*, not against a directory. A standing
directory that no repo in the plan claims has none to run it against, and guessing one would
run a removal against the wrong repository — so it is refused, by name, rather than attempted.

That refusal is also what keeps `— not ours` out of reach. Another tool's worktree in a
repository wecode does not know is not removable through this command however it is spelled,
which is the same conclusion the listing reached and the reason it says *not ours* instead of
*orphan*.

An absent path still closes its registry row, because that destroys nothing and a row claiming
a directory that is provably gone is worse than no row.

## What this leaves

**No sweep.** Every teardown here is attached to something that just happened — a merge, or a
typed command. A tree whose work landed *before* this existed, or one kept because a sibling
was open at merge time and closed later, still needs `wecode worktree remove` by hand. The
listing names all of them, so the work is bounded and visible rather than lost; a
`wecode worktree prune` that swept them wants a defensible answer to *has this landed* for a
task the plan may no longer hold, and `git::merge_commit_for` only answers it for one that it
does.

**The merge scratch is still unrecorded.** It can now be removed by path, which is what the
listing has been telling the operator to do. Giving it a registry row of its own belongs with
step 2, which gives every tree a slot — it has no task to hang a `task_id` on.

**Nothing deletes a merged branch**, per above.

**The occupancy rules from `worktree-provenance` are still not enforced at dispatch.**
`still_working` is the query they need — a live tree's sharers are exactly the tasks it
returns — but consulting it before dispatching is a change to admission, not to teardown, and
it refuses work rather than cleaning up after it.
