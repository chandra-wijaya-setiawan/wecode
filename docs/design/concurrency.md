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
