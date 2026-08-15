# What is built

The inventory, including what is weak. Anything not here is not built — see
[plan.md](../plan.md).

## Planning

| | |
|---|---|
| **Projects and tasks** | two levels, one repo per project |
| **Two relations** | `parent` (is part of) and `depends_on` (comes after), checked separately |
| **Seven kinds** | feature, bug, refactor, chore, spike, design, docs |
| **Admission gate** | deterministic defect checks, each carrying a fixed question |
| **Playbooks** | per-project guidance, in the project's own repo |
| **Starters that know a toolchain** | `playbook init` reads the repo's manifest and writes real commands |
| **Playbook gaps** | a planner records what the guidance did not say; the next one reads it |
| **Templated decomposition** | `--expand` emits the subtasks a playbook declares |
| **Design gate** | `design_required` refuses a kind with no design task behind it |
| **Dispatch gate** | `dispatch = "approved"` refuses to start a task nobody signed for |
| **Archiving** | park a project: hidden *and* not scheduled |

The **admission gate** is the part most worth knowing. A task is refused, with a
question, if its title names more than one outcome or uses a word like *faster*; if it
has no executable acceptance; if it has no write scope (except a spike); if it has no
budget; if its scope overlaps a task that could run at the same time; or if it would
close a dependency cycle. `--force` admits it anyway and records the defects as waivers.

**Scope overlap is judged per repository, not per project.** A project owns one repo; a
repo carries as many projects as anyone starts on it. Two of them claiming the same paths
is two worktrees changing the same lines, and only one of the two can merge cleanly — so
the check scans every open task on the same repo, names the project the other task
belongs to, and takes the same two repairs as a sibling conflict: narrow one scope, or
sequence them, which a `depends_on` may do across the boundary. Tasks on different repos
never collide however alike their globs read, a closed task's scope is history, and an
archived project dispatches nothing, so neither is treated as competition.

The **design gate** is the admission check that keeps a feature from going from an idea
to a merged branch with no human ever seeing a design. A playbook kind that sets
`design_required` is refused unless a `design` task stands before it — a predecessor
anywhere up its dependency chain, or a subtask inside it, which is the shape `--expand`
creates. The relation is the entire check: a design finishes only through a recorded
signature, and nothing dispatches while its predecessors are unfinished, so the ordering
machinery is what holds the work back until someone signs. Whether the design is any
good stays a human judgement; the gate does not pretend to check it.

What was decided then reaches whoever builds it: the same `depends_on` edge the gate
counts is the edge the handoff travels, and a design predecessor arrives as its document
rather than as a diff — see **Execution** below.

The **dispatch gate** is the same idea one step down. A project whose playbook says
`dispatch = "approved"` starts nothing — by hand or by the loop — until a holder has
signed that task: `wecode approve admission --task <id>`. It exists because the admission
gate is deterministic, and a deterministic check can say a task is vague or unscoped but
never that it is the wrong task; that judgement is a person's, and this is where it fits.
The signature is read from the ledger, so it names the post that gave it and the person in
that seat, and it goes stale if the task is redefined afterwards — amending a scope asks
for it again. Off by default: a run is bounded by a budget, confined to a worktree and
judged before it can land, which is what makes it safe to leave `auto` where `merge` is
`approved`.

**Playbooks** are guidance for whoever decomposes work, read before creating tasks. Free
prose for how to break work down, plus a few typed fields wecode acts on: whether the
kind needs a worktree, the default acceptance commands, assignee and budget, and the
merge policy. They live in the repo because they describe that code.

**A starter knows its toolchain.** `wecode playbook init` used to write the same TODO
template whatever `--language` said — the word landed in one field and changed nothing
else — so every project began with `accept = []`, no shared build cache, and a subtask
example scoped to `src/**` and nothing a build touches. Each of those was paid for by
the project's first task, and one repo acquired `python -m pytest` on a machine with no
`python`. The language is now read off the repository's own manifest, and it decides the
acceptance commands, the `[project.build_cache]` block, and the lock file named in the
write scope and in the guidance of every kind that changes code. The table is consulted
once, while the file is written; nothing at run time branches on a language, so being
wrong about one costs an edit. wecode writes for rust, go, python and node, and a
language it does not have still gets the file it always got. What was decided is printed
rather than left in the file, including whether this machine can run what was written —
a starter naming an absent program is a warning there and a refusal everywhere else.

