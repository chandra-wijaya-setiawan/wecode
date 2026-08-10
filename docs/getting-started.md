# Getting started

Run `./wecode` from the repo root. The first invocation compiles (~10s); after that
it is instant.

State lives in `$WECODE_HOME` (default `~/.local/state/wecode`). Set it per project:

```bash
export WECODE_HOME=~/.local/state/wecode/myproject
```

> **Current limitation.** `guard` is a manual probe, not a live intercept, and
> nothing spawns `claude` or `codex` yet — see [Status](#status). What works today
> is the intent, governance and audit half.

---

## 1. See what you have

```bash
./wecode                # usage
./wecode org show       # posts, occupants, and what each may do
```

`org show` is the staff list, and worth reading first:

| post | occupant | writes |
|---|---|---|
| `impl-api` | claude-code | `crates/**`, `src/**` |
| `test-api` | codex | `tests/**` only |
| `review` | claude-code | nothing — read-only, holds the sole merge approval |

A tester that cannot edit the implementation cannot make a failing test pass by
weakening the code. That is enforced, not requested.

Below the table are the **charter invariants**, which outrank every grant.

## 2. Capture intent, top down

```bash
# The direction. A vision is a root and needs no measure.
./wecode intent add vision ship-fast "lead the market on export speed"

# A goal needs a measurable target.
./wecode intent add goal p99 "cut export p99 below 500ms" \
    --parent ship-fast --measure-metric p99_ms:lt:500

# A project needs scope and budget too.
./wecode intent add project caching "add response caching to the export endpoint" \
    --parent p99 --measure-cmd "k6 run load/export.js" \
    --write "crates/export/**" --tokens 200000 --wall 1800
```

### Feed it something vague

This is the part that earns its keep:

```bash
./wecode intent add project speedup "make the export faster"
```

```
  ⚠ 5 defects — not assignable

  1  "faster" names a direction, not a target. faster compared to what, and by how much?
  2  Which intent does this serve? If none, say why it stands alone …
  3  How will we know this is done? Give a command, or a metric with a target.
  4  Which paths may this change?
  5  What is the budget — tokens, wall time, or both?
```

Nothing is saved. Answer the questions, or pass `--force` to admit anyway — which
records a waiver rather than hiding the gap.

Every check except the vagueness one is decided by inspecting types and the tree,
so the gate is reproducible.

### Ad-hoc work

Work that serves nothing is fine, but you have to say so:

```bash
./wecode intent add task bump-deps "update transitive dependencies" \
    --standalone maintenance --measure-cmd "cargo check" \
    --write "Cargo.toml" --tokens 5000
```

`--standalone` is deliberate; an intent with no link at all is drift, and reported.

## 3. Navigate

```bash
./wecode intent tree                     # the whole hierarchy, indented
./wecode intent show caching             # what does this serve?
./wecode intent check caching            # re-run admission on a saved intent
./wecode intent link <id> --parent <p>   # fix drift
```

`intent show` answers the "am I still on trajectory" question by walking from the
root down to the node:

```
VIS lead the market on export speed
  GOAL cut export p99 below 500ms
    PROJ add response caching to the export endpoint
      TASK cover the cache layer with tests
```

## 4. Test the enforcement

`guard` asks the Broker whether a post may do something, and records the answer.

```bash
./wecode guard impl-api write crates/export/cache.rs   # ✓ allowed
./wecode guard test-api write crates/export/cache.rs   # ✗ denied — sanctioned
./wecode guard impl-api write deploy/prod.pem          # ⚡ ALARM
./wecode guard impl-api run "git push --force"         # ⚡ ALARM
./wecode guard review  merge main                      # ⏸ needs approval
./wecode guard impl-api spend x --tokens 500000        # ⚡ ALARM (2.5× cap)
```

Two things to notice:

- The tester denial is **sanctioned** — recoverable, so the attempt is recorded as
  a signal that the *scope* may be wrong rather than the agent.
- The `.pem` and force-push denials are **alarms**, and they fire even under a root
  grant, because charter invariants are checked *before* grants. A grant that
  permits an invariant violation is itself the bug.

## 5. Read the ledger

```bash
./wecode audit                      # everything, every agent, one place
./wecode audit --alarms             # invariant violations only
./wecode audit --denied             # refusals
./wecode audit --path 'crates/**'   # who touched these paths, any agent
```

```
seq  post        occupant      verdict   action  target
1    impl-api    claude-code   ✓ allow   write   crates/export/cache.rs
2    test-api    codex         ✗ deny    write   crates/export/cache.rs
     └─ sanctioned: write outside scope: crates/export/cache.rs
3    impl-api    claude-code   ⚡ ALARM   write   deploy/prod.pem
     └─ regimented: invariant violated: never_touch deploy/prod.pem
```

The `--path` query is the cross-harness question no individual coding CLI can
answer, because each one only knows its own session.

---

## Command reference

| Command | Does |
|---|---|
| `intent add <kind> <id> "<statement>"` | capture intent; runs the admission gate |
| `intent tree` | the whole hierarchy |
| `intent show <id>` | lineage — what this serves |
| `intent check <id>` | re-run admission on a saved intent |
| `intent link <id> --parent <p>` | resolve drift |
| `org show` | posts, occupants, grants, invariants |
| `guard <post> <verb> <target>` | authorise an action and record it |
| `audit` | the ledger |

### `intent add` flags

| Flag | Meaning |
|---|---|
| `--parent <id>` | what this serves |
| `--link requires\|alternative\|contributes` | AND / OR / partial contribution |
| `--standalone maintenance\|urgent\|exploration\|personal` | deliberately unaligned |
| `--measure-cmd "<cmd>"` | executable acceptance (repeatable) |
| `--measure-metric <name>:<lt\|lte\|gt\|gte\|eq>:<target>` | numeric target |
| `--write <glob>` / `--read <glob>` | scope (repeatable) |
| `--tokens <n>` / `--wall <secs>` | budget |
| `--horizon now\|week\|month\|quarter\|year\|indefinite` | never longer than the parent's |
| `--personal` | personal rather than org sphere |
| `--force` | admit despite defects, recording a waiver |

`guard` verbs: `read`, `write`, `run`, `merge`, `spend` (with `--tokens`).

---

## Development

```bash
cargo test  --target wasm32-wasip1              # 141 tests
cargo clippy --target wasm32-wasip1 --all-targets
cargo fmt --all
```

### Why the wasm target

This machine has no C linker — no `cc`, no `crt1.o`, no `libc.so` — and `sudo`
needs a password. Proc-macro crates are host dylibs, so `serde`, `thiserror` and
`clap` are all unavailable, which blocked even `cargo check`.

`wasm32-wasip1` links with Rust's bundled lld against a bundled libc and runs
under Node's WASI, so the whole suite is buildable and testable. Two consequences,
both isolated to one file each:

- the record format is hand-rolled tab-delimited rather than JSONL (`codec.rs`)
- arg parsing is hand-rolled rather than clap (`args.rs`)

Making `wecode-core` dependency-free turned out to be better design regardless: a
pure domain crate, with serialization belonging to the store.

To restore a native build:

```bash
sudo apt-get install -y build-essential
```

Then delete `.cargo/config.toml` and `scripts/wasi-run.mjs`, and simplify
`./wecode` to `cargo run -q -p wecode-cli`. Nothing in the source depends on the
workaround.

## Status

Built and tested: the intent ontology, the admission gate, capability grants, the
Broker, the audit ledger, and the CLI over all of it.

Not built: **agent execution.** `CliAgent`, process supervision and git worktrees
need process spawning, which wasip1 does not have — so that layer cannot be
compiled or tested here until the C linker exists. It is the piece that makes this
actually drive `claude` and `codex`.

See [architecture.md §11](./architecture.md#11-build-order) for the full build
order.
