---
class: hand-tended-state
subject:
  - "crates/wecode-cli/src/commands/exec.rs"
  - "crates/wecode-cli/src/scheduler.rs"
---
# Concurrency must be A2A-shaped

CONSTRAINT FROM THE OWNER (2 Sep 2026), before any code:

wecode already speaks A2A, and A2A is asynchronous by design — the eight
states in `wecode_core::execution::ExecutionStatus` (submitted, working,
input-required, auth-required, completed, canceled, failed, rejected) are
A2A's own. Concurrency must be expressed IN that model, not bolted beside it.

What that forbids:
  - a thread pool whose members block in `spawn::run` and whose only record of
    a run is the thread's own stack. That is the current design with a wider
    neck, and it loses everything the moment the process dies.
  - any concurrency the store cannot see. If `wecode board` from another
    terminal cannot enumerate what is in flight, the loop is lying.

What it implies instead:
  - dispatch is `submitted` written to the store, and returns. The run's
    identity lives in `task_executions`, not in a JoinHandle.
  - a local subprocess harness still needs a supervisor per run (and now a
    beat — see docs/design/liveness.md), but the supervisor is the transport,
    never the record.
  - `input-required` and `auth-required` are why this matters: an async agent
    can stop and ask. A blocking dispatch has nowhere to put that question,
    which is exactly the "needs human" gap on the board.
  - a remote A2A agent is then the same shape with a different transport, and
    concurrency comes free rather than as a second mechanism.

Read: docs/design/liveness.md (the beat is per run, not per loop), ADR-0007
(hold is not competition), and the A2A state table in execution.rs.

## What the loop does now (3 Sep 2026)

`serve` opens one `std::thread::scope` around the whole loop and dispatches
every task the width allows in the same pass, each on a supervisor of its own.
A pass reaps the reports that have arrived, sweeps, promotes, reads replies and
tops the width back up — none of which waits on a run. Before this the queue
was drained one agent at a time, so `max_open_items = 5` bought one agent's
throughput and the number was decoration.

| Question | Answer, and where it is |
| --- | --- |
| What is the record of a run? | The `task_executions` row, opened before the agent starts and beaten while it lives. `wecode board` in another terminal enumerates it. |
| What is the thread, then? | Transport, and nothing else: `exec::Dispatch` says only which task this process is currently carrying. |
| Who owns a key? | One supervisor per task. `exec::triage` will not offer a `held` task, `scheduler::contended` refuses the dispatch already aimed at one. |
| Where does the width come from? | `scheduler::parallelism(max_open_items, cores)`, narrowed per pass by `exec::slots_free` — the union of `running` in the plan and what this loop is carrying, so another terminal's `wecode run` narrows the loop too. |
| Permit or claim first? | Permit. `slots` is the pass's whole allowance; the claim is taken inside the run. |
| What if a supervisor dies? | Nothing is re-attached. The row stops beating and `claim::sweep` closes it — unchanged, and now the reason a lost thread costs only the carrying. |

Not built, and deliberately named rather than implied:

  - **the interrupted slot class.** `input-required` and `auth-required` still
    have no way in from a local run, so there are two slot classes and not
    three. A question from an agent has nowhere to live until there is an
    inbox for the answer — which is the next task, not this one.
  - **`attempt` in the `WHERE` of every status write.** The fencing token
    exists and is unused; a returning zombie can still overwrite a verdict.
    `wecode-store` was outside this task's scope.
  - **the self-restarting drain.** Width is topped up on the next tick rather
    than the instant a slot frees, so a finished run costs up to
    `scheduler::INTERVAL` of idleness. Cheap to keep, cheap to change later.

Sharp edges that are real and bounded:

  - one SQLite writer at a time, and each supervisor opens its own connection.
    rusqlite sets a 5s busy timeout on every connection, and wecode's writes
    are single statements, so contention costs milliseconds — but a write that
    does time out fails that run and leaves its row to the sweep.
  - `git worktree add` and the shared build cache both serialise under the
    hood. Five agents on one repository are five checkouts and one `target/`,
    so cargo's own lock is the ceiling on parallel acceptance, not the width.

## What to copy, from source that ships (researched 2 Sep 2026)

Read before writing code. Every row was verified in primary source; the ones
marked *inference* were not.

### The core: a keyed coordinator, not a thread pool
`sst/opencode` `core/src/session/run-coordinator.ts` — `run(key)` / `wake(key)`
/ `interrupt(key)` / `active`. One owner per key; a second caller for the same
key **joins the first's completion handle** rather than starting anything. Its
own docstring: *"Serializes execution for each key while allowing different keys
to run concurrently."* That is precisely our shape — serial per task, parallel
across tasks.