**Playbook gaps** close the loop the other way. A playbook is hand-edited and in no
role's write scope, which is right and left the planner that discovered the guidance was
short with nowhere to put that; the finding died with the session and the next planner
paid for it again. `wecode playbook gap "<what it did not say>"` records one, and it is
shown at the end of `wecode playbook <kind>` — after the guidance, because that is the
order the two were learned in. It is a note and not a change: nothing branches on one,
which is what makes it safe for an agent to write, and it goes away only when a person
folds it into the playbook and deletes it. The gate is `define project`, so the seat
that plans work may record one and the seat that writes the code may not. It is kept in
the workspace rather than beside the playbook because the repository is what
verification diffs, and a file dropped there would be reported as some other task's
scope violation.

A kind may also declare its **decomposition**, which `wecode task add --expand` emits as
ordinary tasks — chained, scoped, and with `{{task}}` substituted — instead of one
`task add` per step with every scope and acceptance command retyped. That retyping was
where the planning errors came from, and every one of them was catchable before any
agent ran. The template runs once, at planning time, and nothing consults it afterwards:
its output faces the same admission gate as hand-written tasks and can be edited or
dropped before dispatch. It is all or nothing, because a half-built expansion leaves the
later steps waiting on tasks that were never created.

## Governance

| | |
|---|---|
| **Posts, roles, agents** | a seat, its capabilities, and the harness in it |
| **Grants** | intersected, never unioned; empty permits nothing |
| **Charter invariants** | outrank every grant; violations alarm rather than deny |
| **Sessions** | expire on idle; autonomous means no human |
| **Audit ledger** | one table, monotonic, marked by source |
| **Separation of duties** | the chief cannot write or run — enforced at load |

`wecode guard <post> <verb> <target>` asks the Broker a question without doing anything,
which is how you check a scope before assigning work to a seat that cannot reach it.

## Execution

| | |
|---|---|
| **Worktrees** | one per main task, outside the repo and the workspace |
| **Shared build cache** | directories a project's worktrees share, so a task is not a cold build |
| **Spawning** | environment from an allowlist, new process group, wall and idle timeouts |
| **Budgets that bite** | the wall and the token figure a task declared stop the run, not just describe it |
| **Why it failed** | the harness's own last words, on the record the next attempt reads |
| **Intelligence** | a seat declares how clever its occupant is, 1–10, and the model is derived |
| **Verification** | the branch's diff against the declared scope, then the acceptance commands |
| **Commits** | every attempt, pass or fail, authored by wecode |
| **Spend** | tokens read out of the agent's own output, per attempt and on the ledger |
| **Handoff** | a predecessor's diff — or its design document — never the agent's account |
| **Merge** | `--no-ff`, configurable policy, with a report that is committed — by the main task, which is the only thing that owns a branch |
| **Rollback** | revert, not reset |
| **Scheduler** | a tick that promotes, a loop that dispatches |
| **A2A** | the instruction *is* an A2A task; the prompt is one rendering of it |

The **environment is built, not inherited** — a coding CLI would otherwise read every
secret in the shell, and absent a container that is the only network control there is. A
**new process group** matters because coding CLIs spawn children, and signalling only
the parent leaves them running.

**Which model runs is now a property of the chart.** It used to be a property of the
operator's terminal: no model was named anywhere in `company.toml`, every agent
inherited whatever `/model` was last set to, and two runs of the same task on different
afternoons could cost tenfold with nothing recording why. A post now carries
`intelligence`, 1–10, and its harness carries `models` weakest first; the scale is
spread over that list and the level picks the weakest model that reaches it. A level
rather than a name, because names churn and an ordering does not — add a model and every
seat keeps meaning roughly what it meant. `[invariants] max_intelligence` is the ceiling,
and it is a ceiling and not a default, so a seat under it keeps its own number. The
resolved model goes on the launch line, which is the line the ledger already records, and
`wecode run` says which model ran beside what the run cost. It is not a quality control:
a level names what is launched, and whether the work is good is still the acceptance
commands and the human signature. A company that declares none of it names no model at
all and behaves exactly as it did before.

