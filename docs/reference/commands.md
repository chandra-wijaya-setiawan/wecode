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
        --kind <feature|bug|refactor|chore|spike|docs>   default: feature
        --parent <task>          is part of that task
        --after <task>           must come after it (repeatable)
        --accept-cmd "<cmd>"     executable acceptance (repeatable)
        --accept-metric <name>:<cmp>:<target>
        --write <glob>  --read <glob>   scope (repeatable)
        --tokens <n>  --wall <secs>     --to <post>
        --force                  save despite defects, recorded as waivers
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
  wecode rollback <task>               revert that merge; the report says when to
  wecode worktree [remove <task>]      list them, or remove one (--force if dirty)
  wecode approve <merge|admission|budget|measure> [<what>] --as <post>
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

**`wecode guard <post> <verb> <target>`** asks the Broker a question and does nothing.
Use it to check whether a seat can reach the work before assigning it there.

**`wecode start` vs `wecode run`.** Both prepare a task identically — same worktree, same
branch, same envelope. `start` hands you the envelope and steps back; `run` spawns the
agent and supervises it. They share one code path so a task worked by hand and a task
worked by an agent cannot land somewhere different.

**`wecode verify`** can be run on its own, and is the same code path `run` uses. It reads
the *uncommitted* diff, so run it before committing by hand.

**`--all`** widens a narrowed default: `tree --all` and `board --all` include archived
projects. Put it last — the argument parser takes the next token as a flag's value, so
`board --all migration` loses the positional.
