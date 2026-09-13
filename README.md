# wecode

Deterministic project management for a developer and their coding agents. Work is written
down as tests before it is built, agents are given one task each inside a scope they cannot
leave, and nothing is finished because an agent said so.

The design is in [`docs/design`](docs/design). Read it in order.

| package | |
|---|---|
| `@wecode/core` | entities, state machines, constraints, the repository |
| `@wecode/cli` | every verb, as a command |
| `@wecode/tui` | the board |
| `@wecode/runner` | allocator, foreman, synchroniser, worker adapters |

The Rust implementation this replaces is at `../archived/wecode-rust`, tagged `rust-final`.
