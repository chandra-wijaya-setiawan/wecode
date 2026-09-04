---
class: hand-tended-state
subject:
  - "crates/wecode-cli/src/telegram.rs"
  - "crates/wecode-cli/src/commands/gov.rs"
---
# Orchestrating from the phone

Asked for 4 Sep 2026. What exists already, and what is missing.

## What already works
| Capability | Where |
|---|---|
| wecode sends a notice when a task needs a person | `notify.rs` + `[telegram] send` |
| an inline button signs or declines an approval | `telegram::tap_of`, `Verdict` |
| a typed reply signs: `approve merge cache-tests` | `telegram::verdict` + `named_kind` + `task_named` |
| the token never enters wecode | `~/.wecode/telegram-token`, mode 600, read by the configured `curl` |

So **approval from the phone is done.** What is missing is everything else an
operator does: asking, not just answering.

## The gap
Today the channel is a doorbell with two buttons. The board, the reasons, the
queue and the dispatch decision all live on the machine. An operator away from
their desk can say *yes* but cannot ask *why is nothing running*, which was the
question actually asked six times on 3–4 Sep.

## The decision
**The channel is a view onto the ledger, not a second brain.** Every message is
parsed into an existing wecode verb and answered from the store — the reply is
the same text `wecode board` would print, wrapped for a phone. No new state, no
conversation memory, no natural-language planning.

Five verbs, chosen because they are the five questions the owner actually asked:

| Message | Answers with |
|---|---|
| `status` / `?` | the dashboard's summary sentence: healthy, or the cause when nothing runs |
| `board` / `what` | the needs-human rows, each with the command that clears it |
| `why <task>` | the blocker chain — what it waits on, and whether that thing can ever finish |
| `run <task>` / `hold <project>` | the verb, executed, with the ledger line as the receipt |
| `agents` | open runs with their beat age, so a stalled one is visible from a phone |

## What this must NOT become
- **No free-form instruction.** *"fix the login bug"* is planning, and planning is
  a task with a scope and a signature. The channel refuses it and says so.
- **No second source of truth.** Nothing is stored per-chat: reconnecting shows
  the same state, because the state was never in the chat.
- **No wider authority than the seat that sends it.** A message is an act by the
  operator whose token it is; the Broker judges it exactly as it judges a keystroke.
