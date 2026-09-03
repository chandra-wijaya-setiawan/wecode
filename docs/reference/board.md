---
class: hand-tended
subject:
  - crates/wecode-cli/src/board.rs
---

# The board

`wecode board` — the snapshot, the same four columns at every level: `what`, `status`,
`spend`, `needs you`, behind a `#` gutter carrying the short number. `wecode tui` is the
same view, live, drawn from the same grouping. The heading says *needs you* because it
addresses whoever is reading it; the code calls the group **needs-human**.

## The four groups

A row is in exactly one, read in this order, and each answers a different question with
the same cell. Five rows each, then a count of the tail.

| group | holds | the cell says |
|---|---|---|
| `NEEDS YOU` | a status that stops for a person, or a dead-end prerequisite | the category, and the command that clears it |
| `MOVING` | `running`, `verifying` | the newest act in the ledger — what it is doing |
| `NEXT` | anything else still open | what would move it: `after <id>`, `queued for <post>`, `unassigned` |
| `LANDED` | `done`, newest first | the title somebody wrote when they asked for it |

`dropped` is in none of them: a decision already taken, which the tree below still
records.

## What a needs-human row prints

`<category> · <command>`. The category is a closed list; the command has the id in it
already, so it can be typed as printed.

| category | the row | the command |
|---|---|---|
| `needs-approval` | an agent's work passed and is unmerged | `wecode merge <id>` |
| `needs-approval` | a `design` task, which is signed rather than landed | `wecode approve design --task <id>` |
| `yours to do` | a task marked `--by person`: nothing ran, the doing is the reader's | `wecode status <id> done` |
| `needs-input` | the agent asked something only a person can answer | `wecode status <id> ready` |
| `failed` | attempts exhausted; what happens next is a decision | `wecode run <id>` |
| `stuck` | a prerequisite that `failed` or was `dropped` | `wecode status <blocker> waiting` |
| `stuck` | a prerequisite that does not exist | `wecode task add <id> --amend --no-after` |

Neither half is decided in `board.rs`. The category is `render::waiting_word`, which
already answers *what is this row asking*; the command follows `telegram::implied`, which
decides what a bare `approve` in a chat signs — so the board cannot offer a move the
channel behind it would refuse.

## Health is a colour, not a column

Red for an alarm or a breached budget, amber for a defect, a denial, a stall or anything
waiting on a person, green otherwise. It colours the needs-human cell, because every
cause of it already writes words into that cell on the task's own row in the tree. A row
lifted into a group prints its group's answer instead — the incident still colours it,
and the words for it are in the tree below and in `wecode board <id>`.

## The project row

| cell | reading |
|---|---|
| `status` | the declared state, then the standing: `> active 2/5` — leaves done over leaves there are |
| `needs you` | what the fraction cannot say: `N to answer`, `N stuck`, `N to assign`, `ready to close`, `quiet Nd`, `no tasks` |

## See also

`docs/reference/commands.md` for what each command does · `docs/features.md` on stuck
work · `crates/wecode-cli/src/tui.rs` for the live form, which draws its rows from this
module rather than reading the statuses a second time.

A held row stays on the board, marked, and is skipped by dispatch — the difference
from archived, which hides it (ADR-0007).
