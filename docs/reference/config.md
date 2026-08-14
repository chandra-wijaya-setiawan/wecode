# Configuration

Two hand-edited files. Everything else is in `wecode.db`, which no one edits by hand.

| file | scope | describes |
|---|---|---|
| `company.toml` | the workspace | who exists, what they may do, what outranks them |
| `.wecode/playbook.toml` | one repository | how work is broken down *here* |

The split is deliberate. The company is one thing; a project is a codebase with its own
conventions, and its guidance is versioned with the code it describes.

A third file, `gaps.toml`, sits in the workspace and belongs to neither category
cleanly: it is written by machine and emptied by hand. It is guidance's inbox — see
[below](#gapstoml).

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
dispatch = "approved"             # auto | approved — sign each task before it runs

[project.build_cache]             # directories every worktree of this project shares
CARGO_TARGET_DIR = "~/.cache/wecode/app/target"

[feature]
worktree  = true
design_required = true            # refuse a feature with no design task behind it
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

An `accept` line whose program is not on this machine — an `sh` builtin, or a file on
`PATH` — refuses the playbook wherever it is loaded. Verification would report the same
program as "command not found" only after the work is done.

See [../guides/playbooks.md](../guides/playbooks.md) for what to write in it.

### The dispatch gate

`dispatch` decides who may start work, and it is the last door before any budget is
spent. `auto`, the default, leaves the admission gate as the only check — what wecode has
always done. `approved` means nothing is prepared for a task, by hand or by the loop,
until `wecode approve admission --task <id>` is on the ledger.

It defaults to `auto` where `merge` defaults to `approved`, and the difference is
reversibility. A dispatched run happens in its own worktree under a budget and is judged
before it can reach a shared branch; a merge is the step that cannot be un-decided
quietly. A strict default here would also stop `wecode loop` — which exists to run
unattended — on every task in every project that had never heard of the setting.

Turn it on where the *plan* is written by an agent rather than by a person. That is the
case it is for: the admission gate checks that a task is well-formed, and no
deterministic check can say whether it is the work you wanted done.

A signature covers one task, not its subtasks — each is dispatched on its own budget, so
each is signed on its own. And a signature older than the last `define` record for that
task is stale: amending a scope after signing asks for the signature again, so the gate
cannot be walked past by signing something small and then changing it.

### The build cache

A worktree is a clean checkout, so its `target/` starts empty and every task pays for a
cold build twice — once inside the agent, once in verification. None of that output is
task-specific, so `[project.build_cache]` names directories that live outside every
worktree and are shared by all of them.

Each key is the environment variable a toolchain reads; each value is a directory.
wecode sets them and knows nothing else about them, which is what keeps this from being
a list of ecosystems: `CARGO_TARGET_DIR`, `GOCACHE`, `YARN_CACHE_FOLDER`, `SCCACHE_DIR`.
The directories are created before anything is pointed at them, and one that cannot be
created is an error — a toolchain handed an uncreatable path quietly builds into the
worktree instead, which is the failure this is meant to remove.

They are set on the **agent and on the acceptance commands alike**. Verification is
usually the larger build of the two, and sharing only the agent's would leave the
expensive half cold while looking like the setting was on. Nothing needs to be added to
`env_allowlist`: that allowlist governs what an agent may *inherit* from the operator's
shell, and these values are not inherited — they are what this file says. Where a
variable is both allowlisted and declared here, the declaration wins; an inherited
`CARGO_TARGET_DIR` would point at the operator's own checkout.

| refused | why |
|---|---|
| a relative path | resolves inside whichever worktree is running, so each task gets its own copy under a name promising the opposite — and the build still succeeds |
| a key that is not an environment variable name | could never be set |
| `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*` | say which program runs, not where output goes — choosing the toolchain belongs to `company.toml` |

A `~` is resolved when the cache is used, not when the playbook is parsed, so one file
describes the same cache on two machines with different homes.

**Sharing serialises.** Cargo takes an exclusive lock on its target directory, so two
tasks building at the same moment queue rather than building twice. That is the trade —
seconds of waiting against minutes of rebuilding — and a project that would rather have
parallel cold builds declares nothing. Nothing removes a cache: `wecode worktree remove`
leaves it alone, and cleaning it is the toolchain's own business.

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

`design_required` refuses a task of that kind at admission unless a `design` task
stands before it — a predecessor up its dependency chain, or a subtask inside it, which
is what `--expand` creates when the template declares a `design` step. See the
[playbooks guide](../guides/playbooks.md#the-design-gate) for why the dependency is the
entire check.

Emitted tasks are children of the main task and depend on the siblings their `after`
names. Those are separate relations — being part of a task does not mean waiting for it.

Like `company.toml`, a playbook is **hand-edited and deliberately in no role's write
scope**. A task that tried to change one would be refused at assignment, which is the
right answer: letting a worker rewrite the guidance it was given is the same problem as
letting it define its own acceptance.

## gaps.toml

In the workspace, beside `company.toml`. Appended by `wecode playbook gap`, read back
by `wecode playbook`, and emptied by hand.

```toml
[[gap]]
at      = 1755100000          # seconds since the epoch, stamped when it was recorded
project = "caching"
kind    = "bug"               # optional — absent means every kind sees it
task    = "cache-layer"       # optional — where it was found, for attribution
by      = "chief"             # the post that recorded it
note    = "declare the test file: the scope check refuses the diff afterwards"
```

A gap is a **note, not a change**. Nothing in wecode branches on one; like `guidance`,
it is only carried. That is what makes it safe for an agent to append to — a wrong note
misleads a reader, which the prose beside it could already do, and it cannot widen a
scope, raise a budget or switch off a gate. The playbook itself stays hand-edited and
out of every write scope.

The gate is `define project`, not a write scope: the seat that plans work is the one
that finds these, and it is usually a seat that writes no code at all. The seat that
writes the code is exactly the one that must not be able to annotate the guidance it
was handed.

It lives here rather than beside the playbook it is about because **the repository is
what verification diffs**. A kind whose playbook asks for no worktree is judged in the
main checkout, so a file appearing there mid-run would be reported as that task's scope
violation — recording a finding would fail somebody else's work. The workspace is never
diffed.

Entries are appended, never rewritten, so comments and hand corrections survive. An
entry goes away when a person folds it into the playbook and deletes it; nothing else
deletes one.

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
