---
class: record
---
# ADR-0006: A story owns the worktree, and its report is generated

Status: accepted (1 Sep 2026)

## Context
Read against the wt-53 slice, which has the three documents this model replaces:
`requirements.md` (FR rows + `Status: Agreed` as prose), `design.md`, and a
466-line `report_as_finished.md` whose §2 RESTATES every FR id and description
and adds `yes | yes` verdicts. Three documents, three copies of one state, no
gate joining them — so they drift, and the owner (rightly) hates them.

## Decision
1. **The worktree belongs to the STORY, not the task.** Every task under a
   story shares its checkout and branch, lands on one merge signature, and
   costs one build no matter how many tasks it holds. (The playbook already
   said this for parent/subtask sprints; a story IS that parent.)
2. **`report_as_finished.md` is GENERATED, never authored** — the join of
   requirements × tasks × runs × acceptance results × `git diff --numstat`.
   A generated document cannot be stale (living-docs.md's first class).
3. **`wecode close <story>`** is the final gate: it refuses while any
   requirement under the story is `open`, emits the report when every one is
   `done` or `dropped` WITH EVIDENCE, and the report is its receipt.
4. Requirement text lives in ONE place — the `requirements` rows (ADR-0005).
   Nothing restates it; the report references ids and joins.

## Consequences
Per story, exactly one hand-written artifact survives: `design.md` (prose in
git, digest in the record). Everything else is rows or generated. Cost: the
report generator must render the same shape the wt-53 template established, or
readers lose a format they trust. Risk: a story that grows too large now
serialises its tasks in one worktree — the same tradeoff sprints already make,
and the reason a story should be one user-visible capability, not an epic.
