# Closing a run whose supervisor stopped answering

Status: **decided, not built**.

Notes for `heartbeat-cleans-stalled-agents`. What the build step knows about this
decision it knows from this file.

## The silence problem

An open row in `task_executions` is a claim that some wecode process is watching a child
process *right now*. `Claim` in `commands/exec.rs` keeps that claim honest on every exit
the supervisor gets to run code on — an admission refusal, a harness that will not start,
any `?` in `run_task` — because `Drop` hands the task back. The exits it cannot cover are
the ones that run nothing: `kill -9`, a closed laptop that never came back, WSL restarting
under a `wecode loop`, a terminal shut on a `cargo run`.

What is left is a row saying `working` with `ended` NULL, a task saying `running`, a
worktree standing, and one of the operator's open-item slots gone — `free_slots` counts
running tasks. Nothing moves any of it. The tick never authors `running`; `contended`
refuses the next dispatch *because* the row is open, which is correct while a run is real
and permanent once it is not; and `unfinished_executions()`, the one query that finds
these rows, is read by nothing but the cockpit's agents panel, where a dead run is drawn
as an agent at work.

That last part is why this belongs to the reach project rather than to housekeeping. An
operator reading the board from a phone cannot tell a task nine hours into a long run from
one whose supervisor died in minute two: both render as `running`, with an elapsed time
that keeps climbing. A board is only worth answering from elsewhere if it is honest about
what is alive.

## The decision

**A run is alive because a supervisor keeps saying so.** When the saying stops for long
enough, and the process that noticed was there for the whole silence, the loop closes the
row, hands the task to a person, and touches nothing else.

Six parts, each with a cheaper alternative that is wrong.

**The supervisor beats, not the agent.** One new column, `task_executions.beat` (schema
14), written by the wecode process that is blocked in `spawn::run`, every 30 seconds, for
as long as it is blocked. Asking the *agent* to report its own liveness fails the rule
every other verdict in this system obeys — the diff is ground truth, `report.md` is
generated, an agent's account of its own work is inadmissible — and most harnesses could
not be asked anyway. Nor is the session's `last_seen` reusable for this, though it is the
same mechanism one table over: `session.rs` says outright that a session is a connection
and an execution is a unit of work, and a session is touched by every command the operator
types, so an operator's own shell would keep a dead run looking alive.

**No pid liveness.** `plan.md` already refused it and the refusal stands. The column is
NULL for every row `run_task` has ever written, so there is nothing to check; and if there
were, `kill(pid, 0)` answers *some process exists*, which after a reboot is somebody
else's process. What a beat proves is narrower and true: a named supervisor was still
executing at a stated second.

**The beat is the supervisor's liveness, and that is the whole of its job.** An agent that
hangs under a supervisor that is fine is already handled — `Limits.idle` kills a child that
has gone quiet, `Limits.wall` kills one that has run long, and both are enforced in
`supervise`. This mechanism exists for the single case nothing else can reach: the watcher
is gone, so no clock in the process is running any more.

**Stale is ten missed beats, and the number is a constant.** 30 seconds between beats, 5
minutes of silence before a run is suspected. It is derived, not configured: the operator
already owns two clocks over a run — the task's `wall_secs` and the template's — and a
third knob could be set below them, which would close runs that are merely long. The
figures here are properties of the mechanism, and they live where `TOUCH_INTERVAL`,
`INTERVAL` and `POLL` live, which is in the code that beats and sweeps.

**Suspicion is confirmed before it is acted on, by the same process, two beat intervals
apart.** This is the part that makes the whole thing safe on a laptop. Suspend freezes the
beating thread and the wall clock does not stop, so a machine resuming after eight hours
has a live run whose last beat reads eight hours old — and a sweeper acting on one reading
would close it. Instead a stale row is *remembered* on the pass that first sees it and
swept only if it still reads stale 60 seconds later, by which time a resumed supervisor has
beaten again and is forgotten. The memory is in the loop, beside `Announced` and `Rhythm`,
for the reason those are: an edge with nothing in the database to be the edge of belongs
to the process that watches for it.

It follows that **only `wecode loop` sweeps**. A one-shot `wecode tick` has one pass and
was not there to hear the silence, so it may not judge it. This is not a gap: the loop is
what an operator restarts after a crash, and the rows the crash left are closed about a
minute into the next one.

