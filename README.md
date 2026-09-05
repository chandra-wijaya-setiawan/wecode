# wecode

**SDLC and project management for agentic software.** Coding agents do the work;
wecode is the lifecycle they work inside — requirements to versions, specs to
signatures, one ledger both human and agent render.

## The mission

Agentic coding in 2026 produces code faster than anyone can check it. The pain is
not generation, it is delivery: work that looks done and is not wired, "passing"
that an agent asserted rather than a command proved, and no record anyone can
audit afterwards. Vibe coding gets a prototype; nobody gets a product they can
stand behind.

wecode's answer: **agents should not have to remember the process — skipping it
must be impossible.** The SDLC is enforced by deterministic gates, not by
instructions in a prompt. A task is admitted only with an executable acceptance
and a write scope; it runs confined to a worktree under a budget; it is verified
from the diff and the acceptance commands, never from the agent's account of
itself; it lands only through merge policy and, where declared, a human
signature. Trust the process, and the goal takes care of itself.

You talk to one orchestrator; it holds the plan, dispatches work to agents under
enforced scopes and budgets, judges what came back from the diff rather than from
the agent's account of itself, and shows you one board for all of it.

```bash
wecode init mycompany            # a workspace: company.toml + wecode.db
wecode login you                 # take a seat
wecode project add api "cut export p99 below 500ms" --repo app --measure-cmd "cargo bench"
wecode task add cache --project api "add a response cache" --write "src/cache/**"
wecode run cache                 # worktree, agent, verification, commit
wecode board                     # what is happening, and what needs you
```

## Status: pre-MVP, honestly

This is a substantial, actively dogfooded **pre-MVP** alpha — wecode's own
development runs inside it — and it is not yet a dependable autonomous system.
What works: the admission gate, scopes and budgets, worktree isolation, the
ledger with admissibility marked at write time, the board and the cockpit,
Telegram approvals. What does not: a task can still be marked done while the
capability it belongs to is undelivered — *integration* evidence through the real
interface is checked ad hoc, not enforced at admission or at story closure; a
failed run waits for a person; a dead loop can look like a healthy idle one.
[docs/features.md](docs/features.md) lists the gaps where a reader will find
them, and [plan.md](plan.md) is what is next.

## The proving ground: Conduit

The loop is being closed against **Conduit**, a RealWorld API with a vendored
specification and an upstream Hurl suite — an oracle that owes wecode nothing, so
"correct" is not something an agent gets to assert. The campaign is a versioned
delivery, not a demo: a greenfield release, then seeded bug repairs, then
specification-led change requests, then interrupted-run recovery — autonomy at
every step, and a deterministic check at every step. Each failed run becomes a
reproducible wecode defect, which is how the tool's own development exposes the
coordination problems it exists to solve.

## Three ideas it rests on

**Enforce at the boundary, never in the prompt.** A scope is a check the Broker makes,
not a sentence in an instruction. What cannot be checked before the action is advice,
and belongs in the prompt where it will be treated as such.

**Ground truth over self-report.** Status comes from diffs, exit codes and spend. An
agent's account of its own work is useful for debugging and inadmissible as evidence,
and the ledger records which is which at write time.

**Your attention is the binding constraint.** Concurrency derives from it rather than
from cores; the loop throttles itself and stops entirely while something needs you.
Silence on green.

## Where to read next

| | |
|---|---|
| [docs/concepts.md](docs/concepts.md) | what a project, task, post and grant are |
| [docs/lifecycle.md](docs/lifecycle.md) | how work moves from draft to merged |
| [docs/features.md](docs/features.md) | what is built — and what is weak |
| [docs/design/sdlc.md](docs/design/sdlc.md) | where wecode stands in fifty years of SDLC |
| [plan.md](plan.md) | what is next |
| [docs/guides/getting-started.md](docs/guides/getting-started.md) | do it for real |

## Building

```bash
cargo test --workspace
cargo clippy --all-targets -- -D warnings
```

Seven crates: `core` is pure domain types with no dependencies at all, `gov` is the
Broker, `org` is hand-edited config, `store` is SQLite, `a2a` is the protocol data
model, `map` renders the repo map, and `cli` is the only one that executes anything.
