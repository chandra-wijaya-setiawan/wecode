# tui-v2 — from a list with screens to an instrument

The owner's verdict on tui-nav: "is this the best you can come up with? … it is lacking,
you basically just added a group on top." Measured against current practice, that is
correct. What exists is one layout archetype — a drill-down stack with vim keys, a help
overlay and a footer — out of the seven the field uses, and none of the three features
that make k9s and lazygit fast in another person's hands.

Grounding: the Terminal Renaissance principles (hyperbliss.tech, Apr 2026) — spatial
consistency, progressive disclosure, semantic color in layers, async everything, never
poll — and the k9s/lazygit interaction model (`/` filter, `:` palette). The four-layer
key hierarchy (arrows/enter/esc → vim motions → single-letter actions → composed) is
already half-present; this brief completes the half that is missing.

## In order of daily pain

1. **`/` filters the current screen.** Incremental, matches id, title, project, status,
   assignee; esc clears. Fifty tasks are already on the board — scrolling is not a
   search. The cursor stays put when the filter narrows past it.

2. **`:` is the palette.** `:215` and `:board-brief` jump to that task's screen from
   anywhere; `:korean` a project; `:needs` `:moving` `:landed` the groups. Tab
   completes. Unknown input says so in the footer rather than dinging. This is what
   short numbers were built for.

3. **Preview beside the list.** On HOME and PROJECT, the selected row's summary renders
   in a right-hand pane — status, spend vs budget, blockers, last attempt's cause —
   so reading does not cost a descend and a return. The pane collapses below ~100
   columns; the list is never squeezed to make room.

4. **The TASK screen tails.** For a running task, the pane streams the agent's output
   live (the harness stream wecode already captures); for a finished one it shows the
   report. This is "what is it actually doing", answered properly.

5. **Wake on change, not on timer.** The store is one SQLite file; the loop that
   redraws should wake on its mtime/WAL change (and on a stream write), not on a
   fixed tick. A quiet company costs nothing to watch.

6. **Color in layers.** Monochrome must remain fully usable (symbols carry state:
   ✓ ⋯ > ! x); 16-color semantic tokens above that — status.good, status.blocked,
   spend.over — one place, themed, never hex scattered through render code.

## What survives unchanged

The three screens and their keys (tui-nav), the attention groups (board-brief), the
snapshot `wecode board` for pipes. Spatial consistency is the point: nothing moves,
things are added beside what exists.

## What this is not

- Not mouse support, not panes the user arranges, not theming config.
- Not a rewrite: ratatui idioms already in use (constraint layout, immediate mode)
  carry all of the above.
- Not new data — every pane renders what plan, ledger and streams already hold.
