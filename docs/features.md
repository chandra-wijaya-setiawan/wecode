# What is built

The inventory, including what is weak. Anything not here is not built — see
[plan.md](../plan.md).

## Planning

| | |
|---|---|
| **Projects and tasks** | two levels, one repo per project |
| **Two relations** | `parent` (is part of) and `depends_on` (comes after), checked separately |
| **Seven kinds** | feature, bug, refactor, chore, spike, design, docs |
| **Admission gate** | deterministic defect checks, each carrying a fixed question |
| **Playbooks** | per-project guidance, in the project's own repo |
| **Templated decomposition** | `--expand` emits the subtasks a playbook declares |
| **Design gate** | `design_required` refuses a kind with no design task behind it |
| **Dispatch gate** | `dispatch = "approved"` refuses to start a task nobody signed for |
| **Archiving** | park a project: hidden *and* not scheduled |

The **admission gate** is the part most worth knowing. A task is refused, with a
question, if its title names more than one outcome or uses a word like *faster*; if it
has no executable acceptance; if it has no write scope (except a spike); if it has no
budget; if its scope overlaps a task that could run at the same time; or if it would
close a dependency cycle. `--force` admits it anyway and records the defects as waivers.

The **design gate** is the admission check that keeps a feature from going from an idea
to a merged branch with no human ever seeing a design. A playbook kind that sets
`design_required` is refused unless a `design` task stands before it — a predecessor
anywhere up its dependency chain, or a subtask inside it, which is the shape `--expand`
creates. The relation is the entire check: a design finishes only through a recorded
signature, and nothing dispatches while its predecessors are unfinished, so the ordering
machinery is what holds the work back until someone signs. Whether the design is any
good stays a human judgement; the gate does not pretend to check it.

The **dispatch gate** is the same idea one step down. A project whose playbook says
`dispatch = "approved"` starts nothing — by hand or by the loop — until a holder has
signed that task: `wecode approve admission --task <id>`. It exists because the admission
gate is deterministic, and a deterministic check can say a task is vague or unscoped but
never that it is the wrong task; that judgement is a person's, and this is where it fits.
The signature is read from the ledger, so it names the post that gave it and the person in
that seat, and it goes stale if the task is redefined afterwards — amending a scope asks
for it again. Off by default: a run is bounded by a budget, confined to a worktree and
judged before it can land, which is what makes it safe to leave `auto` where `merge` is
`approved`.

**Playbooks** are guidance for whoever decomposes work, read before creating tasks. Free
prose for how to break work down, plus a few typed fields wecode acts on: whether the
kind needs a worktree, the default acceptance commands, assignee and budget, and the
merge policy. They live in the repo because they describe that code.

A kind may also declare its **decomposition**, which `wecode task add --expand` emits as
ordinary tasks — chained, scoped, and with `{{task}}` substituted — instead of one
`task add` per step with every scope and acceptance command retyped. That retyping was
where the planning errors came from, and every one of them was catchable before any
agent ran. The template runs once, at planning time, and nothing consults it afterwards:
its output faces the same admission gate as hand-written tasks and can be edited or
dropped before dispatch. It is all or nothing, because a half-built expansion leaves the
later steps waiting on tasks that were never created.

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
| **Spend** | tokens read out of the agent's own output, per attempt and on the ledger |
| **Handoff** | assembled from git and the execution record, never from the agent |
| **Merge** | `--no-ff`, configurable policy, with a report that is committed |
| **Rollback** | revert, not reset |
| **Scheduler** | a tick that promotes, a loop that dispatches |
| **A2A** | the instruction *is* an A2A task; the prompt is one rendering of it |

The **environment is built, not inherited** — a coding CLI would otherwise read every
secret in the shell, and absent a container that is the only network control there is. A
**new process group** matters because coding CLIs spawn children, and signalling only
the parent leaves them running.

The **instruction is an A2A task**, not a string built beside one. What the worker is
told is a `Message`; what it is given to read — a predecessor's commit, its own failed
attempt — is an `Artifact`. The text prompt is `wecode start <task>`, the same record as
JSON is `wecode start <task> --json`, and neither can drift from the other because there
is only one. The structured half never reaches the prompt: a coding CLI reads a JSON
blob on argv as part of its instruction.

**Nothing reads `.wecode/result.json`.** The diff is ground truth and an agent's account
of its own work is inadmissible, so the file is written and ignored.

