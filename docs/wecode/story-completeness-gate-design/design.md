# A story is complete by arithmetic, and closed by a person

Decided: completeness is a **derived predicate** — three clauses, computed in
`wecode-core::requirement` and never stored — enforced at exactly one door.
`wecode close <story>` refuses while any clause fails, records the closure when none
does, and emits the story's report as its receipt. `wecode status <story> done` starts
refusing for aggregating kinds and names `close` instead. ADR-0006 §3 promised this gate
and nothing was built.

## What settles a story today

Nothing does. Four pieces exist and none of them meet:

| piece | where | what it does |
|---|---|---|
| "an epic or a story is done when its children are" | `wecode-core/src/task.rs:34` | a doc comment; no code reads it |
| `requirement_is_met` | `wecode-core/src/requirement.rs:59` | derives the answer per obligation, correctly — called only by the `owed()` renderer |
| leaf progress | `wecode-cli/src/board.rs:367` | a percentage on the board, never written back |
| `Defect::StoryOwesNothing` | `wecode-core/src/admission.rs:83` | refused nowhere |

That last row is the one to check, because it is the fact the rest of this rests on.
`check_requirement` has two callers and neither is a gate: `plan.rs:467`, on the branch a
story never takes — `requirement_asked` returns `Declared` at `plan.rs:443`, before the
check — and `plan.rs:585`, the `owed()` renderer, which prints it as a `⚠` question.
`check_task`, the admission gate proper, returns early for aggregating kinds
(`admission.rs:305`). So a story that states no obligation is admitted, staffed and
worked, and the only surface that mentions it is one somebody chose to run.

Above that, `wecode status <story> done` writes the column with nothing checked but the
`Staff` capability (`plan/staff.rs:98`–`107`). The transition that closes every other
kind cannot reach a container: `merge`'s `set_task_status(&id, Done)` sits downstream of
acceptance, a scope-checked diff and a signature, and nothing dispatches or merges an
aggregating kind. A story is done because somebody typed that it was — over three
unanswered obligations and a failed child, if that is how it stands.

## Complete is three clauses

| clause | fails when | the repair |
|---|---|---|
| **there is something to be complete about** | a story states no obligation; an epic has no child | state one — `--amend --requirement`; or decompose it |
| **every obligation is answered** | its state is anything but met | write the task, finish it, run the criteria, or drop the obligation |
| **nothing open beneath it** | a descendant is neither `done` nor `dropped` | finish it, drop it, or re-parent it |

Clause 1 generalises rather than being asked of stories only. An epic with nothing under
it passing green is the vacuous pass that the empty-diff and empty-check rules elsewhere
in this tree exist to refuse, with a whole objective's name on it — and ADR-0005 puts
obligations on the story, so an epic can never answer clause 1 on its own account.

Clause 3 exists because not every task under a story serves a requirement — a docs task,
a cleanup, a spike — and the obligations alone would let a story close over work still in
flight. `is_closed()` is `Done | Dropped`, so a **failed** child blocks the close, which
is right: retries are exhausted and a person owes a decision either way.

The canon calls clause 2 the conditions of satisfaction (Cohn, *User Stories Applied*,
2004, ch. 6) and asks a team to check them by hand at a review. Scrum's Definition of
Done is the same checklist one level up, held per team rather than per story. wecode's
difference is 12207's: each condition is already a record, so the checklist is a query
and a gate can hold it.

## The gate does not derive an obligation's state

```rust
pub struct Owed { pub handle: String, pub state: ReqState, pub served_by: Vec<TaskId> }
pub fn shortfalls(t: &Task, plan: &Plan, owed: &[Owed]) -> Vec<Shortfall>
```

`ReqState` is folded by whoever reads the ledger and handed in — `check_requirement`'s
existing seam, for its reason: core reads no database. Today the caller gets it from
`requirement_is_met`; that this gate never calls it itself is what makes one seam serve
three decisions in flight:

| that design | what it changes | what this gate does about it |
|---|---|---|
| acceptance criteria as rows | adds `unproven` between open and met | refuses it, with *run the criteria* as the repair |
| typed delivery links | changes which attempts count as an answer | nothing |
| requirement kinds | classifies the wording | nothing |

A `Shortfall` per failing clause, not one boolean: *unanswered* wants a task written and
*still claimed* wants a task finished, and a refusal an operator cannot act on from its
own wording is one they have to go and reconstruct.

## One door, and it is `close`

`wecode close <story|epic>` is the checked transition and the only way an aggregating kind
reaches `done`. Two doors to one transition is two answers to one question, and the
unchecked one wins every time somebody is in a hurry. No test in the tree moves a story or
an epic through `status`, so the refusal costs nothing to add.

`status <container> dropped` stays legal and unchecked. The gate refuses a claim of
success, never an admission of failure. Authority is `Action::Staff`, as for moving any
task; no new signature, since the merges underneath were each signed under the project's
own policy and a second one here would stand in for evidence that already exists.

`wecode check <story>` prints the same shortfalls without transitioning, the way it
re-runs the admission verdict without the save. An operator asking what is left should not
have to attempt the close to find out.

## The escape the refusal depends on

Refusing where the operator has nothing to type is a gate standing in front of work that
is not allowed to fix what fails it. Clause 2's escape is ADR-0005's third state, and
nothing reaches it — `docs/reference/commands.md:240` says so, and two other designs in
this wave have already taken a dependency on the same hole.

