# Commands

Generated from the CLI's own help, so it cannot drift: `wecode help` prints this.

```
wecode — run coding agents as staff

A company is a self-contained directory: company.toml by hand, wecode.db by
machine. It is not a code repository; the repos it works on are declared inside it
by path.

SESSION
  wecode orgs                          named orgs under ~/.wecode/workspaces
  wecode use <name|dir>                remember a default org (skips --org)
  wecode login <user> [--as <post>] [--agent <n>]   open a session
  wecode whoami                        this seat, and the commands it may call
  wecode who                           everything connected right now
  wecode logout [--session <id>] [--all]

SETUP
  wecode init <name|dir> [--template <t>] scaffold a company workspace
        a bare name lands in ~/.wecode/workspaces/<name>
  wecode templates                        list available templates
  wecode company show                     profile, posts, invariants
  wecode doctor                           check this machine can do the work
        resolves git, the worktree root, every [[repos]] path and [agents.*]
        command, then fires [notify] command and reads [telegram] fetch back;
        signs nothing, consumes no reply, non-zero if what is set does not work

  Commands find the workspace by walking up from the working directory, or via
  --org <name|dir> / $WECODE_ORG / the default set by `wecode use`.

PLAN
  A project owns one repo and carries an objective. A task is the executable unit.

  Anywhere below takes a <project> or <task> by its id or by its short number: every
  view prints one in the left column, and `wecode merge 4` is `wecode merge
  cache-warm-on-deploy`. Write `#4` where a task is actually called `4`.

  wecode project add <id> --repo <name> "<objective>"
        --measure-cmd "<cmd>"   --measure-metric <name>:<lt|lte|gt|gte|eq>:<n>
        --tokens <n>  --wall <secs>
  wecode project list

  wecode task add <id> --project <p> "<title>"
        --kind <epic|story|feature|bug|refactor|chore|spike|design|docs>   default: feature
        --by <agent|person>      who does the work; default: agent. `manual` and
                                 `human` say person. Not yet recordable — the
                                 store has no column for it, so this is refused
        --parent <task>          is part of that task
        --after <task>           must come after it (repeatable)
        --accept-cmd "<cmd>"     executable acceptance (repeatable)
        --accept-metric <name>:<cmp>:<target>
        --write <glob>  --read <glob>   scope (repeatable)
        --tokens <n>  --wall <secs>     --to <post>
        --expand                 also emit the subtasks the playbook declares
        --force                  save despite defects, recorded as waivers
  wecode task rm <id>                  erase a task that never ran
  wecode task scope <id> --write <glob> [--read <glob>]
        replace a scope after the fact; recorded violations are not erased
  wecode task budget <id> [--tokens <n>] [--wall <secs>]
        raise a budget a run proved short, on the task that ran; each figure
        is amended on its own, and the next run is the one held to it

  wecode playbook [<kind>]             this project's guidance for that kind
        --project <p>
  wecode playbook init [--language <l>]   writes a starter into the repo; the language
                                        decides its accept commands, its shared build
                                        cache and the globs a build dirties, and is
                                        read off the repo's manifest when omitted
  wecode playbook gap "<what the guidance does not say>"
        --kind <k> --task <id>          record a gap you found while planning;
                                        shown to whoever reads that kind next
  wecode playbook gaps                 what has been found and not folded in yet
  wecode brief                         who you are and how to work — read this first
  wecode tree [--all]                  projects and their task trees
  wecode map [<project>] [--seed <glob>…]   what sits next to what, by name
        parses the tracked source with tree-sitter and ranks the files nearest the
        seeds — the same ranking a task's envelope carries, seeded from its write
        scope. Names are matched between files, never resolved: read it to declare
        a scope, not as an answer about what calls what
  wecode ready                         what is schedulable right now
  wecode show <id>                     one project or task in full
  wecode check <id>                    the admission verdict
  wecode status <project|task> <status>   set a status by hand
  wecode archive <project> | unarchive <project>
        hide a project from the cockpit, or bring it back (--force if work is live)

COCKPIT
  wecode tui [<id>]                    one application, three screens that call
                                       each other (`wecode up` is the same command)
        HOME     needs-you · moving · next · landed, over the whole portfolio
        PROJECT  one project's task tree      TASK  one task in full
        enter opens what the cursor is on, esc goes back, q quits
        j/k move · space fold · z/Z fold all · a archived · r reload · ? keys
        <id> is the screen it opens on, not a mode: esc still reaches HOME
  wecode board [<id>] [--all]          the same state printed once — for pipes,
                                       logs, and anywhere there is no terminal

