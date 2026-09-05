# 002 — A run whose heartbeat lease expires is reclaimed as failed

**Task:** #405 `rel-dead-worker-lease` · **Branch:** `wecode/rel-dead-worker-lease` ·
**Target:** `master`

Execution state is tracked in `report_as_finished.md`. This document is the contract. The
decision it implements is `docs/wecode/rel-dead-worker-lease/design.md`; where the two
disagree, the design is the record of what was signed and this is what the build is held
to.

## 1. Requirement summary

A supervised run holds a **lease** — a named holder and a stated term, written on its
execution row and renewed while a supervisor is there to renew it. An expired lease,
confirmed by a stamped suspicion and a continuity witness, is reclaimed by **any** wecode
process: the row closes `canceled` with cause class `transient`, the task moves to
`failed`, and a supervisor that returns may finish its own row but may not write the
task's status.

Permanent. Two columns, one renewal guard extended, one pure decision function, one
fenced write. No scaffolding.

**What forced it.** `heartbeat-cleans-stalled-agents` put the deadline in the reader, left
the row unowned, and kept suspicion in `scheduler::Suspects` — so only a live `wecode
loop` can reclaim, and on 4–5 Sep a loop that died with its session left two runs orphaned
for five hours. This is the P0 reliability line *reclaims dead workers*, and both
`rel-transition-journal` and `rel-recover-command` are designed against it.

**Out of this slice's delivery scope:** retrying a reclaimed task, `/proc` identity proof,
orphan-process cleanup, worktree teardown, hand-started tasks — see §6.

## 2. Architecture

C4 L3, unchanged crate graph. `wecode-store` gains two columns on `task_executions` and a
fenced renewal/reclaim pair; `wecode-cli/claim` gains the lease guard in place of the bare
beat and the reclaim caller; `wecode-cli/scheduler` gains the pure expiry decision. No new
crate, no new dependency, nothing in `wecode-core` beyond the cause class
`recovery-mechanism` introduces, nothing in `wecode-gov`.

Assumed placement, since no C4 drawing covers the loop: reclamation is supervisor-side
bookkeeping in the same band as the tick, and is not an actor in the Broker's
authorisation path.

L4 constraint that shapes the layout: `commands/exec.rs` stands at 1682 against the 1700
in `.max-lines`, so the reclaim caller goes in `claim.rs` (310) beside the guard it fences
against, and the decision goes in `scheduler.rs` (824) beside `stale`, which it replaces.

## 3. Requirement details

Provisional and slice-local.

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-02-01 | store | `task_executions` gains `lease_owner TEXT` and `lease_secs INTEGER`. Schema `VERSION` is the next after `recovery-mechanism`'s; the migration adds both columns and backfills nothing |
| FR-02-02 | store | `start_execution` writes the dispatching process's `lease_owner` and the default term, so an open row is never unowned or untermed |
| FR-02-03 | store | Renewal is fenced: it stamps `beat` and clears the suspicion only `WHERE id = ? AND lease_owner = ?`, and reports whether it matched |
| FR-02-04 | store | Reclamation is fenced the same way: a reclaimer takes the lease under its own name and short term before writing any verdict |
| FR-02-05 | store | A `#[doc(hidden)]` helper backdates a lease, as `backdate_session` does, so expiry is testable without sleeping |
| FR-02-06 | cli/claim | `lease_owner` is `host/boot/pid/start` — the identity `rel-transition-journal` settled — as opaque text. This slice reads no `/proc`; off Linux a per-process random id serves |
| FR-02-07 | cli/claim | The guard renews every `BEAT` under its own owner token; a renewal that fails the fence stops the guard and is not retried |
| FR-02-08 | cli/scheduler | A pure function names the open rows whose lease has expired, given the rows and a clock: `beat + lease_secs < now`, with `NULL lease_secs` read as the 300-second default and `NULL beat` as `started`. Ages saturate |
| FR-02-09 | cli/scheduler | A pure function decides reclaimability from three stored inputs — the expiry, the suspicion stamp, and a continuity witness — with no process memory. `scheduler::Suspects` is removed |
| FR-02-10 | cli/scheduler | The continuity witness is any beat-bearing row whose renewals bracket the suspicion window with no gap wider than one renewal interval. Absent a witness, the pass stamps and reclaims nothing |
| FR-02-11 | cli/claim | A first expiry stamps the suspicion; a renewal clears it |
| FR-02-12 | cli | Reclamation is reachable from any wecode process that runs a pass, not only `wecode loop` |
| FR-02-13 | cli/claim | A reclaimed row closes `canceled` with cause class `transient`, `ended` at the last renewal, spend and replay NULL, and a detail naming the holder, the missed deadline and the worktree |
| FR-02-14 | cli/claim | Its task moves to `failed` — only if still `running`, and only for the task's latest attempt — through `notify::on_status_change` |
| FR-02-15 | cli/claim | Reclamation kills no process, removes no worktree, reverts nothing and re-dispatches nothing. No retry is issued here |
| FR-02-16 | cli, store | A supervisor whose lease was reclaimed may still finish its own execution row with its real verdict; it may not write the task's status |
| FR-02-17 | cli | A task `running` with no execution row — `wecode start` — holds no lease and is never reclaimed |
| FR-02-18 | cli/tui, cli/render | An open run past its deadline is shown as stale wherever open runs are shown, with its holder and deadline, before anything is reclaimed |

