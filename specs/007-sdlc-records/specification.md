# 007 — SDLC artifacts are records the store owns, not files a tool greps

**Task:** #<number> `sdlc-records` · **Branch:** `wecode/sdlc-records` · **Target:** `main`

Execution state is tracked in `report_as_finished.md`. This document is the contract.

## 1. Requirement summary

Requirements, design and decisions become **typed records in the store**, linked to each other
and to tasks. Markdown becomes their serialization: exported on demand, committed, and git holds
the history. All permanent — this is doctrine `66b0958` applied to the artifacts it named.

**What forced it.** `scripts/report_from_wecode.py` recovers a requirement from a task id:

```python
TASK_ID = re.compile(r"^t(?P<issue>\d+)-(?P<sort>fr|nfr)-(?P<rest>.+)$")
```

That is grep, and doctrine `66b0958` says gates consume fields rather than grep. It also cannot
model reality: **one requirement takes several tasks**, a rework task serves a requirement that
already passed, and some tasks serve none. Many-to-many does not fit in one id. Observed on the
STETSS project — a report rendered "1 of 13" and "4 of 25" after tasks were renamed, and the
pattern silently stopped matching. Nothing failed; the numbers were just wrong.

## 3. Requirement details

Provisional and slice-local.

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-07-01 | store | A requirement is a record — id, type (`fr`/`nfr`), text, baseline, state — owned by a task of kind `story` |
| FR-07-02 | store | A task declares the requirements it serves; the link is many-to-many |
| FR-07-03 | store | A requirement's state is **derived** from the tasks serving it, never stamped |
| FR-07-04 | store | Creating a task against a satisfied requirement reopens it, and the record keeps that it was satisfied before |
| FR-07-05 | store | A design record is owned by a task of kind `story`, one per story |
| FR-07-06 | store | An ADR is a record owned by the **repository**, not a story, and carries supersede edges |
| FR-07-07 | store | An ADR may link to the requirements it governs |
| FR-07-08 | export | Each record type exports to markdown at a declared path |
| FR-07-09 | export | The export is one-way: the store is written, the file is generated |
| FR-07-10 | report | The requirement-status table is generated from the links, not from task ids |
| FR-07-11 | template | The markdown a record exports to is produced from a **template**, not from formatting hardcoded in the exporter |
| FR-07-12 | template | Templates resolve project-first: the project's own template if it declares one, else the workspace default, else the one shipped with wecode |

**Non-functional**

| ID | Component | Requirement |
|---|---|---|
| NFR-07-INTEG-01 | store | A link to a requirement that does not exist is refused at write time |
| NFR-07-INTEG-02 | store | An accepted ADR record is immutable; superseding writes a new record and an edge |
| NFR-07-CI-01 | export | A round-trip check regenerates from the store and fails when the committed markdown differs |
| NFR-07-MIG-01 | migration | Existing hand-written `requirements.md` files import without loss of baseline history |

## 4. Acceptance criteria

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | A requirement served by three tasks reports one state | FR-07-02, FR-07-03 | Register three tasks against one requirement; the table shows one row |
| AC-2 | A rework task reopens a satisfied requirement | FR-07-04 | Satisfy it, add a task, assert the state and that the history survives |
| AC-3 | An unknown requirement is refused | NFR-07-INTEG-01 | `--serves FR-99-99` is rejected, naming it |
| AC-4 | An accepted ADR cannot be edited | NFR-07-INTEG-02 | The write is refused; superseding is the only path |
| AC-5 | A hand-edited export is caught | NFR-07-CI-01 | Edit the markdown, run the check, it fails naming the file |
| AC-6 | The report needs no id convention | FR-07-10 | A task named for its work reports against the requirement it serves |

## 5. Technical component details

### 5.1 Why the story is the owner

Two stories never write the same record, because a story is already pinned to its own branch by
`--onto`. So `#54`'s design and `#75`'s design are **different rows**, not two versions of one,
and nothing needs merging. Branch divergence is expressed as per-story rows — which is why this
model does not need the store to understand branches.

