# human-task — a task whose agent is a person

The owner's words: "task that me, human, to do the steps; send to Telegram with the
steps to do; then a Complete button to feed back that it is done. This is dependency!"

The specimen that forced it: watching real fares needs a Travelpayouts token, which
only the owner can create. That dependency currently lives in conversation — untracked,
unreminded, and invisible to the graph that is supposed to hold exactly this.

## The model: not a new system, a new kind of seat

A task assigned to a post whose occupant is a user rather than a harness. Everything
existing applies unchanged:

- **admission** — it needs a singular title and (usually) no write scope: its
  deliverable is a fact in the world, so acceptance may be empty or a command that
  can check the fact (`test -n "$TRAVELPAYOUTS_TOKEN"` style probes are legitimate).
- **dispatch** — instead of spawning an agent, send the notification: title, the
  steps (the task's own document, carried the way designs already are), and two
  buttons: **Complete** and **Hold**.
- **completion** — the Complete tap is the exit code. Recorded in the ledger under
  the person's seat, like any other verdict. Hold is a refusal, recorded as one
  (refusal-record already built this).
- **the graph** — depends_on works untouched: tasks blocked on the human task
  unblock on the next tick after the tap.

## Honesty about ground truth

An agent's word is inadmissible; a person's tap is different in kind — the owner
attesting their own dependency is the authority, not a report about it. But where a
check is cheap, prefer it: a human task MAY carry acceptance commands, and if it does,
Complete runs them and a failure says so in the chat instead of marking done.
"Tap says done, probe agrees" is the strongest state this can reach.

## What the notification must carry

The steps, in the message — not a link to a file the phone cannot open. Numbered,
short, written at task-creation. The existing document-attachment path (notify.sh
sends markdown) already fits.

## Reminders belong to digest, not here

An untapped human task appears in the digest's needs-you section every interval.
No separate nag machinery.

## Not doing

- Not delegation to arbitrary humans: the solo profile has one user; posts already
  model more when they come.
- Not forms, not multi-step wizards in chat. One task, one Complete.

## Convergence note

Two sessions asked for this independently: this brief (claude-code, from the
Travelpayouts-token dependency) and task #224 manual-task-kind (opencode, from the
cloud-credentials work, where "a human must create the resource" is the same shape).
One feature, two proofs it is needed. The asks compose rather than compete:

- #224 contributes the state: a kind that reaches **blocked-on-human** instead of
  dispatching, and advances only on an operator signature.
- this brief contributes the surface: the steps travel in the Telegram message,
  **Complete** is the signature, **Hold** is a recorded refusal, optional acceptance
  probes run on Complete, and the digest carries untapped ones as reminders.

One correction to #224 as filed: its write scope names
`crates/wecode-cli/src/scheduler.rs`, which does not exist in this tree — likely
drawn from a stale binary's-eye view. The design step should name the real dispatch
path (`crates/wecode-cli/src/commands/exec.rs`) and the telegram/notify surface.
