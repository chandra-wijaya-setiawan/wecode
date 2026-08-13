# Templated decomposition, and a design gate

Status: **proposed** — awaiting approval.

## The problem

A feature becomes tasks by hand, one `task add` at a time, and every scope and every
acceptance command is retyped. In one session that produced:

- a docs task no seat could be assigned, because no role could write `plan.md`
- an A2A task declaring three files when eleven changed, refused by verify
- six wemail tasks whose acceptance names `python`, a binary absent from this machine
- two tasks dropped and recreated, because acceptance and scope are frozen at creation

None were execution failures. All were **planning** errors, made while hand-copying
defaults, and all were catchable before any agent ran.

Separately, a feature can go from an idea to a merged branch with no human ever seeing
a design. `approve admission` exists as a grant the chief holds and as a ledger record
that **nothing reads**, so the confirmation it implies does not happen.

## What this is not

Not a workflow engine. wecode does not execute a pipeline, and a `subtasks` list is not
a state machine.

The template runs **once, at planning time**, and emits ordinary tasks. Those tasks then
face the same admission gate as hand-written ones, and can be edited, dropped or added
to before anything is dispatched. Nothing at run time consults the template.

That distinction is the whole design. A scaffold that produces tasks is not a pipeline
that runs them.

## The shape

```toml
[feature]
worktree = true
subtasks = ["design", "build", "test", "docs"]
record   = "docs/wecode/{{task}}"

[feature.design]
kind      = "design"
write     = ["docs/wecode/{{task}}/design.md"]
accept    = ["test -f docs/wecode/{{task}}/design.md"]
approve   = true

[feature.build]
after     = ["design"]
write     = ["src/**"]
accept    = ["uv run pytest -q"]

[feature.test]
after     = ["build"]
assign_to = "test"
write     = ["tests/**"]

[feature.docs]
after     = ["build"]
write     = ["README.md", "docs/**"]
```

`wecode task add <id> --project <p> "<title>" --expand` emits four chained tasks with
`{{task}}` substituted. Without `--expand`, behaviour is exactly as today.

Per kind, and per project. `bug` gets no design subtask — it gets a reproduction, which
its playbook guidance already demands and which is a better gate.

## The work record

`docs/wecode/<task>/` is committed. It documents what wecode did, and it holds two kinds
of file that differ in **who wrote them**:

| file | author | admissible as |
|---|---|---|
| `design.md` | the design subtask, signed by a human | a proposal someone approved |
| `report.md` | wecode, from git and the ledger | evidence |

That split is load-bearing. An agent's account of its own work is inadmissible — so
`report.md` is generated, never authored. It is the merge report that already exists,
persisted instead of printed to a terminal and lost.

Project documentation is a **different thing** and does not live here. The `docs`
subtask updates `README.md` and `docs/` — what the project is, not what wecode did.

## The design gate

Three claims, and only two can be checked:

| claim | checkable |
|---|---|
| a design exists | yes — a file at a known path |
| a human approved it | yes — a record in the ledger |
| the design is good | **no** |

The gate enforces the first two and does not pretend to the third. A `feature` task with
`design_required` is refused admission unless it depends on a `design` task that is
`done` and carries an approval. `--force` admits it and records a waiver, as with every
other defect.

`approve design` reuses the existing machinery: `ActionKind` already has the variant,
and merge approval already reads the ledger this way.

A conventional path is what makes this cheap. `test -f docs/wecode/{{task}}/design.md`
is a real acceptance command, so nobody has to name a path by hand for the gate to work.

## Reaching the agent that needs it

Amendment. The gate above makes a design a *dependency*; it does not make the design
*visible*, and a dependency nobody reads is a delay rather than a control.

`task-expand` was dispatched with a signed design sitting in this directory specifying
exactly what to build, and nothing in its envelope pointed at it. The stopgap is a line
of playbook guidance saying where designs live. The fix is smaller than it sounds.

Nothing new is stored. A design task's path is already in the database twice — as its
acceptance command and as its write scope — and the document itself belongs in git,
where it can be diffed and reviewed, for the same reason `company.toml` is not in
`wecode.db`. A third copy in a column would be a derived value free to drift from the
two that produced it.

What changes is one function. `render::predecessor_artifacts` walks `depends_on` and
builds, for each done predecessor, an artifact holding its commit and a capped diff.
For a design predecessor that is the wrong artifact: the value is the document, not the
patch that created it. So a predecessor of kind `design` contributes its document, in
full and uncapped, as its artifact.

Three things already line up to make that small:

- the handoff travels `depends_on`, which is the edge the gate adds anyway
- `a2a::Artifact` is already the shape for "something a predecessor produced"
- the diff cap exists to stop an unbounded patch crowding out the instruction; a design
  is the instruction, so the cap does not apply to it

This is part of `design-gate` rather than a task of its own. A gate that enforces a
dependency the dependent cannot read has enforced paperwork.

## A step is not a landing

Second amendment, from running the first expansion end to end.

`build` passed and stopped at `needs-approval`, blocking `test` behind it. The rule
that put it there — work in a worktree waits for a merge signature — is right for a
*feature* and wrong for a *step of one*: the subtasks of an expansion share the
parent's branch, which cannot merge until the last of them is done. A signature per
step would be four approvals for one landing, three of them about nothing.

So: a subtask (a task with a parent) that passes verification goes to `done`, not
`needs-approval`. The merge gate applies once, where the merge is — the parent's
branch, when its last subtask finishes. The `design` kind keeps its signature: that
gate is about the proposal, not the landing, and fires before anything is built.

The operator resolved this by hand once (`status <build> done`); the rule above is
what `design-gate`'s implementer should encode.

## What is deliberately excluded

**merge** is not a subtask. It is a lifecycle transition with a charter gate, a project
policy, `--no-ff` and a rollback path. A task that "does a merge" is a state change
wearing a costume, and would duplicate machinery that works.

**report** is not a subtask, for the reason above: an agent writing prose about work it
just did is the self-report the trust model rejects.

## Risks

**Rubber-stamping.** A gate that always passes is worse than none, because it looks like
oversight. Mitigated by scope — design is required for `feature` only, three of six
kinds never see it — but not eliminated. If every design is approved unread, this
should be removed rather than kept for appearances.

**Template drift.** A playbook's `accept` commands can name a binary the machine does
not have; that is how the wemail tasks broke. Templating multiplies the blast radius,
since one wrong default now lands in four tasks instead of one. This wants
`wecode playbook check`, resolving each command before any task is created. `verify.rs`
already distinguishes exit 127 from a genuine failure, so the mechanism exists.

**Ceremony on small work.** Four tasks for a two-line change is absurd. `--expand` is
opt-in, and the un-expanded path stays exactly as it is today.

## Order of work

1. `design` kind, `approve design`, and the admission check
2. `subtasks` in the playbook, and `--expand`
3. `report.md` written at merge
4. `confirm_tasks`, making `approve admission` load-bearing at last

Each is usable without the next.
