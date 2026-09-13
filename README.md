# wecode

Deterministic project management for a developer and their coding agents. Work is written
down as tests before it is built, agents get one task each inside a scope they cannot leave,
and nothing is finished because an agent said so — a task is done when its tests pass, and a
story is delivered when every test that proves it passes.

**We code while you are sleeping.**

## Quick start

```bash
pnpm install && pnpm -r build

cd /path/to/your/project
wecode init                      # the database, config/roles.yaml, config/budget.yaml

wecode workspace create acme
wecode project create --parent 1 storefront
wecode release create --parent 1 1.0
wecode epic create --parent 1 "account recovery"
wecode story create --parent 1 "password reset"
wecode requirement create --parent 1 "a reset link authenticates exactly one change"
wecode acceptance_criteria create --parent 1 "a link is emailed within 60s"
wecode acceptance_test create --parent 1 "the mail arrives" --artefact "bash test/mail.sh"
wecode task create --parent 1 "send the reset mail" --role engineer
wecode task scope 1 --write "src/mail/**" --tools bash,read,edit,write
wecode task_test create --parent 1 "the mailer is called" --artefact "vitest run mail"
wecode worker create claude-1 --role engineer --kind agent

for e in project release epic story requirement acceptance_criteria; do wecode $e start 1; done
wecode acceptance_test deliver 1
wecode task_test deliver 1
wecode task start 1

wecode-runner --once              # or install contrib/wecode-runner.service
wecode board
```

## What happens on a tick

| | |
|---|---|
| **allocate** | pick a ready task within the attention budget, bind a worker, cut a worktree at its task branch |
| **run** | start a coding agent session in that tree with only the flags its scope allows |
| **prove** | run the task's tests **in that tree**, before it is released |
| **land** | commit the attempt to its task branch, release the tree, merge into the story branch |
| **prove again** | run the acceptance tests in the story tree, and let the cascade run |

A passing acceptance test accepts its criteria, which meets its requirement, which delivers
its story and its epic. Nobody invokes those — they fire when their guard becomes true.
Shipping a release is the one completion that stays a decision.

## Packages

| | |
|---|---|
| `@wecode/core` | entities, state machines as YAML, guards, the cascade, SQLite, the board |
| `@wecode/cli` | every verb as a command |
| `@wecode/tui` | the board, declared in `views.yaml` |
| `@wecode/runner` | allocator, foreman, synchroniser, worker adapters, git trees |

## Design

[`docs/design`](docs/design), in order — architecture, scenarios, entities, the ERD, state
diagrams, verbs, attributes, roles, worktrees, the attention budget, harness notes.

The Rust implementation this replaces is at `../archived/wecode-rust`, tagged `rust-final`.