WORK
  wecode assign <task> --to <post>     check the post may do it, then make it ready
  wecode start <task> [--json]         worktree + envelope; marks it running
                                       --json emits the A2A task instead of prose
  wecode tick                          promote waiting tasks whose work is unblocked
  wecode loop [--once]                 tick, then dispatch what is ready, forever
        also closes a run whose supervisor has stopped reporting for 5 minutes,
        confirmed a minute later: the task goes to failed for a person to retry;
        nothing is killed, no worktree is removed, nothing is re-dispatched
  wecode run <task>                    spawn its agent, supervise it, then verify
  wecode cost <task> "<what was done>"  attribute work wecode never dispatched
        --tokens <n>  --wall <secs>  --replayed <n>    at least one of the first two
        for a task worked in your own session, or a step done by hand in a console:
        filed as an attempt of its own, in your name, stated rather than measured.
        Every view marks it as stated; no metered row is touched
  wecode verify <task>                 judge it: diff against scope, then acceptance
  wecode merge <task>                  land it on the integration branch, and report
        the worktree comes down once nothing still works in it; the branch stays
        the report is committed to docs/wecode/<task>/report.md, on the target
        a repo with `installs` set also gets its executable built from the merge
        commit and moved to that path — reported, and unable to fail the merge
  wecode rollback <task>               revert that merge; the report says when to
  wecode install [--repo <name>]       build the integration branch and install what
        it produces, at the `installs` path in company.toml. The same step a merge
        runs: for the first install, and for retrying one a merge declined
  wecode worktree                      list them, grouped by repository
  wecode worktree remove <task|path>   take one down (--force if dirty)
        a path reaches the trees no task can: an orphan's, and the merge scratch
  wecode approve <merge|admission|design|budget|measure> [<what>] --as <post>
        approve design --task <id>      signs a design off: needs-approval → done
        approve admission --task <id>   signs a task for dispatch, where its playbook
                                        says dispatch = "approved"
  wecode telegram [--dry-run]          sign what the replies in Telegram approved
        needs [telegram] fetch and a telegram id on the user who replies; `loop`
        reads the channel every pass on its own
        a reply names a task by id or by `#4` — the `#` is required in a chat, where
        a bare number is as likely to be prose
  wecode guard <post> <verb> <target>  authorise an action; records the decision
        verbs: read write run merge spend        --tokens <n> for spend
        --task <id> / --project <id> attributes the record
  wecode audit [--denied] [--alarms] [--path <glob>] [--project <p>] [--task <t>]
```

## The ones worth explaining

**Short numbers** are the same commands, typed with four keystrokes instead of twenty.
Every project and task carries one, printed in the left column of `tree`, `ready`,
`board` and `tui` and beside the id on `show`; anywhere a command takes a project or a
task, the number does as well. `wecode merge 4`. `wecode assign 7 --to impl`. `wecode
audit --task 4`.

It exists because the *reader* and the *typist* are not the same person at the same
keyboard. Ids are slugs so they can be read — in a prompt, in the ledger, on the board —
and `cache-warm-on-deploy` is a fine thing to read and an unpleasant thing to spell back
on a phone at 02:14, which is exactly when the notification arrives.

Three rules, and the first two are the only ones worth memorising:

- **A number is a name, not a position.** It is minted once, when the project or task is
  created, and never reused — not even by a task with the same id created after the
  original was removed with `wecode task rm`. A row number would renumber on every
  `task add`, and the number in a message six hours old has to still mean what it meant
  when it was sent.
- **One sequence covers both levels**, so a number names exactly one thing and
  `wecode show 4` never asks which kind of 4 you meant. Projects tend to hold the low
  numbers, because they are created first.
- **A name always wins.** `4` is looked up as an id first, so a workspace with a task
  genuinely called `4` keeps it; `#4` is a number and nothing else. In a **Telegram
  reply the `#` is required** — `approve 2` in a chat is as likely to mean *two of them
  look fine*, and a signature given on that reading is a signature nobody gave.

What is stored is always the id. The number resolves before anything is written, so the
ledger, the branch names and `docs/wecode/<task>/report.md` are keyed on ids exactly as
before — `wecode audit --task 4` finds records filed under `cache-warm-on-deploy`. A
workspace that predates this acquires numbers for everything already in it the first time
this build opens its `wecode.db`.

`[notify] command` is handed `WECODE_TASK_NUMBER`, the digits with no `#`, so the message
that reaches a phone can carry the thing the operator has to type back. See
[config/notify.md](config/notify.md).

**`wecode check <id>`** and **`wecode task add`** answer twice. The first verdict is the
admission gate — defects, each carrying a fixed question, and a task is not saved until
they are answered or `--force`d. The second is advisory, and appears only for a task
whose project has a playbook with a section for its kind:

