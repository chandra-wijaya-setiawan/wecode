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
| a message asks, and is answered from the store | `telegram::asked` + `commands::gov::from_the_ledger` |

So **approval from the phone is done, and four of the five questions are answered.**
What is missing is taking work: `run` and `hold` — see below.

## The gap this closed
The channel was a doorbell with two buttons. The board, the reasons and the queue all
lived on the machine, so an operator away from their desk could say *yes* and could not
ask *why is nothing running* — the question actually asked six times on 3–4 Sep.

## The decision
**The channel is a view onto the ledger, not a second brain.** Every message is
parsed into an existing wecode verb and answered from the store — the reply is
the same text `wecode board` would print, wrapped for a phone. No new state, no
conversation memory, no natural-language planning.

Five verbs, chosen because they are the five questions the owner actually asked:

| Message | Answers with | State |
|---|---|---|
| `status` / `?` | the dashboard's summary sentence: healthy, or the cause when nothing runs | built |
| `board` / `what` | the needs-human rows, each with the command that clears it | built |
| `why <task>` | the blocker chain — what it waits on, and whether that thing can ever finish | built |
| `agents` | open runs with their beat age, so a stalled one is visible from a phone | built |
| `run <task>` / `hold <project>` | the verb, executed, with the ledger line as the receipt | not yet |

## How the four that are built are answered
Every answer is composed in `commands::gov::from_the_ledger` out of `board`'s own
functions — `attention_groups`, `Group::line`, `task_vitals` — so a reply on a phone and
`wecode board` at a desk cannot disagree. `telegram::asked` is the whole grammar.

| Decision | Why |
|---|---|
| the verb has to be the whole message, `why <task>` excepted | *"what is this one doing?"* is a person talking to a person; `what` alone is somebody asking the bot |
| a leading `/` lifts that, and is what triggers a refusal | Telegram's own way of addressing a bot: `/fix the login bug` was meant for wecode, so it gets an answer — no |
| a question passes the same account check a signature does | the plan, the queue and the ledger are the company's business; a stranger gets nothing, and is answered nowhere |
| no ledger record for the asking | a question is a read, and `wecode board` writes none either |
| the answer goes back through `[telegram] answer` | wecode holds no token: the chat a question came from arrives as `WECODE_TELEGRAM_ASKED`, empty for every receipt, so a hook written before questions existed still does its job |

`run` and `hold` are left out deliberately for now: both *move* work, so each wants the
Broker call, the dry-run and the receipt a signature already has, and none of that is
reading the ledger. Until they land, the board's own rows carry the command to type.

Two pages owe this a section and did not get one, being outside the scope that built it:
`docs/reference/config/telegram.md` (the grammar, and the `sendMessage` branch a hook
needs for `WECODE_TELEGRAM_ASKED`) and `wecode --help`.

## What this must NOT become
- **No free-form instruction.** *"fix the login bug"* is planning, and planning is
  a task with a scope and a signature. The channel refuses it and says so — out loud,
  because an instruction nobody answered reads exactly like one somebody took care of.
- **No second source of truth.** Nothing is stored per-chat: reconnecting shows
  the same state, because the state was never in the chat.
- **No wider authority than the seat that sends it.** A message is an act by the
  operator whose token it is; the Broker judges it exactly as it judges a keystroke.
