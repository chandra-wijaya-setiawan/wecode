---
class: hand-tended-state
subject:
  - "crates/wecode-cli/src/tui.rs"
  - "crates/wecode-cli/src/tui/**"
---
# The dashboard is the cockpit's front page

Drawn by the owner, 4 Sep 2026. `wecode tui` opens on this, not on the board: the
first question an operator has is never "what tasks exist", it is "is anything
wrong, and is anything waiting for me".

## Layout

    ┌ wecode status ─────────────────────────────────────────────────┐
    │ Summary: one sentence — healthy, or why nothing is running     │
    │  • service 1 — running        • service 4 — down               │
    │  • service 2 — down           • service 3 — running            │
    └────────────────────────────────────────────────────────────────┘
    ┌ Agent(4) ──────────────────┐  ┌ Need you(2) ──────────────────┐
    │ • claude-code #75 feat x   │  │ • need input  #123 feat a     │
    │   — stalled                │  │ • need approval #75           │
    │ • pi-dev #123 chore x      │  │                               │
    │   — running                │  │                               │
    │ detail: press v-a          │  │ detail: press v-y             │
    └────────────────────────────┘  └───────────────────────────────┘
    ┌ Blocked(4) ────────────────┐  ┌ Roadmap(3) ───────────────────┐
    │ • #74 feat x waits for     │  │ • #72  story x                │
    │   #71 feat y               │  │ • #104 story y                │
    │ • pi-dev #123 chore x      │  │                               │
    │ detail: press v-g (dag)    │  │ detail: press v-r (dag)       │
    └────────────────────────────┘  └───────────────────────────────┘
    ┌────────────────────────────────────────────────────────────────┐
    │ home v-h · dashboard v-d · agents v-a · needs-you v-y · …      │
    └────────────────────────────────────────────────────────────────┘

## The six rules the drawing states

1. **Six panes, one screen.** Status full width on top; then a 2×2 grid of Agent,
   Need you, Blocked, Roadmap; a shortcut bar at the foot. Nothing scrolls on the
   front page — a pane that overflows shows its first rows and a count of the rest.
2. **Every title carries its count** — `Agent(4)`, `Need you(2)`. The number is the
   answer to the question the pane exists to ask, so it is in the title, not buried.
3. **Every pane names the key that opens it**, in the pane, not only in the bar. A
   discoverable cockpit does not require remembering.
4. **The summary is a synthesised sentence, not a status word.** The owner's own
   example is the specification: *"System is healthy; no agent are running due to
   blocked by approval"* — it must name the CAUSE when nothing is running. This is
   `idle-inspector`'s job, rendered here.
5. **Blocked and Roadmap open as DAG diagrams**, because both answer a shape
   question — what waits on what — and a list cannot show a shape.
6. **`wecode tui` opens here.** The board is `v-h`, one key away.

## What each pane draws from
| Pane | Source |
|---|---|
| Summary + services | `idle-inspector`, `background-services-indicator` |
| Agent(n) | `task_executions` open rows, with harness, task, and beat age → `stalled` when the beat is stale |
| Need you(n) | `tui/approvals.rs::owed` — already built |
| Blocked(n) | `task_depends_on` where the prerequisite is unfinished, and its status |
| Roadmap(n) | open epics and stories with their completion |

## As built, 4 Sep 2026

`crates/wecode-cli/src/tui/dashboard.rs`. `Screen::Dash(Panel)` carries the front page and
the three screens its panes open; the stack's bottom is `Panel::Dashboard`, which is where
rule 6 lives. `v-y` is the approvals panel at full width — the same rows, room for the
command. `v-g` and `v-r` are indented trees over the plan's own edges, depth-capped at 8
so a cycle somebody has just written cannot hang the instrument they opened to find it.

Two sources in the table above are decided and not yet built, so the module computes them
itself until they are. Neither substitute may outlive the real thing: three surfaces that
decide idleness separately are three that will disagree, and the phone is the one believed.

| named source | what stands in | what it cannot say |
|---|---|---|
| `idle-inspector` | `dashboard::cause` — its ranking, less rows 3 and 4 | nothing wecode stores says a `wecode loop` is alive, so *dispatchable and nothing running* stands in for row 2 and cannot tell an absent driver from one that started a second ago |
| `background-services-indicator` | `dashboard::services` — store, supervisor, and each reach the profile configures | whether a configured reach *answers*; that needs a probe, which is `wecode doctor`'s and may not run every frame |

Two readings the drawing left open, and how each was settled:

| question | settled |
|---|---|
| is a workspace with no Telegram *degraded*? | no — a reach nobody configured is not listed. A front page that opened amber on a solo profile doing what it was told teaches its reader to stop believing the word |
| does *healthy* cover idleness? | no. `healthy` is the services' word; whether anything is **moving** is the clause after the semicolon. That is what lets the owner's own example — healthy, and nothing running, and the cause named — be one sentence |

## Revision after first use (5 Sep)

The owner ran it and asked for three changes. All three are about the same thing:
the panes were sized by the grid, not by what they hold.

1. **Content is white; only the frame carries colour.** Blue and red body text on a
   black terminal is hard to read, and the box already says which pane it is by its
   border and title. Body rows render in the default foreground.
2. **Semantic colour survives, and only that.** `running` green, `down` red,
   `stuck` and `needs-approval` in their category colour — those words *mean*
   something, so they keep their colour where a task id does not.
3. **The top row is capped at ten rows and shrinks to fit.** Agent(1) and
   Need you(3) held one and three lines inside a pane thirty deep; Blocked(39) and
   Roadmap(43) were truncated at `… and 14 more` directly beneath. Height is
   `min(rows, 10)`, and every line the top row does not use goes to the bottom row.
   A dashboard whose empty half is the half with nothing to say is upside down.
