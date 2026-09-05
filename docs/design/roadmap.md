---
class: hand-tended-state
subject:
  - "crates/wecode-store/src/schema.rs"
  - "crates/wecode-cli/src/commands/plan/**"
---
# The roadmap is a record, not a view over drafts

`docs/roadmap.md` has held the roadmap by hand since 3 Sep. Its own header names the
plan: *"a mirror, kept by hand … it exists only until the roadmap view lands and reads
the same items off the plan — at that point this file goes."* This is the design for
where it goes.

## Why not the existing view
The dashboard's Roadmap pane lists open epics and stories with a completion fraction —
43 of them on 5 Sep. That is a backlog wearing a roadmap's name. It also cannot hold
what the file already holds, and what the operator actually maintains:

| in the file | in the task tree |
|---|---|
| **P0 / P1** | nothing — priority is expressed by hand-built dependency chains |
| **state in words**: *"scoped, seam specified"*, *"designed, amended once"* | a status enum meant for execution, not intent |
| **an ordering with reasons**: *"a provider abstraction over state that does not survive a restart abstracts the wrong layer first"* | edges with no rationale |
| **parked ≠ blocked**: *"Parked, not blocked. It needs the completeness gate's drop row to land first."* | one `waiting`, which conflates both |

The last row is the whole argument. A roadmap item is work **nobody has started on
purpose**; a blocked task is work that tried and cannot proceed. Rendering the second as
the first is how a backlog becomes noise.

## The record
One table, `roadmap`, and it is small on purpose:

| column | meaning |
|---|---|
| `id` | slug, e.g. `runtime-isolation` |
| `objective` | one sentence, outcome-shaped: what is true afterwards |
| `priority` | `P0`/`P1`/`P2` — the operator's ordering, not a computed one |
| `state` | `sketched` · `scoped` · `designed` · `promoted` · `delivered` · `dropped` |
| `rationale` | why it sits where it sits, in prose. The sentence the file already carries |
| `design` | path to its design record, when it has one |
| `promoted_to` | the story id, once promoted — the join back to execution |
| `parked_behind` | another roadmap id, when the ordering has a reason |

`state` is stored, unlike a container's planning stage which is **derived**
(`planning-lifecycle-stages`). That difference is deliberate and worth stating: a
container's rung is a fold over records that already exist, so computing it cannot lie.
A roadmap item's state is a judgement about work that has not started — there are no
records to fold, so someone has to say it.

## Promote
    wecode roadmap promote <id> --as <story-id>

Creates the story, copies the objective as its title and the rationale into its first
design note, sets `promoted_to`, and moves the item to `promoted`. The row stays: a
roadmap that forgets what it delivered cannot answer *"why did we build that"* six
months later, which is the question a roadmap exists for.

**Promotion is one-way.** A story that stalls is not demoted back to the roadmap — the
roadmap says what we intend, the plan says what we are doing, and moving a thing
backwards between them would make both unreadable. An abandoned story drops, and a new
roadmap item is written if the intent survives.

## Migration, and the file's death
`wecode roadmap import docs/roadmap.md` reads the table and the sections beneath it,
one row per item, then the file is deleted in the same commit. It is not kept in sync:
two copies with no check between them is the defect this whole design removes, and the
file said as much when it was written.

## What this supersedes
`draft-containers-roadmap` (#555) proposed deriving the roadmap from draft containers.
It is superseded rather than amended: a derived roadmap cannot hold priority, rationale,
or the parked/blocked distinction, and those are the three things the hand-kept file
proves an operator needs.
