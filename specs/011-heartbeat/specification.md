# 011 — A heartbeat closes runs whose supervisor is gone

**Task:** #<number> `heartbeat-cleans-stalled-agents` · **Branch:**
`wecode/heartbeat-cleans-stalled-agents` · **Target:** `master`

Execution state is tracked in `report_as_finished.md`. This document is the contract. The
decision it implements is `docs/wecode/heartbeat-cleans-stalled-agents/design.md`; where
the two disagree, the design is the record of what was signed and this is what the build
is held to.

## 1. Requirement summary

A wecode process supervising an agent writes a heartbeat onto that run's execution row
every 30 seconds. `wecode loop` closes any open row whose beat has been silent for 5
minutes — confirmed on a second reading a minute later — as `canceled`, and hands its task
to a person as `failed`. It kills nothing, removes nothing and re-queues nothing.

Permanent. No scaffolding: one column, one guard object, one pure decision function and
one caller.

**What forced it.** `Claim` gives a task back on every exit the supervisor executes; the
exits that execute nothing — `kill -9`, a closed laptop, WSL restarting under the loop —
leave a row saying `working` for ever. The task holds an open-item slot, `contended`
refuses the next dispatch because the row is open, and the cockpit draws the dead run as
an agent at work. An operator reading the board from a phone cannot tell that picture from
a real one.

**Out of this slice's delivery scope:** retry of a swept task, orphan-process cleanup, a
configurable threshold, hand-started tasks with no execution row — see §6.

## 2. Architecture

C4 L3, unchanged crate graph. `wecode-store` gains one column and two calls;
`wecode-cli` gains one module, `claim`, holding the new `Beat` guard and the existing
`Claim` moved out of `commands/exec.rs`; `scheduler` gains the pure staleness decision;
`commands/exec::serve` is the only caller that applies it. No new crate, no new
dependency, nothing in `wecode-core` or `wecode-gov`.

Assumed placement, since no C4 drawing covers the loop today: the sweep is a
supervisor-side bookkeeping step in the same band as the tick, and not an actor in the
Broker's authorisation path.

L4 constraint that shapes the layout rather than following it: `spawn.rs` stands at 1600
lines against the 1600 in `.max-lines` and takes no `Store` by design, and
`commands/exec.rs` stands at 1598. The new module is what makes the change fit, and moving
`Claim` into it is what buys the lines to call `Beat`.

## 3. Requirement details

Provisional and slice-local.

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-11-01 | store | `task_executions` gains `beat INTEGER` — the second a supervisor last reported. Schema `VERSION` 14, with a migration that adds the column and backfills nothing |
| FR-11-02 | store | `start_execution` writes `beat = started`, so an open row is never without one |
| FR-11-03 | store | `Store::beat(id)` stamps now, and only on a row that is still open |
| FR-11-04 | store | A run can be closed at a stated instant rather than at now, so a swept row's `ended` and `wall_secs` end at the last beat |
| FR-11-05 | store | A `#[doc(hidden)]` backdating helper, as `backdate_session` is, so staleness is testable without sleeping |
| FR-11-06 | cli/claim | A `Beat` guard beats its row every 30s from the moment a run is supervised until it is dropped, on its own thread, without blocking `supervise` |
| FR-11-07 | cli/claim | `Claim` moves here from `commands/exec.rs` unchanged in behaviour |
| FR-11-08 | cli/scheduler | A pure function names the open `working` rows whose beat is older than the silence threshold, given the rows and a clock. `NULL` beat on an open row reads as `started` |
| FR-11-09 | cli/scheduler | A run is only swept when it read stale on two passes at least two beat intervals apart within one process; the memory of the first reading is held by the loop |
| FR-11-10 | cli/exec | `wecode loop` sweeps once per pass, before promotion, so the queue is honest before anything is taken from it |
| FR-11-11 | cli/exec | A swept row is closed `canceled`, `ended` at its last beat, spend and replay NULL, with a detail naming the silence and the worktree |
| FR-11-12 | cli/exec | Its task moves to `failed` — only if still `running`, and only for the task's latest attempt — through `notify::on_status_change`, so the operator is told wherever they are |
| FR-11-13 | cli/exec | The sweep is recorded as a `Source::Supervisor` observation on the run. No new ledger action kind, and no second record of the same event |
| FR-11-14 | cli/exec | The sweep kills no process, removes no worktree, reverts nothing, and re-dispatches nothing |
| FR-11-15 | cli/exec | A supervisor that returns after its run was swept writes its own verdict over both the row and the task status |
| FR-11-16 | cli | `wecode tick` does not sweep, and no command triggers a sweep |
| FR-11-17 | cli | A task that is `running` with no open execution row — `wecode start`, worked by hand — is never touched |
| FR-11-18 | cli/tui, cli/render | An open run whose beat is stale is shown as stale wherever open runs are shown, before any sweep confirms it |

