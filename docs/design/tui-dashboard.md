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
