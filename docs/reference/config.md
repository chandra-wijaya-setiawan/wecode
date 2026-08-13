# Configuration

Two hand-edited files. Everything else is in `wecode.db`, which no one edits by hand.

| file | scope | describes |
|---|---|---|
| `company.toml` | the workspace | who exists, what they may do, what outranks them |
| `.wecode/playbook.toml` | one repository | how work is broken down *here* |

The split is deliberate. The company is one thing; a project is a codebase with its own
conventions, and its guidance is versioned with the code it describes.

## company.toml

Lives in the workspace, alongside `wecode.db`. Unknown keys are an **error**, not a
warning — a typo like `writ = [...]` would otherwise leave a role with no write scope
and no complaint.

```toml
[company]
name = "cws"
profile = "solo"                  # solo | team | enterprise
description = "..."

[attention]                       # concurrency derives from this, not from cores
max_open_items = 5
max_interrupts_per_hour = 3
digest_interval_mins = 20

[invariants]                      # outrank every grant below
never_touch = [".github/**", "infra/**", "**/*.pem", "**/.env"]
never_run = ["git push --force*", "rm -rf /*"]
approval_to_merge = ["main", "master", "release/**"]
max_tokens = 1000000

[[repos]]                         # declared by path; they live elsewhere
name = "app"
path = "~/projects/app"

[roles.engineer]                  # a role is enforced capabilities, or it is nothing
read = ["**"]
write = ["src/**", "crates/**"]
run = ["cargo *", "npm test*"]
tokens = 200000
wall_secs = 1800

[roles.chief]
read = ["**"]
define = ["project", "task"]      # may create work
staff = true                      # may assign it
merge_to = ["**"]                 # may land it — the charter says where a signature is needed
approve = ["admission", "merge"]
# no write, no run: loading a company whose chief has either is an error

[[posts]]                         # a seat, and the harness in it
name = "impl"
role = "engineer"
agent = "claude-code"

[[users]]                         # a person against a seat
name = "Chandra"
post = "chief"

[session]
ttl = "8h"                        # idle timeout, not age

[agents.claude-code]              # how to actually launch it
command = "claude"
protocol = "claude-stream-json"   # how to read its output; see below
args = ["-p", "{{prompt}}", "--output-format", "stream-json", "--verbose"]
env_allowlist = ["ANTHROPIC_API_KEY", "PATH", "HOME", "LANG"]
wall_secs = 1800
idle_secs = 300

[templates]
task_envelope = """..."""         # the prompt shape; see below
```

The **env allowlist is the whole environment** a spawned agent gets — nothing is
inherited. Absent a container, that is the only network control there is.

`{{prompt}}` in `args` is where the rendered envelope goes.

`protocol` names the shape of the agent's output, and is what lets wecode read a token
count out of it. One value is understood today:

| | |
|---|---|
| `claude-stream-json` | one JSON object per line; usage on the `assistant` and `result` lines |
| anything else | **unmetered** — the run's spend column stays blank |

It must match what `args` actually asks for: declaring `claude-stream-json` without
`--output-format stream-json` produces prose, and prose reports nothing. Unmetered is
not an error — the run still happens, is still timed, and still lands its wall spend on
the ledger. It only means the token half of the spend column has nothing to show, which
is the truth and not a zero.

## .wecode/playbook.toml

In the repository, committed. `.wecode/run/` is the worker-writable area and should be
gitignored; the playbook should not be.

```toml
[project]
language = "rust"
merge_to = "dev"                  # the integration branch: branch from it, merge to it
merge = "approved"                # approved | auto — the charter still outranks this

[feature]
worktree  = true
assign_to = "impl"
accept    = ["cargo test --workspace"]
tokens    = 120000
wall_secs = 5400
guidance  = """
Prose, read by whoever decomposes a request into tasks. Say how work is split here,
what the seams are, and what a task of this kind must not do.
"""
subtasks  = ["design", "build"]   # what `task add --expand` emits, in this order

[feature.design]                  # one block per name in `subtasks`
kind   = "design"                 # defaults to the kind being expanded
title  = "decide how {{task}} should work"
write  = ["docs/wecode/{{task}}/design.md"]
accept = ["test -f docs/wecode/{{task}}/design.md"]

[feature.build]
after  = ["design"]               # an earlier sibling's name, not a task id
write  = ["src/**"]
```

One section per task kind. A kind with no section gets no defaults and no worktree. Only
the typed fields are acted on; `guidance` is carried, never parsed.

See [../guides/playbooks.md](../guides/playbooks.md) for what to write in it.

### Subtasks

`subtasks` is the decomposition `wecode task add <id> ... --expand` emits, and its order
is the order tasks are created in. Every name needs a block; a block the list does not
name is refused, as is an `after` that names anything but an earlier sibling — all three
are typos, and a typo found at planning time costs nothing.

A block states only what makes that step different. `kind`, `title`, `after`, `write`,
`read`, `accept`, `assign_to`, `tokens` and `wall_secs` are the fields; anything left
out falls through to the playbook for the step's **own** kind, exactly as a hand-written
task of that kind would. So a `design` step wants a `[design]` section to draw its
budget from — without one the step has none, and the gate refuses the expansion and says
so.

`{{task}}` is the main task's id and `{{title}}` its title. They are the only two: a
template that could reach further into the plan would be a small language, and this is a
scaffold that runs once.

Emitted tasks are children of the main task and depend on the siblings their `after`
names. Those are separate relations — being part of a task does not mean waiting for it.

Like `company.toml`, a playbook is **hand-edited and deliberately in no role's write
scope**. A task that tried to change one would be refused at assignment, which is the
right answer: letting a worker rewrite the guidance it was given is the same problem as
letting it define its own acceptance.

## The envelope

`templates.task_envelope` is the prompt a worker receives. Placeholders:

`{{task_id}}` `{{project_id}}` `{{objective}}` `{{title}}` `{{acceptance}}`
`{{write_scope}}` `{{context}}`

`{{context}}` carries the handoff — what predecessors produced. If the template omits
it, the handoff is **appended** rather than dropped: losing it silently would be worse
than putting it somewhere unexpected.

Previous attempts are appended after the template, always.

Both are rendered from A2A artifacts, so `wecode start <task> --json` shows exactly what
a worker is being given — including the structured part it never sees in the prose.

## Where things live

```
~/.wecode/
  current                        the default org, set by `wecode use`
  workspaces/<org>/
    company.toml
    wecode.db
  run/<org>/<task>/              worktrees — outside the repo and the workspace
```

Worktrees sit outside both on purpose, so a glob rooted at a worktree cannot sweep up
the file that defines the worker's own grants. Note this is hygiene rather than a
boundary: `run/` and `workspaces/` are siblings, so traversal still reaches it, and what
actually refuses the write is the Broker.

`$WECODE_CONFIG` relocates all of it, which is how the test suite stays isolated.
