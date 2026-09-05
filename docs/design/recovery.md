---
class: hand-tended-state
subject:
  - "crates/wecode-cli/src/scheduler.rs"
  - "crates/wecode-cli/src/commands/exec.rs"
  - "crates/wecode-core/src/execution.rs"
---
# Stuck must recover itself

Owner, 4 Sep 2026: *"stuck must have recovery resume mechanism though."* Right,
and the ledger says why: of **154 closed non-success runs** on 30 Aug – 4 Sep,

| cause | n | kind |
|---|---|---|
| killed on token budget | 44 | mechanical — fixed 2 Sep, `[budgets] enforce` off by default |
| wrote outside its scope | 39 | mechanical — the run needed a path nobody granted |
| "nothing to judge by" | 17 | mechanical — a container was dispatched, which is a bug |
| supervisor died / closed stale | 14 | mechanical — the heartbeat sweep now closes these |
| command not found (127) | 8 | environment — retrying changes nothing |
| acceptance genuinely failed (101) | 4 | **the work** |

**Four of a hundred and fifty-four were about the work.** Everything else was the
machinery, and every one of them was recovered by a person typing the same three
commands. That is the definition of a job the machine should do.

## The decision
A failure carries a **cause class**, and the class decides what happens next.

| class | what the loop does |
|---|---|
| **transient** — supervisor died, empty run, admission collision | **retry**, up to a cap, with the previous attempt's reason in the envelope |
| **needs a scope decision** — wrote outside scope | do NOT retry, do NOT widen. Hand back naming the exact paths, as a `needs-human` row whose category is `scope`, with the one command that grants them. The guard that refused is the feature; what was missing is the ask |
| **environment** — command not found, toolchain absent | raise a doctor alarm, do not retry: a second run finds the same missing binary |
| **the work** — acceptance failed on its merits | a person decides. This is what `failed` was always for, and it is 3% of the traffic |

Three rules the classes are useless without:

1. **A cap, not a loop.** Attempts are bounded per window (Erlang's restart
   intensity, `docs/design/liveness.md`). A task that exhausts them stops and says
   so — tonight a task was retried four times by hand, which is a crash loop with
   a human as the scheduler.
2. **Exhaustion propagates.** When a prerequisite gives up, its dependents stop
   reading as `waiting` and start reading as blocked-by-dead-work, with the
   blocker named. Nothing may sit patient behind something that will never come —
   that single omission accounted for six stalls on 3–4 Sep.
3. **The retry knows what happened.** The previous attempt's cause goes into the
   next envelope. A retry that cannot see why the last one failed is a coin toss,
   and the ledger already holds the answer.

## What this is not
Not auto-widening scope, not auto-resolving conflicts, not re-running a failed
acceptance in the hope of a different result. Recovery restores work the machinery
broke; it never decides something a person declined to.

## How recovery runs (owner, 5 Sep)

*"Rather than the supervisor being alive all the time, it is better to have a
deterministic scheduled process that scans for liveness, stuck, etc. and clears
deterministically. If any remain stuck, kick a chore agent: check the wecode tasks
that are stuck, try to clear them, and if it needs a human, tell the human."*

Adopted. It fixes the fragility this very design had: today the only recovery
lives **inside** `wecode loop`, so a dead loop recovers nothing — and on 4–5 Sep
the loop died with its session, leaving two runs orphaned for five hours.

### Three rungs, in order
1. **`wecode recover` — deterministic, scheduled, stateless.** A single pass that
   closes silent runs, releases dependents of dead work, retires signatures that
   no longer cover their task, and reports what it did. Safe to run from cron or a
   timer, safe to run twice, and it needs no process to have been watching.
2. **An inspector agent — only for what rung 1 could not clear.** Dispatched as an
   ordinary chore, with a template that says: here is what is still stuck and what
   was already tried; clear what you can; whatever needs a person, say so plainly.
   It is a fallback, never the first responder — judgment costs money and rung 1 is
   free.
3. **The human — only for what the inspector escalates**, arriving as a
   `needs-human` row with its category and the command that clears it.

### The consequence nobody should discover later
The heartbeat sweep confirms suspicion across **two passes 60 seconds apart**, and
that memory lives in the loop's process (`scheduler::Suspects`). A scheduled
process has no such memory: every run is the first pass, so nothing would ever be
confirmed. **Suspicion must move into the store** — a `suspected_at` column, set on
the pass that first reads a run stale and cleared when it beats again. That is the
one schema change this design requires, and without it rung 1 either never acts or
acts on a single reading, which is the laptop-suspend bug the window exists to
prevent.

### What the inspector may and may not do
| may | may not |
|---|---|
| re-arm a failed task, repoint an edge off dead work, close a stale row | approve anything, merge anything, widen a scope |
| write a `needs-human` row naming what it could not clear | decide something a person declined |
| read every record in the ledger | dispatch more agents |

It holds an ordinary seat with an ordinary role, and the Broker judges it exactly
as it judges any other. An inspector that could approve its own findings would be
a second operator, not a fallback.

### Guards
- Rung 2 runs only when rung 1 leaves something behind, and at most once per scan.
- An inspector that finds nothing twice in a row backs off — a fallback that fires
  on every quiet pass is a cost with no signal.
- The inspector's own run is subject to the same sweep. Nothing is exempt from the
  mechanism it maintains.
