# Getting started

Run `./wecode` from the repo root. The first invocation compiles (~10s); after that
it is instant.

> **Current limits.** `guard` is a manual probe, not a live intercept; `board` is a
> snapshot rather than a live dashboard; and nothing spawns `claude` or `codex` yet.
> See [Status](#status). What works today is intent, governance, audit and the
> board.

---

## 1. Create a company

A company is a **self-contained directory**: profile, roles, posts, agent templates
and state, all in one place. It is deliberately *not* a code repository — the repos
it works on are declared inside it by path.

```bash
./wecode templates                              # see what's available
./wecode init ~/companies/acme                  # default: software-company
./wecode init ~/companies/solo --template solo  # smallest governed setup
```

```
~/companies/acme/
  company.toml            profile, attention budget, invariants, roles, posts
  agents/claude-code.toml how to invoke each coding CLI
  agents/codex.toml
  templates/task-envelope.md
  state/                  intents.log, audit.log — append-only (gitignored)
  README.md
```

Then point it at your code. Edit `company.toml`:

```toml
[[repos]]
name = "app"
path = "~/projects/your-repo"
```

Commands find the workspace by walking up from the working directory, like git and
cargo. So `cd ~/companies/acme` and the `--org` flag becomes unnecessary:

```bash
cd ~/companies/acme
wecode company show
```

Otherwise pass `--org <dir>` or set `WECODE_ORG`. Examples below use `--org` to be
explicit.

## 2. Read the org

```bash
./wecode --org ~/companies/acme company show
```

| post | role | occupant | writes |
|---|---|---|---|
| `chief` | chief | claude-code | — read only |
| `impl` | engineer | claude-code | `src/**`, `crates/**`, `lib/**` |
| `test` | tester | codex | `tests/**`, `spec/**` |
| `review` | reviewer | claude-code | — read only |

Two things in that table are load-bearing:

- The **tester writes only tests**, so it cannot make a failing test pass by
  weakening the implementation.
- The **chief writes nothing and runs nothing.** It holds `define`, `staff` and
  approvals — so it configures and assigns, but cannot do the work. Loading a
  company whose chief has `write` or `run` is a validation error. An agent that can
  both set the criteria and satisfy them is not governed.

Below the table are the **charter invariants**, which outrank every grant.

## 3. Capture intent, top down

```bash
W="./wecode --org ~/companies/acme"

# A vision is a root and needs no measure.
$W intent add vision fast "lead the market on export speed"

# A goal needs a measurable target.
$W intent add goal p99 "cut export p99 below 500ms" \
    --parent fast --measure-metric p99_ms:lt:500

# A project needs scope and budget too.
$W intent add project caching "add response caching to the export endpoint" \
    --parent p99 --measure-cmd "k6 run load/export.js" \
    --write "crates/export/**" --tokens 200000 --wall 1800

# A task hangs off a project, never off a goal.
$W intent add task cache-tests "cover the cache layer with tests" \
    --parent caching --measure-cmd "cargo test" \
    --write "tests/**" --tokens 50000
```

### Feed it something vague

This is the part that earns its keep:

```bash
$W intent add project speedup "make the export faster"
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
records a waiver rather than hiding the gap. Every check except the vagueness one is
decided by inspecting types and the tree, so the gate is reproducible.

### Ad-hoc work

Work that serves nothing is fine, but you have to say so. `--standalone` is
deliberate; an intent with no link at all is drift, and reported as such.

```bash
$W intent add task bump-deps "update transitive dependencies" \
    --standalone maintenance --measure-cmd "cargo check" \
    --write "Cargo.toml" --tokens 5000
```

## 4. The board

```bash
$W board            # portfolio
$W board caching    # descend into one intent
```

```
┌ L0 · PORTFOLIO ─────────────────────── wecode board <id> to descend ─┐
│ what                    health    progress    spend       needs you
│ VIS fast                ●red    ▁▁▁▁▁▁   0%   400         1 alarm
│   GOAL p99              ●red    ▁▁▁▁▁▁   0%   400         1 alarm
└─ alarms freeze dispatch · silence on green
```

Same five columns at every level — **what · health · progress · spend · needs-you**
— which works only because the intent tree is self-similar.

**Health is computed, never reported.** Alarms and over-budget are red; defects,
denials and stalled are amber; otherwise green. Spend and incidents roll *up* the
tree, so an alarm on one task turns its project, goal and vision red. `stalled`
means spend rising with zero progress — the failure mode that quietly wastes money.

## 5. Assign work

```bash
$W assign caching --to impl
```

The useful check is deterministic: a post whose grant does not cover the intent's
write scope cannot legally do the work, so assigning it would guarantee a rejection
later.

```
$ $W assign cache-tests --to impl
error: post `impl` (role engineer) may not write tests/** — it writes only: src/**, crates/**, lib/**

$ $W assign cache-tests --to test
  assigned cache-tests to test (tester, occupied by codex)
```

Goals are refused outright — a goal is reached by satisfying its children, never by
being handed to a unit.

## 6. Test the enforcement

`guard` asks the Broker whether a post may do something, and records the answer.

```bash
$W guard impl write crates/export/cache.rs --intent caching   # ✓ allowed
$W guard test write crates/export/cache.rs --intent caching   # ✗ denied — sanctioned
$W guard impl write deploy/prod.pem --intent caching          # ⚡ ALARM
$W guard impl run "git push --force" --intent caching         # ⚡ ALARM
$W guard review merge main --intent caching                   # ⏸ needs approval
$W guard impl spend x --tokens 500000 --intent caching        # ⚡ ALARM (2.5× cap)
```

Two things to notice:

- The tester denial is **sanctioned** — recoverable, so the attempt is recorded as a
  signal that the *scope* may be wrong rather than the agent.
- The `.pem` and force-push denials are **alarms**, and they fire even under a root
  grant, because charter invariants are checked *before* grants. A grant that
  permits an invariant violation is itself the bug.

Always pass `--intent`: a record with no intent cannot be correlated, and will not
appear on the board.

## 7. Read the ledger

```bash
$W audit                      # everything, every agent, one place
$W audit --alarms             # invariant violations only
$W audit --denied             # refusals
$W audit --path 'crates/**'   # who touched these paths, any agent
```

The `--path` query is the cross-harness question no individual coding CLI can
answer, because each one only knows its own session.

---

## Command reference

| Command | Does |
|---|---|
| `init <dir> [--template <name>]` | scaffold a company workspace |
| `templates` | list templates |
| `company show` | profile, posts, grants, invariants |
| `intent add <kind> <id> "<stmt>"` | capture intent; runs the admission gate |
| `intent tree` / `show <id>` / `check <id>` | hierarchy / lineage / re-check |
| `intent link <id> --parent <p>` | resolve drift |
| `board [<id>]` | cockpit: portfolio, or one intent |
| `assign <intent> --to <post>` | check the post may do it, then activate |
| `guard <post> <verb> <target>` | authorise an action and record it |
| `audit [--denied\|--alarms\|--path <glob>]` | the ledger |

Global: `--org <dir>` (or `$WECODE_ORG`) to pick a company explicitly.

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
cargo test  --target wasm32-wasip1              # 199 tests
cargo clippy --target wasm32-wasip1 --all-targets
cargo fmt --all
```

### Why the wasm target

This machine has no C linker — no `cc`, no `crt1.o`, no `libc.so` — and `sudo`
needs a password. Proc-macro crates are host dylibs, so `serde`, `thiserror` and
`clap` are all unavailable, which blocked even `cargo check`.

`wasm32-wasip1` links with Rust's bundled lld against a bundled libc and runs under
Node's WASI, so the whole suite builds and tests. Three consequences, each isolated
to one file:

- record format is hand-rolled tab-delimited rather than JSONL (`store/codec.rs`)
- config parsing is a hand-rolled TOML subset rather than `toml` (`org/toml.rs`)
- arg parsing is hand-rolled rather than `clap` (`cli/args.rs`)

Making `wecode-core` dependency-free turned out to be better design regardless: a
pure domain crate, with serialization belonging to the store.

**Note:** panics abort rather than unwind on wasip1, so a failing test reports
`RuntimeError: unreachable` with no message. Narrow it down by running one test at a
time, or reason from the assertion.

### Restoring a native build

```bash
sudo apt-get install -y build-essential
```

Then delete `.cargo/config.toml` and `scripts/wasi-run.mjs`, and simplify `./wecode`
to `cargo run -q -p wecode-cli`. Nothing in the source depends on the workaround.

## Status

**Working:** the intent ontology and admission gate, company workspaces and
templates, capability grants, the Broker, the audit ledger, assignment with scope
checking, and the board.

**Not built:**

- **A real TUI.** Full-screen rendering works on wasip1, but raw keypress mode needs
  `termios`, which WASI has no equivalent for — so `ratatui`/`crossterm` cannot be
  used. `board` is a snapshot with the right layout; live refresh and `j`/`k`
  navigation need a native build.
- **Agent execution.** `CliAgent`, process supervision and git worktrees need
  process spawning, which wasip1 does not have. This is the piece that makes wecode
  actually drive `claude` and `codex`.

Both are waiting on the same C linker. See
[architecture.md §11](./architecture.md#11-build-order) for the full build order.
