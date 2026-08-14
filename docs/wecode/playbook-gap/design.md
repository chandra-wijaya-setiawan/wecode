# Recording a gap in the playbook

Status: **built**. Written alongside the implementation rather than before it — there was
no design task in front of this one, and the decisions below are worth keeping whichever
order they were made in.

## What went wrong

A playbook is hand-edited and in no role's write scope, deliberately: something that can
rewrite the guidance it was given is not governed by it. That is the right rule, and it
leaves a hole on the other side.

An orchestrator reads `wecode playbook <kind>`, plans against it, and finds out
afterwards that the guidance was short — a trap, a seam, a file that always moves with
another. It has nowhere to put that. The session ends and the finding goes with it, so
the next planner pays for the same discovery. This repo's own playbook records the
outcome in prose: *"Three tasks in a row have been caught by this"*, written by hand,
long after the third.

Every one of those lines is a fact wecode itself produced and then dropped on the floor.
That is what this closes.

## A note, not an edit

`wecode playbook gap "<what the guidance did not say>"` records a finding. It does not
touch the playbook.

The distinction is the whole safety argument. Nothing in wecode branches on a gap: like
`guidance`, it is carried to a reader and never parsed. A wrong note can mislead
somebody, which the prose beside it could already do; it cannot widen a scope, raise a
budget, or switch off a gate. So an agent may write one, and the playbook stays exactly
as protected as it was.

It goes away only when a person folds it into the playbook and deletes the entry.
Nothing else deletes one, and that is the feature rather than a missing command: a gap
sits in front of the next planner until somebody has done something about it. A
`resolve` verb would let it be cleared by whatever recorded it, which is the one thing
that must not happen.

## Where it is written, and why not beside the playbook

Guidance lives in the repository because it describes that code. The obvious move was to
put its inbox there too — `.wecode/gaps.toml`, next to `.wecode/playbook.toml`, versioned
with the thing it is about.

That is wrong, for a reason specific to this codebase: **verification judges a task from
the repository's own diff**, and a kind whose playbook asks for no worktree is judged in
the main checkout. `verify` reads `git diff HEAD` plus untracked files there. So a gap
recorded while a `docs`, `spike` or `design` task was running would appear in that task's
verdict as a scope violation — recording a finding would fail somebody else's work. In
this very repo three of the seven kinds ask for no worktree.

The exemption that would fix it is worse than the placement problem: `verify` exempts
`.wecode/run/` and nothing else, and adding a second exempt path is a hole in the scope
check that a worker could then write through unseen.

So it lives in the workspace, in `gaps.toml` beside `company.toml`. The workspace is
never diffed and no worker ever runs there. What is lost is versioning with the code,
and the loss is small: a gap is transient by construction — its destination is the
playbook, and *that* edit is what gets committed.

## Gated on `define project`, not on a write

The first instinct is that appending to a file is a write, so ask the Broker about
`Action::Write`. Following that through gets the answer backwards twice: the chief, which
plans the work and holds no write scope at all, would be refused, and the engineer, which
holds `crates/**`, would be allowed to annotate the guidance it was just handed.

The capability that means *may say what this project's work is* is `define project`, and
the shipped templates already give it to the chief and to nobody else. So that is the
gate, and `wecode whoami` and `wecode brief` list the command off the same capability —
neither can promise something the Broker would then refuse.

The cost is honest and worth naming: the ledger row reads `define project`, the same as
`project add`, because `Action` has no variant for this and the note itself is not in the
ledger at all. The ledger records *that a seat did something to this project's
definition*; the file records what. Carrying the text would take a store change, which
this task could not make.

## Deduplication, and what counts as the same gap

Something will record these in a loop. Two entries with the same project, the same kind
and the same note are one finding, and the second is answered with "already recorded"
rather than an error or a second copy.

The task is deliberately not part of that comparison. A trap is one fact about the
playbook however many tasks walk into it, and keying on the task would put a fresh copy
in the file every time the loop planned anything.

## What it looks like from the other end

The gaps for a kind print after its guidance, not before it: the guidance is what the
project decided, a gap is what it has since found out and not yet written down, and that
is the order a reader wants them in. A gap filed against no kind shows against all of
them, including a kind the playbook says nothing about — "there is no `[spike]` section"
is the strongest reason for a gap to exist, and the least excusable place to hide one.

`wecode playbook` counts them and points at `wecode playbook gaps`. That count is also
printed for a project with no playbook at all, which is the largest gap a project can
have.

## What this does not do

It does not write the playbook. A machine that edited guidance would eventually edit it
wrongly, and the file is full of hand-written comments that no round-trip through a TOML
serialiser survives. Folding a gap in is a person reading two sentences and writing one.
