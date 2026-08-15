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
        --kind <feature|bug|refactor|chore|spike|design|docs>   default: feature
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
  wecode ready                         what is schedulable right now
  wecode show <id>                     one project or task in full
  wecode check <id>                    the admission verdict
  wecode status <project|task> <status>   set a status by hand
  wecode archive <project> | unarchive <project>
        hide a project from the cockpit, or bring it back (--force if work is live)

COCKPIT
  wecode up                            live dashboard: j/k move, space fold, q quit
        every level draws the whole task tree; z folds it all, Z opens it
  wecode board [<id>] [--all]          the same view as a one-shot snapshot

WORK
  wecode assign <task> --to <post>     check the post may do it, then make it ready
  wecode start <task> [--json]         worktree + envelope; marks it running
                                       --json emits the A2A task instead of prose
  wecode tick                          promote waiting tasks whose work is unblocked
  wecode loop [--once]                 tick, then dispatch what is ready, forever
  wecode run <task>                    spawn its agent, supervise it, then verify
  wecode verify <task>                 judge it: diff against scope, then acceptance
  wecode merge <task>                  land it on the integration branch, and report
        the worktree comes down once nothing still works in it; the branch stays
        the report is committed to docs/wecode/<task>/report.md, on the target
  wecode rollback <task>               revert that merge; the report says when to
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
`board` and `up` and beside the id on `show`; anywhere a command takes a project or a
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
[config](config.md).

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
than failing. What it changes is every view that lists work — `board`, `up` and `tree` —
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
build not sharing it. See [config](config.md#the-build-cache).

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
