# The answer coming back

`[telegram]` is the return leg of the [notify hook](notify.md): `fetch` reads replies,
`answer` says what a tap did. Both are your own command lines — wecode holds no bot token
and speaks no HTTP.

## Signing from a reply

The notify hook is half a loop: it says a task has stopped for you, and the signature
still needed a terminal. `[telegram] fetch` is the way back — reply `approve` under the
message, and the next pass of `wecode loop` signs it. On a phone, [tap a button
instead](#signing-by-tapping-a-button).

```toml
[telegram]
fetch = "curl -sS -m 20 \"https://api.telegram.org/bot$TG_TOKEN/getUpdates?offset=$WECODE_TELEGRAM_OFFSET&timeout=0\""
timeout = "30s"                   # killed at this, like the notify hook

[[users]]
name = "Chandra"
post = "chief"
telegram = "48210934"             # numeric account id, not @username
```

**wecode holds no bot token and speaks no HTTP.** `fetch` is your command line; whatever
it prints on stdout is parsed as a `getUpdates` response. The offset to ask from arrives
as `WECODE_TELEGRAM_OFFSET` — one past the last update wecode has read — along with
`WECODE_ORG` and `WECODE_COMPANY`. Your token stays in your own shell, and anything that
can produce that JSON works: a different chat tool with a shim, or `cat replies.json`
while you are trying it out.

What a reply does:

| the reply says | what happens |
|---|---|
| `approve` / `yes` / `ok` / `lgtm` | signs what that task is waiting for |
| `approve merge` | signs that kind, whatever the task is waiting for |
| `approve cache-tests` | signs that task, rather than the one the message names |
| `approve #4` | the same, by [short number](../commands.md) |
| `no` / `reject` / `hold` | nothing is signed; the refusal goes on the ledger |
| anything else | chat; left alone |

The task is the one named in the message being replied to — the notification wecode
sent — unless the reply names one itself. A text naming two known tasks is refused
rather than resolved; the id and the number of one task are one task, so a hook printing
`cache-tests (#4)` is not ambiguous.

**A number must wear its `#` here**, and this is the one place that is true. On the
command line an argv position where a task is wanted has nothing else it could be; a word
in a chat message has everything else it could be, and `approve 2` is as likely to mean
*two of them look fine*. Getting that wrong signs something nobody signed for, so a bare
number in a reply names no task at all.

A bare yes signs what the task is actually waiting for: `merge` at `needs-approval`,
`design` for a design task there, `admission` for one the dispatch gate is holding. A
task with nothing outstanding is refused rather than given a default — and a `no` is
refused the same way, because a refusal has to name what it refused.

Five properties worth knowing:

- **The account is an identity, not an authority.** It resolves to the `[[users]]` entry
  that names it, or to nobody — there is no fallback seat, so a stranger who finds your
  bot signs nothing. What that person may then sign is their post's `approve` list,
  checked by the Broker at the moment of signing and recorded either way. Two users
  giving the same id is refused at load.
- **A `no` is a decision, and is recorded as one.** It goes past the same Broker as a
  yes, against the same approval, under the same seat — and lands in the ledger as a
  denial of it:

  ```
  $ wecode audit --task cache-tests --denied
  seq  post        agent         verdict   source      action  target
  12   chief       telegram      ✗ deny    broker      approve Merge
       └─ signature withheld: merge
  ```

  Without that row, a task nobody has looked at and a task somebody looked at and said
  no to are the same task in the morning, and the person who has to decide again is the
  person who already decided. It changes no status: "no" to a merge and "no" to a design
  mean different things and one word cannot pick between them, so what a refusal does is
  withhold the signature and say who withheld it. It is also not a lock — the same holder
  replying `approve` afterwards signs it, and the ledger keeps both. A `no` from a seat
  whose post may not sign that kind withholds nothing, for the reason its `approve`
  would have signed nothing.
- **A message is acted on once.** The highest update read is kept in `wecode.db`, and
  updates at or below it are skipped even if the fetch hands them back — a `getUpdates`
  retried after a network error must not sign twice.
- **A bad reply is reported, not raised.** One message naming no task does not stop the
  ones behind it, and a fetch that fails is `⚠ telegram: …` in the loop's output rather
  than the end of the loop.
- **It is not above the charter.** A `fetch` matching `never_run` is refused by name.

`wecode loop` reads the channel every pass when `fetch` is set — after promotion, before
dispatch, so a signature releases work on the pass that finds it. `wecode telegram`
reads it once by hand; `wecode telegram --dry-run` says what the waiting messages would
sign and moves neither a signature nor the cursor.

An empty `fetch` or a zero `timeout` is refused at load, for the reason `[notify]`'s are.
`wecode company show` prints the fetch and who may sign by reply, or says there is none.

**`wecode doctor` runs it.** A `fetch` that cannot resolve the host fails loudly; a token
that has been revoked does not — the command exits `0`, having done exactly what it was
asked, and prints `{"ok":false,"description":"Unauthorized"}`, which reads as an empty
channel to everything except the parser. So the drill runs the line *and* parses what it
printed, and reports the second as the failure it is. It also says whether anybody could
answer at all: a `fetch` that works with no `telegram` id in `[[users]]` resolves every
reply to nobody, which is correct, deliberate, and completely silent from where the
operator is standing.

It asks from offset `0` — everything Telegram still holds — because an offset is an
acknowledgement, and a drill that confirmed the operator's unread replies as a side
effect of checking that it could read them would be worse than no drill. `[telegram]
answer` is checked against the charter and deliberately not run: `answerCallbackQuery`
wants a callback id that only a real tap has.

## Signing by tapping a button

On a phone, typing is the part still left. Put an inline keyboard on the notification your
[`[notify]` command](notify.md) sends and the answer is one thumb — no keyboard, and
nothing to remember about which task it was:

```sh
# in your [notify] command: the button's callback_data is the words a reply would carry
send() { curl -sS -d chat_id="$TG_CHAT" -d text="$WECODE_TASK: $WECODE_WAITING_FOR" "$@" \
  "https://api.telegram.org/bot$TG_TOKEN/sendMessage"; }
if [ -n "$WECODE_SIGN" ] && [ -n "$WECODE_SIGNERS" ]; then
  send --data-urlencode "reply_markup={\"inline_keyboard\":[[
     {\"text\":\"Approve\",\"callback_data\":\"approve $WECODE_SIGN $WECODE_TASK\"},
     {\"text\":\"Hold\",\"callback_data\":\"no $WECODE_TASK\"}]]}"
else
  send            # nothing here can be signed: the message goes without a keyboard
fi
```

**A button is a promise that a thumb decides something.** Hang it only where
`WECODE_SIGN` names an approval and `WECODE_SIGNERS` names somebody who holds it. An
*Approve* on a `failed` task signs nothing whoever presses it; one offering an approval no
seat in the chart holds is refused by the Broker when the reply is read — and both are
refused *after* the operator has treated the wait as answered, in output printed where
they are not. Putting `$WECODE_SIGN` in the `callback_data` rather than leaving `approve`
bare costs nothing and pins the button to the approval the message was written about,
which a bare `approve` re-reads against whatever the task is waiting for by the time the
tap arrives.

**A tap is not a second way to sign anything.** Telegram hands it back through the same
`getUpdates` as a `callback_query`, and wecode reads it as the message it stands for: the
button's `callback_data` is the text, the notification the keyboard hangs under is the
message being answered. So the table above is the whole grammar — `approve`, `no`,
`approve merge`, `approve #4` mean on a button exactly what they mean typed — and the
account check, the task resolution and the Broker call are the same code. Put the task in
the `callback_data` rather than relying on the notification's text: 64 bytes is plenty for
`approve #4`, and Telegram stops handing out the message an old keyboard belongs to.

`answer` is what tells the phone what the tap did:

```toml
[telegram]
fetch = "curl -sS -m 20 \"https://api.telegram.org/bot$TG_TOKEN/getUpdates?offset=$WECODE_TELEGRAM_OFFSET&timeout=0\""
answer = "curl -sS -m 20 -d callback_query_id=\"$WECODE_TELEGRAM_CALLBACK\" -d text=\"$WECODE_TELEGRAM_ANSWER\" \"https://api.telegram.org/bot$TG_TOKEN/answerCallbackQuery\""
```

The callback to acknowledge arrives as `WECODE_TELEGRAM_CALLBACK` and the one line to say
as `WECODE_TELEGRAM_ANSWER` — flattened to one line and cut at 200 characters, which is
`answerCallbackQuery`'s own ceiling. Both run under the single `timeout`, and `answer` is
no more above `never_run` than `fetch` is.

**A decided button should stop offering.** The acknowledgement above is a toast: three
seconds and it is gone. What stays in the chat is the notification — still saying *needs
your signature*, still carrying *Approve* and *Hold*. A merge signed at 02:14 looks at
09:00 exactly like one nobody has answered, and the next thumb that lands on it decides a
settled question. wecode cannot edit that message; it holds no token. So it says **which**
message the button is on, and the same line strikes the keyboard off:

```toml
answer = """
curl -sS -m 20 -d callback_query_id="$WECODE_TELEGRAM_CALLBACK" -d text=recorded \
  "https://api.telegram.org/bot$TG_TOKEN/answerCallbackQuery" >/dev/null; \
[ -z "$WECODE_TELEGRAM_MESSAGE" ] && exit 0; \
curl -sS -m 20 -d chat_id="$WECODE_TELEGRAM_CHAT" \
  -d message_id="$WECODE_TELEGRAM_MESSAGE" \
  --data-urlencode "text=$WECODE_TELEGRAM_ANSWER" \
  "https://api.telegram.org/bot$TG_TOKEN/editMessageText" >/dev/null
"""
```

The guard exits `0` rather than skipping to the end: the line's exit status is what wecode
reports, and a test that merely came out false would be `⚠ could not say so in the chat:
exited 1` on every tap whose message is gone.

`WECODE_TELEGRAM_CHAT` and `WECODE_TELEGRAM_MESSAGE` are the chat the tapped notification
is in and the message in it that carries the keyboard, as Telegram wrote them. An
`editMessageText` or `editMessageCaption` that sends no `reply_markup` removes the
keyboard, so the message that asked becomes the message that records — and there is
nothing left to tap twice. Use `editMessageCaption` when your notification is a document;
a caption and a text are different fields and each API edits only its own.

Both are **empty together, never one without the other**: Telegram stops handing out the
message an old keyboard belongs to, and then there is nothing to edit. The tap is still
signed — the task is in its `callback_data` — and still acknowledged. One test on one
variable, as above, is the whole check a hook needs.

One command and not two, deliberately. Answering the callback and taking the buttons off
are one act from where you are standing — *this has been decided* — and two hooks would be
two places for one of them to go missing, with a live *Approve* on a merged task as the
failure. Everything the tap carries is in the environment; what your line does with it is
your line's business.

It is optional, and worth writing anyway. A typed reply is its own receipt — the words are
in the chat, in front of whoever typed them — but a tap leaves nothing: the spinner stops
and a button that signed a merge looks exactly like a button that is broken. Four things
follow from that:

- **Every tap is acknowledged**, whatever came of it: what was signed, what a *Hold* put
  on the record, that the account signs nothing, that the task has nothing waiting to be
  signed, or that the button's `callback_data` decides nothing at all. Silence is the one
  answer that never informs.
- **A typed reply is not.** It would be wecode repeating the operator back at themselves.
- **A `--dry-run` says nothing into the chat**, because it moves nothing anywhere.
- **A receipt that failed to send is `⚠ could not say so in the chat: …`** under the
  outcome, not instead of it. The signature is already in the ledger, and un-signing it
  because the acknowledgement bounced would throw away an approval that was really given.
  It is also the only warning that a button is still offering — the chat is exactly where
  nothing was said — so it is worth reading in the loop's output rather than scrolling
  past.

`answer` without `fetch` is refused at load: nothing would ever reach it, since taps arrive
through the fetch, and an operator tapping buttons that stay silent has been given the
failure this key exists to prevent.

Worth being clear-eyed about one more thing. A button is more findable than a sentence —
anyone in the chat can press it, and they will. That is safe for the reason a typed reply
is: the account resolves to a `[[users]]` entry or to nobody, and what the person may sign
is their post's business either way. A stranger pressing *Approve* gets a refusal, and the
attempt is on the record.

Two things to be clear-eyed about. A bot token in a shell command is a credential in
`company.toml`'s neighbourhood — keep it in an environment variable, as above, and treat
anyone who has it as able to read every notification you send. And a chat account is
authentication of a kind wecode did not perform: what it proves is that Telegram
believes that account sent the message.
