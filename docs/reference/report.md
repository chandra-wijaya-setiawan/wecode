---
class: hand-tended
subject:
  - crates/wecode-cli/src/record.rs
  - crates/wecode-cli/src/render/report.rs
---

# Reports

Two documents, both generated, both filed in `docs/wecode/<id>/report.md` on the
integration branch. An agent's account of its own work is inadmissible everywhere else in
wecode, and a file it could have written would be inadmissible here too.

| document | written when | built from | renderer |
|---|---|---|---|
| merge record | a task's branch lands | git's numstat, the plan, wecode's record of the run | `record::merged` |
| the same, before the fact | a signature is asked for | the tree so far, minus every fact a merge creates | `record::proposed` |
| story completion | a story closes (ADR-0006) | the ledger and the plan; no diff, no agent | `render::report::story` |

`docs/wecode/<story>/` therefore ends up holding exactly the two documents ADR-0006 leaves
standing: one `design.md` somebody wrote and signed, one report nobody could have written.
`wecode show <id>` reads whichever is there off the branch — the file, not a re-render.

## What closes a story

`wecode close <story>` is a gate, not a status change. It closes only when **every
obligation the story stated is answered**, and each answer carries its evidence.

| answer | what it means | the evidence |
|---|---|---|
| `met` | something finished against it and nothing open still claims it | the attempts that landed |
| `dropped` | every attempt is closed and none finished — a decision not to serve it | the dropped attempt |
| `open` | nothing has answered it, including *nothing ever tried* | none, which is the point |

`met` is `wecode_core::requirement::requirement_is_met` and not a second reading of it, so
ADR-0005's reset holds at the far end of the work too: a bug opened against an obligation
the story once met puts it back to `open`, and the story does not close.

A story that stated **no** obligation does not close either. That is not a gap to fill in
later — an obligation is what a story is for, so a container with none is one whose
completion nothing can settle. Core says the same thing to a planner as
`Defect::StoryOwesNothing`.

## What the report says

One document either way. A story that cannot close gets this same report with `OPEN` on
the first line and a `not closed` line naming what is unanswered — a refusal rendered
separately would be a second account of one state, and it would eventually disagree with
the receipt.

| section | holds |
|---|---|
| the first line | `CLOSED` or `OPEN`, the story's id, its title |
| `summary` | `owes`, `tasks`, `spend`, `refused`, and `not closed` where it did not |
| `requirements` | each handle, its answer, then each attempt and what it was held to |
| `also under it` | work under the story answering to no obligation — a design task, usually |
| `provenance` | the rows it was read out of |

Rules the shape rests on:

- **Handles, never wordings** (ADR-0006 §4). A requirement's text lives in the row that
  stated it. A generated document holding a second copy is a copy nobody can correct.
- **A tick is a claim.** `✓` beside an acceptance command means it passed, so only an
  attempt that finished gets one; everything else is listed with `·`. A person's task ran
  no command and shows its signature instead.
- **Absent, not zeroed.** `spend` and `refused` are omitted when the ledger holds no such
  row for the story. `0 tokens over 0 runs` reads as a measurement and would mean the
  opposite.
- **The spend figure is the harness's.** There is nothing between an agent and a model for
  wecode to count tokens at, so the line says whose number it is. The count of runs beside
  it is wecode's own.
- **A removed attempt is not a claim.** `wecode task rm` erases work that never ran;
  counting one would hold an obligation open for ever.

## See also

`docs/adr/0005-requirements-are-records.md` · `docs/adr/0006-story-owns-the-worktree.md` ·
`docs/design/living-docs.md` on why a generated document cannot go stale ·
`docs/reference/commands.md` for what each command does.