**The merge report is committed, not printed and lost.** It goes to
`docs/wecode/<task>/report.md` on the integration branch — the same directory the design
gate looks in — as its own commit on top of the merge, because the report names the merge
sha and no commit can contain its own name. The file is the report *verbatim*: it is
evidence, so it has to be the text that was produced rather than a second telling of it,
and one generator means the repository and the terminal can never disagree about one
merge. Generated, never authored, for the same reason `result.json` is ignored. The only
line the terminal adds is where the file went, which the file cannot say about itself. A
record that fails to land is a line in the report rather than an error — the merge has
already happened by then, and there is nothing left to undo. `rollback` leaves the file
standing and says so: a revert is a new commit precisely because the merge did happen.

**Spend is the one number that is reported rather than observed**, and it is marked as
such. wecode does not sit between an agent and its model, so the only party that knows
the token count is the harness that spent them: the count is read out of the agent's own
output stream, matched to the `protocol` its template declares, and the ledger files it
under `harness` instead of `supervisor`. Only `claude-stream-json` is read today; every
other protocol string is **unmetered** until an adapter for it exists, since inventing a
number from an output format nobody has read is worse than no number at all.

Unmetered and free are different facts and are stored as different values —
`task_executions.spent_tokens` is NULL for one and `0` for the other. `wecode run` says
"unmetered" in words and `wecode show` leaves that attempt's cell as `—`. The board's
spend cell is a *total*, so it has nowhere to put the distinction: an unmetered agent
contributes nothing to it and the row reads `0`. The number there is always what was
reported and never a guess, but a zero on the board is worth confirming against
`wecode show <task>` before believing a run was cheap.

Counting happens as the output streams past, not afterwards: the buffer is capped at
256 KB and the line stating the run's total is the last one, so the expensive runs are
exactly the ones a read-it-at-the-end approach would lose. The cost is recorded however
the run ended — a killed agent still burned what it burned.

## Watching

| | |
|---|---|
| **`wecode up`** | a live cockpit: what, status, spend, needs-you |
| **`wecode board`** | the same view as a one-shot snapshot |
| **`wecode brief`** | orients an agent, derived from its grant rather than stored |
| **`wecode tree` / `ready`** | the plan, and what is startable |

Health is **computed** from the ledger, the budget and the defect checks — never
reported. It is the colour of the needs-you cell rather than a column of its own:
every cause of amber or red writes an entry there, so a column beside it only ever
repeated it. Status is declared and sits apart, because a task can be perfectly
healthy and not started.

**Work that cannot advance on its own is flagged, not just work that is loud.** A task
whose prerequisite `failed` or was `dropped` looks exactly like one whose prerequisite
is still running — both say *waiting* — but no tick will ever release the first. The
board marks it amber with `stuck on <id>`, the project row carries a `N stuck` count so
a stranded subtask is visible before descending, `ready` counts stuck work apart from
work that time will resolve, and `wecode status <t> failed|dropped` names the dependents
the act just stranded. Deliberately narrow: a prerequisite at `needs-approval` or
`needs-input` is a signature or an answer away from done — work queuing behind an
unsigned design is the design gate working, not a dead end — and reopening the failed
task (`wecode status <t> waiting`) takes the flag down by itself.

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

A **token budget is post-hoc for the same reason**, and more so: the count only arrives
when the agent reports it, which is after the tokens are gone. Exceeding one turns the
row red and never refunds anything. What does stop a runaway mid-flight is the wall and
idle limit, because time is the one thing wecode measures itself.

## The operator is not governed

Everything above applies to work wecode dispatches. An operator working through their
own agent — which is how wecode itself is built — is not subject to any of it. The
guard, the scopes and the charter are advisory in that mode.

## A scope amendment can launder drift

`wecode task scope` can widen a declaration after the work is done, and while the
amendment is recorded, nothing correlates it with a verification that passed
immediately afterwards. The ledger holds both facts and joins neither.

The dispatch gate joins them at the one point it can: a signature earlier than the last
amendment does not count, so widening signed work asks for the signature again. That
covers the window *before* a run and says nothing about the one after it, which is where
`verify` still needs to look.

## No retry, and no crash recovery

A `failed` task waits for a person to reopen it; the loop will not retry by itself.
And if the loop dies mid-run the task stays `running` forever, leaking a slot each time
— `Store::unfinished_executions()` exists to find those rows and nothing calls it.

## Other absences

Serving or calling A2A over JSON-RPC — the model is wired, the transport is not — plus
streaming progress, containers, RACI, and the recursive management functions the theory
describes.

`protocol` is now matched on, but for one thing and one value: `claude-stream-json`,
to read a token count. It is still not validated at load, so a typo in `company.toml`
silently produces an unmetered agent rather than an error — visible on the board as a
blank spend cell, which is honest but easy to miss.
