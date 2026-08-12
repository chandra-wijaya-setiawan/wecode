# wecode

Run coding agents as staff.

You talk to one orchestrator; it holds the plan, dispatches work to agents under
enforced scopes and budgets, judges what came back from the diff rather than from the
agent's account of itself, and shows you one board for all of it.

```bash
wecode init mycompany            # a workspace: company.toml + wecode.db
wecode login you                 # take a seat
wecode project add api "cut export p99 below 500ms" --repo app --measure-cmd "cargo bench"
wecode task add cache --project api "add a response cache" --write "src/cache/**"
wecode run cache                 # worktree, agent, verification, commit
wecode board                     # what is happening, and what needs you
```

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
| [plan.md](plan.md) | what is next |
| [docs/guides/getting-started.md](docs/guides/getting-started.md) | do it for real |

## Building

```bash
cargo test --workspace
cargo clippy --all-targets -- -D warnings
```

Five crates: `core` is pure domain types with no dependencies at all, `gov` is the
Broker, `org` is hand-edited config, `store` is SQLite, `a2a` is the protocol data
model, and `cli` is the only one that executes anything.
