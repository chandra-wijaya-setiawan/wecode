# What a board with nothing on it says

Status: **decided, not built**.

Notes for `idle-inspector-design`. What the build step knows about this decision it knows
from this file.

## The problem

An empty group prints `—` (`board.rs:739`) and the footer prints `silence on green`
(`board.rs:943`). A workspace that finished everything, one whose tasks are all
unassigned, one whose queue is full and unsigned, and one whose operator forgot to start
`wecode loop` all render as four dashes and a green footer. The one idle state wecode
does explain is the empty workspace — `no projects yet — wecode project add …`
(`board.rs:903`) — which is the shape of the answer the rest of them want.

The distinction that matters is **at rest** against **stalled**: idle because there is
nothing to do, or idle because something is stopping it. Today both look the same, and
the second is the state the board exists to catch.

## Idle means MOVING is empty

Nothing is `running` or `verifying` — the group's own definition in
`docs/reference/board.md`. Not "nothing landed today": a workspace three minutes into a
run is not idle, and a workspace whose last merge was Friday is not stalled if six agents
are working now.

## One line, ranked, where the dash was

The board answers *why is nothing moving* with a single line, in the `MOVING` block, in
place of its `—`. One line and not four: three of the four groups are empty for the same
reason, and a reader who has to assemble a cause from four cells is doing the inspector's
job. The four headings stay where they are, for the reason they were drawn empty in the
first place.

At rest keeps today's glyph and adds words: `—  all work is done · 2 ready to close`.
Stalled takes `⏸`, the loop's own mark for a pause, in amber: `⏸ nothing is dispatching`.
Amber and not red — nothing has broken, and an alarm that fires every lunchtime is an
alarm nobody reads.

## The causes, in order

First match wins, and the order is what makes the line useful: what the rows above cannot
say comes before what they already imply.

| # | fires when | the line | class |
|---|---|---|---|
| 1 | no projects | `no projects yet — wecode project add …` (unchanged) | at rest |
| 2 | `dispatchable` is non-empty and no driver has beaten for 60s | `nothing is dispatching — N queued, no loop for 6m · wecode loop` | stalled |
| 3 | every queued task is unsigned for admission | `N queued, none signed — wecode approve admission --task <id>` | stalled |
| 4 | every slot is held by an open run whose supervisor has gone quiet | `N slots held by runs nobody is watching — the next pass closes them` | stalled |
| 5 | open leaves exist and none names a post | `N to assign — wecode assign <id> --to <post>` | stalled |
| 6 | `NEEDS YOU` has rows | `N rows above want you` | stalled |
| 7 | open leaves, all behind unfinished prerequisites | `N waiting behind <id>` | at rest |
| 8 | a project has no tasks | `nothing planned in <p> — wecode task add <p> "<title>"` | stalled |
| 9 | nothing open anywhere | `all work is done — N ready to close` | at rest |

Row 2 counts the queue from `scheduler::dispatchable` at full width rather than through
`free_slots`, so a phantom `running` row cannot hide a missing driver behind a queue that
reads as empty — the exact case row 4 names.

Row 4 is a narrow window by construction: a live loop suspects a run at five minutes of
supervisor silence and closes it a minute later, per `heartbeat-cleans-stalled-agents`.
It stays because the operator who reaches it is usually the one whose loop is *not* live,
so nothing is coming to close those slots — read from the board instead of from
`unfinished_executions()`.

Row 6 is last but one because the rows are already on the screen; the line still prints,
because a person reading a screenshot needs to know the silence is accounted for.

## One computation, three readers

A new module, `crates/wecode-cli/src/idle.rs`, pure over what `board::portfolio` is
already handed. `wecode board`, `wecode tui` and `wecode loop` all print its line, the way
`commands/view.rs` already draws the TUI's rows from `board::attention_groups` rather than
reading the statuses a second time. Three surfaces that compute idleness separately are
three surfaces that will disagree about it, and the phone is the one that gets believed.

The nine causes are a closed list — an enum, its words in one `match`, and a test holding
the list to `docs/reference/board.md`, exactly as the needs-human categories are held
today. The loop's own copy drops row 2 by construction: it is the driver, so it can never
report its own absence, and that is the cheapest available check that the other eight rows
do not depend on it.

## The one fact the store does not hold

Rows 1 and 3 through 9 are computable from the plan, the ledger and the playbooks. Row 2
is not: **nothing wecode stores says a driver is alive.** The loop opens no session, writes
no row and touches nothing between dispatches, so an idle loop and an absent loop are the
same database.

**Decision: the driver beats in the store.** One table, `drivers(id, host, started, beat,
closed)`, one row per `wecode loop` process, stamped every pass and closed on exit; a
driver is alive if `closed IS NULL` and its beat is inside 60 s — twelve passes at
`scheduler::INTERVAL`, wide enough for a slow `[telegram] fetch` and narrow enough that a
board opened a minute after the laptop woke tells the truth.

Four cheaper answers, each wrong:

| instead | why not |
|---|---|
| the loop opens an autonomous **session** and touches it | `ctx::actor` picks the single live session when none is named; a permanent second one makes every un-flagged command fail with *several sessions are active* (`ctx.rs:329`), and there is no post to resolve it to |
| a **beat file** under the run root | the database is the event bus, and this fact is read by a process other than its writer; a run root is one machine's, so a driver anywhere else reads as absent |
| **pid liveness** | already refused twice, for the same reason: after a reboot `kill(pid, 0)` answers about somebody else's process |
| print the **question** — *is `wecode loop` running?* | the line is read from a phone, which is the one place the question cannot be answered |

The beat is the driver's, not the supervisor's. `task_executions.beat` says a run is
watched; this says a dispatcher exists at all, which is true when there are no runs — the
state row 2 is about.

## Where the build lands

| | |
|---|---|
| store half first | `drivers` is the next `schema::VERSION` bump (14 today) plus its `UPGRADES` entry; crate order puts it in its own subtask ahead of the cli one |
| a new module, not more `board.rs` | `board.rs` is 1599 lines against `src=1700` in `.max-lines`, and the ratchet reads the whole worktree |
| module and all three callers in one task | `wecode-cli` has no lib target, so a function nobody calls fails `-D warnings` and no `tests/` file can reach it |
| `docs/reference/board.md` in the write scope | it is `hand-tended` with `board.rs` as its subject, so `wecode verify` refuses the diff without it; add `idle.rs` to that subject list |
| no new verb | a command changes the generated `commands.md` and `schema.md`; the reading belongs on the board a person already has open |

Acceptance for the eye: on a workspace with three ready, assigned tasks and no loop
running, `wecode board` must not print `MOVING` followed by `—`.

## What would show this was decided wrong

An operator reads the line, types the command it printed, and nothing moves — the rank
named a cause that was not the binding one. Watch row 6 in particular: if it is what the
board says most days, the ordering is wrong and the rows above should carry it alone.

## What is not here

No history — a board says what is true now, and *idle for three days* is a report. No
action: the inspector never dispatches, never signs, never closes a stale row. No wiring
diagnosis; a hook that does not fire or a harness that will not start is `wecode doctor`'s
question, and this line would only be its second, worse account. No per-project idle
lines: one board, one reason, and `wecode board <id>` for where.