The **shared build cache** is what keeps a clean worktree from meaning a cold build. A
project names the directories its worktrees share — `[project.build_cache]` in its
playbook, one environment variable per line — and wecode sets them on the agent and on
the acceptance commands alike, since both build and verification's is usually the larger
of the two. wecode carries a name and a path and knows nothing about either, so
`CARGO_TARGET_DIR`, `GOCACHE` and `SCCACHE_DIR` all work without wecode having heard of
them. A relative path is refused, because it would resolve inside each worktree and hand
every task its own copy under a name promising the opposite; so are the variables that
decide which program runs rather than where its output goes. The trade is honest and
stated: cargo locks a target directory, so tasks building at the same moment queue
instead of rebuilding, which is seconds against minutes. A project that declares nothing
behaves exactly as before.

The **instruction is an A2A task**, not a string built beside one. What the worker is
told is a `Message`; what it is given to read — a predecessor's commit, its own failed
attempt — is an `Artifact`. The text prompt is `wecode start <task>`, the same record as
JSON is `wecode start <task> --json`, and neither can drift from the other because there
is only one. The structured half never reaches the prompt: a coding CLI reads a JSON
blob on argv as part of its instruction.

**A design predecessor is handed over as its document, not as a diff.** Every other kind
produces code, where the diff is the answer. A design produces a file, and the decision
is the whole of it — a diff would say what changed since the last draft, which is a
different question and usually an empty one. It is also the one kind wecode never
commits: a design asks for no worktree, so it is written into the repository the operator
is standing in, and the successor's branch is cut from a base that may not carry it yet.
Read out of the file system for that reason — the design's own tree, then this task's,
then the project's checkout — at whatever path the design's **write scope** declared,
because a playbook that templates its steps names its own (`src/design/{{task}}.md` is as
valid as the convention). A scope that names a directory rather than a file falls back to
`docs/wecode/<task>/design.md`, which is what the starter guidance writes down. The cap
is four times the diff cap, since a design is read rather than skimmed and the part
naming what it costs is written last. When no copy can be found, the handoff says which
path it looked at: a signed design that produced nothing and one this process could not
locate are very different facts, and `(no commits in this worktree)` — which is what the
handoff used to say — claimed the first while meaning the second.

**Nothing reads `.wecode/result.json`.** The diff is ground truth and an agent's account
of its own work is inadmissible, so the file is written and ignored.

**The scope check reads the branch, not the working tree.** Both halves of a verdict have
to survive a retry, and one of them did not: wecode commits every attempt, and a retry
opens with `git reset --hard`, so a second attempt is judged on top of the first one's
commit. The acceptance commands were never troubled by that — they run against the
worktree, which carries the committed work either way — but the diff was read as
`git diff HEAD`, and everything the previous attempt wrote sits *behind* `HEAD`. An
attempt that added nothing was therefore judged against an empty diff, and an empty diff
violates no scope. A first attempt rejected for writing outside its scope passed on the
retry that ignored it, with the out-of-scope file still on the branch and on its way to a
merge. The retry did not overturn the finding; it stopped looking, which is the worse of
the two because it reads as a clean run — a green check beside a diff saying *nothing
changed*. The verdict now takes the uncommitted diff together with this task's own
attempt commits, matched by their subject, so what is judged is what the branch would
land. Its own, and not the log's: a subtask shares its parent's branch and its siblings'
attempts are in the same history, each already judged against its own scope, and the base
carries the predecessor work this branch was cut from, which is nobody here's to answer
for.

**The merge report is committed, not printed and lost.** It goes to
`docs/wecode/<task>/report.md` on the integration branch — the same directory the design
gate looks in — as its own commit on top of the merge, because the report names the merge
sha and no commit can contain its own name. The file is the report *verbatim*: it is
evidence, so it has to be the text that was produced rather than a second telling of it,
and one generator means the repository and the terminal can never disagree about one
merge. Generated, never authored, for the same reason `result.json` is ignored. The only
line the terminal adds is where the file went, which the file cannot say about itself. A
record that fails to land is a line in the report rather than an error — the merge has
already happened by then, and there is nothing left to undo. `rollback` leaves the file
standing and says so: a revert is a new commit precisely because the merge did happen.

