# A signature before a task is dispatched

Status: **built**. Written alongside the implementation rather than before it — there was
no design task in front of this one, and the decisions below are worth keeping whichever
order they were made in.

## What went wrong

Using wecode on itself, the tasks are planned by an agent. The orchestrator writes them,
the admission gate checks them, `wecode loop` dispatches them, and the first time a person
reads a task is when they are looking at what it produced. The gate is deterministic and
that is its strength: it can say a title names two outcomes, that a scope is missing, that
a budget is absent. It cannot say the task is the wrong task.

So there was a door for *is this well-formed* and no door for *did anyone agree to this*.
Every other consequential act in wecode has one — a design waits for `approve design`, a
protected branch waits for `approve merge` — and dispatch, the act that spends the money,
had none.

`ActionKind::Admission` already existed in the grant vocabulary, and the shipped templates
already hand it to the chief. Nothing read it. This is the reader.

## The signature is a ledger row, not a flag

`wecode approve admission --task <id>` records one line, attributed to the post that gave
it and to the human in that seat when there is one. `prepare` reads it back. This is the
same shape `merge` uses, for the same reason: a signature a command-line switch could
stand in for is not a signature. The two now share `ledger.rs` rather than each scanning
the log their own way.

Nothing about the task changes when it is signed. There is no `signed` column and no new
status, because the fact is not *about* the task — it is about who said what, and when,
which is what the ledger is. A status would also collide with `needs-approval`, which
already means "verified, waiting to land"; one word for two different signatures would
make the board unreadable at exactly the moment it matters.

## Stale signatures

A present/absent check has a hole in it: sign something small, then widen it. `task scope`
records a `Define{Task}`, and `seq` is assigned by the database, so "was this signed after
the last time it was defined?" is a question the ledger can answer by itself. A signature
earlier than the last definition is reported as covering the earlier task, and asks again.

This is a partial answer to the scope-laundering gap in [features.md](../../features.md).
It closes the window before a run. The window after one — a scope widened to match a diff
that already exists — is still open, and belongs to `verify`.

## Why the playbook, and why it is off by default

The policy sits in `[project] dispatch`, beside `merge`, with the same two words. A
project may be as strict as it likes.

The default is `auto`, where `merge` defaults to `approved`, and the asymmetry is
deliberate. wecode splits control by **reversibility**, not by severity: a dispatched run
happens in its own worktree, under a token and wall budget, and is judged before anything
it produced can reach a shared branch. A merge is the step that cannot be un-decided
quietly. A strict default would also stop `wecode loop` — which exists to run unattended —
on every task in every project that had never heard of the setting, and an operator whose
loop stopped would turn the gate off rather than learn to love it.

An unknown value is refused by name. `dispatch = "manual"` reading as strict and behaving
as `auto` is the one failure mode a gate must not have.

## The loop reports, it does not fail

A task waiting for a person is not a failure. The loop prints `⏸ <id> needs your
signature` and carries on, the same way it already reports work that needs an answer —
dispatching into a refusal would have filled the log with errors that were not errors.

The gate is applied *before* the concurrency cap rather than after. Truncating the queue
first and filtering second would let one unsigned task at the head of it hold a slot for
as long as nobody signed, which is the difference between a gate and a stall.

## One signature per task

Not per expansion. Each task is dispatched on its own budget, so each is signed on its
own; a signature that covered everything beneath it would be a signature on work that had
not been written down yet. The loop lists what is waiting, so the cost of this is reading
a list, not hunting for one.

## What is not here

**The charter half.** `approval_to_merge` lets a company insist on a signature regardless
of what a project says, and there is no equivalent for dispatch — the playbook lives in
the repository being worked on, so this is a project's own promise rather than one the
company can impose. A `dispatch_needs_approval` invariant is the obvious next step; it
belongs in `wecode-gov`, which this task could not reach.

**Anything about *what* was signed.** The record names the task, not its contents. The
staleness check is what stands in for a fingerprint: rather than proving the signature
matches the task, it proves nothing has redefined the task since.
