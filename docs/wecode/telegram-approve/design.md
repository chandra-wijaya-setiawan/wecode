# Signing an approval from a Telegram reply

Status: **built**. Written alongside the implementation, like
[notify-hook](../notify-hook/design.md), which this is the second half of.

## What went wrong

The notify hook closed half a loop and made the other half obvious.

A task now stops for a person at 02:14 and the operator's phone says so. Then nothing
happens, for the same reason as before: the signature lives at a terminal. Using wecode on
itself, the message arrived, was read, and the queue still stood still until morning — the
push moved the *knowing* forward by six hours and the *doing* not at all. An attention
budget of five open items is not five items if four of them are waiting on somebody who is
holding the notification about them in their hand.

So a reply signs it. `approve`, typed under the message wecode sent, becomes the same
ledger record `wecode approve` writes.

## The reply is the same signature

The most important decision is what is *not* here: a second kind of approval.

A reply goes through `commands::gov::sign` — the function `wecode approve` was split into
for this — so it makes the same Broker call, takes the same design transition, and writes
the same `approve` row. `merge`, `run`, `start` and the dispatch gate read that row and
cannot tell how it arrived. Anything else would mean two answers to "is this signed", and
the two would disagree the first time either changed.

A "telegram signature" that gates read differently would also be an invitation to make it
weaker, which is exactly backwards. The record is the same because the authority is: the
post's, not the channel's.

The one thing the reply does add is provenance. The session on the record is `telegram`,
the way `--as` records `adhoc`, so the ledger says how the signature arrived even though
it does not change what it is.

## The account identifies; the post authorises

A reply carries a numeric Telegram account. It resolves to the `[[users]]` entry that
names it in `telegram`, or to nobody at all — there is no fallback seat, no "unknown
sender" post, nothing a stranger who finds the bot can reach. That is the entire identity
check, and it is worth being clear about what it proves: that Telegram believes that
account sent the message. wecode did not authenticate anybody.

What that person may then sign is their post's `approve` list, decided by the Broker at
the moment of signing. An engineer's seat replying `approve merge` is refused and the
refusal is recorded, exactly as it would be at a terminal. Naming an account in
`company.toml` is therefore not a grant of anything: it says *this account is this
person*, and the org chart already says what that person may do.

Two users giving the same id is refused at load. A reply has no name on it, so a shared
account would be signed as whichever user the file happens to list first — a signature
attributed to somebody who did not give it, decided by line order.

## A command, not a client

`[telegram] fetch` is a command line the operator writes. wecode runs it, reads its stdout
as a `getUpdates` response, and tells it how far reading has got through
`WECODE_TELEGRAM_OFFSET`.

wecode has no HTTP client, no bot token, and no dependency that would give it either. The
credential stays in the operator's shell where their other credentials are. It also means
the whole feature is testable against `cat replies.json` — every end-to-end test here
proves the real path, because substituting the fetch *is* the design rather than a seam
cut for tests. And a chat tool that is not Telegram needs a shim that prints the same
shape, not a change here.

The offset is passed in the environment rather than substituted into the line, for the
notify hook's reason turned up one notch: the line has a bot token in it, and wecode
should not be in the business of quoting a URL that carries a credential.

The parser is tolerant about updates and strict about the envelope. Telegram adds fields
between versions, so insisting on a known shape would break on a message with a photo in
it; but `ok: false` is the API saying it did not answer, and reading an empty `result` out
of that would report a quiet channel to somebody whose token is wrong.

## Read once, whatever came of it

The channel hands the same message back until it is told not to, and `wecode loop` reads
it every five seconds. Without a cursor, one `approve` is a signature per pass, forever.

So `inbox_cursor` in `wecode.db` holds the highest update id read, per channel. It cannot
be derived from the ledger: a signature records that a holder approved something, not that
a *message* was looked at, and the two come apart in both directions — a reply saying `no`
writes no signature and must still never be re-read, and a task can be signed at a terminal
with no message involved at all.

Every update advances it, whatever happened. Signed, refused by the Broker, naming no
task, not a decision, not even a message — all of it is *read*. An update left behind
because it could not be acted on would be the same complaint on every pass forever, which
is how a report becomes something nobody looks at.

The cursor is also applied to what comes back, not just asked for in the fetch. What
honours the offset is a command line the operator wrote: one that leaves the parameter
off, or a `getUpdates` retried after a network error, hands the same batch back. Read-once
has to be a property of wecode, because wecode is the thing that would sign twice.

It moves forward only. Replaying an older batch — by hand, or from a second reader — must
not reopen messages already consumed.

## What a bare "approve" means

The reply is one word, and the notification it answers is prose. So what is signed is read
off the task: `merge` at `needs-approval`, `design` for a design task there, `admission`
for one the dispatch gate is holding. A task with nothing outstanding is refused rather
than given a default — signing a merge for work that is still running would be a signature
given before there was anything to look at.

`approve merge` overrides the inference, and naming a task in the reply overrides the one
in the message being answered. Both exist because the ordinary case is inference and the
escape hatch costs a word.

The task itself comes from the message being replied to, which is the notification and
names it. Two known task ids in one text is refused rather than resolved: whichever one
was picked, half the time it would be the other — and a digest listing everything waiting
is exactly the message somebody replies `approve` to.

`no` signs nothing and changes no status. It is tempting to make it `dropped` or reopen
something, but "no" to a merge and "no" to a design mean different things, and a one-word
reply is too blunt to pick between them. Withholding the signature is already what saying
no does; what the reply adds is that the message has been answered rather than left in the
channel.

Anything that is not clearly yes or no is chat. A channel people talk in is a channel
wecode has to be quiet in — this is not a language model, and guessing at "I approve of
that" is how a signature gets given by accident.

## Where it runs from

`wecode loop` drains the channel every pass, between promotion and dispatch.

After promotion because a bare `approve` is read against the task's state: one still
recorded as `waiting` has nothing outstanding, and would be answered with a refusal one
second before becoming the thing that was meant. Before dispatch because a signature that
arrived while the loop slept should release the work on the pass that finds it, not the
one after.

It prints only when it did something. The loop's pauses are printed every pass because
they are standing conditions the operator is holding; a poll that says `nothing to sign`
five seconds apart forever is a loop whose output nobody reads.

A fetch that fails is `⚠ telegram: …` and the pass continues, like a notify hook that
failed. A channel that cannot be reached is a reason to keep working unattended, not a
reason to stop. One bad reply is reported and the ones behind it are still read.

`wecode telegram` is the same drain by hand, and `--dry-run` says what the waiting
messages would sign while moving neither a signature nor the cursor — which is how you
point it at a real bot the first time.

## What is not here

**No polling of anything else.** One channel, named in one block. A general "inbox" with
adapters would be a second configuration language for a feature whose whole point is that
the operator already writes the command.

**No sending.** The notify hook sends; this reads. Keeping them separate is what lets the
outgoing message be anything at all — a desktop notification, a file, a Telegram
message — without this having to know which.

**No conversation.** wecode never replies in the channel, so a refused reply is only
visible in the loop's output. That is a real gap and a deliberate one: replying means
knowing which chat to reply in, which is state this does not keep, and a bot that talks
back is a bot that needs to be muted.

**No second gate on the reply.** No confirmation step, no "type the task id to confirm".
The reply is a signature and the Broker is the gate; a confirmation step would be
security theatre over a channel whose real risk is somebody else holding the bot token,
which a second message would not help with.

**Nothing decided by the message text beyond yes, no, a kind and a task.** The note field
on the signature is deliberately left empty: the ledger already carries what decided it,
and copying sender-controlled prose into an approval record buys nothing.