**Non-functional**

| ID | Component | Requirement |
|---|---|---|
| NFR-11-SAF-01 | cli/scheduler | No live run is closed on a single reading. A machine resuming from suspend, whose beats resume within one interval, loses nothing |
| NFR-11-SAF-02 | cli/exec | No decision in this slice depends on a pid, and none may be added: `plan.md`'s refusal of pid liveness stands |
| NFR-11-SEC-01 | gov | No seat, grant or command gains a path to the sweep; it is a consequence of the tick and is not addressable |
| NFR-11-REL-01 | cli/exec | The sweep is idempotent: a missed pass delays a close, it cannot lose or double one |
| NFR-11-REL-02 | cli/claim | A failed beat write is survivable — the threshold is ten intervals, so single write errors are absorbed rather than reported |
| NFR-11-PERF-01 | store | One write per 30s per in-flight run, and never one per supervise poll (100 ms) |
| NFR-11-OBS-01 | cli/exec | The execution row is the whole record: what happened, when it was last heard from, and which tree to go and look at |
| NFR-11-MNT-01 | cli | `spawn.rs` and `commands/exec.rs` end the slice no taller than they started; `bash scripts/max-lines.sh` passes |

## 4. Acceptance criteria

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | A supervised run's row carries a beat that advances while the agent runs | FR-11-01, FR-11-02, FR-11-06 | end-to-end in `tests/cli.rs`: a fixture agent that sleeps past one interval, beat read back later than `started` |
| AC-2 | A row backdated past the threshold is closed `canceled` by the loop, with `ended` at its last beat and NULL spend | FR-11-04, FR-11-05, FR-11-08, FR-11-11 | `wecode loop` driven twice over a backdated row; row read back from the store |
| AC-3 | Its task reads `failed` afterwards, and the notify hook fired once | FR-11-12 | the same run, with a hook that records what it was sent |
| AC-4 | A row that reads stale once and is beaten again before the confirming pass is not swept | FR-11-09, NFR-11-SAF-01 | unit test over the pure decision plus its memory, and a loop test that beats between passes |
| AC-5 | The worktree still stands, no process was signalled, and the task was not re-dispatched | FR-11-14 | filesystem and plan assertions after AC-2 |
| AC-6 | A supervisor finishing after its run was swept leaves the true verdict on the row and the task | FR-11-15 | store-level test: sweep, then `finish_execution` on the same id |
| AC-7 | A single `wecode tick` over a stale row changes nothing | FR-11-16 | CLI test |
| AC-8 | A task marked `running` by `wecode start`, with no execution row, survives any number of passes | FR-11-17 | CLI test |
| AC-9 | A database at version 13 opens at 14 with existing rows intact and no invented beats | FR-11-01 | store migration test |
| AC-10 | An open run whose beat has stopped is labelled stale in the cockpit and in `wecode show` | FR-11-18 | renderer test over a backdated row |

## 4b. Interfaces — user and agent parity

| Action | User via | Agent via | Same gate? |
|---|---|---|---|
| See that a run is in flight | cockpit agents panel, `wecode board` | `wecode show <task>` — the same execution rows | read-only both |
| See that a run has gone quiet | the same surfaces, marked stale | the same `beat` field on the same rows | read-only both |
| Learn that a run was swept | notification hook, then `failed` on the board | task status and the `canceled` row with its detail | same fact, same record |
| Hand a stuck task back | `wecode status <id> ready`, as `contended` already prints | the same command | same Broker check |
| Trigger a sweep | deliberately none | deliberately none | nothing is addressable, so there is nothing to authorise — see §8 |

## 5. Technical component details

**The column.** `beat INTEGER`, nullable, beside `pid` and on the same terms as
`spent_tokens`: absent is a real state, not a zero. On an *open* row it means the row
predates this slice or was written by a wecode that does not beat, and is read as
`started`; on a closed row it is history. `record_execution` — a cost stated after the
fact — never sets it and is never swept, because it is closed at insert.

**The guard.** `Beat::start(&store, exec_id)` spawns a thread that stamps the row and then
waits on a channel with a 30-second timeout; `Drop` closes the channel and joins. A thread
rather than a hook inside `supervise` because `spawn` deliberately knows nothing about the
store, and because the beat must keep going while the child is silent — an agent thinking
for ten minutes is not a dead supervisor, and coupling the beat to output would say it was.