### 5.2 Owners, and why they differ

| Record | Owner | Why |
|---|---|---|
| requirement | story | It is that story's contract; baselines differ per story |
| design | story | One design per slice, edited by one story |
| task → requirement | many-to-many | One requirement takes several tasks; a task may serve none |
| **ADR** | **repository** | A decision routinely governs several stories at once. STETSS ADR 0013 governs four |

### 5.3 The store is latest; git is history

The record holds the current text. Exporting and committing makes the commit the version, which
is what a hand-maintained baseline-history table is doing today.

### 5.4 Where a template lives, and why not in the consuming repository

A template is the shape of an exported document, so it belongs with the exporter, not with the
thing exported. Today every consuming repository carries its own copy — STETSS has four under
`specs/_TEMPLATE-*.md` and this repository has its own — and six worktrees of one repository each
carried a copy of the playbook, which diverged silently until someone diffed them.

Three levels, most specific winning:

| Level | Path | For |
|---|---|---|
| project | declared by the project record | A project whose documents genuinely differ |
| workspace | `~/.wecode/workspaces/<org>/templates/` | The house style across an org's projects |
| built-in | shipped with the binary | What a new workspace starts from |

The consuming repository holds **no** template, because it holds no authority over the shape of
a generated file. What it holds is the export, and the round-trip gate keeps that honest.

This is the same argument as the records themselves, one level up: a template copied into six
places is six copies with no check between them.

### 5.5 What the supersede edge buys

Today a supersede is a hand-edited `Status:` line, so nothing prevents ADR 0012 claiming 0013
superseded it while 0013 never mentions 0012. As an edge the chain cannot contradict itself, and
"what is the current decision on X" becomes a query rather than four files read in order.

## 6. Out of scope

- **Locking a design record against concurrent edits.** Two people editing one story's design is
  last-write-wins here, where git would have raised a conflict. Deferred by the operator, and
  recorded in §7 rather than solved.
- Storing ADR *prose* differently from any other record — it is text like the rest.
- Anything about how markdown is rendered.

## 7. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | A story owns exactly one design | A second design per story needs a section-level record, which is additive |
| A2 | Last-write-wins is acceptable for a team of three | Needs the record lock §6 defers. The failure is silent: one person's edit disappears |
| A3 | Existing `requirements.md` files can be parsed into records | Migration becomes manual; the tables are regular enough that this looks safe |
| A4 | Requirement ids stay unique within a story | They are today (`FR-54-nn`); a project-wide baseline would need re-scoping |
| A5 | Three levels of template resolution are enough | A fourth — per story — would mean two stories in one project exporting different shapes, which is a divergence rather than a need |

## 8. Decisions

| Decision | Justification | Reference |
|---|---|---|
| Records, not id parsing | Doctrine `66b0958`: gates consume fields rather than grep | §1 |
| Requirement state derived, never stamped | A stamped state lies the moment rework starts — observed on STETSS FR-54-09, which read "built" while a task existed to fix it | FR-07-03 |
| ADR owned by the repo, not a story | A decision spans stories; filing it under one is arbitrary | §5.2 |
| One-way export with a round-trip gate | Two writers on one artifact is the defect STETSS #76 is built around; do not build it in here | NFR-07-CI-01 |
| Baseline is a column | Raising a baseline is a deliberate act. Without the field, a requirement would just change | FR-07-01 |
| Templates resolve project → workspace → built-in | Projects differ; a single global template forces the wrong shape on one of them, and a per-repository copy is the divergence this whole spec exists to remove | §5.4 |

## 9. References

- `66b0958` — SDLC artifacts are typed records; markdown is the serialization, git the transaction log
- `scripts/report_from_wecode.py` — the id-parsing this replaces
- ADR-0004 — epic and story as aggregating kinds
- STETSS `specs/54-silver-layer-definition/` — the worked example these records must reproduce
