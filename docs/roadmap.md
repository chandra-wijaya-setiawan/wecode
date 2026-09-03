# Parked roadmap

Work that is designed or scoped and waiting for capacity. It is a mirror, kept by hand,
and it exists only until the roadmap view lands and reads the same items off the plan —
at that point this file goes.

The larger priorities and their phases are in
[docs/design/maturity-roadmap.md](design/maturity-roadmap.md); what is *next* rather than
parked is in [plan.md](../plan.md). This page holds neither: only the items already
argued for that nobody is working on.

| item | P | state | design |
|---|---|---|---|
| [runtime-isolation](#runtime-isolation) | P0 | scoped, seam specified | [design/runtimes.md](design/runtimes.md) |
| [planning-lifecycle-stages](#planning-lifecycle-stages) | P0 | designed, amended once | `docs/wecode/planning-lifecycle-stages-design/design.md` |
| [container-spend-budgets](#container-spend-budgets) | P1 | scoped, undesigned | — |

## runtime-isolation

A `SandboxProvider` trait, and the first implementations behind it. Agent, devbox and
sandbox runtimes are one thing today, so moving any one of them off this machine is a
rewrite rather than a provider swap. The seam is specified in
[design/runtimes.md](design/runtimes.md).

Ordered, because each rung needs the one under it:

1. P0 reliability — journal, lease, recover. The durable state the rest rests on.
2. `SandboxProvider` with `LocalProcess` and Docker/Podman providers.
3. The same trait shape pointed at a devbox: a worktree in a pod, on this machine.

Parked behind reliability on purpose. A provider abstraction over state that does not
survive a restart abstracts the wrong layer first.

## planning-lifecycle-stages

A container's planning stage is **read, not written**. Six ordered rungs fold out of
records the plan already keeps — the container's status, its obligations, its design
record, its children — computed in `wecode-core` and printed where a leaf prints its
status. No column, no ledger event, no table, no migration.

| rung | reached when |
|---|---|
| `shaping` | admitted, and not `draft` |
| `specified` | it states at least one obligation |
| `designed` | its design record is signed |
| `decomposed` | its obligations have children against them |
| `building` | a child is in flight |
| `complete` | it owes nothing — `shortfalls()` is empty |

The top rung was `closed`; `docs/wecode/story-completeness-gate-design/design.md`
amended it. *Complete* is the derived reading, *closed* is complete plus a stored
decision that no more work is coming — a fact no fold over the records can hold. The two
designs share one function: the rung is `shortfalls()` empty, the gate is `shortfalls()`
non-empty.

Parked, not blocked. It needs the completeness gate's `drop` row to land first.

## container-spend-budgets

Per-container token and wall budgets, checked independently of the leaf budgets under
them. An epic or a story declares its own limit; today only leaves carry one, so scope
creep is invisible until a leaf overruns.

Budgets compose. A grandchild's dispatch checks grandparent, parent and self, and the
tightest limit is the cap. Spend aggregates on the board per container, per project and
per company, rolled from the attempt ledger on each read, so a retry's cost is visible
before its siblings run.

Undesigned, and the reason it is parked: the leaf budgets it composes with are recorded
but not enforced (`budget-unenforced`, `wall-unenforced`). A composition rule over two
limits nothing checks is a table of numbers, not a control.
