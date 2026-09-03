# A container's planning stage is read, not written

Decided: an epic or a story does **not** record its planning stage. The stage is a
closed, ordered ladder folded from records the plan already keeps — obligations, the
design record, the children — computed in `wecode-core` and printed where a leaf task
prints its status. No column, no ledger event, no new table, no migration:
`schema::VERSION` stays 14.

A *delivery container* is what ADR-0004 calls an aggregating kind — `epic` and `story`.
The project is out of it: ADR-0002 made it the repo's standing container, and a standing
thing has no plan of its own to be at a stage of.

## What a container records today

Its `status` column, and nothing else — the same enum the scheduler reads off a leaf.
That column was built for a unit of work that gets dispatched, and a container is never
dispatched, so on a container every value in it is either wrong or unreachable:

| what the operator sees | why it happens | what it should say |
|---|---|---|
| a story sits at `draft` for ever | `draft` → `waiting` is `assign` (`plan/staff.rs:189`), and nobody staffs a container | it is being shaped |
| the board's needs-you cell reads `unassigned` (`board.rs:287`) | that cell is kind-blind — `board.rs` never asks `kind.aggregates()` | state what it owes |
| `wecode status <story> done`, by hand | nothing rolls a container up, though `task.rs:34` already says a container "is done when its children are" | it is closed, because they are |
| a signed design and a story that owes nothing look identical | neither fact reaches any container row | the two rungs apart that they are |

So the one question a container exists to answer — how far has this been planned — is
answered by a column that cannot hold it, and by whoever last remembered to type
`status`. That is `living-docs.md`'s hand-tended class, which the same page says every
fact must justify not escaping.

## The ladder

Six rungs, ordered, closed. A rung is **reached** when its own evidence holds and every
rung below it does, so the stage names the last gate passed and the question it holds is
the next gate's:

| rung | reached when | evidence, all of it already recorded | the question it holds |
|---|---|---|---|
| `shaping` | admitted at all | the container exists and is not `draft` | what must be true for this to be done? |
| `specified` | it states an obligation | ≥1 `require` row (ADR-0005, `audit.rs:433`) | who decides how? |
| `designed` | a design stands behind it, signed | `Store::design_of(story).decided` | what are the pieces? |
| `decomposed` | a work child exists | ≥1 non-aggregating descendant | who does the first one? |
| `building` | a work child has left `draft` | any such descendant with a post named | which obligation is still open? |
| `closed` | every obligation is answered and nothing under it is open | `requirement_is_met` per obligation, plus no open descendant | — |

The names are the canon's, not new ones: `specified` is ISO/IEC/IEEE 29148's state, and
the ladder itself is Anderson's *Kanban* column with explicit entry policies (2010,
ch. 5). Leffingwell's portfolio kanban (*Agile Software Requirements*, 2011) runs
funnel → analyzing → backlog → implementing → done over the same span; wecode's
difference is that each of its entry policies is already a record, so the card does not
have to be dragged.

`designed` is **skipped** where the project's playbook does not gate these kinds — the
design gate's own rule, that "a project that has not asked for the gate does not get it
by omission" (`admission.rs:296`). Where it is gated and no design task exists, the story
stays at `specified` and says so, which is that refusal surfaced one level early instead
of at the child's dispatch.

An **epic** reads the *lowest* rung of its stories, and `shaping` when it has none. Not
the highest and not an average: an epic claiming `designed` while one story under it owes
nothing has overstated the objective, which is the only thing an epic is for. ADR-0005
puts obligations on the story, so an epic never reaches `specified` on its own account.

## How it is computed

```rust
pub fn stage_of(t: &Task, plan: &Plan, r: &Records) -> Option<Stage>
```

`None` for anything that is not a container. `Records` carries what `core` cannot go and
read — the obligations as `(handle, served_by)` pairs, `design: Option<bool>`, and
whether the project gates the design — assembled by the caller exactly as `needs_design`
already is, because `core` reads no files and no database.

Two properties matter more than the enum:

**It is not monotone, deliberately.** File a bug against a closed story and the rung
falls from `closed` to `building` on the next read. That is ADR-0005's reset rule with
nothing to remember, and `requirement_is_met` is the same trick one level down:
"an obligation is met while something has answered it and nothing open still claims it"
(`requirement.rs:51`). A stored stage would still read `closed`, which is the drift
ADR-0006 found between three documents holding one state.

**It follows `audit.rs`'s split, and lands on the other side.** State-now is a column,
that-it-happened is a ledger row — but a rung is neither. It is a *reading* of both, like
`health`, and `concepts.md` already draws that line: status is declared, health is
computed. The rung is the third axis of a container, and it is on health's side.

## What is still stored

The rung answers "how far", not "whether". Two declared facts remain, and neither is
derivable:

