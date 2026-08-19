# .wecode/playbook.toml

How work is broken down in one repository. In the repository, committed. `.wecode/run/`
is the worker-writable area and should be gitignored; the playbook should not be.

`wecode playbook init` writes the first one. Where the language is known — read off
`Cargo.toml`, `go.mod`, `pyproject.toml` or `package.json`, or given with `--language` —
the file arrives with that toolchain's acceptance commands, its shared build cache, and
the lock file a build rewrites named in the write scope; everything below is then an
edit rather than a blank.

```toml
[project]
language = "rust"
merge_to = "dev"                  # the integration branch: branch from it, merge to it
merge = "approved"                # approved | auto — the charter still outranks this
dispatch = "approved"             # auto | approved — sign each task before it runs

[project.build_cache]             # directories every worktree of this project shares
CARGO_TARGET_DIR = "~/.cache/wecode/app/target"

[project.refuses]                 # paths no task here may declare it writes, and why
"vendor/**" = "vendored code is updated by its own tool, never by hand"
"crates/*/src/generated/**" = "regenerate it: `cargo run -p codegen`"

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

See [../../guides/playbooks.md](../../guides/playbooks.md) for what to write in it.

## The dispatch gate

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

## What the project refuses

`[project.refuses]` is the one thing in the file a project says about work nobody has
declared yet: paths that are in this repository and are not any task's to change. Each key
is a glob and each value is the reason, which is not decoration — the refusal is answered
by narrowing a write scope, and whoever does that is usually reading a terminal a long way
from this file. It is read back into the verdict verbatim:

```text
  ⚠ 1 defect — not admitted

  1  Write scope "vendor/serde/**" reaches "vendor/**", which this project refuses:
     "vendored code is updated by its own tool, never by hand". Which paths instead?
```

It is a **declaration** gate, and that is the whole of its shape. What it inspects is the
`--write` scope a task states, not the diff a run produces — so it is asked at `task add`,
at `task scope` and `task add --amend`, at `assign`, and by `check <id>`, which are the
places a scope is written, re-written, or read back. Past those, the write scope *is* the
guardrail: a task admitted here cannot reach a refused path, because the paths it may touch
at all were checked against these lines first.

| | |
|---|---|
| matching | prefix containment, both ways — the same coarse rule two tasks overlap under. `src/**` is refused by `src/generated/**`, because a task claiming the parent may write in the child |
| the reason | optional. Omit it and the refusal is stated without one, which is a worse message and still a refusal |
| `.wecode/run/**` | never refused. Every task is told to write its result there, in a worktree of its own; a refusal of `.wecode/**` reaches the guidance beside it and stops there |
| read scope | not covered. Writing is the enforced guardrail, and a repository that refuses to be *read* is a `[[repos]]` question |
| `--force` | waives it, recorded, exactly as it waives every other defect. A project's line is not the charter's |
| a finished task | never faulted. This arrives in a playbook commit, and work that already ran cannot be re-declared against it |

A line added to a playbook today is read by the next command that asks, and nothing goes
looking for tasks that were declared before it. One already assigned and waiting keeps the
scope it was admitted with until something re-declares it; `check <id>` is what says so, and
`task scope` is what fixes it. That is the same way the design gate and every advisory note
here behave, and it is deliberate — guidance arrives in a commit, and retroactively
faulting a board full of work that was well-formed when it was written is how a gate gets
switched off.

Nothing validates the globs, on purpose: a glob matching nothing costs a line nobody trips
over, and `"**"` — which refuses every task in the project — is discovered by the next
`task add`, quoting the exact line that said no. That is a better teacher than a parse
error, and the only reader that knows what this project's tasks actually claim.

**Not the same instrument as [`never_touch`](company.md).** That is the company's, checked
per write against every project at once, and a violation raises an alarm because a grant
that permitted it is itself the bug. This is one repository's, checked against a
declaration, and answered by editing the declaration. A project may be stricter than the
charter and never laxer — the same rule `merge` and `dispatch` keep — so refusing a path
the charter already forbids changes nothing except when somebody reads the verdict.

## The build cache

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
| `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*` | say which program runs, not where output goes — choosing the toolchain belongs to [`company.toml`](company.md) |

A `~` is resolved when the cache is used, not when the playbook is parsed, so one file
describes the same cache on two machines with different homes.

**Sharing serialises.** Cargo takes an exclusive lock on its target directory, so two
tasks building at the same moment queue rather than building twice. That is the trade —
seconds of waiting against minutes of rebuilding — and a project that would rather have
parallel cold builds declares nothing. Nothing removes a cache: `wecode worktree remove`
leaves it alone, and cleaning it is the toolchain's own business.

## Subtasks

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
[playbooks guide](../../guides/playbooks.md#the-design-gate) for why the dependency is
the entire check.

Emitted tasks are children of the main task and depend on the siblings their `after`
names. Those are separate relations — being part of a task does not mean waiting for it.

Like [`company.toml`](company.md), a playbook is **hand-edited and deliberately in no
role's write scope**. A task that tried to change one would be refused at assignment,
which is the right answer: letting a worker rewrite the guidance it was given is the same
problem as letting it define its own acceptance.

## gaps.toml

In the workspace, beside `company.toml`. Appended by `wecode playbook gap`, read back
by `wecode playbook`, and emptied by hand. It is on this page rather than the company's
because what it annotates is the playbook: it is guidance's inbox, and nothing else
reads it.

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

It lives in the workspace rather than beside the playbook it is about because **the
repository is what verification diffs**. A kind whose playbook asks for no worktree is
judged in the main checkout, so a file appearing there mid-run would be reported as that
task's scope violation — recording a finding would fail somebody else's work. The
workspace is never diffed.

Entries are appended, never rewritten, so comments and hand corrections survive. An
entry goes away when a person folds it into the playbook and deletes it; nothing else
deletes one.