```
  ⚠ 2 notes — the playbook for [bug] would have written this differently

  ·  `bash scripts/max-lines.sh` is how this project accepts work of this kind, and
     this task does not run it. Naming any acceptance replaces all of it.
  ·  this kind is written for 2700 seconds of wall time and this task declares none.
     Naming either figure takes the whole default off.

  advisory — nothing is refused for these
```

A note is never a refusal, whatever it says and however many there are: the task above
is saved, and `check` calls it `✓ admitted`. It exists because a playbook fills only
what a declaration leaves blank, and fills acceptance and budget *whole* — so a single
`--accept-cmd` takes the project's own checks off, and a lone `--tokens` takes the
kind's wall limit with it, neither of which said anything until now. See
[playbooks](../guides/playbooks.md) for what is reported and where it stays silent.

**`wecode task add --requirement`** states what a story owes, or names the obligation a
task is an attempt at. The task's own kind decides which, so a wording that happens to
look like a handle is still a wording:

| on | `--requirement` means | what happens |
|---|---|---|
| `--kind story` | the wording of one obligation | a handle is minted: `<story>/FR-1`, or `NFR-1` with `--nfr` |
| any other kind | a handle a story already stated | the task is recorded as an attempt at it |

A handle nothing stated is refused before the task is written, because a saved task
pointing at nothing is a row somebody has to find and unpick. A story already in the
plan takes more with `wecode task add <story> --amend --requirement "<…>"`.

A requirement is stored in two halves, and the split is state against event (ADR-0005):

| half | where | what it says |
|---|---|---|
| the contract | a `require` row in the ledger | this story owes this, stated by this person, then |
| the claim | a `serve` row in the ledger | this task took a run at that handle, then |
| what a task serves | `tasks.requirement_id` | what this task answers to **now** |

Not two copies of one fact. The column holds one handle and moves when the task is
re-aimed; the rows never change, which is what makes the history of an obligation
readable — rework, a bug against it and a changed design are all supposed to show.
`wecode audit --task <id>` prints them with everything else decided about that task.

Which tasks answer to a requirement is read off the **column**, so a task pointed at
another obligation stops holding the first one open. Their state is then **derived,
never stored**: a requirement is `met` while something has answered it and nothing open
still claims it, so creating a task against a closed requirement reopens it by
arithmetic rather than by remembering to. `wecode check <id>` prints what a story owes
with each one's state, and what a task serves.

Two limits worth knowing. `--requirement` and `--nfr` are not in `wecode help` above,
because the usage text lives in `main.rs` and this change was scoped out of it — the
fenced block is verbatim `wecode help` and a test enforces that. And `dropped`, the
third state ADR-0005 names, is not reachable: nothing can drop a requirement yet.

**`wecode task budget <id>`** changes what a task may spend without recreating it. The
way out before it was `wecode task rm` followed by `task add` again, and that stops
working at the moment it is wanted: a task that has run is history and refuses to be
removed, and a budget is rarely known to be wrong until a run has proved it short. The
extra room then had to come from a new id, and what was recorded against the old one —
the spend, the refusals, the design signed off on it — stayed behind under a task nobody
was looking at.

`--tokens` and `--wall` are amended one at a time, unlike `task scope`, which replaces
read and write together. An unstated wall is not a wall of zero: it is the agent
template's, which is usually far longer, so a `--tokens` raise that quietly dropped the
wall would hand the task hours nobody granted it. Whichever figure is not named is left
as it was, and both are printed back before and after.

A budget is what **one run** may spend, not what the task has cost so far — each attempt
starts the count again. Raising one does not reach a run already in flight, because the
limits of a run are read once, when the process starts; the command says so when the
task is running, and points at `wecode status <id> waiting` when it has failed, since
nothing moves a failed task on its own.

Amending a budget records a `define`, exactly as `task scope` does, so a task in a
project that dispatches by approval has to be signed for again: a signature given to a
task budgeted at 100k did not cover the same task at 400k. What it spent already stays
in the ledger either way — `wecode audit --task <id>`.

**`wecode task add --by <agent|person>`** says whose hands are on the work. `agent` is the
default and everything wecode dispatches; `person` is a step no agent is launched for — a
console click, a token only the owner can mint. `manual` and `human` are accepted for it,
because the work is named by what it is *not* dispatched to. It is a separate axis from
`--kind`, deliberately: provisioning a bucket by hand is still a chore, and folding the
two together would lose which chore it was.

It records, and everything downstream honours it. `tasks.doer` is the column, so a plan read
back after a restart still knows the work is somebody's to do by hand: admission stops
demanding the write scope, budget and acceptance a dispatch needs and a person's work has
none of; the tick stops such a task on the operator instead of dispatching it; `show`, the
tree and the board all say so. The usage block above still calls the flag refused, which it
was for two commits — that text is `wecode help` verbatim, and the last stale copy of the
sentence is the usage constant in `crates/wecode-cli/src/main.rs`.

