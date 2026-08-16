# The notify hook

`[notify] command` runs when a task **starts** waiting on a person. Absent, which is the
default, nothing is run and waits are silent. It is one half of a round trip:
[`[telegram]`](telegram.md) is how the answer gets back.

| variable | |
|---|---|
| `WECODE_TASK` | the task id |
| `WECODE_TASK_NUMBER` | its [short number](../commands.md), digits only — `4`, not `#4` |
| `WECODE_TASK_TITLE` | its title, as written |
| `WECODE_TASK_STATUS` | the status being set — `needs-approval`, `failed`, … |
| `WECODE_WAITING_FOR` | `approval` \| `input` \| `failed` \| `signature` |
| `WECODE_SIGN` | the approval that ends this wait — `merge`, `design`, `admission`; empty when no signature does |
| `WECODE_SIGNERS` | who may give it, one per line; empty when nobody may |
| `WECODE_PROJECT` | the project it belongs to |
| `WECODE_COMPANY` | `[company] name` |
| `WECODE_ORG` | the workspace, so the hook can call `wecode` back |
| `WECODE_CHANGED_COUNT` | how many paths the task changed |
| `WECODE_CHANGED_FILES` | those paths, one per line, at most `max_files` of them |
| `WECODE_DIFF` | what changed in them, as a diff, to 4000 characters |
| `WECODE_WORKTREE` | the tree the work is in |

`WECODE_WAITING_FOR` is the one to branch on. `signature` is the dispatch gate holding a
task that is otherwise `ready`, which no status can express — the other three restate
the status in one word.

**Put `WECODE_TASK_NUMBER` in the message.** It is what makes the notification answerable
from wherever it arrives: the reply that signs it has to name the task, and `#4` is four
characters where `cache-warm-on-deploy` is twenty spelled exactly. The variable holds the
digits alone so the hook decides how to write them — a hook that wants the sigil writes
`#$WECODE_TASK_NUMBER`, and one that wants a bare number cannot portably strip one.

