---
class: record
---
# ADR-0005: Requirements, designs and decisions are store records

Status: accepted (1 Sep 2026) · owner's model, one amendment (§Designs)

## Context
ADR-0004 gave the tree aggregating kinds (epic, story). The SDLC artifacts were
still all at task level: one `specification.md` per task carried FR/NFR/AC AND
implementation detail, so a 20-line fix was asked for a requirements document,
and nothing could answer "which tasks served this requirement?" — the
traceability gap named in docs/design/sdlc.md.

## Decision — the shape
    requirements(id, story_id → task.id, type FR|NFR, description, status)
      status: open | done | dropped                     1 story : many requirements
    task.requirement_id → requirements.id              many tasks : one requirement
    designs(story_id → task.id, path, decided_at, signed_by, digest)   1 : 1
    adrs(id, repo, title, status, supersedes, path, digest)   repo level

Rules:
- A requirement belongs to a STORY. Its wording is the contract; tasks are
  attempts at it.
- Many tasks may reference one requirement — rework, a bug against it, a
  changed design. That is the point: the history of an obligation is visible.
- **Creating a task against a requirement RESETS that requirement to `open`.**
  A requirement is only done while nothing open references it, so rework
  cannot silently land against a closed requirement.
- `dropped` is a first-class end state: a requirement we decided not to serve
  is answered, not forgotten.

## Designs — the amendment
The owner's model synced design.md's VALUE into a column. That is two copies of
one definition, which this repo's own rule forbids. Instead: the table holds the
RECORD (story, path, when decided, who signed, content digest); git holds the
prose, where review, diff and history already live. Drift is then DETECTED, not
synced — a file that moves without its record failing the digest check is
exactly the doc-freshness gate's shape (ADR-0001's move again: the key is the
freshness proof).

ADRs follow the same split: the table is the index (id, status, supersedes),
`docs/adr/*.md` is the text.

## Consequences
Traceability becomes a join rather than a discipline: story → requirements →
tasks → acceptance commands. `plan.md` shrinks to the epic list, so it stops
rotting. Cost: a store migration, `--requirement` on task creation, and the
reset rule in one place. Risk: requirement wording drifting from the story's
title — the digest guards the design, nothing yet guards that, and the first
person to notice should file it.