| stored | what it means on a container | where |
|---|---|---|
| `draft` | nobody has decided to do this | `tasks.status` |
| `dropped` | we looked and decided not to | `tasks.status` |
| held, with a reason | someone else's turn (ADR-0007) | `hold` |

`done` on a container becomes refusable in the commit that ships the ladder, because rung
`closed` is what it was trying to say and the ladder derives it. No test sets a
container's status today, so the refusal costs nothing to add — and a container marked
`done` over open obligations is precisely the lie ADR-0006's `close` gate was written to
refuse.

`wecode close <story>` (ADR-0006 §3) then stops being the thing that *records* closure and
becomes the thing that *reports* it: it refuses unless the rung reads `closed`, and emits
the generated report as its receipt. One condition, in one place, instead of the
requirement scan the ADR describes.

## What it was decided against

| instead | why it loses |
|---|---|
| a `stage` column, set by `wecode stage <id>` | a second copy of a state the records hold, and the copy is the one that goes stale — a story reading `shaping` with eight children done |
| container-only values in `TaskStatus` | the scheduler reads that enum; `is_schedulable` and `needs_a_human` would have to ask the kind first, and one enum meaning two things is how a leaf ends up promoted on a container's rule |
| a `stage` ledger event per transition | right if a rung were a decision; it is a consequence of five decisions already recorded, so the row would be a sixth account that can disagree with them |
| a `container_stages` table | a migration and a write path for a value that is a fold over two existing queries |
| front-matter in `design.md` | reachable only for stories that got as far as a design, which is the rung above the ones nobody can see |
| `progress` alone — the percentage already there | it counts done leaves, so every rung below `decomposed` is 0% and the whole planning half of the ladder reads identically |

The `stage` column is the close call, because an operator can then say what they mean.
They still can: everything they would type is a record with an owner — state the
obligation, sign the design, add the child, hold it. The column's only extra power is to
say a thing the records deny, and `sdlc.md`'s line is the ruling one — wecode adds
checks, not processes, and a row moves left only when it is something a gate can refuse.

## Where it lands, and the room

| file | lines | cap | what goes there |
|---|---|---|---|
| `crates/wecode-core/src/stage.rs` | new | 1700 | `Stage`, `Records`, `stage_of` |
| `crates/wecode-core/src/lib.rs` | 36 | 1700 | the export |
| `crates/wecode-cli/src/commands/ctx.rs` | 500 | 1700 | assembling `Records`, beside `design_gates` |
| `crates/wecode-cli/src/render/plan.rs` | 1024 | 1700 | the rung, where a leaf's status prints |
| `crates/wecode-cli/src/board.rs` | 1599 | 1700 | the needs-you cell asks the rung's question |
| `crates/wecode-cli/tests/plan.rs` | 1407 | 1500 | 93 lines of headroom — the ladder's tests do not fit here |

A new module rather than `plan.rs` or `requirement.rs`: the fold is a pure function over
types `core` already owns, which is what `requirement.rs` was split out of `admission.rs`
to be, and that file is about obligations. `board.rs` has 101 lines and a kind-blind
needs-you cell to fix, so the words belong in `render/`. The tests go to a new
`tests/stages.rs`, not `tests/plan.rs`, since acceptance reads the whole worktree and a
build task that overruns the tests ratchet fails on a file it had no business in.

## What this costs

**A stage cannot be asserted.** An operator whose story was shaped in conversation and
never written down cannot make the board say `specified`; they have to state the
obligation. That is the enforcement, and it is also the friction — the first week of it
will read as the tool being wrong about work somebody knows is further along.

**`closed` is unreachable for an abandoned obligation.** Nothing can drop a requirement
yet, so a story with one obligation it decided against can never leave `building`. This
takes the same dependency `docs/wecode/requirement-kinds-design/design.md` records on the
same gap, and it is the more expensive of the two: there it leaves a handle visible and
wrong, here it holds a whole container open.

**A read per container.** `design_of` is one query and the obligations are one more, per
container row on the board. The board already reads the ledger for vitals, so this is a
second pass over the same rows rather than new I/O — but a hundred stories is two hundred
queries, and the fix when it bites is one batched query, not a cached column.

## What would show this was decided wrong

If operators start writing the rung into titles — `[designed] warm cache` — to make a row
say what the records deny, then the ladder is measuring the wrong evidence and the
declared column was right after all.

If `decomposed` and `building` are never the answer anybody wanted, because the child rows
below already said it, the ladder wanted three rungs and stopping at `designed` was the
honest ceiling.

If a story routinely needs two rungs at once — half designed, half building, which is what
a story too large for one capability looks like — then a rung is a set, a set does not go
on a row, and ADR-0006's warning about oversized stories is the thing to fix instead.
