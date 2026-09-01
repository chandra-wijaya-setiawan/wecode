---
class: record
---
# ADR-0007: `hold` suspends work; `archive` files it away

Status: accepted (1 Sep 2026)

## Context
The owner wanted the STE project out of dispatch while another orchestrator
drove it, and the only tool was `archive` — which HIDES a project from the
cockpit, because its meaning is "done with this, file it". Hiding live work is
the wrong answer: it disappears from view exactly while someone else is
changing it, and it reappears only if you remember it exists.

## Decision
A third state, on projects and tasks alike:

| state | dispatch | board | meaning |
|---|---|---|---|
| live | yes | shown | ordinary work |
| **hold** | **skipped** | **shown, marked** | deliberately suspended — someone else's turn, blocked on the outside world, or waiting on a decision |
| archived | skipped | hidden (`--all`) | finished with; history only |

`wecode hold <id>` / `wecode unhold <id>`. Held work stays visible with its
reason, because a suspension nobody can see is indistinguishable from neglect.

**A held task is not competition for a scope.** It cannot be dispatched, so the
overlap check skips it — which also gives an honest way to take a task out of
the collision graph without deleting or archiving it. (Weakening the check for
DRAFTS was tried on 1 Sep and correctly refused by six tests: a draft may be
signed at any moment, a held task may not.)

## Consequences
Three states need three renderings, and `hold` must carry a reason or it decays
into a second archive. The loop's skip list grows by one condition. Gains: live
work stays visible while suspended, and the collision graph shrinks by whatever
is explicitly on hold rather than by whatever someone hid.
