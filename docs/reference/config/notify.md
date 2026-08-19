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
| `WECODE_REPORT` | the change added up — the merge record, before the merge |
| `WECODE_WORKTREE` | the tree the work is in |
| `WECODE_STEPS` | what a person's task asks them to do, to 4000 characters; empty for an agent's |
| `WECODE_STEPS_FILE` | the whole of it as a file, to attach rather than quote |

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
at it — which is the trip the hook exists to save. The five artifact variables are the
work in the message, one per size of channel: a desktop line has room for
`$WECODE_CHANGED_COUNT files`, a chat message has room for `$WECODE_REPORT` or for the
names and `$WECODE_DIFF` under them, and a script wanting more than that is handed
`$WECODE_WORKTREE` and can ask git anything.

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

**Put the report in front of the signature that needs it.** The names say what the change
reached and the diff says what it did, and between them a person holding a phone is still
left adding it up: how much of it there is, which corners of the tree it fell in, what the
work was held to, and what has been queued behind it waiting for exactly this signature.
wecode already writes that document — it is the merge report, committed to
`docs/wecode/<task>/report.md` when the work lands — and it used to write it *after* the
merge, which is after the decision it would have informed. `WECODE_REPORT` is the same
body, rendered by the same code before the merge instead of after it:

```text
summary
  4 files, +392 −8
  unblocks   envelope-guidance

what changed
  crates/wecode-cli/src/notify.rs                      +204   −2
  crates/wecode-cli/src/record.rs                      +60    −0
  crates/wecode-cli/tests/notify.rs                    +72    −0
  docs/reference/config/notify.md                      +56    −6

by area
  crates/wecode-cli/src        2 files, +264 −2
  crates/wecode-cli/tests      1 file, +72 −0
  docs/reference/config        1 file, +56 −6

acceptance
  · `cargo test --workspace` exits 0
```

`by area` is printed only where it groups — one row per file under that heading would be
the list above it a second time.

Two parts of it are things no diff contains and only wecode knows: `unblocks`, which is
what signing this releases, and `acceptance`, which is what the work was held to. The
acceptance lines are marked `·` and not `✓`, because the report goes out on every wait
with a tree behind it — `failed` included — and a tick beside the command that has just
refused the work would be the message contradicting the reason it was sent. The `✓`
belongs to the copy committed at the merge, which is written downstream of a verdict that
passed.

Everything else in it is what the record will say, word for word, because it comes from
the same generator: what an operator approved from a phone and what the repository keeps
about what they approved cannot drift apart. What is missing is only what a merge creates
— no merge sha, no `target was`, no `undo`, no `how`. Those are not left out for brevity;
they do not exist yet, and printing a shape for them would make a proposal read as a
receipt.

```toml
[notify]
command = "curl -sS -m 20 https://api.telegram.org/bot$TG_TOKEN/sendMessage \
  -d chat_id=$TG_CHAT --data-urlencode \
  \"text=#$WECODE_TASK_NUMBER $WECODE_TASK_TITLE — $WECODE_WAITING_FOR
$WECODE_REPORT\""
```

`max_files` (default `20`) bounds the **names** and never the count, so a hook handed ten
paths of forty can still say forty. `0` is legal and means the count alone. It bounds the
`what changed` rows of `WECODE_REPORT` too — the same list of paths, into the same
channel — and a report that was cut says `… and N more` rather than ending quietly, while
the tally above it and the `by area` block below stay whole. That is most of what `by
area` is for: a cut list still says where the change fell. The bound exists because an
environment is not the place to put a thousand paths, and it is yours to set because the
channel is: a desktop notification has a line where a log file has room for everything.

All five are **empty** when there is nothing yet to show — no worktree, because the task
has not started. That is the ordinary case for `signature`, which is a wait for permission
to begin. Empty rather than `0`: *has written nothing* and *has not run* are different
things to be woken up for, and a hook that reported the second as the first would be
describing an empty diff nobody produced. An empty report is worse still, since a document
that arrived saying nothing reads as a finding rather than as an absence — so none is sent
at all, and a tree that was worked in and left unchanged says so in words instead.

**Send a person the work, not a reference to it.** Everything above is about a wait that
comes *after* something happened: there is a tree, a diff, a report, and the message is
asking whether it may land. A task whose doer is a person is the other kind. Nothing has
been done, the doing is the operator's, and the notification is not a summons to go and
look at work — it is the dispatch. `WECODE_STEPS` is what makes it one: the instructions
written at `wecode task add --steps <file>` (see
[commands](../commands.md#the-ones-worth-explaining)), stored with the task and handed over
as written.

Without them the message is a title and a number, which is somebody woken up at 02:14 and
asked to guess what they were woken up for. That is the complaint this exists to answer, so
`wecode task add --by person` says so when no steps are declared — an advisory, not a
refusal, since a task whose whole instruction is its own title is a real task.

```sh
# in your [notify] command: a person's task is briefed by the message
if [ -n "$WECODE_STEPS" ]; then
  body="$WECODE_TASK_TITLE

$WECODE_STEPS"
else
  body="$WECODE_TASK_TITLE — $WECODE_WAITING_FOR ($WECODE_CHANGED_COUNT files)"
fi
```

`WECODE_STEPS_FILE` is the same document as a file, for the channel that would rather
attach it than quote it — Telegram's `sendDocument` takes a caption and buttons, so the
runbook and the **Complete** that answers it are one message. Use it when the steps are
long: `WECODE_STEPS` is cut at 4000 characters like the diff and for the same channel, and
says `… truncated — the whole of it is the file in WECODE_STEPS_FILE` when it was, because
a person reading step 40 of 60 has to know there are 60. There is no worktree behind a
manual task, so this file is the only document there is to send.

wecode writes it for the length of the notification and removes it afterwards. It is a
handle for one `sendDocument`, not a second place the steps live — the store is that — so a
hook that wants to keep a copy should copy it while it runs.

Both are **empty for every task wecode dispatches**. An agent is told what to do at
dispatch, out of the plan, the playbook and the repository, and `--steps` is refused on its
task rather than stored where nothing would read it. Empty, not the title again: a hook that
printed a heading over these would be presenting an absence as a briefing.

**What does not send them yet.** A manual task reaches `needs-approval` by being promoted
in the tick — straight from `waiting`, as soon as its prerequisites are done — and the tick
is the one place that writes a status without calling this hook. Nothing needed it to before:
every promotion it made was to `ready`, which no person is waiting on. So the briefing goes
out today when the status is set by hand (`wecode status <id> needs-approval`), and it goes
out with everything else on the digest's rhythm, but the moment the graph decides a person is
wanted is announced by nothing. The fix is one `notify::on_status_change` in the promotion
loop in `crates/wecode-cli/src/commands/exec.rs`, guarded the way every other call site is —
`crossing` already returns `None` for a promotion no person is waiting on, so it cannot
become noise.

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
