# 012 — A task names the worktree it is worked in, and a forced task can still be dispatched

**Task:** TBD · **Branch:** `wecode/012-task-worktree-binding` · **Target:** `main`

Execution state is tracked in `report_as_finished.md`. This document is the contract.

## 1. Requirement summary

Two defects, found the same afternoon on the STETSS lakehouse, both of which cost real tokens
and produced work that had to be redone by hand.

**A task does not say which worktree it belongs to.** `s54-strip-bom` was dispatched and
rejected in 77 seconds having spent 36,093 tokens. Its rejection reads *"re-read outside
scope: `.wecode/playbook.toml`, `config/lakehouse/gold_semantic.yaml`"* — and
`config/lakehouse/gold_semantic.yaml` does not exist anywhere on the machine. The agent was
looking for a file that belongs to a different ticket, which is what happens when the tree it
lands in is not the tree the task was written against. This has happened before and is
recorded as a standing hazard: *ticket tasks keep landing in the wrong worktree; check the
acceptance path exists before working.*

**`--force` produces a task that can never be worked.** The admission gate refused six tasks
over write-scope overlap; each was forced, each recorded its waiver, and each became a
**draft**. Dispatching one returns `a draft cannot be worked on`. So the escape hatch for a
gate that is too strict produces a task the dispatcher will not touch — the work is recorded,
scheduled, blocked, and silently undispatchable.

Both are permanent changes to the task record and the dispatcher.

## 2. Architecture

TBD — the change is confined to the task store, the admission gate and `wecode start`.

## 3. Requirement details

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-12-01 | task record | A task carries a `worktree` naming the tree it is worked in. It is **mandatory** at `task add`. |
| FR-12-02 | task add | `task add` refuses a `worktree` that does not resolve to a directory, naming the path it tried. |
| FR-12-03 | task add | `task add` refuses a task whose acceptance command references a path absent from its worktree, for the same reason the gate checks scope: the failure is cheap now and expensive after dispatch. |
| FR-12-04 | dispatcher | `wecode start` and `wecode run` work the task in its declared `worktree`, and refuse rather than guess when the tree is missing. |
| FR-12-05 | dispatcher | A run that reads outside its worktree is rejected with the tree it was in, not only the paths it touched. The current message names the paths and leaves the reader to infer the tree. |
| FR-12-06 | admission | A forced task is admitted, not drafted. The waiver is the record that the gate was overridden; leaving it a draft overrides the override. |
| FR-12-07 | admission | Where forcing should still block dispatch, `task add` says so at the point of forcing, rather than at `run` an hour later. |
| FR-12-08 | task edit | `wecode task edit <id> --after <task>` exists, so an ordering discovered after creation does not require `task rm` and a full re-add. |

**Non-functional**

| ID | Component | Requirement |
|---|---|---|
| NFR-12-COST-01 | dispatcher | A task that cannot be worked costs nothing. Both defects were paid for in agent tokens: 36,093 on one rejected run, and six tasks scheduled that no dispatcher would pick up. |
| NFR-12-DOC-01 | help | `--force`'s help states what the task becomes. It currently says defects are "recorded as waivers" and does not say the task is drafted. |

## 4. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | One task belongs to exactly one worktree | A task spanning trees needs a list, and the scope check needs to know which tree each glob belongs to |
| A2 | The worktree is knowable at `task add` | If a tree is cut later, `worktree` has to be settable before dispatch rather than at creation |

## 5. Evidence

```
x bug s54-strip-bom  #512
  runs (2, 1 stated rather than metered)
  #1  rejected  77s  36093t  re-read outside scope: .wecode/playbook.toml,
      config/lakehouse/gold_semantic.yaml; uv run pytest app/lakehouse -q — exit 4, wanted 0
```

`config/lakehouse/gold_semantic.yaml` exists in no worktree on the machine.

```
$ wecode run g75-student-performance-fact
  ⚠ 2 defects — not admitted
  1  Write scope "…/gold_model.json" overlaps task `g76-checkpoint-capture`
  a draft cannot be worked on
```

The overlap is on a **generated** file, against two tasks that are themselves blocked and
cannot run concurrently with anything. The gate reasons statically and cannot see that.