**Spend is the one number that is reported rather than observed**, and it is marked as
such. wecode does not sit between an agent and its model, so the only party that knows
the token count is the harness that spent them: the count is read out of the agent's own
output stream, matched to the `protocol` its template declares, and the ledger files it
under `harness` instead of `supervisor`. Only `claude-stream-json` is read today; every
other protocol string is **unmetered** until an adapter for it exists, since inventing a
number from an output format nobody has read is worse than no number at all.

Unmetered and free are different facts and are stored as different values —
`task_executions.spent_tokens` is NULL for one and `0` for the other. `wecode run` says
"unmetered" in words and `wecode show` leaves that attempt's cell as `—`. The board's
spend cell is a *total*, so it has nowhere to put the distinction: an unmetered agent
contributes nothing to it and the row reads `0`. The number there is always what was
reported and never a guess, but a zero on the board is worth confirming against
`wecode show <task>` before believing a run was cheap.

Counting happens as the output streams past, not afterwards: the buffer is capped at
256 KB and the line stating the run's total is the last one, so the expensive runs are
exactly the ones a read-it-at-the-end approach would lose. The cost is recorded however
the run ended — a killed agent still burned what it burned.

**Spend is counted in the unit budgets are written in**, which is tokens the run *added*
— what it sent, what it wrote to the cache, and everything the model produced. Context
re-read out of the cache is not in that number. Those tokens were counted once already,
on the turn that wrote them, and a conversation replays its whole context on every turn
after: the replay grows with turns *times* context while the work grows with the
conversation. Nobody estimates a task in the first scale. Judged against it, a 120k
budget was blown before the agent had written a line, every row on the board was red,
and a genuine overrun looked exactly like a cheap run — which is how this was found, by
running wecode on itself.

The replay is not hidden, because cache reads are billed, at a tenth of the rate. It is
reported beside the spend on the `wecode run` line — `spent 163400 tokens, as the agent
reported them (+4812000 re-read from cache, not budgeted)` — where a long conversation's
cost is visible without a budget having to be denominated in it.

**A turn is counted once, however many lines it took to announce itself.** A coding CLI
emits one `assistant` line per content block, so a turn that thought and then called a
tool restates the same message — same id, same usage — three or four times over. Summed
line by line, a 60-token turn reads as 240. The run's own total, stated at the end,
supersedes that sum and is what the ledger keeps, so the figure a person read afterwards
was always right; the supervisor is not reading afterwards. It checks the budget against
the running sum, and killed runs at four times the spend they had made, for a number
nothing that survived the run agreed with. Restatements are now recognised by their
message id and counted once, so the count that stops a run is the count that is recorded
for it. A harness that names no message is taken at its word every line — there is
nothing to recognise a restatement by, and the wrong guess in that direction would
report a whole conversation as a single call.

**A budget is a limit, not a label.** Both figures a task declares now reach the process
it was written for. The wall is the *tighter* of the task's and the harness template's:
the template is the backstop under every run this harness makes, and a task must not
declare its way past it — a chore given sixty seconds no longer runs to the harness's
half hour. The token figure is checked against the meter while the output is still
streaming, so a run that has reported spending past its budget is killed where it stands
and the line reads `killed — token budget`. That is a bound, not an interception: the
count arrives a turn at a time and the tokens of the turn that crossed the line are
already gone, so a task budgeted at 1000 stops shortly after 1000 rather than at 1000 —
and, before this, at nothing at all. The residual overrun still lands on the board in
red, which is the part that was always true and used to be the only part.

The `wecode run` line names what held the run, and whose figure it was: `limit    wall
600s (this task's budget), idle 300s, 9000 tokens (this task's budget)`. A task's wall
and a harness's wall are two declarations in two files with two owners, and "give it
longer" means editing a different one depending on which of them bit. Idle stays the
harness's alone — a budget says how long the work may take, not how long it may go quiet
in the middle of it — and so does the whole of an unmetered run: an agent whose protocol
wecode cannot read reports no count, and a budget checked against a number nobody has
would be a kill nobody could account for.

