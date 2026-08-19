# manual-task-steps — a person's task arrives with its instructions

The owner, holding #238: "I don't have instruction on the ticket — what should I do
step by step? Why is that?"

Because a task carries a title and nothing else a notification can show. For an
agent that is right — the envelope assembles context at dispatch. A person's task IS
its dispatch message, so the steps must be written at creation and carried to the
phone.

## The shape

- `wecode task add x --by person --steps <file.md>` (or reading
  `docs/wecode/<task>/steps.md` when present — design picks one and argues it).
  Stored with the task; a manual task with no steps draws an advisory, since a bare
  title on a phone is this exact complaint.
- The notification for a person's task carries the steps in the message body, and
  as the attached document when they run long — both paths exist in notify today.
- `wecode show <task>` prints them; the board's preview... is gone, so `show` and
  the phone are the two readers.

## Not doing

- No wizard, no per-step ticking. One document, one Complete.
