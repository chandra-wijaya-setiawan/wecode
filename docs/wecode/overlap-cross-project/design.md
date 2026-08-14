# Overlap across projects on one repo

Status: **built**. Written alongside the implementation: there was no design task in
front of this one, and the decisions below are worth keeping whichever order they were
made in.

## What went wrong

The admission gate refuses a task whose write scope overlaps another task that could be
running at the same time. It found those tasks with `plan.tasks_of(&t.project)`.

A project owns exactly one repository. Nothing says a repository owns one project, and
nothing should: a codebase being worked on from more than one angle is the ordinary
reason to start a second project against it. This repo has had several at once for
weeks.

So the check was scoped to the wrong thing. Two projects on the same repo could each
admit a task claiming `crates/wecode-cli/**`, both pass the gate cleanly, both be
dispatched into their own worktrees, and both come back having changed the same lines.
The first merge lands; the second is a conflict somebody resolves by hand, in a diff
they did not write, after both agents have been paid. Nothing in the ledger records a
refusal, because there was none — the gate said yes twice.

That is the failure this closes, and it is the same failure the sibling check exists to
prevent. Only the query was narrow.

## The resource is the repository

The check now scans every task in the plan and keeps the ones whose project names the
same repo. Same project settles it without a lookup — a project owns one repo, so its
own tasks always agree — and across projects the repo name each one registers under
`[[repos]]` decides it.

Everything else about the check is unchanged, and that is the argument that it was a
query bug rather than a new rule. Each existing exemption already stated something true
about *tasks*, not about projects, and each still does:

- **A closed task's scope is history.** Unchanged, and it is doing more work now: a
  finished project's tasks are the bulk of what the widened scan sees.
- **Ordering removes the conflict.** `depends_on` deliberately does not stop at the
  project boundary the way `parent` does — `Plan::check_dependencies` accepts any task
  in the plan, and `blockers` walks it — so the repair the message offers works across
  the boundary it reports. There is an end-to-end test for exactly that, because a
  message offering a repair that does not work would be worse than no message.
- **A parent contains its child.** `Plan` refuses a subtask in another project outright,
  so this one is same-project by construction and needed no thought.
- **The worker area is shared.** `.wecode/run/**` is written by every task whatever
  project it belongs to, each in its own worktree. Left unexempted the widened scan
  would have made the second project's first task un-admittable.

Two additions were needed.

**Different repos never collide.** Without this the check would refuse most of a
company's board at once: `crates/**` against a different checkout is a different set of
files, however alike the globs read. A project the plan does not hold, or one with a
blank repo, answers *no* — a blank repo is a defect `check_project` already reports, and
pairing two of them off each other would report it a second time under another name.
Failing toward *no conflict* on missing data is the direction that cannot invent one.

**An archived project is not competition.** Archiving parks a project: `ready_tasks`,
the tick and the dispatcher all skip it, so nothing in it can be running while anything
else is. Saying "could run at the same time" about work that cannot start at all is the
same falsehood the transitive-chain fix removed from this message once already. It cuts
both ways — a task in a parked project raises no conflict and is faulted for none — and
unarchiving brings the conflict straight back, since the check is recomputed rather than
stored.

Two stale comments said archiving was "display only", which stopped being true when the
scheduler learned to skip parked projects. They are corrected, in `Project::archived` and
in the schema reference, because this change reads them as load-bearing.

## Naming the other project in the message

`Defect::ScopeOverlaps` grew `in_project: Option<ProjectId>` — `Some` only when the
other task is somewhere else.

A task id alone is unhelpful across the boundary. Ids are unique across the plan, so it
is not ambiguous, but the operator reading the refusal is looking at their own project's
board and the id is not on it; the first thing they do is search for a task that appears
not to exist. The message names the project so the search starts in the right place.

A field rather than a second variant, and `None` rather than always naming the project:

- The CLI matches `Defect::ScopeOverlaps { .. }` in `task scope` to decide what blocks a
  widening. A new variant is a place to forget; an added field cannot be.
- Waivers compare defects by value, and a `--force`d sibling conflict should keep
  recording what it always recorded.
- A sibling message that gained a project clause would be noise on the common case — it
  was never ambiguous, and it is most of the traffic.

The clause is the only difference between the two messages. Both offer the same two
repairs, because both repairs work.

## What this does not do

It does not stop two tasks *running* on the same files — the gate is at admission and
re-run at dispatch, which is where a scope amended after the fact gets caught, and that
is as far as a check on declared scopes can go. What an agent actually wrote is the
supervisor's business, and `verify` already reads it out of the diff.

It does not coordinate between the projects. wecode refuses, names the other project,
and stops; deciding which scope gives way is a conversation between two people, and a
tool that picked for them would be picking whose work is less important.
