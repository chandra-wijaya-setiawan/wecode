# What makes a story done, and what refuses it

Notes for `story-completeness-gate-design`. ADR-0006 §3 promised `wecode close <story>` —
a gate that "refuses while any requirement under the story is `open`" — and nothing was
built. What is decided here is the predicate, the one door it stands at, and why it
refuses where the same shape of check on a project only leaves a note.

## What settles a story today

Nothing does. Four pieces exist and none of them meet.

| piece | where | what it does |
|---|---|---|
| "an epic or a story is done when its children are" | `crates/wecode-core/src/task.rs:32` | a doc comment; no code reads it |
| `requirement_is_met` | `crates/wecode-core/src/requirement.rs:59` | derives the answer per obligation, correctly — and is called only by the `owed()` renderer |
| leaf progress | `crates/wecode-cli/src/board.rs:368` | a percentage on the board, from leaf statuses, never written back |
| `Defect::StoryOwesNothing` | `crates/wecode-core/src/admission.rs:83` | the one enforced story rule, and it stands at the front door |

A story's status is a column like any other, and `wecode status <story> done` writes it
(`plan/staff.rs:108`) with nothing checked but the `Staff` capability. The transition that
closes every other kind cannot reach a story: aggregating kinds are never dispatched and
never merged, so `merge`'s `set_task_status(&id, Done)` — downstream of acceptance, a
scope-checked diff and a signature — has no path to one. A story becomes done because
somebody typed that it was.

So a story can sit at `done` with three obligations nothing ever answered and a failed
child beneath it, and every surface will report it green. That is worse than a gap:
`StoryOwesNothing` already forces every story to state what it owes, so the ledger holds
the material to settle the question and no gate asks it.

## Complete is three clauses, derived

A story is complete when all three hold. They are computed from the plan and the ledger
at the moment they are asked, never stored — the reason is written on `requirement_is_met`
already and it is the same reason: a column recording completeness is a copy of what the
tasks say, and the two part company at the first task somebody moves by hand.

| clause | fails when | the repair |
|---|---|---|
| **owes something** | the story stated no obligation | state one — `--amend --requirement` |
| **every obligation answered** | nothing done answers it, or an open task still claims it | write the task, finish it, or drop the obligation |
| **nothing open beneath it** | a task under the story is neither `done` nor `dropped` | finish it, drop it, or re-parent it |

The second clause splits `requirement_is_met`'s single `false` into its two halves,
because the repairs are different work: *unanswered* wants a task written, *still claimed*
wants a task finished. A shortfall an operator cannot act on from its own wording is a
shortfall they have to go and reconstruct.

The third clause exists because not every task under a story serves a requirement — a
docs task, a cleanup, a spike — and the obligations alone would let the story close over
work still in flight. `is_closed()` is `Done | Dropped`, so a **failed** child blocks the
close, which is right: retries are exhausted and a person owes a decision either way.

The predicate belongs in `wecode-core::requirement`, beside the two functions it is made
of, and takes what core can name: the story, the plan, and `&[Owed { id, served_by }]` —
the ledger rows folded down to the two fields the answer needs, handed in by the command
that has a store. That is `check_requirement`'s existing seam and it holds for the same
reason: core reads no database.

An epic needs no second rule. Obligations belong to stories (ADR-0005), so an epic's own
obligation list is always empty and its completeness is its stories' — the first clause is
therefore asked of stories only, and the other two generalise unchanged.

## One door, and it is `close`

`wecode close <story>` is the checked transition and the only way a story reaches `done`.
`wecode status <story> done` starts refusing for aggregating kinds and names `close`
instead. Two doors to one transition is two answers to one question, and the unchecked one
would win every time somebody was in a hurry.

`status <story> dropped` stays legal and unchecked. The gate refuses a claim of success,
never an admission of failure: abandoning a story is a judgement an operator is entitled
to make, and it is the honest thing to type when the work is not going to happen.

Authority does not change — `Action::Staff`, as for moving any task. No new signature: the
merges underneath were each signed under the project's own policy, and asking for a second
one here would be a signature standing in for evidence that already exists.

`wecode check <story>` prints the same shortfalls without transitioning, the way it
re-runs the admission verdict without the save. The gate is something to consult, not only
to be refused by, and an operator asking "what is left on this story?" should not have to
attempt the close to find out.

## Why a refusal here, when a project only gets a note