Its `settle()` is the second half worth copying: a run that finishes while new
work was admitted **starts a successor for the same key immediately** instead of
returning to idle. A self-restarting drain, with no polling tick.

### The claim, in SQLite
SQLite 3.50.2 (what we link) has **no `SKIP LOCKED`** — verified, zero hits in
the amalgamation. Airflow's `SELECT … FOR UPDATE SKIP LOCKED` is unavailable and
also unnecessary: it solves multi-scheduler HA, which one dispatcher does not
have. The substitute:

    BEGIN IMMEDIATE;
    UPDATE task_executions SET status='working', …
     WHERE task_id=? AND attempt=? AND status='submitted'
    RETURNING …;

**The UPDATE's own row count is the claim.** Zero rows means somebody else took
it, and the loser stands down — which is what `scheduler::contended` already
says in words.

### `attempt` is already our fencing token
Temporal rejects any write whose token's `Attempt` disagrees with the server's
(`service/history/api/activity_util.go:68` → not found; an evicted worker's
heartbeat gets `ErrActivityTaskNotFound` and cancels itself locally). We have
`attempt` and `UNIQUE(task_id, attempt)` already. Every status write should
carry the attempt in its `WHERE`, so a returning zombie cannot overwrite the
verdict of the run that replaced it. Near-free, and it removes a whole class of
race we would otherwise discover in production.

### Permit before claim
Temporal acquires a slot permit *before* it polls, and binds the permit into the
task for its whole life (`ActivityTask._permit`), so it releases on every exit
path. Same here: take the semaphore permit, then attempt the claim — never the
reverse, or a claimed run waits for a slot while holding the row.

### Three slot classes, not two
A2A's `input-required` and `auth-required` are labelled **interrupted, not
terminal** in the proto. So the dispatcher needs: **running** (holds a slot),
**interrupted** (holds none, needs a wake), **terminal** (done). This is the
piece that makes an agent able to *stop and ask* — and the answer to the "needs
human" gap on the board, since a question from a run finally has somewhere to
live.

### The answer to a question is a durable row, not a live promise
a2a-python resumes a parked task by **re-invoking** the executor with state
re-read from the store (`active_task.py:523-525`); nothing about the paused call
is preserved. opencode does the opposite — `Question.ask` parks the fiber on an
in-memory `Deferred`, and **process death loses the question entirely**. A2A is
right and opencode is wrong, by opencode's own admission (`llm.ts:50-52` leaves
*"mark busy, retrying, idle, interrupted, or terminal-failure status durably"*
unchecked). Copy opencode's `session_input` inbox shape for the answer path, not
its `Question` module.

For us this is easy, because a local subprocess **cannot** be resumed anyway:
the only sane resume is a fresh subprocess handed the durable record.

### On startup, fail what you cannot re-attach to
opencode's `failInterruptedTools` (`llm.ts:119-139`) walks projected history at
run start and durably fails every tool still `running`, so *"abandoned side
effects are never silently replayed."* Our equivalent: sweep `working` rows
whose pid is dead → `failed`, detail "interrupted". **Do not re-attach.** And
per Airflow (`scheduler_job_runner.py:3665-3670`), re-read the row inside the
transaction before writing the failure — a run that just succeeded must not be
clobbered by the reaper.

### Where we are already ahead
Neither opencode nor a2a-python persists anything about an in-flight run — no
pid, no lease, no heartbeat; a2a-python has **no reaper at all**, so a task left
`working` stays `working` forever. Our `beat` + `pid` + `attempt` row is
strictly more than either. What we lack is only the coordinator.

### Calibration to check against Temporal
Temporal throttles heartbeats to **0.8 × the timeout** and coalesces, keeping
only the newest pending value. Ours beats every 30s against a 5-minute stale
threshold — a 0.1 ratio, ten missed beats. That was a deliberate choice for
laptop suspend (see liveness.md), and it is safe in the conservative direction,
but the coalescing is worth copying if a beat ever carries progress.

### Ergonomics
Both agent orchestrators ship **unbounded** fan-out: opencode has no width limit
at all (only `subagent_depth`, default 1), and a2a-python has no semaphore in
`src/a2a/server/`. Claude Code caps at 20 with a named error and an env
override; Temporal defaults to 100 slots per kind. A configured integer with a
specific refusal beats an implicit unbounded default — `[attention]
max_open_items` is that number, and as of the section above it means what it
says: the loop prints the width it resolved on the line it starts with, and
never has more agents than that working at once.

Held work occupies no slot and is not competition for a scope — the one honest way
to shrink the collision graph without archiving or deleting anything.

A seat that spends faster than its declared rate is cut off before its next
dispatch, not mid-run: the runaway is stopped at the door, and work already paid
for still finishes (Shopify's circuit breaker, [budgets] enforce stays off).
