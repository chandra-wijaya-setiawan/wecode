# Why it is like this

Only the arguments you still need in order to use the system correctly, or to change it
without undoing something on purpose. The reasoning behind any individual change lives
in its commit message, where it stays true.

## Enforce at the boundary, never in the prompt

A scope is a check the Broker makes before an action. A sentence in an instruction is
advice, and an agent that ignores it has done nothing the system can detect.

The selection rule follows: **if it cannot be checked before the action occurs, it is not
a capability** — it is advice, and belongs in the prompt where it will be treated as
such.

This is also why playbook guidance can be free prose. It acts at *planning* time, and
whatever it produces still faces the admission gate. Prose that granted authority would
be a different thing entirely.

## Ground truth over self-report

Status comes from diffs, exit codes and spend. The task envelope asks every agent to
write `.wecode/run/result.json`, and **nothing reads it** — an agent's account of its own
work is useful for debugging and inadmissible as evidence.

The ledger marks each record `broker` (we decided), `supervisor` (we observed) or
`harness` (it said so). Marking at write time is what stops the three being confused
later.

A consequence worth naming: for a CLI agent that cannot speak A2A, wecode fills in the
agent's side of the record from what it observed. That is strictly *more* trustworthy
than an agent-reported one, because the agent cannot author it.

## Two levels, and two relations

Four levels — vision, goal, project, task — cost a level of tree for two things that
were never executable. They are attributes now: a company has a vision, a project has an
objective.

Splitting `parent` from `depends_on` is the substantive part. A subtask is not blocked
by its parent, and a predecessor is not a parent; conflating them is the classic
modelling error here. Each earns its keep: `parent` decides which worktree you work in,
`depends_on` decides when you may start and what your handoff contains.

## Regimented or sanctioned, split by reversibility

Not by severity. An irreversible action — a merge to a protected branch, a forbidden
command — must be prevented, because there is no afterwards in which to sanction it. A
recoverable one — a write outside scope inside a worktree — is allowed to happen and
recorded, because the attempt is diagnostic: repeated attempts mean the scope is wrong,
not that the agent is.

This is why auto-merge is defensible at all. A merge you can genuinely roll back is
reversible, so it moves to sanctioned legitimately — *provided* the rollback information
is actually kept. Hence `--no-ff` on every merge, and a report that leads with what
undoes it.

## Attention is the binding constraint

Concurrency derives from `max_open_items`, not from cores. The machine only ever narrows
it. The loop stops dispatching entirely while anything needs a human, because more work
in flight does not help an unanswered question.

Silence on green. Progress is pulled, never pushed.

## The chief cannot execute

An agent that can both set the criteria and satisfy them is not governed. The chief post
holds `define`, `staff` and approvals, and loading a company whose chief also has
`write` or `run` is a validation error rather than a warning.

The `solo` profile relaxes this in one place — its chief may sign its own merges —
because there is one person and they cannot countersign themselves. A team profile moves
merge approval to a reviewer who writes no code.

## Declared and computed, side by side

**Status** is a stored fact someone chose. **Health** is derived from the ledger, the
budget and the defect checks. Both are on the board because a task can be entirely
healthy and simply not started, and a board showing only one cannot say which.

**Archived** is a third property, and deliberately not a status: it parks a project,
hiding it *and* stopping its work being scheduled. Hiding without stopping would leave
the board advertising work nothing will ever pick up.

## A2A

wecode is a platform, not an agent, and speaks to coding CLIs over argv and a working
directory — there is nothing for JSON-RPC to do. But A2A separates its canonical data
model from its bindings, so adopting the model without the transport is what the
specification sanctions rather than a compromise.

What it buys is a *named* contract. The envelope previously carried headings invented on
the spot, which nothing could parse and nothing pinned down.

The status mapping is identity, not translation: `submitted`, `working`,
`input-required`, `auth-required`, `completed`, `failed`, `canceled`, `rejected` are the
protocol's own names. A2A's `Task` maps to a wecode **execution**, never to a wecode
task — A2A has no notion of planned-but-unstarted work.

## Threads, and the database as the bus

An earlier design specified an async runtime and an append-only event log. Both were
reversed. Roughly five concurrent agents does not justify async, and SQLite in WAL mode
already lets the cockpit read while a scheduler writes — a second event log would be a
second source of truth to keep consistent.

`audit_log.seq` is `AUTOINCREMENT` so the ledger is monotonic across every process that
writes to it. A per-process counter got that wrong once, and every record claimed to be
first.

## Build only what something uses

`task_executions` sat specified-but-absent for weeks, because nothing wrote it and every
column would have been a guess about code that did not exist. When it landed, it landed
without `spent_tokens`: nothing counts tokens, and a column that is always NULL is a
guess wearing a schema.

The same rule applies to unreachable code. A helper written for the next task is removed
and re-added when that task arrives — twice now, deliberately, because "it will be used
soon" is exactly the reasoning that leaves dead code behind.
