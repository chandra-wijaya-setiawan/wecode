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