**`wecode task add --steps <file>`** is the other half of declaring a person's task: what
they are actually being asked to do. An agent is described its task at dispatch — the
objective, the playbook, the scope, the repository — and a person's task has no dispatch, so
the notification *is* the briefing and the words have to exist before it. The file is read
at declaration and stored with the task, as text: the message goes out days later, from a
loop on a machine where the path may have moved or been merged away, so a path would be a
promise this cannot keep. It reaches the person in `WECODE_STEPS`, and as an attached
document in `WECODE_STEPS_FILE` — see [the notify hook](config/notify.md).

The file is named rather than found. The obvious alternative is a convention —
`docs/wecode/<task>/steps.md`, picked up when it happens to be there — and it is wrong
twice: that path is inside the *repository* while this command runs in the workspace, so
resolving it means knowing which repo the project names and where it is checked out, and the
same declaration would read a different document on another machine. And it would arrive
silently, which for instructions is the worst possible default: the task looks briefed and
the briefing is a file somebody forgot they wrote. The convention still works, typed —
`--steps docs/wecode/mint-token/steps.md`.

A path that cannot be read, and a document with nothing in it, are both refused before
anything is saved: a task claiming a briefing it has not got is the failure the flag exists
to end. `--steps` on an agent's task is refused too, since nothing would ever read it. And a
person's task declared with no steps draws an advisory naming `--amend --steps` — nothing is
refused, because a task whose whole instruction is its own title is a real task, but a bare
one reaches a phone as a title and a number, which is somebody woken up and asked to guess.

`wecode task add <id> --amend --steps <file>` re-declares them, beside or instead of a move,
and prints what it replaced. `wecode show` does not print them yet.

**`wecode task add <id> --amend`** reshapes the plan without taking anything out of it.
It changes where a task *sits* — `--parent <task>` puts it inside a sprint, `--top` lifts
it back out, `--after <task>` (repeatable) says what it must come after, and `--no-after`
clears the ordering. Nothing else about the task moves: scope and budget have their own
commands, and acceptance deliberately has none.

It shares `task add` because `--parent` and `--after` are already declared there, and one
place that knows how to read them beats two that could read them differently. Typing
`task add` with an id that is already taken now says so and points here, which is where
the amendment is usually discovered: retyping the declaration is the wall an operator
hits. (`wecode help` does not list `--amend` yet — the usage text is a constant in
`main.rs`, and adding the two lines to the `task add` stanza is all it needs.)

Before it, neither relation could be changed once a task existed. The way out was
`wecode task rm` and `task add` again, which is refused the moment a task has run — and a
grouping is rarely known to be wrong until something in it has run. So the work that
belonged in a sprint got a new id, and the spend, the refusals and the design signed off
on it stayed behind under a task nobody was looking at. An ordering was worse: `--after`
was readable only at creation, so a dependency discovered late meant retyping both tasks,
and the refusals that told an operator to *re-point* a stranded chain named no command
that could do it. They name this one now.

Each relation is amended on its own, and an ordering is replaced whole. Silence leaves a
relation exactly as it was rather than clearing it — the same rule `task budget` follows
— which is why emptying one has a flag of its own to say it out loud.

Two things refuse a move, and they are worth knowing before it is wanted:

- **A run keeps the worktree it started in.** One worktree per main task, with subtasks
  sharing their parent's, so `parent` is what decides which checkout the work happens in
  and which branch it lands on. Nothing holds a run to the path it was started in —
  `verify` asks which tree the task owns all over again when the run is done — so a move
  that re-roots a task in flight would have it judged somewhere the work never happened.
  The question asked is *whose worktree would change*, not who is running: moving a
  sprint is refused while an item inside it runs, and moving a task from one place in a
  chain to another is not refused at all, because the root above it is the same either
  way. The ordering may always change: it is read on the next scan, not by the run
  standing there.
- **The ordering is part of what keeps two scopes apart.** Sibling tasks may claim the
  same files precisely because one comes after the other, so dropping that ordering puts
  the collision back. It is the check `task scope` re-runs, run again here, and it names
  the overlap and refuses unless `--force` says otherwise.

A move that changes which task owns the worktree says so, and says that what earlier
attempts committed stays on the branch they landed on — a task carries its history, not
its checkout. Moving one records a `define`, exactly as `task scope` and `task budget` do,
so a task in a project that dispatches by approval has to be signed for again: a signature
given to a task that was going to ship on its own did not cover the same task shipping
inside a sprint, on a different branch.

