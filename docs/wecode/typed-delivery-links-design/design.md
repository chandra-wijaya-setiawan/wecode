# A task-to-requirement link carries its relation on the task

Decided: the link gains a relation, `Delivery`, with three values fixed by what they do to
closure and nothing else. It lives in a nullable `tasks.requirement_rel` column beside
the handle, defaults from the task's kind when unstated, and rides the `serve` row's
empty `detail` so the event says what was claimed. `wecode-core` owns the vocabulary.

## What the link says today, and what it cannot

`tasks.requirement_id` is one string and every link means the same thing: *this task is
an attempt at that obligation*. `requirement_is_met` then reads every attempt the same
way — done answers, open blocks:

```rust
if t.status.is_done() { answered = true }
else if !t.status.is_closed() { return false }
```

Two live failures, in opposite directions:

| what happens | what the board says | what is true |
|---|---|---|
| a `design` task against `checkout/FR-1` is signed | `met` | nothing is built |
| a `spike` against `checkout/FR-1` sits open after the feature lands | `open` | the obligation is served |

A design is *done* when someone signs it (`TaskKind::Design`, task.rs) and a signature is
not delivery. A spike "is expected to produce an answer, not a change" — its own doc
comment — and an answer does not hold an obligation open. Both are the same missing fact:
the link cannot say what the task does *for* the requirement, so closure counts a
proposal, an investigation and an implementation as one thing.

## The decision — three relations, and the algebra that closes the vocabulary

A relation earns its place only if `requirement_is_met` reads it differently. That gives
two questions and four cells, not a taxonomy of intents:

| relation | done ⇒ answers it | open ⇒ holds it open | what it is |
|---|---|---|---|
| `delivers` | yes | yes | the work that meets the obligation. Today's meaning, and the default |
| `verifies` | no | yes | the check that proves it. An unwritten check is a reason to refuse `met`; a passing check alone proves nothing was built |
| `informs` | no | no | a spike, a design, an investigation. Traceability only — it answers the question, not the obligation |

A closed-but-not-done task stays neutral under every relation, which is what the code
does now: `wecode task rm` and a dead end are not claims on anything.

**The fourth cell is empty on purpose.** A link that answers when done but blocks nothing
while open is an obligation nobody is accountable for: it closes if the work happens to
land and nobody minds if it never does. Naming it would let an operator write exactly
that, so it is not named. Four cells, three relations, one argued out — the vocabulary is
closed by the algebra rather than by taste, which is why nothing gets a fourth value
later without a fourth column in this table.

`delivers` also swallows the partial contribution. Two tasks each doing half of `FR-1`
both `delivers`; the obligation closes when both are done, because an open one blocks and
a done one answers. A separate `contributes` that blocked-while-open and answered-never
would leave a requirement served entirely by partial work forever open, and one that
answered-in-aggregate would be `delivers` under another name. It reads differently in
neither cell, so it is not a relation.

The reset rule of ADR-0005 falls out of this rather than being restated: creating an
`informs` task against a met obligation no longer reopens it, and creating a `delivers`
or `verifies` one still does. Derived, so there is nothing to remember and nothing to
migrate when it changes.

## Where it lives

**On the task, as its own nullable column.** The deciding argument is reach:
`requirement_is_met` lives in `wecode-core`, which reads no database, and it is handed a
`Plan`. A relation on the task row is already in its hand — `plan.task(id)` returns it —
and the function's signature does not change at all. A relation held only in the ledger
would need a `Store` passed into core, which the crate order forbids. The same structural
argument that moves `ReqKind` into `core` decides this one.

Nullable, and never backfilled. `None` means *not stated*, read from the kind:

```rust
pub fn delivery(&self) -> Delivery {
    self.requirement_rel.unwrap_or_else(|| Delivery::of_kind(self.kind))
}
```

| kind | default | why |
|---|---|---|
| `design`, `spike` | `informs` | both are defined as producing an answer rather than a change |
| everything else | `delivers` | today's meaning, unchanged for every row already written |

Defaulting through the accessor rather than writing the default in is what keeps the two
from drifting: a task re-kinded from `spike` to `feature` starts delivering, because
nothing froze the old answer into a column. `verifies` is reachable from no kind — there
is no test kind and inventing one would put a relation in the wrong enum — so it is the
one value an operator always states.

The `serve` row carries it too, in the `detail` field that is empty today. Not a second
copy, on the split `audit.rs` already states in its module doc: the column is what this
task answers to *now* and moves when the task is re-aimed; the row is that it claimed
that relation then, and never changes. The handle is stored in both halves for that
reason; the relation is half of the same claim.