Closing a project with open tasks prints a line and proceeds (`plan/staff.rs:69`):
"closing with work outstanding is a judgement the operator is entitled to make." The
asymmetry is deliberate and rests on one fact — a requirement has a first-class way to say
*we decided not to serve this*, and an open task under a project has none. Refusing where
the operator has nothing to type is a gate standing in front of work that is not allowed
to fix what fails it. Refusing where they can type one sentence is a gate asking them to
say which of the two things they mean.

That escape does not exist yet. `dropped` is named in ADR-0005 and nothing reaches it —
`requirement-kinds-design` took a dependency on the same hole. So it ships in this change:
`wecode requirement drop <handle> --why "<reason>"` appends a `drop` row beside `require`
and `serve`, and the fold in `Store::requirements` reads the newest row for a handle as
the current state, which makes a later `require` the restatement gesture for free.
The refusal is only legitimate with the escape it names, so the two land together or
neither does.

There is no `close --force`. A waiver at admission says *work on it anyway*; a forced
close would say *call it done anyway*, which is what `dropped` already says with a reason
attached and an author on it. The difference is that `--force` would put an unrecorded
claim into a generated report.

## Why not roll up on the last merge

The tempting alternative: `merge` closes the last child, recomputes the story, and sets it
done with nobody typing anything. It fails on the clause it would have to trust most —
the plan cannot tell *no more work* from *no work written yet*. A story with two tasks
where the second has not been declared would close the moment the first landed, and the
vacuous pass is the exact failure the empty-diff and empty-check rules elsewhere in this
tree exist to refuse. Only a person knows the decomposition is finished. The transition
therefore stays explicit and the gate checks it, which is also what keeps the report a
receipt for a deliberate act rather than a side effect of a merge aimed at something else.

## What it was decided against

| instead | why it loses |
|---|---|
| a `Divergence` note on `status <story> done` | advice is for calls an operator is entitled to make; a story reported done over an unanswered obligation is not a call, it is the thing the requirement rows were added to prevent |
| a `complete` column on the story, written when the last child lands | a copy of what the tasks say, out of step at the first hand-moved task — `requirement_is_met`'s own argument |
| a new `Defect` on the admission gate | admission asks whether work may *start*; this asks whether it may *stop*, and folding them would refuse dispatch on an unfinished story, which is every story |
| rolling up automatically on the last merge | cannot distinguish an empty child list from a decomposition nobody finished |
| adding a fresh design digest as a fourth clause | the digest proves what was signed and the doc-freshness gate already refuses a diff that moves it; a second reader of one fact is the drift this repo keeps refusing |
| `close --force` | an unrecorded claim in a generated report, where `dropped --why` is a recorded one |

## The receipt

ADR-0006 §2 makes `report_as_finished.md` generated, never authored, and this is the
command that emits it — the join of requirements × the tasks that served them × their runs
× acceptance results, on the merge record's existing renderer and shape. Emitted only on a
close that passed, so the document's existence is the proof: a report cannot be produced
for an incomplete story, and there is nothing else to produce it. The story's design
document is cited by path and digest rather than restated.

## The room it has to land in

| file | lines | cap | note |
|---|---|---|---|
| `crates/wecode-core/src/requirement.rs` | 70 | 1700 | `Owed`, `Shortfall`, the predicate |
| `crates/wecode-store/src/audit.rs` | 1140 | 1700 | the `drop` row and the fold |
| `crates/wecode-cli/src/commands/plan/staff.rs` | 209 | 1700 | the redirect |
| `crates/wecode-cli/src/main.rs` | 257 | 1700 | `("close", _)` — and `wecode-cli` has no lib target, so a command not wired here is dead code under `-D warnings` |
| `crates/wecode-cli/tests/requirements.rs` | 124 | 1500 | where the existing requirement tests are |

`close` itself is a new module under `commands/plan/`, not another 200 lines in
`plan.rs` (694) — the directory was split for this. Acceptance reads the whole worktree,
so the build task's write scope has to cover `main.rs` or the command it adds cannot
compile.

## What would show this was decided wrong

Operators typing `wecode status <story> dropped` to get past a close they could not
satisfy. That would mean the third clause is too strict — that stories routinely carry
side work nobody intends to finish — and the answer would be to scope the clause to tasks
that serve an obligation and let the rest be listed rather than blocking.

Or: nobody ever runs `close`. Stories would then be a planning device that no one settles,
the report would go unwritten, and the honest reading is that completeness wanted to be
a question the board asks continuously rather than a gate one command holds.
