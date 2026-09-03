# An acceptance criterion is a ledger row against the obligation

Decided: a criterion is stored as one `measure` row in the audit ledger, targeted at a
requirement handle, and its result as one `met`/`unmet` row targeted at the same handle.
Both folded on read the way requirements themselves are. Not a table, not a column on the
task, not a heading in a markdown spec. Task acceptance keeps the table it already has,
because it is a different thing wearing the same word.

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
plus the ratchet. ADR-0006 §2 asks the story report to be the join of *requirements × tasks
× runs × acceptance results*, and there is no acceptance result keyed to a requirement for
that join to reach.

## The decision — two row shapes, one join key

| | action | target | detail |
|---|---|---|---|
| the criterion | `measure` | `<handle>` — `checkout/FR-2` | one command line; `live:` honoured, as everywhere else |
| the result | `met` / `unmet` | the same `<handle>` | `3/3 green`, or `2/3 — \`cargo clippy\` exit 1` |

Both through `Store::append_stated`, beside `declare_requirement` and `serve_requirement` —
so `source` is `supervisor`, `outcome` is `allow`, and `project_id`/`task_id` are the
requirement's project and story, all for free. Nothing in `wecode-gov` changes: an `Action`
is something the Broker authorises, and neither of these is a request to do anything.

**The join key is the handle, not the command line.** This is the part worth the whole
design: the ledger's existing record of a command that ran is `Action::Run`, whose `target`
is the argv, and `cargo test` is the argv of nearly every task in the tree. Keyed that way,
one requirement's green would credit another's, which is worse than having no evidence.

One row per criterion, appended, never rewritten. A requirement's criteria are every
distinct line ever stated against its handle, in the order stated. `Requirement` gains
`criteria: Vec<Measure>`, `stated_at` (the newest `measure` row) and `proven_at` (the newest
`met` row), all folded in the pass that already folds `wording` out of `require` rows —
`requirements()` widens its one `WHERE action = 'require'` to an `IN` list and matches on
the action, so the fold stays a single scan.

`Vec<Measure>` rather than a richer criterion type because `run_tier` takes `&[Measure]`,
and anything else needs a conversion at the call site. Who stated which line, and when, is
in the ledger, and `wecode audit --task <story>` already prints it.

A criterion is a `Measure::Command` with `expect_status` 0, and nothing else. That is a
restriction and it is worth what it buys: the existing runner, `tier_of`, the deferred-live
block and the `` `cmd` exits 0 `` render all work unchanged. A metric target — p95 under
200ms — is the non-functional requirement's *wording*, not its criterion; the criterion is
the command that reads the number. A `Judged` criterion would be a requirement whose
evidence is somebody's opinion, which is what the story's merge signature already is.

## What it was decided against

| instead | why it loses |
|---|---|
| a `requirement_acceptance` table beside `task_acceptance` | a requirement has no table to hang a foreign key on, so the rows could name a handle nobody stated — and it would need `stated_by` and `at` columns, which is the ledger rewritten badly |
| criteria on the story task's `acceptance` | a story aggregates; admission exempts it from the acceptance check on purpose, and the criteria of four obligations in one undifferentiated list cannot say which one failed |
| copy them onto each serving task at dispatch | two copies of one definition, and the task's copy is the one the agent optimises against |
| keep them in `specs/**/specification.md`, index a digest | the designs treatment applied to the wrong half: prose belongs in git because it is *read*, and a criterion is *run*. Parsing acceptance out of markdown at a commit is the fragile thing ADR-0001 built a cache to avoid |
| a `criteria` column on `tasks` | it is a fact about the obligation, and it would move when the task moved |
| record results as `Action::Run` rows through the Broker | the join key above, and a second reason: `Run` is `Regimented`, so every result row would read as an authorisation that was granted |
| refuse a story whose requirement has no criteria | the gate is `check_requirement` in `admission.rs`, which has 21 lines of headroom against its cap — and the floor has to follow the tree, because every obligation already in the ledger has none |

## The attempt's bar is frozen; the obligation's is a ratchet

`wecode task --scope` refuses to amend acceptance, and the comment says why: amending what
counts as done after seeing what was produced is how criteria drift to fit the work. That
argument is about the attempt, where the person amending is the one being judged. It does
not transfer to the obligation, and the shape here answers it more strongly than a freeze
would: **a criterion cannot be withdrawn.** Tightening is a new row. Loosening — the actual
laundering move — has no gesture at all.

That is the same rule `.max-lines` and `design-check.sh` follow, turned to a different
purpose: a floor that only ever rises.

## Where they run, and who says what state an obligation is in