**A failed run records why, not only that it failed.** The record used to say `exit 1`,
which is a fact about a process and not a reason: an agent that gave up, a harness that
crashed on a bad config and a machine with no credential on it left the same mark, and
`exit 1` says exactly as much as `killed by a signal` does. The sentence telling them
apart had been captured all along — it is in the output wecode buffers, and the last
lines of it are printed at the end of `wecode run` — and then it was dropped, so the
durable copy kept the exit code alone. That is the copy that matters: it is what the
retry's envelope hands the next attempt under **YOUR PREVIOUS ATTEMPTS**, what `wecode
show` prints against the run, and what the failed attempt's own commit carries in its
message. All three read `exit 1 — Error: invalid x-api-key` now, and a run stopped by a
limit says what it was in the middle of saying when the clock ran out.

The **last plain line**, and three things are deliberately not quoted. Nothing from a run
that overflowed its 256 KB buffer: the cap keeps the *beginning*, so the end of that
string is the middle of the run, and quoting it as the reason would be an invention —
those runs fall back to the bare ending, which is what every run used to get. (The same
cap is why the `last output` block at the foot of `wecode run` shows a capped run's
*first* lines under that heading; the `output was capped` line above it is the only
warning, and the record is now the more careful of the two.) Nothing that begins as JSON,
since a metered agent narrates itself into the same buffer its errors land in and 200
characters of a `result` object explains nothing — recognised by its first character and
skipped, not parsed. And nothing more than twenty lines back, so the answer is the run's
ending rather than the last prose it happened to emit. A clean run is left alone
entirely: its last line is a warning or a progress note, and hanging that off `exit 0`
would put a cause on every record that has none.

## Watching

| | |
|---|---|
| **`wecode up`** | a live cockpit: what, status, spend, needs-you |
| **`wecode board`** | the same view as a one-shot snapshot |
| **`wecode brief`** | orients an agent, derived from its grant rather than stored |
| **`wecode tree` / `ready`** | the plan, and what is startable |
| **Short numbers** | every project and task also answers to a number you can type from a phone |
| **Notify hook** | a command wecode runs when a task starts waiting on a person |
| **`wecode telegram`** | signs what the replies to those notifications approved |
| **`wecode doctor`** | runs both of those now, so neither is trusted untested |

**The notify hook is the only thing here that does not wait to be looked at.** Every
view above answers a question the operator thought to ask; a task that stopped at 02:14
for a signature sat there until somebody next opened a terminal, which is the one part
of running unattended that was still manual. `[notify] command` runs when a task
*starts* waiting — the transition, not the state, so a task waiting a week fires once —
and the operator decides what telling them means: a desktop notification, a message, a
line in a file. The task arrives in the environment rather than substituted into the
command line, since a title is prose and a shell would read it as syntax.

`WECODE_WAITING_FOR` is what the hook branches on, and it has four values where the
board has three: `approval`, `input` and `failed` restate a status, and `signature` is
the dispatch gate holding a task that is otherwise `ready` — a wait with no status to
express it, which is exactly why the loop had to print it every pass. That one is
announced by the loop that computes it, once per task while it stays unsigned.

A hook cannot fail the work: a non-zero exit, a hang, a command that is not there are
all reported as a warning beside the verdict and stepped over, because a task is not
less finished for a notification going astray. It is killed at `[notify] timeout`, since
`wecode loop` runs for days. And it is checked against `never_run` like any other
command wecode executes — an invariant outranks every grant, and a config is not an
exception.

**And the answer comes back the same way.** A notification that reaches a phone at 02:14
still left the signature on a terminal, so the queue stood still until morning anyway —
the push moved the knowing and not the doing. With `[telegram] fetch` set, replying
`approve` under that message signs it: `wecode loop` reads the channel every pass, after
promotion and before dispatch, so the work starts on the pass that finds the reply.

wecode holds no bot token and speaks no HTTP. `fetch` is the operator's own command line
— a `curl` of `getUpdates`, told how far wecode has read through
`WECODE_TELEGRAM_OFFSET` — and what it prints is what gets parsed. The reply's account
is an *identity*: it resolves to the `[[users]]` entry naming it or to nobody at all, and
what that person may sign is their post's `approve` list, checked by the Broker and
recorded either way. A stranger who finds the bot signs nothing. What is signed is one
ledger record, indistinguishable from a typed one — which is the point, because every
gate that reads it should be.

A bare `approve` signs what the task is waiting for — `merge`, `design`, or the
`admission` the dispatch gate wants — and a task with nothing outstanding is refused
rather than given a default. `no` signs nothing and leaves the task in front of a person,
which is what withholding a signature already means. Anything else is chat and is left
alone. Every message is acted on once: the update read is kept in `wecode.db`, so a
`getUpdates` retried after a network error cannot sign twice.

**And both halves are run before anything depends on them.** The way out and the way back
are command lines the operator writes by hand, and nothing executed either of them until
a real task stopped for a real person — the worst moment to find out the chat id is one
digit out, and the moment the failure is invisible. Every way this breaks arrives as
*silence*, which is also what a quiet queue looks like: the board says a task is waiting
and nothing anywhere says whether anybody was told.

`wecode doctor` fires `[notify] command` for real, against a task that does not exist,
and reads `[telegram] fetch` back — the command *and* the JSON, because a revoked token
exits `0` with `{"ok":false}` in the body and reads as an empty channel to everything but
the parser. It also asks the question neither line can: whether any `[[users]]` gives a
`telegram` id, and what that person's post may sign, since a channel that resolves every
reply to nobody is read every pass and answered from never.

It signs nothing and consumes nothing — no ledger record, no status write, and the fetch
is asked from offset `0`, which is everything Telegram still holds and confirms none of
it. The drill's message carries no short number, because that is the handle a reply is
typed against and a live one in a real chat message would be one `approve` away from
signing work nobody looked at. What it cannot do is say the message arrived: wecode holds
no chat and sees no phone, so the report ends by naming the half only the operator can
answer. The exit status carries the rest, which is what puts `wecode doctor && wecode
loop` in front of a day's unattended work.

**Every level shows the whole tree beneath it.** The portfolio used to stop at root
tasks, so a plan that broke its work down showed only the tops of the breakdowns — and
the row that is actually running, over budget or waiting for a signature is usually a
leaf. It was there on the project row as a rolled-up `2 to answer`, with no way to find
out which two without descending into each project in turn. Now the portfolio draws
projects, their tasks, their subtasks, and so on to the bottom; `wecode board <id>` and
the focused levels of `wecode up` do the same from wherever they start.

A tree that is drawn in full is a tree that can be longer than the screen, so `wecode up`
folds: `space` puts the selection's children away, `z` folds the whole plan down to its
projects, `Z` opens it again, and `▾`/`▸` on the row says which way it points. It starts
open, because what is not on screen should be what the operator put away rather than what
the view decided to omit — and a fold is remembered by subject, so it survives the
reload a second and a half later. Descending into a folded row opens it, since zooming in
is asking to see inside. `wecode board` does not fold: a snapshot piped into a pager is
already scrollable, and a fold state a one-shot command forgets is a flag nobody sets.

Health is **computed** from the ledger, the budget and the defect checks — never
reported. It is the colour of the needs-you cell rather than a column of its own:
every cause of amber or red writes an entry there, so a column beside it only ever
repeated it. Status is declared and sits apart, because a task can be perfectly
healthy and not started.

**Work that cannot advance on its own is flagged, not just work that is loud.** A task
whose prerequisite `failed` or was `dropped` looks exactly like one whose prerequisite
is still running — both say *waiting* — but no tick will ever release the first. The
board marks it amber with `stuck on <id>`, the project row carries a `N stuck` count so
a stranded subtask is countable without reading its branch, `ready` counts stuck work apart from
work that time will resolve, and `wecode status <t> failed|dropped` names the dependents
the act just stranded. Deliberately narrow: a prerequisite at `needs-approval` or
`needs-input` is a signature or an answer away from done — work queuing behind an
unsigned design is the design gate working, not a dead end — and reopening the failed
task (`wecode status <t> waiting`) takes the flag down by itself.

`brief` is derived rather than written down on purpose: a stored "you are the
orchestrator" prompt drifts from the grants the moment a role changes, and then promises
authority the Broker will refuse.

---

# Gaps

Stated here rather than left to be discovered.

## Two statuses are unreachable

`verifying` is never set — verification is synchronous inside `run`, so nothing observes
the task while it happens. `needs-input` is never set — nothing detects an agent
stopping to ask, and a subprocess CLI that has paused generally cannot be resumed
anyway. Both remain in the vocabulary because the A2A mapping needs them and the board
renders them.

## A plan more than two levels deep may not load again

`Plan` puts no limit on how deep the is-part-of tree goes, and every view now draws it
to the bottom. The **store cannot always read one back**. `load_plan` orders tasks
`(parent_id IS NOT NULL), id` — roots first, then everything else by id — which gets a
parent before its child for exactly two levels. A grandchild whose id sorts before its
parent's arrives first, `Plan::add_task` refuses it as `no task <parent>`, and the load
fails: `stored plan structure is not recognised`. Not the task, the whole workspace,
every command, until the row is deleted by hand.

Found by writing a three-level tree into a test store, and left here rather than fixed
because the fix is in `wecode-store` and this task could only write to the CLI. It wants
a walk from the roots outward, or a topological sort, in place of the ordering trick —
about ten lines, and worth doing before anybody plans three levels deep in anger. Two
levels are safe in any order, which is why nothing has hit it yet.

## Enforcement is post-hoc, not intercepted

wecode cannot hook another process's writes. Confinement is the worktree; the scope
check runs afterwards on the diff. That is *why* a write outside scope is sanctioned —
recorded as a signal — rather than prevented. Per-write enforcement needs a sandbox, and
claiming it without one would be false.

A **token budget is bounded rather than intercepted**, which is the weaker claim and the
honest one. The count is the agent's report and arrives a turn at a time, so no limit can
refuse the tokens that cross it — but it can refuse the next turn, and the supervisor
does. The overrun that survives is one turn wide instead of unbounded, it still turns the
row red, and nothing is ever refunded. A wall is the stronger half of the same budget,
because time is the one thing wecode measures itself.

## The operator is not governed

Everything above applies to work wecode dispatches. An operator working through their
own agent — which is how wecode itself is built — is not subject to any of it. The
guard, the scopes and the charter are advisory in that mode.

## A scope amendment can launder drift

`wecode task scope` can widen a declaration after the work is done, and while the
amendment is recorded, nothing correlates it with a verification that passed
immediately afterwards. The ledger holds both facts and joins neither.

The dispatch gate joins them at the one point it can: a signature earlier than the last
amendment does not count, so widening signed work asks for the signature again. That
covers the window *before* a run and says nothing about the one after it, which is where
`verify` still needs to look.

## A reply is answered in the loop's output, not in the channel

wecode reads replies and never writes one. A `no` is acknowledged, a message naming no
task is reported, a refused signature is explained — all of it in `wecode loop`'s output,
which is on the machine the operator was not at when they replied. The channel goes
quiet, which reads exactly like a reply that was never processed.

Fixing it means keeping the chat to answer in, which is state this deliberately does not
hold: the outgoing side is `[notify] command`, an arbitrary line that may not be a chat
tool at all. Until then, `wecode telegram` run by hand says what happened to everything
already read — and the board still says what is waiting, which is the fact that matters.

Nothing narrows *which* chat a reply may come from, either. The account is the check, so
a message to the bot from anywhere counts if that account is a `[[users]]` entry.

## No retry, and no crash recovery

A `failed` task waits for a person to reopen it; the loop will not retry by itself.
And if the loop dies mid-run the task stays `running` forever, leaking a slot each time
— `Store::unfinished_executions()` exists to find those rows and nothing calls it.

## Other absences

Serving or calling A2A over JSON-RPC — the model is wired, the transport is not — plus
streaming progress, containers, RACI, and the recursive management functions the theory
describes.

A **shared build cache is never cleaned or bounded**. wecode creates the directory and
sets the variable; nothing evicts it, no worktree teardown touches it, and there is no
`wecode cache clean` — every toolchain that reads one of these variables has its own
opinion about clearing it, and one wecode ran on its own schedule would be a way to lose
a cache at the worst moment. The growth is the operator's to watch. Concurrent tasks
also queue on the toolchain's own lock rather than building in parallel, which is the
trade the feature is for and not a defect.

**A task cannot ask for a cleverer occupant than its seat has.** `intelligence` is a
post property and there is no `--intelligence` on a task, so the lever for one unusually
hard piece of work is to assign it to a seat that carries the level — which the playbook
already does per subtask, and which is the case worth optimising for anyway. The
per-task override would have to freeze with the acceptance and the scope to be worth
anything, and a number that lives only on the command line is a number nobody can audit.

`protocol` is now matched on, but for one thing and one value: `claude-stream-json`,
to read a token count. It is still not validated at load, so a typo in `company.toml`
silently produces an unmetered agent rather than an error — visible on the board as a
blank spend cell, which is honest but easy to miss.
