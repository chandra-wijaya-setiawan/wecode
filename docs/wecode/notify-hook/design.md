# A command to run when a task starts waiting on a human

Status: **built**. Written alongside the implementation rather than before it — there
was no design task in front of this one, and the decisions below are worth keeping
whichever order they were made in.

## What went wrong

wecode is built to be left running. A task is dispatched under a token and wall budget,
into its own worktree, and judged before anything it produced can reach a shared branch —
that is the whole argument for `dispatch = "auto"` being the default. What it cannot do
unattended is the half that was always a person's: signing a merge, answering a question,
deciding what happens to work that failed.

So the loop reaches one of those and stops, correctly, and then *nothing happens*. Every
way of finding out was a pull: `wecode loop`'s output if you still had the terminal,
`wecode board`, `wecode up`, `wecode ready`. Using wecode on itself, work that finished at
02:14 waited until the morning, and the actual bottleneck on a night's throughput was the
operator not knowing there was anything to sign. An attention budget of five open items is
not five items if four of them are waiting on you silently.

`[notify] command` is the push. It is deliberately the *only* one.

## The edge, not the state

The hook fires on the transition **into** waiting, not on being in it. A task that has
been at `needs-approval` for a week fires once.

This is the difference between a notification and a monitor, and getting it wrong is how
notifiers get switched off. The loop already prints the standing condition every pass —
`⏸ t needs you — needs-approval`, five seconds apart, forever — and a hook wired to that
would be a desktop notification every five seconds until somebody signed.

The edge is computed in one place, `notify::crossing`, from the pair of statuses: waiting
begins where the old status did not need a human and the new one does. `failed` →
`needs-input` is not a new wait; it is the same person still holding the same task, told
twice. Releasing a task and stopping it again *is* a second wait, and is announced.

## Four reasons, three statuses

The hook is told `WECODE_WAITING_FOR`, not just the status, and it has one more value than
the statuses do: `signature`, the dispatch gate holding a task that is otherwise `ready`.

That case is the reason a reason exists at all. `approval`, `input` and `failed` are
restatements of a status a hook could have read for itself. A task waiting for
`approve admission` has no status of its own — deliberately, per
[confirm-tasks](../confirm-tasks/design.md): the fact is about who has said what, which is
the ledger's business, and `needs-approval` already means "verified, waiting to land". A
notification that reported `ready` would be telling the operator the opposite of why they
were being interrupted.

`Waiting::of` maps statuses to reasons and is pinned to `TaskStatus::needs_a_human` by a
test over every status. The board's needs-you column, the loop's pause and this hook must
not be able to disagree about what waiting means; the two definitions live in different
crates, and the test is what holds them together.

## Where it fires from

Every site that writes a status that stops for a person calls the same function:
`verify`'s verdict, a run whose agent did not finish, `rollback`, and `wecode status` by
hand. Not the store — `set_task_status` is in `wecode-store`, which knows nothing about
processes and should not learn.

Announcing a change made by hand looks redundant, since whoever typed it is at a terminal
already. It is not: a hook that only fires when wecode discovered the wait itself is a hook
that cannot be relied on, and the operator moving a task is not always the person who has
to act on it.

The dispatch gate is the exception, because there is no write to hang it on: nothing in the
database changes when a signature becomes due, and the condition is recomputed from the
ledger every pass. So `wecode loop` keeps the edge itself, in a set of task ids it has
already announced, pruned each pass to what is still waiting. A restarted loop announces
again — that state only ever lived in one process, and a loop restarting says what it is
stuck on, which is what an operator restarting it wants to know.

It announces every unsigned task, not the three the log prints. Truncating the printed
list keeps the terminal readable; a notification nobody receives is not a readability
problem.

## It cannot fail the work

A hook that exits non-zero, hangs, or names a program that is not installed produces
`⚠ notify: …` beside the verdict, and nothing else. Never an error, never a status.

A task is not less finished because a notification went astray, and a `wecode run` that
exited non-zero *because its notifier did* would send the operator hunting through the
work for a problem that is in their `company.toml`. This is the same reasoning that keeps
an unrunnable acceptance command apart from failing work.

It is killed at `[notify] timeout`, ten seconds by default. `wecode loop` is meant to run
for days; a notifier blocked on a network call would otherwise take the loop with it. Only
the hook itself is signalled, not a process group — a notifier that backgrounds children of
its own has decided to outlive its exit, and that is its author's business.

Output is discarded. The loop's output is the record of the work, and a notifier's chatter
interleaved with it made both unreadable; what is worth reporting is whether it ran.

## The environment, not the command line

The task is passed as `WECODE_TASK`, `WECODE_TASK_TITLE`, `WECODE_WAITING_FOR` and the
rest, rather than substituted into the command the way `{{prompt}}` is substituted into an
agent's launch line.

A title is arbitrary prose written by whoever planned the work, and wecode is holding the
shell. Substituted, a title with a quote in it is a broken hook, and a title with a
backtick in it is worse. Variables also mean a hook can ignore what it does not care about
without wecode inventing placeholders for every field.

The environment is **inherited**, unlike an agent's, which is built from an allowlist. The
reasoning is the same one acceptance commands run under: this is the operator's own command,
run on their behalf, and a desktop notifier needs the session it was configured in —
`DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, a token. There is nothing to confine; the hook is the
operator, not a worker. `WECODE_ORG` is set on top so a hook can call `wecode` back from
whatever directory it inherited.

## Refused rather than run

The line is checked against the charter's `never_run` — the same function that checks an
agent's launch line, so the two cannot drift. An invariant outranks every grant, and
`company.toml` does not become an exception because the command sits in a different block
of it. A forbidden hook is reported by the pattern that caught it and not executed.

Two config shapes are refused at load: an empty `command`, and a zero `timeout`. Both read
as configured and behave as absent — the first announces nothing, the second kills the hook
before it can run — and a gate that silently does nothing is the one failure mode a
notification must not have. If you do not want notifications, delete the block.

## What is not here

**Anything about who to tell.** One command for the whole workspace, not per project, per
post or per person. Routing is what the hook is for: `WECODE_PROJECT` and the rest are in
the environment, and a `case` statement in shell is more expressive than any set of config
keys this would have grown.

**`needs-input` never fires in practice.** Nothing detects an agent stopping to ask a
question — the status is unreachable today, and is listed as a gap in
[features.md](../../features.md). The reason is wired up so that whatever eventually sets
the status gets the notification for free.

**No retry, and no queue.** A hook that fails, fails. Persisting undelivered notifications
means storing them, expiring them, and deciding what a duplicate is after a crash — a
mail system, to tell somebody something the board will still be saying when they look.

**Nothing on the ledger.** A notification is not an act of authority: nobody was permitted
or refused anything, and the wait that caused it is already recorded by whatever caused the
wait. Filing it would put a line the operator cannot act on into the channel that exists
for lines they must.