**Offer only a decision that can be made, to somebody who can make it.** A message saying
*you are wanted* under an *Approve* button is offering a decision, and two things decide
whether a thumb on it settles anything. `WECODE_SIGN` is the first: it holds the word that
goes after `approve` — in a [reply](telegram.md#signing-from-a-reply), on a
[button](telegram.md#signing-by-tapping-a-button), or on a command line — and it is
**empty for `input` and `failed`**, which are waits no signature answers. An *Approve* on
one of those is refused when the reply is read, which is minutes to an hour later, on the
machine the operator is not standing at; from where they are, they answered it.
`WECODE_SIGNERS` is the second: authority is the post's, checked by the Broker at the
moment of signing, so a notification that reached the wrong seat offered something that
seat never held. It names the people whose seat may give this signature, one per line —
the seat's own name where nobody is in it, since `--as <post>` still signs at a terminal —
and it is empty when no seat in `company.toml` holds that approval at all, which is worth
saying in place of the button rather than discovering by pressing it.

```sh
# in your [notify] command: ask for the signature only where there is one to give
if   [ -z "$WECODE_SIGN" ];    then ask=""      # no signature answers this wait
elif [ -z "$WECODE_SIGNERS" ]; then ask="nobody holds $WECODE_SIGN — see [roles.*] approve"
else ask="$WECODE_SIGNERS: reply \`approve $WECODE_SIGN #$WECODE_TASK_NUMBER\`"
fi
```

The two travel together on purpose: the signers are the signers *of that kind*, so a task
whose merge nobody holds and a task with nothing to sign are different messages. Both are
read from the same place the answer will be judged against — `WECODE_SIGN` from the rule
that decides what a bare `approve` means for a task in this state, `WECODE_SIGNERS` from
the `approve` list on each post's role — so what the notification offers is what the
channel behind it accepts.

**Say what it produced.** A message that only names the task answers *you are wanted* and
not *for what*, and deciding whether to sign a diff then means opening a terminal to look
at it — which is the trip the hook exists to save. The four artifact variables are the
diff in the message, one per size of channel: a desktop line has room for
`$WECODE_CHANGED_COUNT files`, a chat message has room for the names and `$WECODE_DIFF`
under them, and a script wanting more than that is handed `$WECODE_WORKTREE` and can ask
git anything.

```toml
[notify]
command = "notify-send 'wecode' \"#$WECODE_TASK_NUMBER $WECODE_TASK: $WECODE_WAITING_FOR, $WECODE_CHANGED_COUNT files\""
max_files = 20                    # names handed over; the count is never capped
```

**Send the diff where the reply can sign.** A list of names says what a change *reached*
and never what it *did*: `notify.rs, config.md` reads the same whether the attempt rewrote
a module or fixed a typo in it. Where the reply can approve — [a Telegram
message](telegram.md#signing-from-a-reply), where a tap is a signature — that is a
decision made without the evidence for it, and *ask git yourself* is not an answer on a
phone.

```toml
[notify]
command = "curl -sS -m 20 https://api.telegram.org/bot$TG_TOKEN/sendMessage \
  -d chat_id=$TG_CHAT --data-urlencode \
  \"text=#$WECODE_TASK_NUMBER $WECODE_TASK_TITLE — $WECODE_WAITING_FOR ($WECODE_CHANGED_COUNT files)
$WECODE_DIFF\""
```

`WECODE_DIFF` is cut at **4000 characters**, marked `… truncated, N bytes in full` when it
is, so a hook can never present part of a diff as the whole of one. That bound is not
yours to set, unlike `max_files`, because there is nothing to trade: fewer names still
leave a true count beside them, where a shorter diff is only less of a diff. 4000 is what
the tightest channel that carries one will take — Telegram refuses a message over 4096 —
less the room a hook needs for its own words around it. Untracked files are in it, because
they are in the count: a task whose whole output is new files would otherwise arrive
listed and unexplained. Reading it writes nothing, so an announcement cannot disturb a
worktree an agent is still in.

They are read out of git, never taken from the agent's report — the same rule the verdict
is judged under, and for the same reason: a diff is ground truth where a self-report is a
claim, and a notification carrying a claim is one more thing to go and check. It is the
uncommitted diff, which is exactly the one `wecode verify` judged, because an attempt is
committed only after the verdict.

`max_files` (default `20`) bounds the **names** and never the count, so a hook handed ten
paths of forty can still say forty. `0` is legal and means the count alone. The bound
exists because an environment is not the place to put a thousand paths, and it is yours
to set because the channel is: a desktop notification has a line where a log file has room
for everything.

All four are **empty** when there is nothing yet to show — no worktree, because the task
has not started. That is the ordinary case for `signature`, which is a wait for permission
to begin. Empty rather than `0`: *has written nothing* and *has not run* are different
things to be woken up for, and a hook that reported the second as the first would be
describing an empty diff nobody produced.

The line runs through `sh -c`, in the workspace, with your environment: it is your own
command, and a desktop notifier needs the session it was configured in. The task is
passed in the environment rather than substituted into the line, because a title is
arbitrary prose and pasting it into a shell is a quoting bug at best.

Four things it deliberately does not do:

- **It does not repeat.** The hook fires on the transition into waiting, so a task that
  has been waiting a week fires once. `wecode loop` prints the standing condition every
  pass; the hook is not that.
- **It cannot fail the work.** A hook that exits non-zero, hangs, or does not exist is
  reported as `⚠ notify: …` and stepped over. The task stopped for a person whether or
  not anything managed to say so.
- **It is killed at `timeout`** (default `10s`). `wecode loop` runs for days, and a
  notifier blocked on a network call must not take it with it.
- **It is not above the charter.** A command matching `never_run` is refused by name
  rather than run — an invariant outranks every grant, and this file is not an exception
  because the line happens to be in a different block of it.

A `[notify]` block with an empty `command`, or a zero `timeout`, is refused at load. Both
read as configured and behave as absent, which is the one failure mode a notification
must not have. `wecode company show` prints the hook, or says there is none.

**Run it before you depend on it.** Everything above is checked when the line is
*loaded*; whether the line *works* is a question about a network, a daemon and a token,
and until a task stops for a person nothing asks it. `wecode doctor` asks it now — it
fires this hook for real, against a task that does not exist, and reports what came back
under the same rule the loop uses. The drill's message carries no short number, so a
reply to it signs nothing. What it does carry truthfully is `WECODE_SIGN` and
`WECODE_SIGNERS` — both are read from `company.toml` rather than from the invented task —
so the rehearsal also answers whether your notifier reaches a seat that can sign, which is
the question a real wait asks at 02:14. See
[commands](../commands.md#the-ones-worth-explaining).
