# Playbooks

A playbook tells whoever decomposes a request how work is broken down **in this
project**. It lives in the project's own repository, committed, because it describes
that code — change the test command and the guidance changes in the same commit.

```bash
wecode playbook init                    # writes .wecode/playbook.toml
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
| `dispatch` | whether a task needs a signature before it may be started at all |
| `build_cache` | directories every worktree of this project shares |
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

## The starter knows the toolchain

`init` reads the repository's own manifest — `Cargo.toml`, `go.mod`, `pyproject.toml`,
`package.json` — and writes a starter for that language. `--language` overrides it, and
is worth passing where a repo carries two manifests; the first match in that order wins,
so a Rust workspace with a docs site in it is scaffolded as Rust.

Three of the typed fields above then arrive filled in, and each of them used to be a
blank the project paid for on its first task:

- **`accept`.** `["cargo test --workspace", "cargo clippy --all-targets -- -D warnings"]`
  on every kind that changes code, rather than `accept = []` and a task accepted by
  nothing until somebody typed a command in from memory.
- **`build_cache`.** Declared, not commented out: the cold build it prevents is paid by
  the first task, long before anyone has read that far down the file. Delete the block
  to give every worktree its own; the path is keyed on the repository's directory name,
  so change it if two repos here share one.
- **The write scope in the `subtasks` example**, including what a build dirties —
  `Cargo.lock`, `uv.lock`, `go.sum`, `package-lock.json`. That file is also named in the
  `guidance` of every kind that changes code, because a planner reads one kind and not
  the file. A task that adds a dependency without declaring the lock file is reported as
  reaching outside its scope, after its budget is spent.

The commands are the toolchain's usual ones and not this project's, which is why `init`
prints them instead of leaving them in the file to be trusted. It also reads back what
it wrote and says if this machine cannot run it — the load-time check above, applied
while the fix is one edit rather than a spent budget. The file is still written: it is
right for the repository and wrong only here.

A language nothing answers to — wecode writes for rust, go, python and node — gets the
prompts-and-TODO starter, which is what every language got before this existed, and a
line at the top saying which ones would have got more.

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
- **A step that passes is `done`, and the main task is what lands.** Every step works in
  the main task's tree, on its branch, so none of them has a landing decision of its
  own — `wecode merge <step>` is refused and names the task that does. That is what lets
  the next step start: readiness follows `done`, and a step parked at `needs-approval`
  would hold up the rest of its own expansion. The exception is a `design` step, which
  waits for its signature at any depth, for the reason below.

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

## The dispatch gate

The design gate asks whether a *feature* was thought about. This asks the narrower
question about each task: did a person agree to this one, as written, before its budget
was spent? One line, on the project rather than on a kind:

```toml
[project]
dispatch = "approved"
```

`start` and `run` then refuse until a holder signs — `wecode approve admission --task
<id>` — and `wecode loop` reports the task as `⏸ <id> needs your signature` and carries
on with whatever else is ready. Nothing is prepared first: no worktree is cut for work
nobody has agreed to.

It is off by default, and worth turning on exactly where the plan is written by an
agent. The admission gate is deterministic — it can tell you a task is vague, unscoped
or unbudgeted, and it cannot tell you the task is the wrong thing to build. That
judgement is a person's, and this is where it fits.

The signature is one line in the ledger, attributed to the post that gave it and to the
person in that seat. It covers one task, not the subtasks beneath it, and it goes stale
if the task is redefined afterwards: amending a scope asks for it again, so signing
something small and then widening it is not a way through.

## Sharing the build cache

A worktree is a clean checkout, which is what makes it safe — and it means `target/`
starts empty. Every task then pays for a cold build twice: once inside the agent, and
once in verification, which runs the suite to judge it. On a Rust workspace that is
minutes per attempt, paid again by every retry, and it comes out of the wall budget the
task was given for doing the work.

None of that output is task-specific, so point the toolchain somewhere all the
worktrees can reach — which `playbook init` already did if it knew the language:

```toml
[project.build_cache]
CARGO_TARGET_DIR = "~/.cache/wecode/app/target"
```

Key is the environment variable, value is a directory — absolute, or under `~/`. wecode
sets it on the agent and on the acceptance commands, creates it if it is missing, and
knows nothing else about it, so `GOCACHE`, `YARN_CACHE_FOLDER` or `SCCACHE_DIR` work the
same way. It goes here rather than in `env_allowlist`, which is about what an agent may
inherit from the operator's shell; this is not inherited from anywhere.

Two things to know before turning it on:

- **A relative path is refused**, and that refusal is the useful part. `target/shared`
  resolves against whichever worktree is running, so each task would quietly get its own
  copy while the setting said otherwise.
- **Sharing serialises.** Cargo locks its target directory, so two tasks building at the
  same moment queue instead of building twice. Seconds of waiting against minutes of
  rebuilding is a good trade in nearly every project, and one that would rather have
  parallel cold builds simply declares nothing.

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

## Recording what it did not say

Every line in the "traps" list above was learned by a task failing. Until there was
somewhere to put that, the finding lived in whoever noticed it — an orchestrator plans
against the guidance, discovers afterwards that it was short, and by the next session
the fact is gone. wecode's own playbook says three tasks in a row were caught by one
missing sentence.

```bash
wecode playbook gap "declare docs/** — the reference is generated and moves anyway" \
  --task confirm-tasks
```

`--task` is usually the whole invocation: the task names its own project and its own
kind, so the note lands against the guidance that was short. `--kind` states it
directly; neither means the finding is about the project's planning as a whole, and it
is then shown against every kind.

It comes back out where the next planner already looks — at the end of `wecode playbook
<kind>`, after the guidance, counted on `wecode playbook`, and listed by `wecode
playbook gaps`.

**A gap is a note, not a change.** Nothing acts on one: like `guidance`, wecode only
carries it. That is exactly what makes it safe for an agent to record — a wrong note
can mislead a reader, which the prose beside it could already do, and it cannot widen a
scope, raise a budget or switch off a gate. The playbook stays hand-edited, in no
role's write scope, for the reason it always was.

It goes away when a person folds it into the playbook and deletes the entry. Nothing
else deletes one, which is the point: it sits in front of the next planner until
somebody has done something about it.

Two details worth knowing:

- **It is recorded in the workspace**, in `gaps.toml` beside `company.toml`, not in the
  repository the playbook lives in. Verification judges a task from the repository's
  own diff, and a kind whose playbook asks for no worktree is judged in the main
  checkout — a file appearing there while such a task ran would be reported as *that
  task's* scope violation. Recording a finding must not fail somebody else's work.
- **The gate is `define project`**, not a write scope. The chief writes no code and is
  the seat that finds these; the engineer writes the code and must not be able to
  annotate the guidance it was handed. A file-write check would have had it backwards
  on both counts.

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
