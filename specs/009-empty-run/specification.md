# 009 — A run that could not write is distinguished from one that chose not to

**Task:** `empty-run-vs-blocked-write` · **Branch:** `wecode/empty-run-vs-blocked-write`
· **Target:** `master`

Execution state is tracked in the merge record. This document is the contract.

## 1. Requirement summary

`verify` reads one bool off an empty diff — `Changed::delivered_nothing`, *a write scope was
declared and nothing is there*. Every empty run that was owed a diff therefore gets one
sentence and one status, and two runs that need opposite things get the same line:

- the agent finished, and put nothing in the tree — **it chose not to write**;
- the agent was killed, refused its tools, or never started — **it could not write**.

The first wants its instruction changed. The second wants its log read, and retrying it on a
better prompt buys the same empty tree a second time at full budget.

**The evidence is the worker area, and it is already in the tree.** Every envelope ends by
telling the agent to write `.wecode/run/result.json`, and `exec::worker_area` makes that
directory, empty, before the process starts. A run that left something there reached the end
of its envelope. A run that left nothing there did not get that far. Neither reading opens
the file: *a report exists* is wecode's observation of a directory it prepared, where *what
the report says* is the agent's account of itself and stays inadmissible.

Splitting the area out of the diff closes a second hole in the same place. The report is a
changed file, so `is_empty()` counted it, so a run that wrote nothing but the file it was
ordered to write had a non-empty diff, `delivered_nothing` false, green acceptance, and a
clean path to a merge. It could answer *did it do anything* by doing exactly what it was told
and nothing else. The toy fixture reproduces it, because it does not gitignore `.wecode/run/`.

## 2. Architecture

`crates/wecode-cli/src/verify.rs` only. One new type, `Empty`, one new observation,
`left_a_report`, and two sentences in the render that already existed as one.

## 3. Requirement details

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-09-01 | `Changed` | The worker area is not the work. Its paths are held out of `paths` and `delegated`, so they are never listed as a delivery and never count toward one. |
| FR-09-02 | `left_a_report` | Whether the run left anything in the worker area, read off the diff **and** off the disk — a repository that gitignores `.wecode/run/` keeps the report out of git entirely. The file is never opened. |
| FR-09-03 | `Empty` | An empty diff has three readings: `Delegated` (its steps wrote), `Reported` (it reported and wrote nothing), `Silent` (nothing anywhere, its report included). |
| FR-09-04 | `verdict` | The diff header and the failure conclusion each say which reading applies. `Silent` says the run was stopped or refused before it could write, and points at the log rather than the prompt. |
| FR-09-05 | `delivered_nothing` | Unchanged in meaning: `Reported` and `Silent` both fail, `Delegated` does not. The reading moves the sentence, never the verdict. |

**Non-functional**

| ID | Component | Requirement |
|---|---|---|
| NFR-09-EVID-01 | `verify` | No path added here reads an agent's self-report. The whole module still judges from what it observed. |
| NFR-09-SAFE-01 | `verify` | No task that passed before passes differently, except one that delivered only its own report — which was the defect. |

## 4. Acceptance criteria

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | A run that wrote only its report is failed, with `diff — 0 files` and the report unlisted | FR-09-01, FR-09-05 | `tests/cli.rs::an_agent_that_wrote_only_its_own_report_delivered_nothing` |
| AC-2 | A run that wrote nothing at all is reported as stopped rather than idle | FR-09-03, FR-09-04 | `tests/cli.rs::an_agent_that_left_no_trace_at_all_is_reported_as_stopped_rather_than_idle` |
| AC-3 | Neither reading borrows the other's sentence | FR-09-04 | `tests/cli.rs::the_two_empty_runs_do_not_borrow_each_others_sentence` |
| AC-4 | A run that wrote code earns the tick and is neither reading, report or no report | FR-09-01, NFR-09-SAFE-01 | `tests/cli.rs::a_run_that_wrote_code_is_neither_of_them` |

Proven end to end rather than in a unit test: the claim is that wecode tells the two apart
without asking either one, which needs a real agent process against a real worktree.

## 5. Out of scope

`crates/wecode-cli/src/spawn.rs` was in this task's write scope and is untouched — see A2.
Reading the harness's refusals out of the run's own stream is the sharper instrument and is
the obvious next slice; this one uses only what the tree already carries.

## 6. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | The worker area is wecode's to interpret: it makes the directory empty before every attempt, so anything in it is that run's | `git clean -fd` leaves ignored files alone, so on a retry a previous attempt's report can survive and read as this one's. The ambiguity falls to `Reported`, the quieter of the two findings, and moves no verdict. Exact on a first attempt |
| A2 | `spawn.rs` cannot be edited by a task scoped as this one is | `docs/design/liveness.md` declares `subject: crates/wecode-cli/src/spawn.rs` and is outside the write scope, so any diff touching `spawn.rs` is refused by the freshness gate and cannot be repaired from inside the task. A slice wanting `spawn.rs` must take the governing page with it |
| A3 | Both empty runs are failures | If a kind should legitimately report and write nothing, that is `owed` — the spike's question — and not this one |

## 7. Decisions

| # | Decision | Where argued |
|---|---|---|
| D1 | The observation is *that* a report exists, never its contents | §1; `verify.rs` module doc, rule three |
| D2 | Read off both the diff and the disk, since gitignoring `.wecode/run/` is the standing advice | FR-09-02 |
| D3 | Three readings, not a bool: `Delegated` already existed and was being carried by a separate `if` | FR-09-03 |
| D4 | The verdict does not move — only the sentence | FR-09-05 |
