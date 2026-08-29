# 001 — a run transition is written down before the side effect it authorises

**Task:** `rel-transition-journal` · **Branch:** `wecode/rel-transition-journal`
· **Target:** `master` · **User story:** US-01 — *a restart leaves no run in a state a
dead worker still owns*

Execution state is tracked in `report_as_finished.md`. This document is the contract.
The argument for every choice below is in `docs/wecode/rel-transition-journal/design.md`
and is not repeated here.

## 1. Requirement summary

A dispatch's steps write an intent row before acting and settle it after. A new
`wecode reclaim` adjudicates unsettled intents by proving whether the wecode process that
wrote them is alive, and finishes what a dead one left. Closes the first P0 line of
`docs/design/maturity-roadmap.md`.

| Component | Lifespan | Responsibility |
|---|---|---|
| `run_journal` table (schema 12) | permanent | one row per step in doubt |
| `proc` identity reader | permanent | boot id, pid, start time — is this owner alive |
| `reclaim` | permanent | settle every unsettled intent whose owner is dead |
| journal calls in `commands::exec` | permanent | intent before the step, settlement after |

Out of this slice: journalling `merge`, `rollback` and the teardown hook (§6).

## 2. Architecture

C4 L3, three existing containers. `wecode-store` gains the table and its reads/writes;
`wecode-cli` gains `reclaim.rs` and the identity reader; `wecode-core` is untouched — an
intent is an operational fact, not a domain type. No new dependency: `/proc` is read with
`std::fs` and signalling reuses `spawn`'s existing `kill` shell-out. Diagrams are not
drawn in this repo, so this placement is the record of what was assumed.

## 3. Requirement details

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-01-01 | `run_journal` | Every step with an effect outside the database writes an intent row, committed, before the step runs. |
| FR-01-02 | `run_journal` | The intent names its resolve class: `redo`, `verify` or `refuse`. |
| FR-01-03 | `run_journal` | The intent carries host, boot id, and the owning wecode process's pid and start time. |
| FR-01-04 | `commands::exec` | The spawn intent carries a token; the token is laid into the child's environment as `WECODE_RUN`. |
| FR-01-05 | `commands::exec` | The child's pid — equal to its process-group id — and start time are written the moment `Command::spawn` returns. |
| FR-01-06 | `commands::exec` | Each step settles its intent with `done`, `undone` or `abandoned`. |
| FR-01-07 | `reclaim` | An intent whose owner is provably alive is left untouched. |
| FR-01-08 | `reclaim` | For a dead owner: kill the child group if its recorded identity still matches, commit the worktree as that attempt, close the run `canceled` with the crash as its cause, restore the task's prior status, leave the worktree standing. |
| FR-01-09 | `reclaim` | An orphan whose pid was never recorded is found by its token in `/proc/*/environ`. |
| FR-01-10 | `serve` | Runs `reclaim` once at startup, before the first pass. |
| FR-01-11 | `doctor` | Reports what `reclaim` would do and changes nothing. |
| FR-01-12 | ledger | Each reclaim is one `audit_log` row, `Source::Supervisor`, outcome `allow`. |

**Non-functional** — named by ISO/IEC 25010 characteristics.

| ID | Characteristic | Component | Requirement |
|---|---|---|---|
| NFR-01-REC-01 | Reliability / recoverability | `reclaim` | Repeating it changes nothing; an interrupted reclaim is completed by the next. |
| NFR-01-REC-02 | Reliability / fault tolerance | identity | Liveness is decided by proof, never by a timeout or heartbeat. |
| NFR-01-PERF-01 | Performance efficiency | `run_journal` | One insert and one update per step; under ten rows per run. |
| NFR-01-COMP-01 | Compatibility | schema | A version-11 database upgrades in place; existing rows are not backfilled. |
| NFR-01-MAIN-01 | Maintainability | all | Files stay under their `.max-lines` budget; `reclaim` is its own module. |
| NFR-01-PORT-01 | Portability | identity | A host without `/proc` degrades to `kill -0` plus the token, and says so. |