**Non-functional**

| ID | Component | Requirement |
|---|---|---|
| NFR-02-SAF-01 | cli/scheduler | No live run is reclaimed on a single reading, and no reclamation happens on a pass that cannot show a continuity witness. A machine resuming from suspend loses nothing |
| NFR-02-SAF-02 | cli | No decision in this slice depends on a pid being live. `lease_owner` is compared for equality only |
| NFR-02-SEC-01 | gov | No seat, grant or command gains an addressable path to reclamation; it is a consequence of a pass |
| NFR-02-REL-01 | cli/claim | Reclamation is idempotent and safe under concurrency: two passes cannot both close a row, and a missed pass delays a close rather than losing one |
| NFR-02-REL-02 | cli/claim | A single failed renewal write is survivable — the term is ten intervals |
| NFR-02-PERF-01 | store | One write per renewal interval per in-flight run, unchanged from the beat |
| NFR-02-OBS-01 | cli | The execution row is the whole record: who held it, when it was last renewed, what it missed, and which tree to look at |
| NFR-02-MNT-01 | cli | `commands/exec.rs` ends the slice no taller than it started; `bash scripts/max-lines.sh` passes |

## 4. Acceptance criteria

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | A supervised run's row carries an owner and a term, and its beat advances | FR-02-01, FR-02-02, FR-02-07 | end-to-end in `tests/cli.rs` over a fixture agent that outlives one interval |
| AC-2 | A backdated lease, suspected on one pass and still expired on a later one with a witness, is closed `canceled` with `ended` at the last renewal and NULL spend | FR-02-05, FR-02-08, FR-02-11, FR-02-13 | two passes over a backdated row; row read back from the store |
| AC-3 | Its task reads `failed`, the cause class is `transient`, and the notify hook fired once | FR-02-14 | the same run, with a hook recording what it was sent |
| AC-4 | A row that expires once and is renewed before the confirming pass is not reclaimed, and its suspicion is cleared | FR-02-09, FR-02-11, NFR-02-SAF-01 | unit test over the pure decision plus a loop test that renews between passes |
| AC-5 | A pass with no continuity witness across the window reclaims nothing | FR-02-10, NFR-02-SAF-01 | unit test with a witness trail holed at the window |
| AC-6 | Two concurrent passes over one expired row produce exactly one close | FR-02-04, NFR-02-REL-01 | store-level test racing two reclaims on one id |
| AC-7 | A supervisor whose lease was reclaimed finishes its row with the true verdict and leaves the task `failed` | FR-02-16 | store-level test: reclaim, then `finish_execution` on the same id |
| AC-8 | A one-shot process that is not `wecode loop` reclaims an expired, witnessed, suspected row | FR-02-12 | CLI test |
| AC-9 | The worktree still stands, no process was signalled, and nothing was re-dispatched | FR-02-15 | filesystem and plan assertions after AC-2 |
| AC-10 | A task marked `running` by `wecode start` survives any number of passes | FR-02-17 | CLI test |
| AC-11 | A database at the previous version opens at this one with existing rows intact, no invented owners and no invented terms | FR-02-01 | store migration test |
| AC-12 | An open run past its deadline is labelled stale, with its holder, before any reclamation | FR-02-18 | renderer test over a backdated row |
| AC-13 | `grep -rqi 'lease' crates/wecode-store/src/` exits 0 | FR-02-01 | the task's own acceptance command |

## 4b. Interfaces — user and agent parity

| Action | User via | Agent via | Same gate? |
|---|---|---|---|
| See who holds a run and until when | cockpit agents panel, `wecode board` | `wecode show <task>` — the same execution rows | read-only both |
| See that a lease has expired | the same surfaces, marked stale | the same `beat`/`lease_secs` on the same rows | read-only both |
| Learn that a run was reclaimed | notification hook, then `failed` on the board | task status and the `canceled` row with its detail | same fact, same record |
| Hand a reclaimed task back | `wecode status <id> ready` | the same command | same Broker check |
| Trigger a reclamation | deliberately none | deliberately none | nothing addressable, so nothing to authorise — §8 |

## 5. Technical component details

**The columns.** `lease_owner TEXT` and `lease_secs INTEGER`, both nullable, on the terms
`beat` already carries: absent is a real state. NULL on an open row means the row predates
this slice — reclaimable, and unfenced, because there is no name to fence on. Expiry is
`beat + lease_secs`, computed by the reader from what the holder wrote, so there is no
second timestamp to disagree with the first.