**The decision.** `scheduler::stale(runs, now, silence) -> Vec<&Execution>` is pure and
returns what *would* be closed, as `transitions` does. The confirmation lives with the
caller: the loop keeps the ids it saw stale and the monotonic instant it saw them, and acts
on the second sighting two intervals later. Held in memory beside `Announced` and `Rhythm`,
which are there for the same reason — an edge with nothing in the database to be the edge
of belongs to the process watching for it.

**Constants.** `BEAT = 30s`, `SILENCE = 5min`, confirmation at `2 × BEAT`. In code, beside
`INTERVAL` and `TOUCH_INTERVAL`, and not in `company.toml`: see §8.

## 6. Out of scope

| Not this slice | Whose it is |
|---|---|
| Retrying a swept task automatically | the retry slice in `plan.md` — bounded, with a stop in front of a person |
| Killing an orphaned agent process | nobody, deliberately: the only handle is a pid that may have been reused |
| Removing the swept run's worktree | `teardown`, after the work has become evidence, or the operator via `wecode worktree remove` |
| A task `running` with no execution row (`wecode start`) | the operator who typed `start`; nobody claimed to be watching it |
| A configurable silence threshold | withheld on purpose — §8 |
| Runs supervised on another machine | out of the model entirely: a beat is one host's clock on one database file |
| The `plan.md` crash-recovery bullet, which this supersedes in part | whoever holds `plan.md` in scope; it is outside this task's |

## 7. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | The beat writer and the sweeper share a wall clock, and it does not step backwards | A backwards step makes a beat read as future-dated; ages are computed saturating, so it reads fresh and the sweep is delayed rather than made wrong |
| A2 | Suspend freezes the beating thread and the sweeper together | Covered anyway by the confirmation pass, which is the mechanism that exists for this case |
| A3 | A std thread beating every 30s survives while the main thread blocks in `spawn::run` | If it does not, runs are swept while alive — the confirmation window would need to be widened and AC-4 would catch it |
| A4 | SQLite write contention between beats, the loop and verifying tasks is negligible at five slots | A lost beat costs one of ten; a persistent stall would show as false sweeps, and the answer is a longer interval, not a shorter one |
| A5 | `finish_execution` will keep overwriting a closed row | FR-11-15 depends on it; a store that refuses to reopen a closed row would make the sweep's verdict final, which is the opposite of what was decided |

## 8. Decisions

| Decision | Justification | Reference |
|---|---|---|
| The supervisor beats, not the agent | An agent's account of itself is inadmissible everywhere else here, and most harnesses cannot be asked | design §The decision |
| Not the session's `last_seen` | A session is a connection, not a unit of work; the operator's own shell would keep a dead run looking alive | `store/session.rs` module note |
| No pid liveness | The column is NULL on every row `run_task` writes, and a pid after a reboot is somebody else's process | `plan.md`, crash recovery |
| Threshold and interval are constants, not config | The operator already owns two clocks over a run; a third could be set below them and would close runs that are merely long | design §The decision |
| Confirmed on a second reading | Suspend freezes the beat and not the wall clock, so one reading cannot tell frozen from dead | design §The decision |
| Only the loop sweeps | A one-shot process was not there to hear the silence it would be judging | design §The decision |
| The execution closes `canceled`, the task goes `failed` | *Stopped by us* is the true one of A2A's eight; `failed` is *attempted, a person decides*, and is a dead end so dependents stop waiting | `core/execution.rs`, `core/common.rs` |
| Nothing is killed, removed or re-queued | The sweep acts on an absence of evidence, and the strongest move on an absence is to write down that we no longer know | design §What the sweep does |
| No `wecode sweep` command, for user or agent | Nothing addressable means nothing to authorise, which is a better answer than a command no seat may call; the manual path `contended` already prints is unchanged | design, and §4b |
| A new `claim` module rather than growing `exec.rs` | Both files are at or one line under the ratchet, and `Claim` and `Beat` are the same object: what one dispatch holds while it runs | `.max-lines`, NFR-11-MNT-01 |

## 9. References

Project documents: `docs/wecode/heartbeat-cleans-stalled-agents/design.md` (the signed
decision); `docs/design/ax.md` (§4b); `docs/design/method.md` (why the design travels as a
document); `plan.md` (crash recovery, retry); `.max-lines` and `scripts/max-lines.sh`;
`docs/adr/0006-story-owns-the-worktree.md` for what a swept run leaves standing.

Published: the A2A task lifecycle, which `ExecutionStatus` mirrors and which supplies
`canceled`. Leases and failure detection in distributed systems supply the shape — a lease
proves a holder was alive at a stated time and never that it is alive now — and that
caveat is exactly why the sweep confirms before acting and never kills.
