# tui-input-lag — keys queue behind frames

Owner's report: j/k lag. Diagnosis, from the event loop in tui.rs:

    draw → poll(200ms) → read ONE event → maybe reload → draw …

One key event is processed per full-frame draw, so key-repeat (~30/s) outruns the
loop and events queue; a held j moves one row per frame. On top of that the 1500ms
reload (load_plan + the whole audit query, against a database `wecode loop` is
actively writing) lands mid-scroll and costs a rebuild.

The fix, in the ratatui idiom:

1. **Drain before drawing.** After the blocking poll returns, keep reading while
   `event::poll(Duration::ZERO)` says there is more — apply every pending key —
   then draw once. A burst of twenty j's becomes one frame, not twenty.
2. **Defer the reload while input is flowing.** A reload that would land within,
   say, 300ms of the last keystroke waits; scrolling stops stuttering and the data
   is never more than a beat behind.
3. Nothing else. No async runtime, no dirty-flag rewrite; the 200ms idle poll and
   the 1500ms rhythm stay.

Acceptance for the fingers: holding j on the wecode-loop tree must track the key
repeat rate with no visible rubber-banding while `wecode loop` runs.
