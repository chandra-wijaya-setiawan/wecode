# How work moves

```
              task add            assign / --to
   (nothing) ─────────► draft ──────────────────► waiting
                                                    │
                                    tick ◄──────────┤  the scheduler, alone
                                     │              │
                                     ▼              │  predecessor reopened
                                   ready ───────────┘
                                     │
                        start │ run  ▼
                                  running
                                     │
                          verify ────┼──────────────┐
                                     ▼              ▼
                    ┌──── needs-approval          failed
             merge  │           ▲                   │
                    ▼           │ rollback          │  status <t> waiting
                   done ────────┘                   ▼
                                                 waiting
```

`dropped` is reachable from anywhere with `wecode status <task> dropped`.

## Who owns each move

| move | who | why it works that way |
|---|---|---|
| → `draft` | `task add` | admitted or refused on the spot |
| → `waiting` | `assign`, or `task add --to` | naming a post *is* assigning; a half-assigned task is invisible to the queue |
| `waiting` ⇄ `ready` | **the scheduler, alone** | recomputed from the graph each tick, so a missed tick delays a promotion and cannot lose one |
| → `running` | `start` or `run` | |
| → `needs-approval` | `verify` passes in a worktree | passing is not landing; the branch is unmerged |
| → `done` | `verify` passes with no worktree, or `merge` | |
| → `failed` | `verify` fails, or the agent did not exit cleanly | |
| `done` → `needs-approval` | `rollback` | the work still passed; the decision to land it was withdrawn |

Demotion matters as much as promotion. Reopening a finished prerequisite puts its
dependents back to `waiting`, or the queue keeps offering work whose groundwork has been
undone.

## One run of one task

A task is planned work. An **execution** is one attempt at it, and they are separate so
a retry does not erase what happened last time. Each execution records its worktree, its
attempt number, when it started and ended, and how it finished.

Executions carry the [A2A](design/decisions.md#a2a) lifecycle — `submitted`, `working`,
`completed`, `failed`, `canceled`, `rejected`, and the rest — where `rejected` is the
one that matters: the agent finished cleanly and *we declined what it produced*.

## What `wecode run` does, in order

1. Resolve the task, its assignee post, and that post's agent template.
2. **Prepare** — refuse a draft or a blocked task; create or reset the worktree the
   playbook asks for; render the envelope.
3. **Charter check** on the launch command. Everything refusable is refused before
   anything starts.
4. Mark the task `running` and open an execution row, so a crash leaves a trace.
5. **Spawn** — environment built from an allowlist, not inherited; working directory
   pinned to the worktree; a new process group; wall and idle timers.
6. **Judge**, in trust order:
   - `git diff` of the worktree — **ground truth**
   - every changed path checked against the declared scope
   - the acceptance commands, run by wecode — **authoritative**
   - `.wecode/run/result.json` — the agent's own claim, currently not read
7. **Commit** whatever the attempt produced, pass or fail.
8. Close the execution row with why, not just how it exited.

Step 7 is after step 6 deliberately: `verify` reads the *uncommitted* diff, so committing
first would leave it nothing to check.

Committing a **failure** is the point rather than the cost. The failed diff is what a
retry learns from; uncommitted, the next attempt's reset destroys it.

## Worktrees

One worktree per **main task**, at `~/.wecode/run/<org>/<task>/`, on a branch named
`wecode/<task>`. Subtasks share their parent's tree — which is `parent` and `depends_on`
each doing one job.

A branch is cut from its **predecessor's** branch when it has one, so a dependent task
*has* the work it comes after rather than merely being told about it. Only one
predecessor: merging several branch points is a real decision about order and conflicts,
and two predecessors that both changed code want a merge task between them.

Whether a kind gets a worktree at all is the playbook's call. Docs usually do not need
one; prose does not conflict the way code does.

## The handoff

What the next agent is told is **assembled by wecode from what it observed**, never
passed by the agent that produced it. Posts do not talk to each other, and an agent's
account of its own work is inadmissible — so it is read out of git and the execution
record.

Both payloads are [A2A](design/decisions.md#a2a) **artifacts**, because that is what
they are — the output of a run that already happened:

- **what came before you** — follows `depends_on`, since that relation already means
  "must come after"
- **what you tried last time** — this task's own earlier attempts, with the reason each
  was rejected

Both carry the real diff, capped, because an envelope is a prompt and an unbounded diff
would crowd out the instruction.

The instruction itself is an A2A `Message`, and the two together are one A2A `Task` —
wecode's *execution*, in state `submitted` until something is spawned. `wecode start
<task>` renders it as the prompt; `--json` emits the record. Where the artifacts land in
the prompt is the template's call: inline at `{{context}}`, or appended when it has no
such slot.

## Landing it

`merge` puts a verified branch on the project's integration branch, always `--no-ff`, so
every merge is exactly one commit you can revert.

Two gates, and they are different things:

- the **charter's** `approval_to_merge` is a company invariant
- the **playbook's** `merge = "auto" | "approved"` is a project preference

A project can therefore be stricter than the company, never laxer. Where a signature is
required it must be a recorded one — `wecode approve merge --task <id>` — because a
signature a command-line flag can stand in for is not a signature.

`rollback` reverts the merge. It is a new commit rather than a rewrite, so it is safe
whether or not the branch has been shared — but git still counts the branch as merged
afterwards, so restoring the work means reverting the revert, not merging again.

## The loop

`wecode loop` does two passes per cycle, kept separate: promote, then dispatch.
Promotion records work *becoming* startable; dispatch records it being *started*, and
collapsing them would lose the first — the one that explains why the second happened.

Concurrency comes from `max_open_items`, the operator's attention, not from cores. The
loop stops dispatching entirely while anything needs a human, because more work in
flight does not help an unanswered question.
