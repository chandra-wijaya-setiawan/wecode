# Concepts

The whole model, at the level you need to use it.

## The company

One **workspace** per company: a directory holding two files.

```
~/.wecode/workspaces/cws/
  company.toml     hand-edited — roles, posts, users, repos, agents
  wecode.db        machine-written — projects, tasks, sessions, runs, the ledger
```

A workspace is deliberately **not** a code repository. The repos it works on are
declared inside it by path and live elsewhere, so a worker's working directory is never
the place its own authority is defined.

## Work: two levels, and two relations

A **project** owns exactly one repository and carries an objective. A **task** is the
executable unit. There is no third level: what used to be *vision* and *goal* are
attributes — a company has a vision, a project has an objective — because neither was
ever executable and both cost a level of tree.

Tasks carry **two independent relations**, and conflating them is the classic error
here:

| relation | means | shape |
|---|---|---|
| `parent` | *is part of* — a subtask | a tree |
| `depends_on` | *must come after* — a predecessor | a DAG |

A subtask is **not** blocked by its parent. A predecessor is **not** a parent. Each gets
its own cycle check, and each does one job: `parent` decides which worktree you work in,
`depends_on` decides when you may start and what your handoff contains.

A task has a **kind** — `feature`, `bug`, `refactor`, `chore`, `spike`, `design`,
`docs` — which selects guidance and defaults. A spike is the one kind admitted without
a write scope, because it answers a question rather than changing code. A design is
the one kind not finished when it passes: it goes to `needs-approval` and waits for a
signature, because whether a design is right is the part no command can check.

## Who does the work

Three things people conflate, kept apart:

| | is | example |
|---|---|---|
| **post** | a seat in the org chart | `impl`, `test`, `review`, `chief` |
| **role** | the capabilities a seat carries | `engineer` writes `crates/**`, runs `cargo *` |
| **agent** | the harness that occupies the seat | `claude-code`, `codex` |

A **user** is a person named against a post. Authority lives on the *role*, so naming a
user adds accountability rather than power. A post with no user is an agent-only seat.

The **chief** post is special in one way: it may not write files or run commands, and
loading a company whose chief can is a validation error. An agent that can both set the
criteria and satisfy them is not governed.

## Authority

A **grant** says what a role may do: read and write globs, runnable commands, merge
targets, budgets, approvals, whether it may define work or staff it.

Grants are **evaluators, not sets**. Where several bear on one action the effective
grant is their *intersection* — every one must permit it. An empty intersection permits
nothing, which is the safe default.

Above every grant sits the **charter**: invariants that outrank all of them. Never touch
these paths, never run these commands, this branch needs a signature, this is the token
ceiling. A grant that would permit an invariant violation is itself the bug, so a
violation raises an alarm rather than a denial.

## The two questions a task answers

Every task must say **how we will know it is done** (acceptance) and **what it may
change** (scope). Both are checked before the work is admitted, not after.

Acceptance must be **executable** — a command and its expected exit code. A judged
measure is legal on a project's objective and illegal on a task, so nothing can be
marked done because someone was satisfied.

## Status is declared; health is computed

A task's **status** is a stored fact someone chose. Its **health** — green, amber, red —
is derived from the ledger, the budget and the admission checks, and is never reported
by an agent. Both appear on the board, because a task can be entirely healthy and simply
not started: status is a column, and health is the colour of the needs-you cell, whose
entries are the reasons a row is amber or red.

Archiving is a third, separate property: it parks a project, hiding it *and* stopping
its work being scheduled. See [lifecycle.md](lifecycle.md).

## The ledger

Every decision and every observation lands in one append-only table, marked with where
it came from:

| source | means | admissible |
|---|---|---|
| `broker` | we decided it | yes |
| `supervisor` | we observed it — an exit code, a diff | yes |
| `harness` | the agent said so | **no** |

That marking is the load-bearing part. A harness's account of its own work is useful for
debugging and inadmissible as evidence, and recording which is which at write time stops
the two being confused later.

A **denial** and a **failure** are different things, and the ledger keeps them apart. A
denial means authority refused an action — a write outside scope, a command no grant
permits. An acceptance check that exits wrong is not that: the supervisor ran it itself,
so it lands as an *allowed* `run` whose target carries the exit code, and the verdict
goes on the task, which turns `failed`. `wecode audit --denied` is therefore purely the
governance channel — a real denial is never buried under red tests.
