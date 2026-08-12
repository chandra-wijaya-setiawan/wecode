# Playbooks

A playbook tells whoever decomposes a request how work is broken down **in this
project**. It lives in the project's own repository, committed, because it describes
that code — change the test command and the guidance changes in the same commit.

```bash
wecode playbook init --language rust    # writes .wecode/playbook.toml
wecode playbook bug                     # what an orchestrator reads before planning
```

## It is guidance, not a workflow

Nothing executes a playbook. It is read *before* tasks are created, and is then out of
the picture.

That is why the prose can be free-form: whatever the orchestrator produces still has to
clear the admission gate — vague titles, missing acceptance, scope overlaps, dependency
cycles. The gate is the backstop, so the guidance needs no enforcement of its own.

Only a few fields are typed, because wecode itself acts on them:

| field | what wecode does with it |
|---|---|
| `worktree` | creates one, or does not |
| `assign_to` | fills the assignee when you omit `--to` |
| `accept` | fills acceptance when you omit `--accept-cmd` |
| `tokens`, `wall_secs` | fill the budget |
| `merge_to`, `merge` | where work lands, and whether it needs a signature |

Everything in `guidance` is carried to the reader and never parsed.

## Writing a good one

Say things that are **true of this project and not of projects in general**. Generic
advice is noise; the reader is already competent.

Worth stating:

- **The seams.** Where does work naturally split here? In a Rust workspace it is crate
  boundaries, and they are ordered — a task needing a type in `core` and its use in
  `cli` is two subtasks in that order.
- **What a kind means here.** A refactor means behaviour unchanged, so the acceptance is
  the existing suite passing untouched; needing to edit a test proves it was not a
  refactor.
- **Where the traps are.** Facts about this repo that will otherwise be rediscovered the
  hard way. wecode's own playbook says to put the test file in the write scope, because
  three tasks in a row failed their scope check without it.
- **What a task must never do.** "Do not span both languages", "schema changes are always
  their own task", "anything on the search path states a number".

Not worth stating: how to write good code, that acceptance should be executable (the
gate enforces it), or anything the reader would do anyway.

## Kinds

One section per task kind — `feature`, `bug`, `refactor`, `chore`, `spike`, `docs`. A
kind with no section gets no defaults and no worktree, which is a reasonable way to say
"we do not do those here".

`spike` is the one kind admitted without a write scope, because it answers a question
rather than changing code. That makes it the right shape for *find out why* before a fix
is planned.

## Two projects, two playbooks

The point is that they differ. wecode's own says crate order and that tests live beside
the code; `wemail`'s says not to span Python and TypeScript in one task and that schema
changes are always separate. Same tool, different rules, because they are different
codebases.

## The worker area

`.wecode/run/` is where a running task may write its own scratch — the envelope tells
every agent to put its result there. It is exempt from all three scope checks: coverage
at assignment, overlap at admission, and the diff at verification.

Gitignore it. Do **not** gitignore `playbook.toml` alongside it — ignoring `.wecode/`
wholesale keeps the playbook out of history silently, which is exactly what you do not
want for a file that shapes how work is planned.