So it lands first, in this story, and the gate lands behind it:
`wecode task add <story> --amend --drop <handle> --why "<reason>"` — a third `Stated`
variant (`plan.rs:400`) writing a `drop` row beside `require` and `serve`, and the fold in
`Store::requirements` (`audit.rs:615`) reading the newest row per handle as the current
state. A later `require` restating the handle then reopens it for free. Not a
`wecode requirement` command group: there is no such group, and an obligation is stated on
the amend path today.

## Complete is not closed

`docs/wecode/planning-lifecycle-stages-design/design.md` folds a container's planning
stage out of the same records and derives a top rung it calls `closed`, refusing `done` on
a container outright. One rung has to move, and this is the amendment: the derived reading
is **complete**, and **closed** is complete plus the column this command writes.

What `close` adds is not in the records — *no more work is coming*. That is the same fact
an automatic rollup on the last merge cannot have, and it is a decision, so it is stored.
The two designs then share one function: the ladder's rung is `shortfalls()` returning
empty, and the gate is `shortfalls()` returning anything.

Closure is therefore not final, and the reading is the half that can fall. File a bug
against a closed story and the obligation reopens by ADR-0005's arithmetic while the
column still says `done`. Decided: the column is not rewritten and nothing is refused —
it surfaces as a `Divergence`, the advisory tier this repo already has for a call an
operator is entitled to make, naming the obligation and when the story was closed. `close`
may be run again, and a second report at the same path is a later commit.

## The receipt

ADR-0006 §2 makes the story's report generated, never authored, and this is the command
that emits it: the join of obligations × the tasks that served them × their runs ×
acceptance results, on `record.rs`'s renderer and shape. Committed by
`git::commit_file(repo, scratch, target, …)` — `record::keep`'s own path (`record.rs:93`),
because the story's worktree comes down when its last task lands. It goes to
`docs/wecode/<story>/report.md`, beside the design, and cites each child's
`docs/wecode/<task>/report.md` by path rather than restating it.

Emitted only on a close that passed, so the document's existence is the proof: a report
cannot be produced for an incomplete story, and there is nothing else that produces one.

## What it was decided against

| instead | why it loses |
|---|---|
| a `Divergence` on `status <story> done` | advice is for calls an operator is entitled to make; a story reported done over an unanswered obligation is the thing the requirement rows were added to prevent |
| a `complete` column, written when the last child lands | a copy of what the tasks say, out of step at the first hand-moved task — `requirement_is_met`'s own argument |
| a new `Defect` on the admission gate | admission asks whether work may *start*; this asks whether it may *stop*, and folding them would refuse dispatch on every unfinished story |
| rolling up automatically on the last merge | the plan cannot tell *no more work* from *no work written yet*, so a story whose second task is undeclared closes when the first lands |
| deriving `ReqState` inside the gate | a second reader of a rule three designs in flight are each changing |
| a fresh design digest as a fourth clause | the doc-freshness gate already refuses a diff that moves it |
| `close --force` | an unrecorded claim in a generated report, where `--drop --why` is a recorded one |

## What this costs

**Clause 1 turns a printed question into a refusal.** Every story in an existing
workspace that owes nothing can be worked but not closed, and the first week of this reads
as the tool being wrong about work somebody knows is finished. The repair is one sentence
typed, which is the point of the clause.

**Nothing runs the criteria.** Until acceptance criteria are records, clause 2 is a claim
about attempts, not about the obligation — the gate is exactly as strong as
`requirement_is_met`, which is stronger than a typed column and weaker than the word
*complete* suggests.

**Two commands are the wrong shape for a shell.** `close` exits non-zero on a shortfall,
so a script that closes an epic's stories in a loop stops at the first incomplete one with
no summary of the rest. `check` is the answer and the refusal says so.

## The room it has to land in

| file | lines | cap | what goes there |
|---|---|---|---|
| `crates/wecode-core/src/requirement.rs` | 70 | 1700 | `Owed`, `Shortfall`, `shortfalls` |
| `crates/wecode-store/src/audit.rs` | 1140 | 1700 | the `drop` row and the fold |
| `crates/wecode-cli/src/commands/plan.rs` | 694 | 1700 | the third `Stated` variant |
| `crates/wecode-cli/src/commands/plan/close.rs` | new | 1700 | the gate, the report, the commit |
| `crates/wecode-cli/src/commands/plan/staff.rs` | 209 | 1700 | the redirect |
| `crates/wecode-cli/src/main.rs` | 257 | 1700 | `("close", _)` and `USAGE` |
| `crates/wecode-cli/tests/requirements.rs` | 124 | 1500 | where the requirement tests are |
| `docs/reference/commands.md` | 719 | — | `tests/workspace.rs:626` asserts its fenced block *is* `wecode help` |

`close` is a new module under `commands/plan/`, not another 200 lines in `plan.rs` — the
directory was split for this. Two scope traps, both named in `.wecode/playbook.toml`: the
build task must declare `docs/**`, or the commands.md line it is forced to move fails the
scope check after the work is done; and `wecode-cli` has no lib target, so a `close`
module not wired into `main.rs` is dead code under `-D warnings`.

## What would show this was decided wrong

Operators typing `status <story> dropped` to get past a close they could not satisfy.
Clause 3 would then be too strict — stories routinely carry side work nobody intends to
finish — and the answer is to scope it to tasks that serve an obligation and list the rest.

Or: nobody ever runs `close`. Stories would be a planning device no one settles, the
report would go unwritten, and the honest reading is that completeness wanted to be a
question the board asks continuously rather than a gate one command holds.