**The guard.** The existing `Beat` becomes the lease holder: same thread, same interval,
but the renewal carries the owner token and reports whether it matched. A guard that loses
the fence stops rather than writing again — that is how a returning supervisor learns its
run was reclaimed.

**The decision.** Expiry and reclaimability are both pure functions in `scheduler.rs`
taking rows and a clock, as `transitions` and `stale` do, so the whole window rule is
testable without a database or a sleep. `Suspects` goes: its job moved into the store when
`recovery-mechanism` landed the suspicion stamp.

**Constants.** `BEAT = 30s` and a default term of `10 × BEAT` stay in `claim.rs` beside
`INTERVAL` and `TOUCH_INTERVAL`, and not in `company.toml` — see §8. The confirmation
window is one renewal interval measured against the stamped suspicion.

## 6. Out of scope

| Not this slice | Whose it is |
|---|---|
| Retrying a reclaimed task | `recovery-mechanism`'s ladder, from the cause class and the attempt count, bounded |
| `/proc` identity proof, and killing the child group | `rel-transition-journal`, which lands after this and upgrades this verdict where it has proof |
| Reconstruction at startup | `rel-recover-command` |
| Removing the reclaimed run's worktree | `teardown`, or the operator via `wecode worktree remove` |
| A task `running` with no execution row | the operator who typed `start`; nobody claimed to be watching it |
| Exposing `lease_secs` as a per-template knob | withheld, though the mechanism now permits it — §8 |
| Amending `docs/design/liveness.md` and `plan.md` | whoever holds them in scope; both are outside this task's |

## 7. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | `recovery-mechanism` lands its stored suspicion before this slice | This slice would have to add the column itself, and the two designs would own one fact |
| A2 | The renewing and reclaiming processes share a wall clock that does not step backwards | A backwards step reads as fresh, because ages saturate, so reclamation is delayed rather than made wrong |
| A3 | Suspend freezes the whole machine, so a sleeping laptop leaves a gap in every beat-bearing row | This is what the continuity witness rests on; a process that beat through a suspend would defeat it, and AC-5 is where that would show |
| A4 | SQLite serialises the fenced update, so the compare-and-swap is a real one | AC-6 is the test; without it two passes could both close a row |
| A5 | `finish_execution` keeps overwriting a closed row | FR-02-16 depends on it |
| A6 | The identity triple is stable for a process's lifetime | If it is not, a supervisor fences itself out of its own run and AC-1 fails |

## 8. Decisions

| Decision | Justification | Reference |
|---|---|---|
| The term is on the row, not in the reader | The holder states its own terms; two builds over one database cannot disagree about when a run died | design §The decision |
| One timestamp and a term, not two timestamps | Two copies of a deadline with no check between them is the defect, whatever the format | design §The decision |
| `lease_owner` is the journal's identity triple, adopted early | One identity scheme across the reliability project; opaque here, proven later | design §The decision |
| Suspicion is stored, not remembered | A scheduled pass has no memory, and a dead loop reclaimed nothing for five hours | `docs/design/recovery.md` |
| A continuity witness, not a second process-local reading | A wall clock stops over suspend; a beat trail shows the gap for the same seconds | design §Expiry is not evidence |
| Any process may reclaim | The terms are on the row, so nothing about the verdict is one process's to hold | supersedes `heartbeat-cleans-stalled-agents` §only the loop sweeps |
| The task lands `failed`, not `ready` | This acts on silence, not proof. `rel-transition-journal`'s `reclaim` has proof and may re-arm; this may not | design §What reclamation writes |
| A returning supervisor keeps its row and loses the task | Its account of the run is better evidence; its authority over a task that may have been retried is gone | amends spec 011 FR-11-15 |
| Nothing killed, removed or re-queued | Unchanged from `heartbeat-cleans-stalled-agents`: the strongest move on an absence is to write down that we no longer know | that design §What the sweep does |
| No `wecode reclaim`-style command here, for user or agent | Nothing addressable means nothing to authorise; the manual path `contended` prints is unchanged | design, and §4b |
| The code goes in `claim.rs` and `scheduler.rs` | `commands/exec.rs` is 18 lines under the ratchet, and the fence belongs beside the guard it fences | `.max-lines`, NFR-02-MNT-01 |

## 9. References

Project documents: `docs/wecode/rel-dead-worker-lease/design.md` (the signed decision);
`docs/wecode/heartbeat-cleans-stalled-agents/design.md` and `specs/011-heartbeat/` (what
this supersedes and amends); `docs/wecode/rel-transition-journal/design.md` and
`specs/001-rel-transition-journal/` (the identity triple, and the proof that lands after);
`docs/design/recovery.md` (the ladder and the stored suspicion); `docs/design/liveness.md`
(the refusal this qualifies); `docs/design/ax.md` (§4b); `.max-lines`.

Published: the A2A task lifecycle, which supplies `canceled`. Leases and fencing tokens in
distributed systems supply the shape — a lease proves a holder was alive at a stated time
and never that it is alive now, and a holder that loses one must stop writing — and that
caveat is why reclamation confirms before acting and never kills.