**`wecode tui`** is one application whose screens call each other, in the way `k9s` and
`lazygit` are: state lives in the app, and moving between screens is navigation rather
than a fresh invocation.

    HOME     the four attention groups — needs-you, moving, next, landed — over the
             whole portfolio, with the is-part-of tree under them
      ↓ enter
    PROJECT  that project's task tree, to the leaves
      ↓ enter
    TASK     one task in full: where it sits, what it waits on, what it is doing, what
             each attempt cost against its budget, the report it landed, its incidents

`enter` opens what the cursor is on and `esc` (or backspace) goes back to the row it was
opened from; `q` quits. `j`/`k`, `space`, `z`/`Z`, `a` and `r` mean the same thing
wherever they are pressed — on TASK, which is a page rather than a table, `j` and `k`
scroll it. **No screen is reachable only by restarting with a different command**, which
is what makes this one cockpit rather than three. Nor is any screen a flag: `wecode tui
4` opens *on* that project or task, with HOME still underneath it, so `esc` behaves there
exactly as it does anywhere else.

`wecode up` is the same command under its old name. Renaming what the hands already know
is a tax with no revenue, so both spellings stay.

### The instrument

Three keys turn the cockpit from something an operator watches into something they work.
None of them is a mode: each is a key pressed on the screen already in front of them, and
`esc` puts every one of them back.

| key | what it does |
| --- | --- |
| `/` | narrow this screen to the rows that answer what you type |
| `:` | ask the same question of the whole workspace, and open what it finds |
| `t` | put the ledger as it is written under the table, or take it away |

**`/` filters what is on the glass.** Every keystroke re-narrows, so the list is always
the answer to what has been typed so far; `enter` opens the row the cursor is on and `esc`
puts the screen back as it found it. A row answers if the query appears anywhere in its
label, its declared status, its needs-you cell — or **the title it was written down with**,
which is what somebody actually remembers a task by and the one thing the four columns
have no room for. Matching is case-insensitive and not a pattern: `appr` is a question,
not a glob. The four attention groups stand down while a query holds, because they are
the same leaves read a second way and a narrowed HOME would answer with one task twice.
A query nothing answers says so, rather than printing the line about how to start a
workspace to somebody who has simply mistyped.

**`:` is the palette**: the same narrowing asked from HOME, which is where every project
and every task in the workspace has a row. That is why it needs no second list and no
second kind of search — it pushes a HOME screen and opens the query line over it, so *go
to anything from anywhere* is one line of typing, `enter` lands on it, and `esc` walks
back out through the screen it pushed to wherever the operator was standing.

**`t` puts a live tail of the ledger under the table** for whatever the cursor is on: a
project's own records and its tasks', a task's alone, the whole workspace when the cursor
is on neither. Every act an agent takes passes the Broker on its way to the ledger, so
these lines are as near as wecode gets to reading over its shoulder — what it opened,
what it ran, what it was refused. Newest last, the way a log reads, each with how long
ago it happened; a refusal is amber and an alarm red. The cockpit's reload tick is what
makes it a tail rather than a snapshot of one.

Nothing is under the table until `t` asks for it, and the same key takes it away again.
A pane that previewed the screen `enter` opens stood here and was dropped: it said a
second time, in fewer words, what one keystroke says in full, and it cost rows the tree
wanted. The tail is the reading that is *not* in the plan — what an agent is doing now —
which is why it is the one that stayed.

`?` inside the cockpit lists every key, these three included; the one-line summary in
`wecode help` above names only the keys that move and fold.

**`wecode board`** is not a second cockpit. It prints the same state once and exits, for
pipes, logs, and anywhere there is no terminal — a different consumer, not a different
view. `wecode tui` refuses to start without a tty and says so, naming `board` as what to
run instead.

**`wecode status <project|task> hold`** pauses dispatch without removing anything from
its board. Holding a task leaves its project and sibling tasks moving; holding a project
skips every task in that project. Restore the appropriate active queue state explicitly,
for example with `wecode status <task> waiting` or `wecode status <project> active`.
A hold is not an archive: held rows remain visible, and their `hold` status explains why
the loop skipped them.

**`wecode archive task <id>`** files a task away *with its subtasks*, and
`wecode unarchive task <id>` brings the group back. A bare id — `wecode archive caching` —
is a project, as it always was.

The cascade is the point. A feature expanded into four subtasks is one piece of work and
five rows; filing the parent alone would clear the heading and none of the clutter, and
five ids typed by hand is why nobody would file anything. It follows *is part of* and
nothing else: a subtask can be put away on its own, leaving the feature it belongs to on
the board, and a task that merely comes **after** this one is not part of it and is left
where it is.

The two levels do not archive alike, which is why the level is named rather than guessed
from the id:

- **A project is parked.** `ready`, the scheduler and the overlap check all skip it, so
  nothing in it is promoted or dispatched.
