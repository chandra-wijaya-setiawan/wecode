# board-brief — what the owner asked for

Written by the chief from the owner's words, before the design. The design must answer
this document; where it disagrees, it argues rather than ignores.

## The complaint

"The TUI is my window into what's going on; I can't keep asking the orchestrator for
everything." The board answers *what is running right now* and nothing else. It has no
memory (yesterday's 23 merges render identically to a dead day), no outcome (objective
is a dim caption; measures are never run; % done counts tasks, not delivery), and no
comparison of spend against the project's budget — which is how 800k became ~4M
without a row changing colour.

## Group by attention, not by hierarchy

The owner's words: "separate the grouping — not just a list — what's outstanding, what
is running, what recently done; like the 7±2 of human perception, workflow-wise."

The portfolio today is a tree: projects, tasks under them. That is how the *system* is
shaped, not how a *person* reads it. The board should lead with groups in the order a
person acts on them:

1. **needs you** — signatures, blocked-on-grant, questions. Always first, always small.
2. **moving** — running and verifying now. Each row carries the agent's own latest
   line from its stream (wecode already captures it since `retry-cause`), so "running"
   answers *what is it doing*, not just *that it is*. The owner's words: "I don't even
   know what agents are running and what they're doing."
3. **next** — ready and waiting, with what unblocks each.
4. **landed** — recently merged, each with its one-line what and cost.

Hierarchy survives *inside* a group (a task still names its project), but state outranks
structure. Keep each group at a handful of rows — `[attention] max_open_items = 5` is
already the company's own declaration of this — and let a count ("… and 9 more")
stand in for the tail rather than rendering it.

## The OKR line

Each project gets one line the current board lacks: objective, measures actually run
and coloured by their exit codes, spend **against budget** (4.0M/800k must look like
what it is), and delivered count. Outcome, not output.

## What this is not

- Not a dashboard of charts. It is still a terminal board read in seconds.
- Not a feed. "Landed" is the last few, not a scrollback.
- Not new data. Every fact above already exists in the plan, the ledger, or a measure
  command — this is assembly, not collection.

## Review of attempt 1 — signature withheld

Delivered and good: spend against budget on every row with over-budget in red, parent
rolls aggregating children, and waiting rows naming what blocks them. Kept.

Missing: the document's first requirement. The portfolio is still one hierarchy tree.
There are no attention groups — no **needs you / moving / next / landed** leading the
view, no ordering by what a person acts on, no handful-per-group ceiling. "Group by
attention, not by hierarchy" is the owner's headline ask and the reason this task
exists; the rest was supporting detail. Attempt 2 is about that section alone.
