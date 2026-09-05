# Reclaiming a run whose lease has expired

Status: **decided, not built**.

Notes for `rel-dead-worker-lease`, the second P0 line of the reliability project —
*restart reconstructs, **reclaims dead workers**, resumes*. It lands before
`rel-transition-journal` and before `rel-recover-command`, both of which are designed
against it. What the build step knows about this decision it knows from this file.

## What a beat cannot do

`heartbeat-cleans-stalled-agents` shipped `task_executions.beat` and a sweep, and it
closed the case it was built for. Three things it left are what this slice is:

| gap | consequence today |
|---|---|
| **The deadline is in the reader, not the row.** `SILENCE` is a constant in `claim.rs` | The holder cannot state its own terms, and two builds reading one database can disagree about when a run died |
| **The row does not name its holder.** A beat proves *somebody* was executing, not *who* | Reclamation cannot be fenced. A supervisor that returns after its run was closed writes over a task that may since have been retried |
| **Suspicion lives in `scheduler::Suspects`, in the loop's memory** | A dead loop reclaims nothing. On 4–5 Sep the loop died with its session and two runs sat orphaned for five hours — the exact failure the sweep exists to prevent, unreachable by the sweep |

## The decision: the run carries its own terms

**A supervised run holds a lease: a named holder and a term, both written on the row,
renewed while the supervisor is there to renew them.** Expiry is then a fact any reader
computes from the record rather than a verdict one process is entitled to.

| column | is | NULL means |
|---|---|---|
| `lease_owner TEXT` | who holds it: `host/boot/pid/start` | the row predates this slice — reclaimable, unfenced |
| `lease_secs INTEGER` | the term the holder claims, in seconds | the reader's default, which is today's 300 |
| `beat` | unchanged: the second of the last renewal | as it already reads — `started` |

Expired is `beat + lease_secs < now`, and there is no second timestamp to fall out of
agreement with the first. The term is stored rather than configured: the knob
`heartbeat-cleans-stalled-agents` withheld stays withheld, but the mechanism no longer
depends on withholding it, because a harness that legitimately blocks longer can take a
longer term without any reader being changed.

`lease_owner` is the identity triple `rel-transition-journal` already settled, as opaque
text. **This slice compares it for equality and never reads `/proc`** — it is entitled
to no proof, only to a name it can fence on. When the journal lands, the same token is
the thing its proof is checked against; one identity scheme, adopted early on purpose.
Off Linux, where there is no boot id, a per-process random id serves: equality is all
that is asked of it here.

## Expiry is not evidence

An expired lease says the wall clock passed a deadline. It does not say the holder is
gone — a laptop that slept for eight hours wakes with every lease expired and every
supervisor alive. So:

**An expiry is only acted on when a clock that did not stop agrees.** Two stamped facts
are required, and neither is held in a process:

1. **The suspicion** — the second an expiry was first seen, on the row, cleared by the
   next renewal. This is `recovery-mechanism`'s stored suspicion, not a second column;
   the whole reason that design demanded it is that a scheduled pass has no memory.
2. **A continuity witness** — some beat-bearing row in the workspace whose renewals
   bracket the suspicion window with no gap wider than one renewal interval. A machine
   that slept leaves that gap in its own `drivers` row for the same seconds, and so
   disqualifies itself; it re-stamps and reclaims nothing.

The witness is a record, not a process, and that is the point. `wecode loop` witnesses
with its `drivers` row; a `wecode recover` on a timer witnesses with the trail its own
passes leave. **Any wecode process may therefore reclaim**, which is what closes the
five-hour hole. A pass that finds no witness has learned something true — nobody was
awake — and waits a cycle.

## What reclamation writes

Reclamation takes the lease before it writes the verdict: `UPDATE … WHERE id = ? AND
lease_owner = ?`, the reclaimer naming itself with a short term. Two concurrent passes
cannot both close a row, and a run reclaimed twice is a no-op.

| | |
|---|---|
| the execution row | closed `canceled`, cause class **transient**, detail naming the holder, the deadline it missed and the worktree |
| the task | `failed` — and no retry here. `failed` is *attempted, a person decides*, and the recovery ladder decides afterwards from the cause class and the attempt count |
| `ended`, spend, the process, the worktree, the queue | exactly as `heartbeat-cleans-stalled-agents` fixed them: the last renewal, NULL, unsignalled, standing, untouched |

The rule under the last row is that one's and stands unchanged: this acts on an absence
of evidence, and the strongest move on an absence is to write down that we no longer
know. It is also why the verdict is `failed` where `rel-transition-journal`'s `reclaim`
hands a task back to `ready`. That is not a contradiction to fix later — the two act on
different evidence. `reclaim` has proof the owner is dead and has committed the tree, so
it may re-arm; this has silence, so it stops and names a person. When the journal lands,
an expired lease whose owner is *provably* dead is upgraded to that stronger path, and
this verdict remains what happens when no proof is available.

## The supervisor that comes back

Spec 011 says a returning supervisor outranks the sweep and writes over both records.
Under retry that is corruption: attempt *n*'s supervisor writing `done` while attempt
*n+1* is running is two supervisors on one task. Amended, split by what each party
actually knows:

| a supervisor whose lease was reclaimed | may | may not |
|---|---|---|
| its own execution row | finish it with its real verdict — it watched the agent and holds the diff | — |
| the task's status | — | write it; the scheduler has moved on |

Nothing is lost. If no retry was dispatched, the next recovery pass reads the row's true
verdict and corrects the task; if one was, the truth is on the row where a person can
read it and the live attempt is undisturbed. The supervisor learns it lost from the
failed compare-and-swap on its next renewal, and stops renewing.

## Why a lease, when `liveness.md` refused leases

That refusal was of leases as partition tolerance, and it was right: there are no
partitions on one machine, and `rel-transition-journal` answers *is that process alive*
exactly, with no threshold. This is a different question. A lease asks whether a run is
still being **supervised**, and the two come apart in cases a pid check certifies as
healthy: a supervisor stopped with `SIGSTOP`, one wedged in an uninterruptible syscall,
one whose renewing thread panicked while the process lives on. Existence is not activity.
The proof is what stops us killing a live sibling; the lease is what notices that nothing
is happening. `liveness.md` and `plan.md` are outside this task's write scope, so
somebody holding them has to record that.

## What would show this was decided wrong

- **A reclaim of a live run.** The fence makes these countable: a supervisor whose
  renewal fails compare-and-swap while its agent is still producing output. One is a
  window that is too short; a pattern is the continuity witness not working.
- **Rows reclaimed with no witness ever found.** A workspace where nothing beats for long
  stretches would leave dead runs open indefinitely — safe, but useless, and the answer
  would be that `wecode recover` must run oftener rather than that the rule is wrong.
- **`lease_secs` never varying from the default.** Then storing the term bought nothing
  the constant did not, and one column of the two should go.
- **Operators reading `failed` and typing `ready` every time.** That would mean the
  transient class should have re-armed it, and the ladder is drawn one rung too high.
