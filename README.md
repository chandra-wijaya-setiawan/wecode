# wecode

A Rust runtime for running coding agents as staff. You talk only to the
orchestrator: it holds every project, task and goal in one hierarchy of intent,
enforces what each agent may do, and attenuates what reaches you — so nothing
drifts from the objective it was meant to serve.

```bash
./wecode init ~/companies/acme     # a company: profile, roles, posts, state
./wecode company show              # your staff, and what each may do
./wecode board                     # the cockpit
./wecode audit --path 'crates/**'  # who touched this, any agent
```

## Docs

| | |
|---|---|
| **[Getting started](docs/getting-started.md)** | **Install, walkthrough, command reference.** Start here. |
| [Architecture](docs/architecture.md) | The design. Current state, authoritative. |
| [Theory](docs/theory.md) | Grounding, prior art, open questions. Not needed to implement. |
| `git log` | How the design got here, and why it changed. |

## Three rules

1. **Authority is enforced, never prompted.** A role is a set of checked
   capabilities or it is nothing.
2. **Ground truth over self-report.** Status comes from diffs, exit codes and
   spend — never from an agent's account of its own work.
3. **The operator's attention is the binding constraint.** Concurrency derives
   from it; the runtime throttles itself rather than flooding you.

## Status

Working: the intent ontology and admission gate, company workspaces and templates,
capability grants, the Broker, the audit ledger, assignment with scope checking, and
the board. 199 tests.

Not yet built: a real TUI, and agent execution — nothing spawns `claude` or `codex`
yet. Both need a native build; see [Status](docs/getting-started.md#status) for why,
and [architecture.md §11](docs/architecture.md#11-build-order) for the build order.
