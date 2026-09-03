# company.toml

Who exists, what they may do, and what outranks them. Lives in the workspace, alongside
`wecode.db`. Unknown keys are an **error**, not a warning — a typo like `writ = [...]`
would otherwise leave a role with no write scope and no complaint.

Two of the blocks below have their own pages, because between them they describe the
round trip to a person rather than the chart: [`[notify]`](notify.md) is the message out
and [`[telegram]`](telegram.md) is the answer back. `[templates]` has one too, since what
it configures is what a worker is told rather than what a person may do — see
[envelope.md](envelope.md).

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
timeout = "10s"                   # killed at this; see notify.md

[telegram]                        # and how the answer gets back; see telegram.md
fetch = "curl -sS -m 20 \"https://api.telegram.org/bot$TG_TOKEN/getUpdates?offset=$WECODE_TELEGRAM_OFFSET\""
answer = "curl -sS -m 20 -d callback_query_id=\"$WECODE_TELEGRAM_CALLBACK\" -d text=\"$WECODE_TELEGRAM_ANSWER\" \"https://api.telegram.org/bot$TG_TOKEN/answerCallbackQuery\""
timeout = "30s"                   # the same line should edit the message it answers,
                                  # so a decided button stops offering; see telegram.md

[invariants]                      # outrank every grant below
never_touch = [".github/**", "infra/**", "**/*.pem", "**/.env"]
never_run = ["git push --force*", "rm -rf /*"]
approval_to_merge = ["main", "master", "release/**"]
max_tokens = 1000000
max_intelligence = 7.5            # no seat may be staffed above this level; see below

[[invariants.auto_merge]]         # a merge you answer once instead of every time
to = "release/**"                 # branch glob, required — see below
projects = ["docs-site"]          # only this project's work; omit for every project

[[repos]]                         # declared by path; they live elsewhere
name = "app"                      # unique across the file; see below
path = "~/projects/app"

[roles.engineer]                  # a role is enforced capabilities, or it is nothing
read = ["**"]
write = ["src/**", "crates/**", "specs/**/specification.md"]   # and its contract; see below
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
telegram = "48210934"             # the account this person may sign from; see telegram.md

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
task_envelope = """..."""         # the prompt shape; see envelope.md
```

The **env allowlist is the whole environment** a spawned agent gets — nothing is
inherited. Absent a container, that is the only network control there is.

`{{prompt}}` in `args` is where the rendered envelope goes.

## What a harness has to do to hold a seat

Nothing, beyond being declarable in the block above. There are no adapters in the
crate and no list of supported coding CLIs: an `[agents.*]` block is four
declarations, and any executable that satisfies them is a seat's occupant.

| declaration | how | absent |
|---|---|---|
| how it is told | `{{prompt}}` in `args` | it is launched with no task |
| what it may do | `{{tools}}` in `args` | no allow-list flag — the grant is enforced anyway |
| what it reports | `protocol` | `plain`: unmetered |
| which model | `models`, `model_flag` | wecode names none |

`{{tools}}` renders claude's `--allowedTools Bash(cargo *),Read,Edit` syntax, so a
harness that spells an allow-list differently — or has none — leaves the placeholder
out and passes the flag no other way. Nothing is lost that was load-bearing: the flag
is a courtesy that refuses a command early, and the enforcement is the scope check
over `git diff --name-only` and the charter's `never_run`, which run whatever the
harness did or did not honour.

### `protocol`

The shape of the agent's output, which is what lets wecode read a token count out of
it. Three values, and a name outside them is refused when the file loads — a protocol
nothing reads meters nothing on every run of that harness and says so nowhere, which
is indistinguishable from an honest `plain`.

| | |
|---|---|
| `claude-stream-json` | one JSON object per line; usage on the `assistant` and `result` lines |
| `generic-jsonl` | one JSON object per line; **any** line carrying a `usage` object is that turn's spend, and a line with `"type": "result"` states the run's total |
| `plain`, or omitted | **unmetered** — the run's spend column stays blank |

`generic-jsonl` is a contract wecode publishes rather than a format it has read: a
`usage` object at the top level or under `message`, with `*_tokens` fields, and
`cache_read_input_tokens` for context re-read rather than sent. A turn restated across
several lines carries the same `id` and is counted once. A harness that states a
*running* total on every line rather than each turn's addition does not meet it and
should say `plain` — the figure would otherwise be summed as if it were new spend.

`protocol` must match what `args` actually asks for: declaring `claude-stream-json`
without `--output-format stream-json` produces prose, and prose reports nothing.
Unmetered is not an error — the run still happens, is still timed, and still lands its
wall spend on the ledger. It only means the token half of the spend column has nothing
to show, which is the truth and not a zero.

Worked, for two harnesses wecode knows nothing about:

```toml
[agents.opencode]                 # takes its instruction as an argument, says nothing
command = "opencode"
protocol = "plain"
args = ["run", "{{prompt}}"]
env_allowlist = ["OPENCODE_API_KEY", "PATH", "HOME", "LANG"]
wall_secs = 1800