Nothing about a task's verdict. A story's obligations are served by several tasks, and
failing the first one for a criterion only the last can satisfy would make the criterion
unwritable. They run against the story — which owns the worktree (ADR-0006), so there is
exactly one tree and one commit to run them in — at `wecode verify <story>`, and at
`wecode close` when that exists. A run writes exactly one row per handle: `met` when every
criterion of that handle ran green, `unmet` otherwise. A `live:` criterion deferred by the
offline tier is not a pass, so it yields `unmet` naming the deferral.

`owed()` prints `met` or `open` today and gains a third state, because "the tasks are done
and nobody has run the criteria" is neither:

| | when |
|---|---|
| open | something unfinished still claims it |
| unproven | attempts answered it; no `met` row since the newest criterion was stated |
| met | attempts answered it, and `proven_at >= stated_at` |

`proven_at >= stated_at` is the whole freshness rule, and it makes the ratchet bite: a
restated criterion puts a met requirement back to `unproven` until it is run, which is
ADR-0005's reset rule arriving from the second direction. A requirement with no criteria
stays on the old two-state rule and prints the fact.

The comparison happens in `wecode-core`, not in the store or the render. Core opens no
database — `requirement.rs` says so, and that is why `requirement_is_met` is handed
`served_by` and a `Plan` rather than fetching them — so the fold hands out two integers and
core gains `requirement_state(served_by, plan, criteria, stated_at, proven_at) -> ReqState`,
a pure function beside the two-state one it replaces. The rule is then testable without a
database, which is where the reset rule's tests already are.

## What the build actually touches

| | |
|---|---|
| schema | **nothing.** No table, no column, no version bump: `docs/reference/schema.md`'s "version 14" and its table list stay true |
| governed pages | none. Four pages in the tree declare `subject:` — `board.md`, `front-matter.md`, `concurrency.md`, `liveness.md` — and none covers `audit.rs`, `requirement.rs`, `commands/plan.rs` or `verify.rs`, so the doc-freshness gate asks nothing here |
| `wecode help` | `--met-by` will not appear in it. The usage text is in `main.rs`, `commands.md` is that text verbatim and a test enforces it — the same limit `--requirement` and `--nfr` already sit under |

## The surface

No new command. `--requirement "<wording>"` on a story states the obligation; `--met-by
"<cmd>"`, repeatable, states the criteria in the same breath, and `wecode task add <story>
--amend --requirement <handle> --met-by "<cmd>"` — a story restating what it owes — adds
more later.

## What this makes harder

**A wrong criterion is permanent.** Append-only with no withdrawal means a typo that is a
valid command sits red for ever. The remedy is the one the class-segment work also reaches
for: restate the obligation and drop the old one — and `dropped`, ADR-0005's third state,
is still not reachable by anything. Two decisions now depend on that gap, which is the
argument for closing it next rather than a reason to soften either.

**`wecode audit` grows two row shapes whose detail is a command line and an exit count**
rather than a sentence. They render fine; they read oddly beside `require`'s wording.

## What would show this was decided wrong

If `unproven` becomes the resting state of every requirement in the tree — criteria stated
once at planning and never run — then the storage was never the missing part and the
criteria are decoration on a board nobody drives from.

If operators routinely want a criterion that no single command can settle, and start
writing shell one-liners that chain three checks to get past the restriction, then
`expect_status` and the other `Measure` variants were load-bearing after all, and the
honest answer was the fuller grammar `task_acceptance` already stores.

If the one-row-per-handle result turns out to be too coarse for ADR-0006's report — because
a reader wants each criterion's own exit code and not a count — then the result half should
have been one row per criterion, keyed `<handle>#<seq>`. The criterion half is unaffected
either way, which is why this is the cheaper mistake of the two to make.

## The room it has to land in

| file | lines | cap | headroom |
|---|---|---|---|
| `crates/wecode-store/src/audit.rs` | 1140 | 1700 | 560 |
| `crates/wecode-cli/src/verify.rs` | 1583 | 1700 | 117 |
| `crates/wecode-core/src/admission.rs` | 1679 | 1700 | 21 |
| `crates/wecode-cli/src/commands/plan.rs` | 694 | 1700 | ample |
| `crates/wecode-core/src/requirement.rs` | 70 | 1700 | ample |
| `crates/wecode-cli/tests/requirements.rs` | 124 | 1500 | ample |

`verify.rs` is the one to watch: acceptance reads the whole worktree, so a build task that
adds a hundred lines of story-verdict rendering there fails on the file it was working in.
The fold, both writers and the `Measure` construction belong in `audit.rs`, which has the
room; the state rule belongs in `requirement.rs`, which has all of it.