- **A task is only hidden.** Nothing in the domain reads the flag: an archived task is
  still promoted, still dispatched, still merged, and still competition for the files it
  writes.

So filing a task **refuses work that could still move on its own** — anything that is not
`done`, `dropped` or `draft` — and names the rows it would have hidden. `--force`
overrides, and the reason it needs one is that a hidden `ready` row gets dispatched with
nothing on screen to say so. A draft needs no force: nothing dispatches a draft, so a
mis-scoped one can be put away without first being dropped.

Filing is a display decision, not a judgement about the work, so it is reversible and
says nothing about status: `wecode archive task 4` twice reports *already archived* rather
than failing. What it changes is every view that lists work — `board`, `tui` and `tree` —
where a filed-away group is one hidden row rather than four. `board --all`, `tree --all`
and the cockpit's `a` bring them back, greyed on the snapshot board and marked `archived`
in the cockpit and in `tree`. Naming a filed-away task directly (`wecode board 4`) shows
its group in full, there being no `--all` at that level.

`--all` is one flag for both levels on purpose. A `tree` that hid an archived *project*
but printed an archived *task* unchanged made the filing read as having failed, and left
the row uncounted as well as unmarked — the footer names projects and filed-away task
groups as one number.

`wecode show` and `check` are the exception: they are reached by naming their subject and
have no `--all`, so hiding there would put a row out of reach. They report every task
whatever its filing, and mark the filed ones.

**`wecode brief`** is how an agent learns what it is. Run it once at the start of a
session; everything in it is derived from the seat's grant, so it cannot promise
authority the Broker will refuse. The bootstrap — the one thing that cannot be
discovered — is a line in your `~/.claude/CLAUDE.md`: *if I say "use wecode", run
`wecode brief` first.*

**`wecode playbook <kind>`** is what an orchestrator reads before decomposing a request
into tasks. See [../guides/playbooks.md](../guides/playbooks.md).

**`wecode playbook init`** writes that file. The language decides what goes in it — the
acceptance commands for every kind that changes code, the `[project.build_cache]` the
worktrees share, and the globs a build dirties in the subtask example — and it is read
off the repository's own manifest (`Cargo.toml`, `go.mod`, `pyproject.toml`,
`package.json`) unless `--language` says otherwise. wecode writes starters for rust, go,
python and node; any other language gets the prompts-and-TODO file, which is what every
language used to get.

What it decided is printed rather than left in the file, because those are the lines you
are expected to disagree with. If the commands it wrote name a program this machine does
not have, it says so and still writes the file: the playbook is right for the repository
and wrong only here, and every command that reads it will refuse it until that line is
changed. See [../guides/playbooks.md](../guides/playbooks.md).

**`wecode playbook gap "<...>"`** is the way back in. An orchestrator that plans against
the guidance and finds out afterwards that it was short records the finding, and it is
shown to whoever reads that kind's guidance next. `--task <id>` is usually the whole
invocation — the task names its own project and kind. It is a note, not a change:
nothing acts on one, and it goes away when a person folds it into the playbook and
deletes it. `wecode playbook gaps` lists what is waiting.

**`wecode task add --expand`** emits the subtasks that kind's playbook declares, with
`{{task}}` substituted, instead of typing each one out. It runs once, at planning time,
and produces ordinary tasks: they face the same admission gate, and can be edited,
dropped or added to before anything is dispatched. Nothing consults the template again.

It is all or nothing — if one subtask would be refused, none are created, because a
half-built expansion leaves the rest waiting on tasks that do not exist. The main task
is unaffected either way; it was admitted on its own merits. A kind whose playbook
declares no `subtasks` refuses the flag rather than silently doing nothing.

**`wecode guard <post> <verb> <target>`** asks the Broker a question and does nothing.
Use it to check whether a seat can reach the work before assigning it there.

**`wecode start` vs `wecode run`.** Both prepare a task identically — same worktree, same
branch, same envelope. `start` hands you the envelope and steps back; `run` spawns the
agent and supervises it. They share one code path so a task worked by hand and a task
worked by an agent cannot land somewhere different.

The envelope carries a **repo map** under that heading: the directories git tracks, the
files inside the ones the task may write to marked `✍`, and the line each of those files
uses to describe itself. It is there so an agent does not open with `find` and `wc -l`
against a budget the task is held to. A template that wants it somewhere particular names
`{{repo_map}}`; see [config/envelope.md](config/envelope.md).

That shared path is also where the dispatch gate lives, so it holds for both. A project
whose playbook says `dispatch = "approved"` refuses either until `wecode approve admission
--task <id>` is on the ledger, and refuses before the worktree is cut — a tree made for
work nobody signed for is a tree left standing. `wecode loop` reports the same tasks as
`⏸ <id> needs your signature` and dispatches past them rather than failing them, so an
unsigned task at the head of the queue does not hold a slot.

