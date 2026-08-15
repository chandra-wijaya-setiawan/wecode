# Configuration

Two hand-edited files. Everything else is in `wecode.db`, which no one edits by hand.

| file | scope | describes |
|---|---|---|
| `company.toml` | the workspace | who exists, what they may do, what outranks them |
| `.wecode/playbook.toml` | one repository | how work is broken down *here* |

The split is deliberate. The company is one thing; a project is a codebase with its own
conventions, and its guidance is versioned with the code it describes.

A third file, `gaps.toml`, sits in the workspace and belongs to neither category
cleanly: it is written by machine and emptied by hand. It is guidance's inbox — see
[below](#gapstoml).

## company.toml

Lives in the workspace, alongside `wecode.db`. Unknown keys are an **error**, not a
warning — a typo like `writ = [...]` would otherwise leave a role with no write scope
and no complaint.

```toml
[company]
name = "cws"
profile = "solo"                  # solo | team | enterprise
description = "..."

[attention]                       # concurrency derives from this, not from cores
max_open_items = 5
max_interrupts_per_hour = 3
digest_interval_mins = 20

[notify]                          # run when a task starts waiting on a person
command = "notify-send 'wecode' \"$WECODE_TASK: $WECODE_WAITING_FOR\""
timeout = "10s"                   # killed at this; see below

[telegram]                        # and how the answer gets back; see below
fetch = "curl -sS -m 20 \"https://api.telegram.org/bot$TG_TOKEN/getUpdates?offset=$WECODE_TELEGRAM_OFFSET\""
answer = "curl -sS -m 20 -d callback_query_id=\"$WECODE_TELEGRAM_CALLBACK\" -d text=\"$WECODE_TELEGRAM_ANSWER\" \"https://api.telegram.org/bot$TG_TOKEN/answerCallbackQuery\""
timeout = "30s"

[invariants]                      # outrank every grant below
never_touch = [".github/**", "infra/**", "**/*.pem", "**/.env"]
never_run = ["git push --force*", "rm -rf /*"]
approval_to_merge = ["main", "master", "release/**"]
max_tokens = 1000000
max_intelligence = 7.5            # no seat may be staffed above this level; see below

[[repos]]                         # declared by path; they live elsewhere
name = "app"
path = "~/projects/app"

[roles.engineer]                  # a role is enforced capabilities, or it is nothing
read = ["**"]
write = ["src/**", "crates/**"]
run = ["cargo *", "npm test*"]
tokens = 200000
wall_secs = 1800

[roles.chief]
read = ["**"]
define = ["project", "task"]      # may create work
staff = true                      # may assign it
merge_to = ["**"]                 # may land it — the charter says where a signature is needed
approve = ["admission", "merge"]
# no write, no run: loading a company whose chief has either is an error

[[posts]]                         # a seat, and the harness in it
name = "impl"
role = "engineer"
agent = "claude-code"
intelligence = 5                  # how clever its occupant is, 1–10; see below

[[users]]                         # a person against a seat
name = "Chandra"
post = "chief"
telegram = "48210934"             # the account this person may sign from; see below

[session]
ttl = "8h"                        # idle timeout, not age

[agents.claude-code]              # how to actually launch it
command = "claude"
protocol = "claude-stream-json"   # how to read its output; see below
args = ["-p", "{{prompt}}", "--output-format", "stream-json", "--verbose"]
env_allowlist = ["ANTHROPIC_API_KEY", "PATH", "HOME", "LANG"]
wall_secs = 1800
idle_secs = 300
models = ["haiku", "sonnet", "opus"]   # weakest first; see below
# model_flag = "--model"          # only if this harness spells it differently

[templates]
task_envelope = """..."""         # the prompt shape; see below
```

The **env allowlist is the whole environment** a spawned agent gets — nothing is
inherited. Absent a container, that is the only network control there is.

`{{prompt}}` in `args` is where the rendered envelope goes.

`protocol` names the shape of the agent's output, and is what lets wecode read a token
count out of it. One value is understood today:

| | |
|---|---|
| `claude-stream-json` | one JSON object per line; usage on the `assistant` and `result` lines |
| anything else | **unmetered** — the run's spend column stays blank |

It must match what `args` actually asks for: declaring `claude-stream-json` without
`--output-format stream-json` produces prose, and prose reports nothing. Unmetered is
not an error — the run still happens, is still timed, and still lands its wall spend on
the ledger. It only means the token half of the spend column has nothing to show, which
is the truth and not a zero.

Every `tokens` number in this file — the `max_tokens` invariant, a role's cap, a
playbook's default — counts the tokens a run **adds**: its prompts, what it writes to a
prompt cache, and everything the model produces. Context re-read out of that cache is
counted separately and is never checked against a budget. It is the same context on
every turn, so it grows with turns times context while the work grows with the
conversation; a cap written in the one scale and checked in the other is over on the
first turn and says nothing thereafter. `wecode run` prints the replayed figure beside
the spend, because cache reads are billed — at a tenth of the rate — and a number left
out of a budget should not also be left off the screen.

### Which model a seat gets

`intelligence` on a post says how capable its occupant should be, on a scale of 1 to 10.
It is **not a model name**: names churn, and a chart pinned to one rots at the next
release. What is stable is *order* — which of a harness's models is stronger than which
— and that is the one line `models` declares, weakest first.

The scale is spread over that list rather than written down per model. Four entries
answer up to 2.5, 5, 7.5 and 10; three answer up to 3.3, 6.6 and 10. A level picks the
weakest model that reaches it, so `intelligence = 5` against `["haiku", "sonnet",
"opus", "fable"]` launches `sonnet`. Add a model or reorder the list and every seat
keeps meaning roughly what it meant, which hand-written levels per model would not.

It sits on the **post**, beside `agent`, and not on the role. A role is enforced
capability — what a seat *may do*. Intelligence is a property of who occupies it,
exactly like the harness name next to it; on the role, two seats with the same authority
and different models would be inexpressible, which is the one thing the post/role split
exists for. Routing hard work to a stronger occupant is then the playbook's existing
`assign_to`: a `design` step goes to a seat at 10, the build to one at 5.

The resolved model is launched as `--model <name>`, appended to `args`. A harness that
spells it differently names its own `model_flag`.

Three things are refused at load rather than ignored at dispatch, because each is a
setting that reads as configured and decides nothing:

| | |
|---|---|
| `intelligence` on an agent with no `models` | there is nothing to pick from — the message names the line that repairs it |
| a level outside 1–10 | reported against the seat that wrote it |
| a post above `[invariants] max_intelligence` | invariants outrank every grant, so the config is wrong rather than the run being quietly lowered |

The ceiling is a **ceiling, not a default**. A post under it keeps its own number —
otherwise every task would run at the top of the scale, and this would be an elaborate
way to spell *always use the best model*.

Omitting all of it is the supported case and is exactly today's behaviour: no `models`,
or no `intelligence`, means wecode names no model and the harness runs whatever it would
have run. `wecode company show` prints the resolved name beside the level, and `wecode
run` prints it beside what the run cost.

### The notify hook

`[notify] command` runs when a task **starts** waiting on a person. Absent, which is the
default, nothing is run and waits are silent.

| variable | |
|---|---|
| `WECODE_TASK` | the task id |
| `WECODE_TASK_NUMBER` | its [short number](commands.md), digits only — `4`, not `#4` |
| `WECODE_TASK_TITLE` | its title, as written |
| `WECODE_TASK_STATUS` | the status being set — `needs-approval`, `failed`, … |
| `WECODE_WAITING_FOR` | `approval` \| `input` \| `failed` \| `signature` |
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
message](#signing-from-a-reply), where a tap is a signature — that is a decision made
without the evidence for it, and *ask git yourself* is not an answer on a phone.

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
reply to it signs nothing. See [commands](commands.md#the-ones-worth-explaining).

### Signing from a reply

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
| `approve #4` | the same, by [short number](commands.md) |
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

### Signing by tapping a button

On a phone, typing is the part still left. Put an inline keyboard on the notification your
`[notify] command` sends and the answer is one thumb — no keyboard, and nothing to remember
about which task it was:

```sh
# in your [notify] command: the button's callback_data is the words a reply would carry
curl -sS -d chat_id="$TG_CHAT" -d text="$WECODE_TASK: $WECODE_WAITING_FOR" \
  --data-urlencode "reply_markup={\"inline_keyboard\":[[
     {\"text\":\"Approve\",\"callback_data\":\"approve $WECODE_TASK\"},
     {\"text\":\"Hold\",\"callback_data\":\"no $WECODE_TASK\"}]]}" \
  "https://api.telegram.org/bot$TG_TOKEN/sendMessage"
```

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

## .wecode/playbook.toml

In the repository, committed. `.wecode/run/` is the worker-writable area and should be
gitignored; the playbook should not be.

`wecode playbook init` writes the first one. Where the language is known — read off
`Cargo.toml`, `go.mod`, `pyproject.toml` or `package.json`, or given with `--language` —
the file arrives with that toolchain's acceptance commands, its shared build cache, and
the lock file a build rewrites named in the write scope; everything below is then an
edit rather than a blank.

```toml
[project]
language = "rust"
merge_to = "dev"                  # the integration branch: branch from it, merge to it
merge = "approved"                # approved | auto — the charter still outranks this
dispatch = "approved"             # auto | approved — sign each task before it runs

[project.build_cache]             # directories every worktree of this project shares
CARGO_TARGET_DIR = "~/.cache/wecode/app/target"

[feature]
worktree  = true
design_required = true            # refuse a feature with no design task behind it
assign_to = "impl"
accept    = ["cargo test --workspace"]
tokens    = 120000
wall_secs = 5400
guidance  = """
Prose, read by whoever decomposes a request into tasks. Say how work is split here,
what the seams are, and what a task of this kind must not do.
"""
subtasks  = ["design", "build"]   # what `task add --expand` emits, in this order

[feature.design]                  # one block per name in `subtasks`
kind   = "design"                 # defaults to the kind being expanded
title  = "decide how {{task}} should work"
write  = ["docs/wecode/{{task}}/design.md"]
accept = ["test -f docs/wecode/{{task}}/design.md"]

[feature.build]
after  = ["design"]               # an earlier sibling's name, not a task id
write  = ["src/**"]
```

One section per task kind. A kind with no section gets no defaults and no worktree. Only
the typed fields are acted on; `guidance` is carried, never parsed.

An `accept` line whose program is not on this machine — an `sh` builtin, or a file on
`PATH` — refuses the playbook wherever it is loaded. Verification would report the same
program as "command not found" only after the work is done.

See [../guides/playbooks.md](../guides/playbooks.md) for what to write in it.

### The dispatch gate

`dispatch` decides who may start work, and it is the last door before any budget is
spent. `auto`, the default, leaves the admission gate as the only check — what wecode has
always done. `approved` means nothing is prepared for a task, by hand or by the loop,
until `wecode approve admission --task <id>` is on the ledger.

It defaults to `auto` where `merge` defaults to `approved`, and the difference is
reversibility. A dispatched run happens in its own worktree under a budget and is judged
before it can reach a shared branch; a merge is the step that cannot be un-decided
quietly. A strict default here would also stop `wecode loop` — which exists to run
unattended — on every task in every project that had never heard of the setting.

Turn it on where the *plan* is written by an agent rather than by a person. That is the
case it is for: the admission gate checks that a task is well-formed, and no
deterministic check can say whether it is the work you wanted done.

A signature covers one task, not its subtasks — each is dispatched on its own budget, so
each is signed on its own. And a signature older than the last `define` record for that
task is stale: amending a scope after signing asks for the signature again, so the gate
cannot be walked past by signing something small and then changing it.

### The build cache

A worktree is a clean checkout, so its `target/` starts empty and every task pays for a
cold build twice — once inside the agent, once in verification. None of that output is
task-specific, so `[project.build_cache]` names directories that live outside every
worktree and are shared by all of them.

Each key is the environment variable a toolchain reads; each value is a directory.
wecode sets them and knows nothing else about them, which is what keeps this from being
a list of ecosystems: `CARGO_TARGET_DIR`, `GOCACHE`, `YARN_CACHE_FOLDER`, `SCCACHE_DIR`.
The directories are created before anything is pointed at them, and one that cannot be
created is an error — a toolchain handed an uncreatable path quietly builds into the
worktree instead, which is the failure this is meant to remove.

They are set on the **agent and on the acceptance commands alike**. Verification is
usually the larger build of the two, and sharing only the agent's would leave the
expensive half cold while looking like the setting was on. Nothing needs to be added to
`env_allowlist`: that allowlist governs what an agent may *inherit* from the operator's
shell, and these values are not inherited — they are what this file says. Where a
variable is both allowlisted and declared here, the declaration wins; an inherited
`CARGO_TARGET_DIR` would point at the operator's own checkout.

| refused | why |
|---|---|
| a relative path | resolves inside whichever worktree is running, so each task gets its own copy under a name promising the opposite — and the build still succeeds |
| a key that is not an environment variable name | could never be set |
| `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*` | say which program runs, not where output goes — choosing the toolchain belongs to `company.toml` |

A `~` is resolved when the cache is used, not when the playbook is parsed, so one file
describes the same cache on two machines with different homes.

**Sharing serialises.** Cargo takes an exclusive lock on its target directory, so two
tasks building at the same moment queue rather than building twice. That is the trade —
seconds of waiting against minutes of rebuilding — and a project that would rather have
parallel cold builds declares nothing. Nothing removes a cache: `wecode worktree remove`
leaves it alone, and cleaning it is the toolchain's own business.

### Subtasks

`subtasks` is the decomposition `wecode task add <id> ... --expand` emits, and its order
is the order tasks are created in. Every name needs a block; a block the list does not
name is refused, as is an `after` that names anything but an earlier sibling — all three
are typos, and a typo found at planning time costs nothing.

A block states only what makes that step different. `kind`, `title`, `after`, `write`,
`read`, `accept`, `assign_to`, `tokens` and `wall_secs` are the fields; anything left
out falls through to the playbook for the step's **own** kind, exactly as a hand-written
task of that kind would. So a `design` step wants a `[design]` section to draw its
budget from — without one the step has none, and the gate refuses the expansion and says
so.

`{{task}}` is the main task's id and `{{title}}` its title. They are the only two: a
template that could reach further into the plan would be a small language, and this is a
scaffold that runs once.

`design_required` refuses a task of that kind at admission unless a `design` task
stands before it — a predecessor up its dependency chain, or a subtask inside it, which
is what `--expand` creates when the template declares a `design` step. See the
[playbooks guide](../guides/playbooks.md#the-design-gate) for why the dependency is the
entire check.

Emitted tasks are children of the main task and depend on the siblings their `after`
names. Those are separate relations — being part of a task does not mean waiting for it.

Like `company.toml`, a playbook is **hand-edited and deliberately in no role's write
scope**. A task that tried to change one would be refused at assignment, which is the
right answer: letting a worker rewrite the guidance it was given is the same problem as
letting it define its own acceptance.

## gaps.toml

In the workspace, beside `company.toml`. Appended by `wecode playbook gap`, read back
by `wecode playbook`, and emptied by hand.

```toml
[[gap]]
at      = 1755100000          # seconds since the epoch, stamped when it was recorded
project = "caching"
kind    = "bug"               # optional — absent means every kind sees it
task    = "cache-layer"       # optional — where it was found, for attribution
by      = "chief"             # the post that recorded it
note    = "declare the test file: the scope check refuses the diff afterwards"
```

A gap is a **note, not a change**. Nothing in wecode branches on one; like `guidance`,
it is only carried. That is what makes it safe for an agent to append to — a wrong note
misleads a reader, which the prose beside it could already do, and it cannot widen a
scope, raise a budget or switch off a gate. The playbook itself stays hand-edited and
out of every write scope.

The gate is `define project`, not a write scope: the seat that plans work is the one
that finds these, and it is usually a seat that writes no code at all. The seat that
writes the code is exactly the one that must not be able to annotate the guidance it
was handed.

It lives here rather than beside the playbook it is about because **the repository is
what verification diffs**. A kind whose playbook asks for no worktree is judged in the
main checkout, so a file appearing there mid-run would be reported as that task's scope
violation — recording a finding would fail somebody else's work. The workspace is never
diffed.

Entries are appended, never rewritten, so comments and hand corrections survive. An
entry goes away when a person folds it into the playbook and deletes it; nothing else
deletes one.

## The envelope

`templates.task_envelope` is the prompt a worker receives. Placeholders:

`{{task_id}}` `{{project_id}}` `{{objective}}` `{{title}}` `{{acceptance}}`
`{{write_scope}}` `{{context}}`

`{{context}}` carries the handoff — what predecessors produced: a capped diff per
predecessor, or the whole document when the predecessor was a `design`. If the template
omits it, the handoff is **appended** rather than dropped: losing it silently would be
worse than putting it somewhere unexpected.

Previous attempts are appended after the template, always.

Both are rendered from A2A artifacts, so `wecode start <task> --json` shows exactly what
a worker is being given — including the structured part it never sees in the prose.

## Where things live

```
~/.wecode/
  current                        the default org, set by `wecode use`
  workspaces/<org>/
    company.toml
    wecode.db
  run/<org>/<task>/              worktrees — outside the repo and the workspace
```

Worktrees sit outside both on purpose, so a glob rooted at a worktree cannot sweep up
the file that defines the worker's own grants. Note this is hygiene rather than a
boundary: `run/` and `workspaces/` are siblings, so traversal still reaches it, and what
actually refuses the write is the Broker.

`$WECODE_CONFIG` relocates all of it, which is how the test suite stays isolated.
