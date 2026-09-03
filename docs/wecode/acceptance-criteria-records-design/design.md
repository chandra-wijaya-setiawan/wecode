# An acceptance criterion is a ledger row against the obligation

Decided: a criterion is stored as one `measure` row in the audit ledger, targeted at a
requirement handle, folded on read the way requirements themselves are. Not a table, not
a column on the task, not a heading in a markdown spec. Task acceptance keeps the table
it already has, because it is a different thing wearing the same word.

## Two things are called acceptance, and only one of them is stored

| | what it is | where it lives today |
|---|---|---|
| task acceptance | the bar the *attempt* was dispatched against | `task_acceptance(task_id, seq, kind, cmd, …)`, `Task::acceptance: Vec<Measure>` |
| project measures | how the objective will be judged | `project_measures`, same shape |
| **requirement criteria** | what would settle the *obligation* | **nowhere** |

ADR-0005 moved requirements out of `specification.md` and made them records. The AC rows
that sat beside the FR/NFR rows in that same document did not move, and `docs/design/sdlc.md`
still books 29148 as adopted on the strength of a markdown template. So a story's
obligations have wording, attempts and a handle, and nothing that says what passing looks
like.

The gap is not cosmetic. `requirement_is_met` answers "met" from task statuses alone — some
task that pointed here finished, and nothing open still points here. That is a claim about
attempts, not about the obligation: the task's own acceptance was written by whoever created
the task, can be narrower than the thing it serves, and in the ordinary case is `cargo test`
plus the ratchet. ADR-0006 §3 asks `wecode close <story>` to emit its report when every
requirement is done or dropped **with evidence**, and there is no evidence to join.

## The decision

    action  = 'measure'
    target  = <requirement handle>     -- checkout/FR-2, checkout/NFR-SEC-1
    detail  = <one command line>       -- `live:` honoured, as everywhere else
    project_id, task_id = the requirement's project and story

One row per criterion, appended, never rewritten. A requirement's criteria are every
distinct line ever stated against its handle, in the order stated. `Requirement` gains
`criteria: Vec<Measure>`, folded in the same pass that already folds `wording` and
`served_by` out of `require` and `serve` rows.

A criterion is a `Measure::Command` with `expect_status` 0, and nothing else. That is a
restriction and it is worth what it buys: the existing runner, `tier_of`, the deferred-live
block and the `✓ cmd exits 0` render all work unchanged, so the whole build is a fold and a
flag. A metric target — p95 under 200ms — is the non-functional requirement's *wording*,
not its criterion; the criterion is the command that reads the number. A `Judged` criterion
would be a requirement whose evidence is somebody's opinion, which is what the story's
signature already is.

## What it was decided against

| instead | why it loses |
|---|---|
| a `requirement_acceptance` table beside `task_acceptance` | a requirement has no table to hang a foreign key on, so the rows could name a handle nobody stated — and to be honest it would need `stated_by` and `at` columns, which is the ledger rewritten badly |
| criteria on the story task's `acceptance` | a story aggregates; admission exempts it from the acceptance check on purpose, and the criteria of four obligations in one undifferentiated list cannot say which one failed |
| copy them onto each serving task at dispatch | two copies of one definition, and the task's copy is the one the agent optimises against |
| keep them in `specs/**/specification.md`, index a digest | the designs treatment, applied to the wrong half: prose belongs in git because it is read, and a criterion is *run*. Parsing acceptance out of markdown at a commit is the fragile thing ADR-0001 built a cache to avoid |
| a `criteria` column on `tasks` | it is a fact about the obligation, and it would move when the task moved |

## The attempt's bar is frozen; the obligation's is a ratchet

`wecode task --scope` refuses to amend acceptance, and the comment says why: amending what
counts as done after seeing what was produced is how criteria drift to fit the work. That
argument is about the attempt, where the person amending is the one being judged. It does
not transfer to the obligation, and the shape here answers it more strongly than a freeze
would: **a criterion cannot be withdrawn.** Tightening is a new row. Loosening — the actual
laundering move — has no gesture at all.

That is the same rule `.max-lines` and `design-check.sh` follow, turned to a different
purpose: a floor that only ever rises. It also means a restated criterion makes a met
requirement unmet again until it is run, which is ADR-0005's reset rule arriving from the
second direction.

## Where they run, and what they change

Nothing about a task's verdict. A story's obligations are served by several tasks, and
failing the first one for a criterion only the last can satisfy would make the criterion
unwritable. They run against the story — which owns the worktree (ADR-0006), so there is
exactly one tree and one commit to run them in — at `wecode verify <story>` and again at
`wecode close`. Results land as they already do: one `Allow` per command with its exit code,
`Source::Supervisor`.

`owed()` prints `met` or `open` today and gains a third state, because "the tasks are done
and nobody has run the criteria" is neither:

| | when |
|---|---|
| open | something unfinished still claims it |
| unproven | attempts answered it; its criteria have not run green since |
| met | attempts answered it and its criteria passed |

A requirement with no criteria stays on the old rule and prints the fact. Refusing one
would fail every obligation already in the ledger, and the floor follows the tree.

## The surface

No new command. `--requirement "<wording>"` on a story states the obligation; `--met-by
"<cmd>"`, repeatable, states the criteria in the same breath, and the amend path — where a
handle typed on a story is already a story restating what it owes — adds more later.

## What this makes harder

**A wrong criterion is permanent.** Append-only with no withdrawal means a typo that is a
valid command sits red for ever. The remedy is the one the class-segment work also reaches
for: restate the obligation and drop the old one — and `dropped`, ADR-0005's third state,
is still not reachable by anything. Two decisions now depend on that gap, which is the
argument for closing it next rather than a reason to soften either.

**`wecode audit` grows a row shape whose detail is a command line** rather than a sentence.
It renders fine; it reads oddly beside `require`'s wording.

## What would show this was decided wrong

If `unproven` becomes the resting state of every requirement in the tree — criteria stated
once at planning and never run — then the storage was never the missing part and the
criteria are decoration on a board nobody drives from.

If operators routinely want a criterion that no single command can settle, and start
writing shell one-liners that chain three checks to get past the restriction, then
`expect_status` and the other `Measure` variants were load-bearing after all, and the
honest answer was the fuller grammar `task_acceptance` already stores.

## The room it has to land in

| file | lines | cap | headroom |
|---|---|---|---|
| `crates/wecode-store/src/audit.rs` | 1140 | 1700 | 560 |
| `crates/wecode-cli/src/verify.rs` | 1583 | 1700 | 117 |
| `crates/wecode-cli/src/commands/plan.rs` | 694 | 1700 | ample |
| `crates/wecode-core/src/requirement.rs` | 70 | 1700 | ample |
| `crates/wecode-cli/tests/requirements.rs` | 124 | 1500 | ample |

`verify.rs` is the one to watch: acceptance reads the whole worktree, so a build task that
adds a hundred lines of story-verdict rendering there fails on the file it was working in.
The fold and the `Measure` construction belong in `audit.rs`, which has the room.
