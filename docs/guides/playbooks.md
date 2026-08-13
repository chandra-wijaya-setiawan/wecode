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
| `design_required` | refuses the kind at admission unless a design task stands before it |
| `assign_to` | fills the assignee when you omit `--to` |
| `accept` | fills acceptance when you omit `--accept-cmd` |
| `tokens`, `wall_secs` | fill the budget |
| `merge_to`, `merge` | where work lands, and whether it needs a signature |
| `subtasks` | what `task add --expand` emits |

Everything in `guidance` is carried to the reader and never parsed.

One typed field is also checked against the machine: an `accept` line whose program is
neither an `sh` builtin nor on `PATH` refuses the whole playbook at load, everywhere it
is read — `playbook`, `task add`, `start`, `merge`. Left in, the mistake surfaces as
exit 127 at verification, once per task and only after each budget is spent; caught at
load it costs one edit to one file. This is why the check is at load and not at parse:
the same file is legal on a machine that has the toolchain. The check reads only a
line's first word, past any `VAR=value` prefixes, and stays silent wherever reading
the word would take a shell — quoting, substitution, a path into the worktree — so it
refuses only what could never run, and guesses at nothing.

## Writing the decomposition down

A kind may declare its breakdown, so it is created rather than retyped:

```toml
[feature]
subtasks = ["design", "build", "docs"]

[feature.design]
kind   = "design"
write  = ["docs/wecode/{{task}}/design.md"]
accept = ["test -f docs/wecode/{{task}}/design.md"]

[feature.build]
after  = ["design"]
write  = ["src/**"]

[feature.docs]
after  = ["build"]
kind   = "docs"
write  = ["README.md", "docs/**"]
```

`wecode task add <id> --project <p> "<title>" --expand` then emits three chained tasks
with `{{task}}` substituted. Without `--expand`, behaviour is exactly as before.

**This is not a workflow engine.** The template runs once, at planning time, and its
output is ordinary tasks — they face the same admission gate as hand-written ones, and
can be edited, dropped or added to before anything is dispatched. Nothing at run time
consults it. A scaffold that produces tasks is not a pipeline that runs them.

Two rules worth knowing before you write one:

- **A block states only what differs.** `accept`, `assign_to` and the budget fall
  through to the playbook for the step's *own* kind. A `design` step therefore wants a
  `[design]` section; without one it has no budget and the gate refuses the expansion.
- **It is all or nothing.** One refused subtask means none are created — a half-built
  expansion leaves the rest waiting on tasks that do not exist. The main task is
  unaffected; it was admitted on its own merits.

Ceremony on small work is the real risk. Three tasks for a two-line change is absurd,
which is why `--expand` is opt-in and per kind: `bug` should get no design step here —
it gets a reproduction, which its guidance already demands and which is a better gate.

## The design gate

Without it, a feature can go from an idea to a merged branch with no human ever seeing
a design. Turning it on is one line on the kind:

```toml
[feature]
design_required = true
```

A feature is then refused at admission unless a `design` task stands before it — a
predecessor anywhere up its dependency chain, or a subtask inside it, which is the
shape `--expand` creates. That relation is the entire check. A design goes to
`needs-approval` when it passes and reaches `done` only through `wecode approve design`,
and nothing dispatches while a predecessor is unfinished — so the ordering machinery,
not a status inspection, is what keeps the build step from running until a person has
signed. `--force` admits an undesigned task and records the waiver, as with every other
defect.

Three claims, and the gate checks two: a design exists (a task at a known place), a
human approved it (a record in the ledger). Whether the design is *good* is checkable
by nobody but a reader, which is exactly why the design waits for a signature instead
of finishing when its file exists.

Pair it with `subtasks` so satisfying the gate costs one flag rather than two hand-typed
tasks. A gated kind whose template declares a `design` step passes at `task add
--expand` time on the strength of the step about to be created; every later check finds
the design in the plan. A feature created before the gate was turned on can be repaired
the same way — a dependency cannot be added to an existing task, but a subtask can:
`wecode task add <id>-design --parent <id> --kind design ...`.

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
