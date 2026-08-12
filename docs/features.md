# What is built

The inventory, including what is weak. Anything not here is not built — see
[plan.md](../plan.md).

## Planning

| | |
|---|---|
| **Projects and tasks** | two levels, one repo per project |
| **Two relations** | `parent` (is part of) and `depends_on` (comes after), checked separately |
| **Six kinds** | feature, bug, refactor, chore, spike, docs |
| **Admission gate** | deterministic defect checks, each carrying a fixed question |
| **Playbooks** | per-project guidance, in the project's own repo |
| **Archiving** | park a project: hidden *and* not scheduled |

The **admission gate** is the part most worth knowing. A task is refused, with a
question, if its title names more than one outcome or uses a word like *faster*; if it
has no executable acceptance; if it has no write scope (except a spike); if it has no
budget; if its scope overlaps a task that could run at the same time; or if it would
close a dependency cycle. `--force` admits it anyway and records the defects as waivers.

**Playbooks** are guidance for whoever decomposes work, read before creating tasks. Free
prose for how to break work down, plus a few typed fields wecode acts on: whether the
kind needs a worktree, the default acceptance commands, assignee and budget, and the
merge policy. They live in the repo because they describe that code.

## Governance

| | |
|---|---|
| **Posts, roles, agents** | a seat, its capabilities, and the harness in it |
| **Grants** | intersected, never unioned; empty permits nothing |
| **Charter invariants** | outrank every grant; violations alarm rather than deny |
| **Sessions** | expire on idle; autonomous means no human |
| **Audit ledger** | one table, monotonic, marked by source |
| **Separation of duties** | the chief cannot write or run — enforced at load |

`wecode guard <post> <verb> <target>` asks the Broker a question without doing anything,
which is how you check a scope before assigning work to a seat that cannot reach it.

## Execution

| | |
|---|---|
| **Worktrees** | one per main task, outside the repo and the workspace |
| **Spawning** | environment from an allowlist, new process group, wall and idle timeouts |
| **Verification** | the diff against the declared scope, then the acceptance commands |
| **Commits** | every attempt, pass or fail, authored by wecode |
| **Handoff** | assembled from git and the execution record, never from the agent |
| **Merge** | `--no-ff`, configurable policy, with a report |
| **Rollback** | revert, not reset |
| **Scheduler** | a tick that promotes, a loop that dispatches |
| **A2A** | the data model, so a bridge stays a mapping |

The **environment is built, not inherited** — a coding CLI would otherwise read every
secret in the shell, and absent a container that is the only network control there is. A
**new process group** matters because coding CLIs spawn children, and signalling only
the parent leaves them running.

**Nothing reads `.wecode/result.json`.** The diff is ground truth and an agent's account
of its own work is inadmissible, so the file is written and ignored.

## Watching

| | |
|---|---|
| **`wecode up`** | a live cockpit: what, status, health, progress, spend, needs-you |
| **`wecode board`** | the same view as a one-shot snapshot |
| **`wecode brief`** | orients an agent, derived from its grant rather than stored |
| **`wecode tree` / `ready`** | the plan, and what is startable |

Health is **computed** from the ledger, the budget and the defect checks — never
reported. Status sits beside it because a task can be perfectly healthy and not started.

`brief` is derived rather than written down on purpose: a stored "you are the
orchestrator" prompt drifts from the grants the moment a role changes, and then promises
authority the Broker will refuse.

---

# Gaps

Stated here rather than left to be discovered.

## Two statuses are unreachable

`verifying` is never set — verification is synchronous inside `run`, so nothing observes
the task while it happens. `needs-input` is never set — nothing detects an agent
stopping to ask, and a subprocess CLI that has paused generally cannot be resumed
anyway. Both remain in the vocabulary because the A2A mapping needs them and the board
renders them.

## Enforcement is post-hoc, not intercepted

wecode cannot hook another process's writes. Confinement is the worktree; the scope
check runs afterwards on the diff. That is *why* a write outside scope is sanctioned —
recorded as a signal — rather than prevented. Per-write enforcement needs a sandbox, and
claiming it without one would be false.

## The operator is not governed

Everything above applies to work wecode dispatches. An operator working through their
own agent — which is how wecode itself is built — is not subject to any of it. The
guard, the scopes and the charter are advisory in that mode.

## A scope amendment can launder drift

`wecode task scope` can widen a declaration after the work is done, and while the
amendment is recorded, nothing correlates it with a verification that passed
immediately afterwards. The ledger holds both facts and joins neither.

## No retry, and no crash recovery

A `failed` task waits for a person to reopen it; the loop will not retry by itself.
And if the loop dies mid-run the task stays `running` forever, leaking a slot each time
— `Store::unfinished_executions()` exists to find those rows and nothing calls it.

## Other absences

Sending work to a remote A2A agent, streaming progress or token accounting (the
`protocol` field is an unvalidated string that nothing matches on), containers, RACI, and
the recursive management functions the theory describes.
