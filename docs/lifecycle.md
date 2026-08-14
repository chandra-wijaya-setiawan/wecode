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
| → `needs-approval` | `verify` passes on a task that owns a branch, or on a design | passing is not landing; the branch is unmerged |
| → `done` | `verify` passes with nothing of its own to land, or `merge` | a subtask, or a kind that gets no worktree, has no separate landing decision |
| → `failed` | `verify` fails, or the agent did not exit cleanly | |
| `done` → `needs-approval` | `rollback` | the work still passed; the decision to land it was withdrawn |

Demotion matters as much as promotion. Reopening a finished prerequisite puts its
dependents back to `waiting`, or the queue keeps offering work whose groundwork has been
undone.

**Owning a branch is what makes passing short of finished**, and only a main task does.
A subtask works in its parent's tree, on its parent's branch, so a step that passes is
`done`: there is nothing about it left to land separately, and the main task is what
lands. Parking it at `needs-approval` asked for a decision nobody could correctly take —
`merge` on a step would have put the whole shared branch on the integration branch,
every step of the expansion including the ones that had not run. Worse, it stopped the
plan: the sibling declared `--after` that step stayed `waiting`, because readiness
follows `done`, and the loop stops dispatching entirely while anything needs a human. A
design is still the exception at any depth, for the other reason — see below.

## One run of one task

A task is planned work. An **execution** is one attempt at it, and they are separate so
a retry does not erase what happened last time. Each execution records its worktree, its
attempt number, when it started and ended, how it finished, and what it cost — a task
that overran its budget on its third try can say so, which a per-task total cannot.

