---
class: evergreen
subject:
  - "crates/wecode-cli/src/spawn.rs"
  - "crates/wecode-cli/src/scheduler.rs"
  - "crates/wecode-store/src/execution.rs"
---
# Liveness, staleness, and what we take from prior art

The reliability project needs one vocabulary, not three. This is what the canon
offers, what we adopt, and what we deliberately refuse.

## Adopted

| Idea | Source | Why here |
|---|---|---|
| **Progress-carrying heartbeat** | Temporal / Cadence activity heartbeats | An idle timeout cannot tell a slow agent from a hung one. A heartbeat that carries what the run is doing can, and a retry can resume from it. Tonight's phantom empty runs would have shown in seconds rather than four attempts. |
| **Attempt cap with backoff** | Erlang/OTP restart intensity | Retrying forever is a crash loop with extra steps. Cap attempts per window; a task that exhausts them needs a person, not another spawn. |
| **Readiness ≠ liveness** | Kubernetes probes | Three questions wear one word today: is the agent alive, is the task dispatchable, is this run still starting. Splitting them is what makes `waiting` mean one thing. |
| **Scheduler owns the verdict** | Airflow zombie reaping | A worker never declares itself dead. The sweep that finds an expired lease writes the status. |

Built, narrower than Temporal's on purpose: the supervisor beats
`task_executions.beat` every 30 seconds (`claim::Beat`) and carries no progress —
the beat proves the *watcher* was alive, and the diff stays the only account of the
work. The pure staleness decision is `scheduler::stale`; only `wecode loop` acts on
it, after a confirming second reading, per
`docs/wecode/heartbeat-cleans-stalled-agents/design.md`.

## Kept, because ours is stronger here
- **Identity as a proof, not an estimate:** `boot_id + pid + process start time`
  (rel-transition-journal's design). Chubby and Kubernetes need TTL leases
  because of network partitions; on one machine there are none, so we can answer
  exactly, with no clock to tune and no threshold to argue about.
- **Journal before the side effect** (write-ahead logging, Gray & Reuter). K8s
  and Airflow reconcile after the fact; we make the drift impossible instead.

## Refused
- **φ-accrual failure detectors** (Chandra & Toueg; Akka, Cassandra) — suspicion
  as a degree solves network flakiness we do not have. Sophistication without a
  matching problem.
- **Full probe machinery** — three endpoints with periods and thresholds is
  configuration for its own sake at one-operator scale.

## Staleness of RECORDS, not processes
The nearest prior art is Airflow's SLA misses and Temporal's stuck-workflow
detection: the system notices elapsed time without progress and says so, rather
than waiting for a person to notice. That is the shape of the reminder the
owner asked for — and the same shape as the doc-freshness gate, one level up.

A held task is not schedulable, so it is neither dispatched nor swept: `hold` takes
work out of the runner without pretending anything about its liveness.

A cut-off seat is not a dead one: the circuit breaker withholds the next dispatch
and says so. Liveness is about whether a supervisor still speaks; the breaker is
about whether a seat may start again.