Type `Delivery`, in `requirement.rs` beside `check_requirement` and `ReqKind` — 70 lines
holding the concept it was split out of `admission.rs` to hold. The column is named
`requirement_rel` for the pair it completes, the type for the question it answers.

Migration 14→15: `ALTER TABLE tasks ADD COLUMN requirement_rel TEXT`, one of the silent
steps. `ADD_REQUIREMENT_LINK` backfilled because the fact had been observed and written
down; nothing ever observed a relation, so writing one would be inventing it, and the
kind default already reads every old row correctly.

## Surface

`--requirement <handle> --rel <relation>`, mirroring the story side exactly: there
`--requirement` states the obligation and `--nfr` classifies it, here `--requirement`
names the link and `--rel` classifies it. One axis, one flag, both ends.

| said | printed back |
|---|---|
| `--rel` absent | `delivers  <id> — open again until this task is done` |
| `--rel verifies` | `verifies  <id> — open again until this check is written` |
| `--rel informs` | `informs   <id> — recorded; it does not reopen the obligation` |

Two refusals, both in `requirement_asked` and both for its stated reason — a wrong
command is a typo to fix now, not a saved row somebody has to find and unpick:

- an unknown relation word, on the same terms as an unknown handle;
- `--rel` on a story, which states obligations and links to none.

No refusal anywhere else, and no note either. Every existing task reads correctly through
the default, so there is no unclassified population to grow a gate against later — the
`--nfr` case needed a note precisely because there was one.

`wecode check <id>` gains the relation in the line it already prints for what a task
serves, and a story's `open` obligations gain the reason: an obligation whose only links
are `informs` reads **open — nothing delivers it**, which is the true state and today
reads `met` the moment the design is signed.

## What it was decided against

| instead | why it loses |
|---|---|
| derive from `TaskKind` alone, no column | right for the two defaults, and unable to express `verifies` at all; also makes a `chore` that writes the acceptance check indistinguishable from one that ships it |
| the `serve` row's `detail`, and nothing on the task | the gate that needs it is in `core`, which cannot read a store — the argument that moved `ReqKind` out of `store` |
| a segment on the handle — `checkout/FR-1@delivers` | the handle is the requirement's identity; decorating it per-task means the string a task carries no longer resolves to the obligation |
| a `serves(task, requirement, rel)` table | reverses ADR-0005's one-requirement-per-task shape and buys a cardinality nothing has asked for; the table can be added later without unpicking the column |
| a `status` word written onto the requirement | ADR-0005's amendment already refused this, and for this reason: the state is a fact about the tasks |
| free text — `--rel "checks it"` | four spellings inside a month; `PER`/`PERF` in the tree is the standing proof |

## The room it has to land in

| file | lines | cap | headroom |
|---|---|---|---|
| `crates/wecode-store/src/plan.rs` | 1683 | 1700 | 17 |
| `crates/wecode-core/src/admission.rs` | 1679 | 1700 | 21 |
| `crates/wecode-store/src/schema.rs` | 1324 | 1700 | 376 |
| `crates/wecode-store/src/audit.rs` | 1140 | 1700 | 560 |
| `crates/wecode-cli/src/commands/plan.rs` | 694 | 1700 | ample |
| `crates/wecode-core/src/requirement.rs` | 70 | 1700 | ample |
| `crates/wecode-cli/tests/requirements.rs` | 124 | 1500 | ample |

`plan.rs` is the tight one and it is unavoidable: the column has to be selected, bound
and written in `load_plan`/`save`, which is four lines in a file with seventeen. Budget
it first and put nothing else there. The type, the default and the closure change go to
`requirement.rs`; the flag and the printed lines to `commands/plan.rs`; the tests to
`tests/requirements.rs`.

Acceptance reads the whole worktree, so the build task's scope must also include
`docs/reference/schema.md` (the `tasks` DDL and the migration list) and
`docs/reference/commands.md` (the `--requirement` section and its two-halves table) —
the doc-freshness gate refuses the diff either way if a governing page is outside scope.

This is orthogonal to the requirement-kinds design: that one types the *obligation* by
quality characteristic, this one types the *link*. Both land in `requirement.rs` and
neither reads the other, so either order works.

## What would show this was decided wrong

If `--rel` is never typed, `verifies` bought nothing and the kind defaults were the whole
answer — the column should then go and `delivery()` become a match on kind.

If operators reach for `verifies` on work that also builds the thing, the relation is a
set rather than a value, and a set does not go in a column beside a single handle: the
`serves` table rejected above wins after all.

If obligations routinely read `met` while the story owner says only a piece landed, the
partial-contribution argument was wrong: what was wanted was a link that says "this one
completes it", and `delivers` on every piece cannot say it.