**Where the code goes, because the ratchet has already decided.** `spawn.rs` is at 1600
lines against a limit of 1600 and takes no `Store` on purpose; `exec.rs` is at 1598. So the
beating thread is a new module — `claim.rs`, holding a `Beat` guard and the existing
`Claim` moved out of `exec.rs` beside it. The two are the same object: what one dispatch
holds while it runs, released by `Drop`. Moving `Claim` is what buys the lines to call
`Beat`. The decision itself — which rows are stale, given a clock — is a pure function in
`scheduler.rs` returning what *would* be closed, exactly as `transitions` does, so it is
testable without a database and the caller records each close before making it.

## What the sweep does, and what it must never do

| | |
|---|---|
| the execution row | closed `canceled`, detail naming the last beat. `Canceled` is the true one of the eight — stopped by us — where `failed` would say the agent failed, which nobody observed |
| `ended` | the last beat, not the moment of the sweep. Otherwise a row records as elapsed work a silence nobody was watching, and `wall_secs` stops meaning what it means everywhere else |
| the spend | NULL, on the rule the column already carries. Nothing read a count out of that run, and `0` would claim it ran for free |
| the task | `failed`, and only if it is still `running` and this was its latest attempt. `Failed` is *attempted, a person decides what happens next*, which is exactly the situation; it is also a dead end, so dependents stop waiting on work that will not arrive |
| the process | nothing is killed. An orphaned agent may still be writing in that tree, and the only handle to it is a pid that may since have been reused — killing the wrong process on the operator's machine is unbounded harm |
| the worktree | left standing, with its path on the record. Teardown on the absence of evidence destroys work |
| the queue | nothing is re-dispatched. `failed` is not schedulable, and a retry is a person's call precisely because the tree may hold half-finished work |

The rule underneath the last three rows: this acts on an *absence* of evidence, and the
strongest thing anyone may do on an absence is write down that they no longer know.

One consequence is worth naming rather than discovering. A sweep can be wrong — a
supervisor frozen past the confirmation window comes back, finishes its run, and writes
`finish_execution` and a real verdict over both rows. That is the correct ordering and the
build must keep it: the sweep's verdict is provisional, and a supervisor that returns
outranks it, because it has evidence and the sweep had none.

## What records it, and what the operator sees

The task's move to `failed` goes through `notify::on_status_change`, which is the single
entry point every status write already uses — so the operator gets the message on the
phone they were reading the board from, without this feature owning a notifier of its own.
The loop prints one line per swept run. The execution row carries the account: `canceled`,
the last beat, the worktree to go and look at. No new ledger action beyond a
`Source::Supervisor` observation on the run, because the row *is* the record and a second
copy is a second thing to keep in agreement.

Before the sweep confirms anything, a run whose beat has stopped is already worth showing
as such: the cockpit's agents panel and `wecode show` mark it stale rather than drawing it
as an agent at work. That is the honest state — *we have stopped hearing from this* — and
it is available five minutes before the verdict is.

There is no `wecode sweep`. Nothing addresses this, so there is nothing to authorise, which
is a better answer than a command no seat may call. The operator's manual path already
exists and is already printed by `contended`: `wecode status <id> ready`.

## Deliberately not this

A hand-started task — `wecode start`, worked in somebody's own session — writes `running`
and opens no attempt at all, so there is no row, no supervisor and no beat. It is never
swept. Nobody ever claimed to be watching it, and the operator who typed `start` and went
to lunch must not have the task taken out from under them.

The single-scheduler lock in `plan.md`'s crash-recovery note is not what was built, and the
line saying *no heartbeat* is superseded by this document — the *no pid liveness check*
half of it is not. A lock makes startup deterministic and says nothing at all while it is
held, which leaves the case this exists for; and `wecode run` is reachable from a terminal
without any loop, so *holding the only lock means nothing else is running* is not true
today. `plan.md` is outside this task's write scope, so somebody who has it must correct
that bullet.

## What would show this was decided wrong

- **A swept row later overwritten by a returning supervisor.** The detail line makes these
  countable. A few are the price of the mechanism; a pattern of them means the
  confirmation window is short, and the fix is the window rather than the design.
- **Operators who stop running `wecode loop`** so the sweep cannot reach them. That would
  mean it is closing runs people believe in, and the honest response is to report staleness
  and close nothing.
- **A company that needs the threshold tuned.** Withholding the knob is a claim that 5
  minutes of supervisor silence means the same thing on every machine. A harness that
  legitimately blocks its supervisor longer than that would disprove it.
- **The beat becoming the busiest writer in the database.** One row per 30 seconds per run
  is nothing at five slots and a different question at fifty.