## 4. Acceptance criteria

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | A supervisor killed mid-run leaves a task that `reclaim` returns to its prior status, with the run `canceled` | FR-01-01, 06, 08 | drill: dispatch a slow fake agent, `kill -9` the supervisor, `wecode reclaim`, assert status and run |
| AC-2 | The orphaned agent is gone after `reclaim` | FR-01-05, 08 | same drill: the recorded group is no longer live |
| AC-3 | The worktree still stands and the attempt is committed | FR-01-08 | same drill: directory exists, `git log` shows `attempt 1` |
| AC-4 | A second `reclaim` prints nothing to do and writes nothing | NFR-01-REC-01 | same drill, run twice; store unchanged |
| AC-5 | An intent whose owner is alive is untouched | FR-01-07 | drill: journal an intent naming the test's own process; assert nothing happens |
| AC-6 | An orphan whose pid was never recorded is still found | FR-01-09 | drill: settle no `child_pid`; assert the token scan finds and stops it |
| AC-7 | `doctor` reports the same runs and kills nothing | FR-01-11 | drill: crash, `doctor`, assert output names the run and the process survives |
| AC-8 | A version-11 database opens and upgrades | NFR-01-COMP-01 | `schema.rs` migration test, as for 10→11 |
| AC-9 | `wecode serve` after a crash dispatches the task again | FR-01-10 | drill: crash, `serve --once`, assert a second attempt starts |

## 4b. Interfaces — user and agent parity

| Action | User via | Agent via | Same gate? |
|---|---|---|---|
| settle runs a dead supervisor left | `wecode reclaim` | `wecode reclaim` | yes |
| see what would be settled | `wecode doctor` | `wecode doctor` | yes |
| see a run's steps and their doubt | `wecode show <task>` | `wecode show <task>` | yes |
| have it happen unattended | `wecode serve` at startup | same | yes |

No signature gate on any of them: a restart cannot wait for one, and the ledger row is
what makes the act accountable after the fact.

## 5. Technical component details

**Table.** As in the design's `run_journal` block: identity columns, `step`, `resolve`,
`target`, `token`, `opened`/`settled`/`outcome`, no foreign key on `task_id`, and a
partial index on the unsettled rows. Nullable `exec_id`, because `prepare` runs before the
execution row exists.

**Step names** are a fixed enumeration — `prepare`, `spawn`, `commit`, `verdict`,
`reclaim` — parsed like `ExecutionStatus`, so an unknown value is `StoreError::Corrupt`
rather than a silent skip.

**Identity** is `boot_id` from `/proc/sys/kernel/random/boot_id` plus field 22 of
`/proc/<pid>/stat`. A differing boot id settles the question without reading anything
else.

**Ordering in `run_task`**: intent → step → settlement, at each of the four steps, with
`Claim` kept as the fast path for the ordinary `?` returns.

**Configuration.** Nothing here is tunable, so nothing is added to `company.toml`: the
enumerations above are code because they are a protocol between two functions in this
crate, not data an operator owns.

## 6. Out of scope

| Not done | Owner |
|---|---|
| journalling `merge`, `rollback`, teardown hooks | the next slice; the table takes them unchanged |
| resuming a run rather than settling it | never — the supervisor holds the pipe, meter and clock |
| distributed workers on another host | P2 `Scale`; `host` is recorded now so the row survives that change |
| a sandbox provider | the parallel P0 `Isolation` line |

## 7. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | wecode runs on Linux with `/proc` | NFR-01-PORT-01's fallback applies; macOS needs `ps -o lstart=` |
| A2 | The agent runs as the same uid, so `/proc/*/environ` is readable | FR-01-09 fails silently; the pid path still covers every recorded spawn |
| A3 | WAL `synchronous=NORMAL` is durable against process death | a lost row costs a hint, not correctness — see the design |
| A4 | At most one supervisor per run, since `serve` dispatches synchronously | unchanged: liveness is per-owner, so more supervisors is already handled |

## 8. Decisions

| Decision | Justification | Reference |
|---|---|---|
| A separate table, not `audit_log` | journal rows are retractable; ledger rows are evidence | design §*The journal* |
| A separate table, not columns on `task_executions` | the first step predates that row | design §*The journal* |
| Proof of liveness, not a heartbeat | a threshold's false death puts two agents in one worktree | design §*Naming the owner* |
| Kill the orphan, do not adopt it | its meter, clock and pipe died with the parent | design §*What a restart does* |
| Settle as `canceled`, not `failed` | stopped from outside; A2A keeps those apart | `wecode-core/src/execution.rs` |
| `reclaim` acts, `doctor` only reports | the split `teardown` already draws | `wecode-cli/src/teardown.rs` |
| No signature gate | a restart cannot wait for one | §4b |

## 9. References

**Project** — `docs/wecode/rel-transition-journal/design.md` (the argument);
`docs/design/maturity-roadmap.md` P0 *Reliability*; `docs/design/method.md` on the
handoff being the only channel; `docs/design/ax.md` for §4b; `specs/README.md` for this
document's shape.

**Published** — ISO/IEC 25010 for the NFR characteristic names, used as a vocabulary
only; ISO/IEC/IEEE 29148 for the FR/AC structure. Neither is claimed as conformance.