A signature earlier than the last change to the task does not count: `task scope` records
a definition, so widening signed work asks for the signature again. The refusal says which
of the two it is, and `wecode audit --task <id>` shows the sequence.

`start` also reports the project's shared build cache — `cache CARGO_TARGET_DIR=...`,
beside the worktree — because a hand-run task that built somewhere else would be the one
build not sharing it. See [config/playbook.md](config/playbook.md#the-build-cache).

**`wecode cost <task> "<what was done>"`** is what `start` was missing. A task handed out
by `start` and finished in somebody's own session spends the same real money as one `run`
supervised, and left no row anywhere — so the task read as free, and the project's total
was short by every hour a person put into it. The same hole swallows a step no agent could
have done at all: a console click, a key minted by hand.

It writes **one more attempt**, never an amendment to an existing one. A stated figure
added to a metered row would leave a number half measured and half claimed with nothing
left to say which half; a row of its own reaches the task's total, which is what was
wanted, and leaves every other row exactly as honest as it was. Two people attesting the
same work therefore file two costs, and that is the correct arithmetic — nothing here can
tell it was the same work.

| | |
|---|---|
| `--tokens <n>` | what it cost, in the unit the budget is written in |
| `--wall <secs>` | how long it took, as stated |
| `--replayed <n>` | cache reads, if the figure is even known |

At least one of `--tokens` and `--wall` is required, and so is the account of the work: a
metered row gets its detail from an exit code, and this one has no such source. What is
*not* a flag is who is attesting. That is the session's — a name a switch could carry is
not an attribution, and the point of the record is that somebody is answerable.

Stated is not measured, and every view says which. `wecode show` heads the block `runs (3,
1 stated rather than metered)` and prefixes the row `stated by <name>`; the cockpit's task
screen does the same from the same function. In the database it is
`task_executions.attested_by`, where NULL is a claim rather than a gap — *wecode watched
this process* — so no run recorded before the column existed is retitled by it.

The record makes no claim about the result. No status moves and no acceptance runs: what
the work cost and whether it was any good are different questions, and the task's own
status is where the second one lives. Recording a cost needs `staff`, the authority that
says who acts on a task — not `spend`, which is checked against a cap and would refuse a
large honest figure after the money was already gone.

**`wecode verify`** can be run on its own, and is the same code path `run` uses. It reads
the *uncommitted* diff, so run it before committing by hand. The acceptance commands get
the same shared build cache the agent had; verification is usually the larger build of
the two.

**`wecode worktree`** lists checkouts grouped by the **repository** they were cut from,
because that is what a worktree belongs to — several projects sharing one repo share one
set of trees, and each tree is listed under it once. Archived projects are included: a
checkout you cannot see is one you cannot clean up.

The first column says who is in the tree, and only the first kind is safe to assume
anything about:

| column | means | what to do |
| --- | --- | --- |
| a task id | a task in the plan works here | usually nothing — `merge` takes it down |
| `— orphan (<task>)` | wecode made it; that task is no longer in the plan | `wecode worktree remove <path>` |
| `— merge scratch` | the checkout a merge borrows | nothing, unless wecode died mid-merge; then the same |
| `— not ours` | another tool's worktree in the same repository | nothing. It is not wecode's to touch |

**`wecode merge`** commits its own report. The text the terminal prints also lands at
`docs/wecode/<task>/report.md` on the integration branch, beside that task's `design.md`,
as a separate commit on top of the merge. Verbatim, because the file is evidence and a
re-rendered version could disagree with what you were shown. The `record` line at the
bottom of `provenance` says where it went — or, if the commit failed, that it did not go
anywhere; the merge stands either way, since by then there is nothing to undo. `rollback`
does not delete it.

**`wecode worktree remove`** takes either a task id or a path. A path is how the two middle
rows are reached: neither has a task to look up in the plan, which is precisely what makes
them an orphan and a scratch. The two are told apart by shape — a task id is a kebab-case
slug, so anything with a `/` in it is a path.

Removing by path will not touch a directory no repository in the plan lists as a worktree,
so `— not ours` stays out of reach through this command whichever way you name it.

Most trees never need the command at all. A worktree comes down on its own when
`wecode merge` lands the work, provided nothing sharing it is still open and nothing in it
is uncommitted; the report's `worktree` line says which of those happened. The branch is
kept in every case — its commits are already on the integration branch, and `wecode start`
cuts the tree again from it if the work reopens.

`— not ours` exists because the alternative was worse: before the `worktrees` registry,
anything wecode could not place was called an orphan, which reads as *we made this and
lost track of it* — an invitation to delete somebody else's work. A tree wecode created
before the registry existed reads as a task row anyway, since its path is still the one
wecode computes for that task.

**`--all`** widens a narrowed default: `tree --all` and `board --all` include archived
projects and archived tasks alike. Put it last — the argument parser takes the next token
as a flag's value, so `board --all migration` loses the positional.

**`wecode doctor`** exercises what a task will depend on, before a task depends on it.
Two halves, in the order they are needed: whether this **machine** can do the work at
all, and whether the way back to the **operator** carries a wait and an answer. Both are
hand-written `company.toml` — a path, a command name, a token — true on the machine they
were typed on and believed everywhere else until something leans on them.

The two cost differently when they are wrong, which is why one command covers both.
A broken **hook** is silent: a hook that never fired and a queue with nothing in it are
the same silence from where the operator is standing. A broken **machine** is loud in the
wrong place — the dispatch fails *after* admission, after scheduling, with a worktree cut
and a run recorded, so it reads back as a task that could not be done when it is really a
`claude` that was never installed. Under `wecode loop` that repeats once per promotion,
filing one honest-looking record per attempt for a cause none of them names.

The exit status is the verdict: non-zero when what is configured does not work, so
`wecode doctor && wecode loop` starts a day's unattended work only on a machine that can
do it and a channel that can say so. What is *not* set is reported and passes — an
operator who watches a terminal is configured for a terminal, not misconfigured. Hence
three marks and not two: `✓` ran, `·` nothing is set, `✗` it is set and does not work.

The machine, in the order a dispatch needs it:

| | |
|---|---|
| `git` | run, not resolved: a `git` that is present and cannot run — a broken symlink, a lost executable bit — is as fatal as one that is absent and looks nothing like it in a `which` |
| `worktree root` | created and written to, then the probe removed; reported on the good day too, because *where do worktrees land* is the commonest question about a directory that sits outside both repo and workspace |
| `[[repos]] <name>` | there, and a repository by git's own reckoning. The likeliest wrong line in a new workspace: `wecode init` ships `path = "~/projects/your-repo"`, which parses, validates and has never existed |
| `[agents.<name>] command` | resolved the way `spawn` resolves it, and **not started** — a coding agent launched to see whether it launches is a session and a bill. Checked against the charter first: a line `never_run` forbids is refused however well installed the harness is |
| `[agents.<name>] env_allowlist` | every name read back off the environment wecode runs in. The list is not a filter, it *is* the environment — a worker is `env_clear`ed and handed exactly what it names, so a name unset here arrives as nothing and the agent fails on its first authenticated call, having spent the budget getting there |

A harness no post is staffed with launches nothing, and is reported as an absence rather
than failed — a workspace keeping a spare configured for the day it switches is not
broken. The way back, named as `company.toml` names it:

| | |
|---|---|
| `[notify] command` | fired, and read under the rule the loop reads it by: a hook that delivered has no reason to speak, so anything it printed is reported as a failure |
| `[telegram] fetch` | run **and parsed**, because a revoked token exits `0` with `{"ok":false}` in the body — indistinguishable from a quiet channel to everything but the parser |
| `[telegram] answer` | checked against the charter and not run: `answerCallbackQuery` needs a live callback id, and a made-up one is refused whatever the token is |
| `who may answer` | whether any `[[users]]` gives a `telegram` id, and what that person's post may sign — a channel that resolves every reply to nobody is read every pass and answered from never |

Three things the hooks half will not do. It **signs nothing and consumes nothing**: no ledger record,
no status write, and the fetch is asked from offset `0` — everything Telegram still holds,
confirming none of it — because `getUpdates` treats an offset as an acknowledgement, and a
drill that swallowed the reply it was checking for would be the failure it exists to find.
The drill's message carries **no short number**, since that is the handle a reply is typed
against and a live one in a real chat message is one `approve` away from signing work
nobody looked at. And it **cannot say the message arrived**: wecode holds no chat and sees
no phone, so *exited 0 and said nothing* is the strongest thing knowable from this side.
The last line of the report is the half only the operator can answer.

The machine half is as restrained. It **touches nothing anybody owns** — repositories are
asked questions and never written to, and the one file it writes is a probe in wecode's
own run directory, carrying the process id so two drills cannot delete each other's, and
removed either way. It **installs nothing**: every fault has a one-line repair in a file
the operator already edits, and the note says which line, because a doctor that fixed
things is not one you could leave in front of `wecode loop`. And the whole command
**never opens the store** — it reads `company.toml` and nothing else, which bounds what it
can break and equally what it can check: the toolchain a *particular* task declares as its
acceptance lives in the plan, so what is checked here is what every task needs.