Executions carry the [A2A](design/decisions.md#a2a) lifecycle — `submitted`, `working`,
`completed`, `failed`, `canceled`, `rejected`, and the rest — where `rejected` is the
one that matters: the agent finished cleanly and *we declined what it produced*.

## What `wecode run` does, in order

1. Resolve the task, its assignee post, and that post's agent template.
2. **Prepare** — refuse a draft or a blocked task; refuse it where the project asks for a
   signature and the ledger has none; create or reset the worktree the playbook asks for;
   render the envelope.
3. **Charter check** on the launch command. Everything refusable is refused before
   anything starts.
4. Mark the task `running` and open an execution row, so a crash leaves a trace.
5. **Spawn** — environment built from an allowlist, not inherited; working directory
   pinned to the worktree; a new process group; wall and idle timers. Output is metered
   as it streams, so what the agent says it spent survives the buffer cap.
6. **Record what it cost** — the wall clock wecode timed, and the token count the agent
   reported, marked as reported. This happens however the run ended: a killed agent
   still spent what it spent, and a cost recorded only for clean exits would hide the
   expensive failures.
7. **Judge**, in trust order:
   - `git diff` of the worktree — **ground truth**
   - every changed path checked against the declared scope
   - the acceptance commands, run by wecode — **authoritative**
   - `.wecode/run/result.json` — the agent's own claim, currently not read
8. **Commit** whatever the attempt produced, pass or fail.
9. Close the execution row with why, not just how it exited, and with its spend.

Step 8 is after step 7 deliberately: `verify` reads the *uncommitted* diff, so committing
first would leave it nothing to check.

Committing a **failure** is the point rather than the cost. The failed diff is what a
retry learns from; uncommitted, the next attempt's reset destroys it.

## Starting it

Two gates stand before a task runs, and they ask different questions:

- the **admission gate** asks whether the task is well-formed, and answers deterministically
- the **playbook's** `dispatch = "auto" | "approved"` asks whether anyone agreed to it

Both are checked in `prepare`, which `start` and `run` share, so a task cannot be walked
around the gate by taking it by hand. Where a signature is required it must be a recorded
one — `wecode approve admission --task <id>` — and it must be *later* than the last
`define` record for that task, so amending a scope after signing asks again rather than
inheriting the earlier answer.

The refusal happens before the worktree is cut. A tree made for work nobody signed for is
a tree left standing.

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

A tree comes down when the work **lands**, not when it passes: `merge` removes it, because
that is the moment every commit in it is also on the integration branch. It stays if a task
sharing it is still open, or if it holds uncommitted work the merge did not take — the merge
report says which. The branch is kept either way, so `wecode start` cuts the tree again from
it if the work reopens, and the worst a removal costs is a rebuild.

## The handoff

What the next agent is told is **assembled by wecode from what it observed**, never
passed by the agent that produced it. Posts do not talk to each other, and an agent's
account of its own work is inadmissible — so it is read out of git, the working tree and
the execution record.

Both payloads are [A2A](design/decisions.md#a2a) **artifacts**, because that is what
they are — the output of a run that already happened:

- **what came before you** — follows `depends_on`, since that relation already means
  "must come after"
- **what you tried last time** — this task's own earlier attempts, with the reason each
  was rejected

Both carry the real diff, capped, because an envelope is a prompt and an unbounded diff
would crowd out the instruction.

**Except a design.** A design's output is not code, so its handoff is not a diff: the
predecessor's document is handed over whole, at whatever path its write scope declared,
falling back to `docs/wecode/<task>/design.md`. It has to be read from a file rather than
from git because a design asks for no worktree and wecode therefore never commits it —
before this, a signed design reached the task built on it as `(no commits in this
worktree)`, which is the design gate holding work back for a decision the implementer was
then never shown. The document is looked for in the design's own tree, then this task's,
then the project's checkout, and if none of them has it the handoff names the path it
tried instead of implying nothing was written.

The instruction itself is an A2A `Message`, and the two together are one A2A `Task` —
wecode's *execution*, in state `submitted` until something is spawned. `wecode start
<task>` renders it as the prompt; `--json` emits the record. Where the artifacts land in
the prompt is the template's call: inline at `{{context}}`, or appended when it has no
such slot.

## Landing it

`merge` puts a verified branch on the project's integration branch, always `--no-ff`, so
every merge is exactly one commit you can revert.

Only a **main task** merges. Naming a subtask is refused, and the refusal says which task
does land it: a step has no branch of its own, so merging it would take the whole tree's
work — including steps that have not run — while marking one task done.

Two gates, and they are different things:

- the **charter's** `approval_to_merge` is a company invariant
- the **playbook's** `merge = "auto" | "approved"` is a project preference

A project can therefore be stricter than the company, never laxer. Where a signature is
required it must be a recorded one — `wecode approve merge --task <id>` — because a
signature a command-line flag can stand in for is not a signature.

The report is **kept, not printed**. It lands at `docs/wecode/<task>/report.md` on the
integration branch, in the same directory as that task's `design.md`, as a second commit
on top of the merge — the report quotes the merge sha, and no commit can contain its own
name. The file holds the report verbatim, because it is evidence rather than a retelling
of one; the terminal shows the same text plus a `record` line saying where it went, which
is the one fact the file cannot state about itself. If that commit fails the merge still
stands and the report says the record is missing, since by then there is nothing to undo.

`rollback` reverts the merge. It is a new commit rather than a rewrite, so it is safe
whether or not the branch has been shared — but git still counts the branch as merged
afterwards, so restoring the work means reverting the revert, not merging again. The
record stays where it is: the merge did happen, and that is what it says.

## The loop

`wecode loop` does two passes per cycle, kept separate: promote, then dispatch.
Promotion records work *becoming* startable; dispatch records it being *started*, and
collapsing them would lose the first — the one that explains why the second happened.

Concurrency comes from `max_open_items`, the operator's attention, not from cores. The
loop stops dispatching entirely while anything needs a human, because more work in
flight does not help an unanswered question.

Whenever a task *starts* waiting on a person — verified and unlanded, failed, or held by
the dispatch gate — the `[notify] command` runs, if the workspace has one. That is the
only push in the system: everything else here has to be looked at. It fires on the
transition rather than the state, so the loop's per-pass report and the notification are
not the same thing and the second does not become noise.

If `[telegram] fetch` is set, each pass then reads the replies to those notifications and
signs what they approved — after promotion, so a bare `approve` is read against a task
the queue has already settled, and before dispatch, so the signature releases the work on
this pass rather than the next. The signature is an ordinary ledger record given by the
replier's post; the gates below cannot tell it apart from a typed one, which is why
nothing below mentions it again.

A task waiting for a dispatch signature is reported as `⏸ <id> needs your signature` and
passed over, not dispatched into a refusal — waiting for a person is not a failure, and
printing it as one sends the operator looking for a bug. It is passed over *before* the
concurrency cap is applied, too, so one unsigned task at the head of the queue cannot hold
a slot the work behind it could use.
