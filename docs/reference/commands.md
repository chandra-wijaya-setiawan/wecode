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

  wecode playbook [<kind>]             this project's guidance for that kind
        --project <p>   init            `init` writes a starter into the repo
  wecode brief                         who you are and how to work — read this first
  wecode tree [--all]                  projects and their task trees
  wecode ready                         what is schedulable right now
  wecode show <id>                     one project or task in full
  wecode check <id>                    the admission verdict
  wecode status <project|task> <status>   set a status by hand
  wecode archive <project> | unarchive <project>
        hide a project from the cockpit, or bring it back (--force if work is live)

COCKPIT
  wecode up                            live dashboard: j/k move, enter descend, q quit
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
        approve design --task <id>   signs a design off: needs-approval → done
  wecode guard <post> <verb> <target>  authorise an action; records the decision
        verbs: read write run merge spend        --tokens <n> for spend
        --task <id> / --project <id> attributes the record
  wecode audit [--denied] [--alarms] [--path <glob>] [--project <p>] [--task <t>]
```

## The ones worth explaining

**`wecode brief`** is how an agent learns what it is. Run it once at the start of a
session; everything in it is derived from the seat's grant, so it cannot promise
authority the Broker will refuse. The bootstrap — the one thing that cannot be
discovered — is a line in your `~/.claude/CLAUDE.md`: *if I say "use wecode", run
`wecode brief` first.*

**`wecode playbook <kind>`** is what an orchestrator reads before decomposing a request
into tasks. See [../guides/playbooks.md](../guides/playbooks.md).

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

**`wecode verify`** can be run on its own, and is the same code path `run` uses. It reads
the *uncommitted* diff, so run it before committing by hand.

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
projects. Put it last — the argument parser takes the next token as a flag's value, so
`board --all migration` loses the positional.