[agents.hermes]                   # emits the published contract, so its runs are metered
command = "hermes"
protocol = "generic-jsonl"
args = ["--task", "{{prompt}}", "--events", "jsonl"]
env_allowlist = ["HERMES_TOKEN", "PATH", "HOME", "LANG"]
models = ["small", "large"]
model_flag = "--model"
```

Every `tokens` number in this file — the `max_tokens` invariant, a role's cap, a
playbook's default — counts the tokens a run **adds**: its prompts, what it writes to a
prompt cache, and everything the model produces. Context re-read out of that cache is
counted separately and is never checked against a budget. It is the same context on
every turn, so it grows with turns times context while the work grows with the
conversation; a cap written in the one scale and checked in the other is over on the
first turn and says nothing thereafter. `wecode run` prints the replayed figure beside
the spend, because cache reads are billed — at a tenth of the rate — and a number left
out of a budget should not also be left off the screen.

## Why `engineer` reaches into `specs/`

Both starters give the engineer `specs/**/specification.md` beside its code globs. The
specification is that seat's own deliverable — ISO/IEC/IEEE 15289 names the information
item and no author for it apart from whoever builds the thing — so a role that ships
code and cannot keep its contract true ships a stale one.

| the objection | why it does not hold |
|---|---|
| an engineer editing what it is judged by | acceptance commands are named on the **task**, by whoever defined it, and are never read back out of the spec |
| it could write its own close-out report | `specs/**/report_as_finished.md` is outside the glob: its numbers come from `git diff --numstat`, and an agent's account of its own work is inadmissible |
| `spec/**` on the tester looks like the same thing | it is rspec's test directory — one letter away, a different owner; settle it with `wecode guard <post> write <path>` rather than by reading |

Named per document, not as `specs/**`, because the folder also carries the template a
spec is copied from and a README that is nobody's slice.

## Names that must resolve to one thing

Two identifiers in this file are looked up by something that has nothing else to go on,
so a second block claiming one is refused at load rather than resolved by order.

| | why one |
|---|---|
| `[[repos]] name` | a project owns one repository, by name — a duplicate makes the second `path` configured and unreachable, and the work lands in whichever was typed first |
| `[[users]] telegram` | a reply carries an account and no name, so a shared one is a signature attributable to two people; see [telegram.md](telegram.md) |

Neither refusal is about tidiness: order decides both, silently, and the wrong answer is
indistinguishable from the right one afterwards. The reverse pairings are legal — two
names over one `path` is a monorepo or a renamed checkout, and a person with no
`telegram` simply cannot answer from a chat.

## Run it before you depend on it

Everything above is checked when the file is *loaded*: the TOML parses, the roles
resolve, a post names an agent that exists. What none of that asks is whether the names
are true **here** — whether `[[repos]] path` is a directory on this machine and a
repository, whether `[agents.*] command` resolves to something executable on wecode's
`PATH`, whether every name in `env_allowlist` is actually set in the environment wecode
is running in. Those are questions about a filesystem and a shell, and until a task was
dispatched nothing asked them.

That is the wrong moment to find out, because the failure is *misattributed* rather than
merely late. Dispatch happens after admission and after scheduling, with a worktree
already cut and a run row already open, so a missing `claude` or an `[[repos]] app` still
pointing at the `~/projects/your-repo` the template shipped with lands on the board as a
task that could not be done. Read back later it is indistinguishable from work that was
genuinely too hard, and `wecode loop` files another one on every promotion.

`wecode doctor` asks all three now. It resolves the command the way `spawn` will —
without starting it — checks the charter's `never_run` against the line each staffed seat
would actually be dispatched on, and reads the allowlist back off its own environment,
which matters more than it looks: a worker is started with `env_clear`, so the list is
not a filter over the ambient environment, it *is* the environment. A name on it that is
unset where wecode runs arrives as nothing at all, and the agent discovers that on its
first authenticated call, having already spent the task's budget getting there. A missing
`PATH` is the same fault wearing a disguise — every name on the list is set, so nothing
reads as wrong, and the harness starts without the `git` it commits with. An agent no
post is staffed with is reported as an absence, not a fault. See
[commands](../commands.md#the-ones-worth-explaining).

## Which model a seat gets

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

## `[budgets]`

| key | default | meaning |
|---|---|---|
| `enforce` | `false` | whether a task's token budget stops a run or only measures it |

Off, a run that spends past its budget is never killed: the overrun lands on the
board in red and the ledger keeps the true figure, but the work in the tree
survives. On, the supervisor stops the run shortly after the budget is crossed.
Wall clocks are not behind this flag — time is the operator's; tokens are money.

## `[[invariants.auto_merge]]` — saying yes once

`approval_to_merge` demands a holder's signature per merge. On the branch somebody lands
on twice a day that signature stops being a decision and becomes a keystroke, and the
operator typing it is not governing the merge. A standing order is the same permission
given once, by condition, in this file.

| key | required | meaning |
|---|---|---|
| `to` | yes | branch glob the order is about — `*` stays in one segment, `**` spans them |
| `projects` | no | project ids it is confined to; omitted means every project |

One block per order, and as many as you like. Nothing else is conditionable: the Broker
decides as a pure function of its inputs, so a size or a file list — which would mean
reading a repository — is not on offer.

### Worked example

A company that protects every release branch, and has decided in advance that the docs
site may land on them:

```toml
[invariants]
approval_to_merge = ["main", "master", "release/**"]

[[invariants.auto_merge]]
to = "release/**"
projects = ["docs-site"]
```

```console
$ wecode guard chief merge release/2026-09 --project docs-site
chief (claude-code)  merge release/2026-09

  ✓ allowed

$ wecode guard chief merge release/2026-09 --project payments
chief (claude-code)  merge release/2026-09

  ⏸ needs approval: merge
     nothing happens until a holder signs.
```

### The four things it does not do

| | |
|---|---|
| grant anything | the seat still needs `merge_to` for the branch; this settles whether a *person* is asked, never whether the seat may act |
| cover a merge that named no project | an order confined to projects needs to know which one, so an unattributed merge still stops on a signature |
| open a branch nothing protects | those merges already land; the order is inert, and is left that way so putting a protection back is a one-line edit |
| reach `wecode merge <task>` **yet** | that command still re-derives protection for itself; until it asks `Charter::demands_signature_to_merge`, `guard` and `merge` can disagree about the same merge |

It also cannot be written anywhere but here. A per-task signature comes from any seat
holding `approve merge`; answering every merge of a shape in advance changes what the
charter demands, and the charter is amended by hand, in a diff — never on a signature.
That is the same reason `wecode approve` grows no `--standing` flag, and the reason
`[project] merge = "auto"` in a playbook cannot do this: a playbook is committed inside
the repository being merged, so it may be stricter than the charter and never laxer.
