---
name: wecode
description: Deterministic project management for a developer and their coding agents — shape work as stories, requirements, criteria and tests, then let wecode dispatch agents under enforced scopes and judge the result from the tests. Use when the user wants work planned and delegated to agents, wants to see what is running or needs them, or invokes /wecode.
user-invocable: true
---

**If a wecode runner started you, stop reading here.** You were spawned with `claude -p`
inside a worktree, given one task, one scope and one test to pass. Your job is to write
the code and make that test pass, by hand, in the files your scope names. Everything
below is for the human's orchestrator session, and none of it applies to you — in
particular "never write the feature code yourself" and "do not fix a failing test by
hand" are instructions to the orchestrator, and following them as a worker means
returning an empty attempt.

The rest of this file is the orchestrator's.

A local CLI. **The binary is the manual — run it, do not rely on this file:**

```bash
wecode --help              # the model, the verbs, the rules
wecode <entity> --help     # that entity's states and verbs, read off its state machine
```

This file exists only to tell you the binary is there and how to hold it.

## If the project is not set up yet

```bash
wecode onboard [name]
```

It detects the stack, records the test command in `config/project.yaml`, writes
`config/roles.yaml` with scopes that are real paths, registers the project, and installs
this file as the wecode skill so the next session reads it. Every test and scope then
defaults to what it learned.

## Your job

You are the orchestrator. Nobody else moves work into the runner's reach, so that is
yours: turn what the operator wants into records, walk each one to the state the runner
allocates from, and keep the queue fed. A record you create and leave sitting is work
that will never start, and nothing will tell you.

**Prefer `wecode plan <file.yaml>`.** It writes the whole story in one document and
leaves every row in the state that runs. Build by hand only for a single follow-up task,
and then walk it the whole way:

```bash
wecode task create --parent <acceptance_test> --role engineer "<what to do>"
wecode task scope <task> --write "a.ts,b.ts"       # files this task alone may change
wecode task_test create --parent <task> --artefact "<the command that proves it>"
wecode task_test deliver <task_test>               # planned → ready. Without this the task cannot start
wecode task start <task>                           # planned → ready. Now the runner can allocate it
```

The two `deliver`/`start` steps are the ones that get forgotten. A task sits in `planned`
with a `task_test` in `planned`, the board shows nothing running, and it looks like the
runner is broken. It is not: a task needs a **ready** `task_test` before it may start.

## How to hold it

| | |
|---|---|
| **you shape the work; wecode runs it** | never write the feature code yourself. Create the work and let the runner dispatch an agent |
| **tests come before tasks** | a task exists to make one `acceptance_test` pass, and needs its own `task_test` ready before it can start |
| **one task, one scope** | two tasks whose write scopes overlap will not run together. Give each task its own files |
| **a failing test is the answer** | do not fix it by hand. Make another task |
| **nothing is done because an agent said so** | a task is done when its tests pass; a story is delivered when every test proving it passes |

## Running it

```bash
wecode board                 # what is running, waiting, queued, failed
wecode-runner --once         # one tick: allocate, run an agent, prove, land
wecode-tui                   # the live board
wecode land <story>          # merge a delivered story into your branch
```

`wecode answer <assignment> "<text>"` clears anything waiting on a person.

## Where this text lives

`packages/cli/config/orchestrator-skill.md`, in the repository wecode is installed from.
It is configuration the operator owns: edit it there and `wecode onboard` installs the
new text over the copy in the skills directory. Editing the installed copy loses it at
the next onboard.
