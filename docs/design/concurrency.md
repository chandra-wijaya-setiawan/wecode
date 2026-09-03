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
max_open_items` is already that number, and after this change it will finally
mean what it says.

Held work occupies no slot and is not competition for a scope — the one honest way
to shrink the collision graph without archiving or deleting anything.
