# 010 — Admission refuses a second live project on a repo that already has one

**Task:** `one-project-per-repo` · **Branch:** `wecode/one-project-per-repo`
· **Target:** `master`

Execution state is tracked in `report_as_finished.md`. This document is the contract.

## 1. Requirement summary

`check_project` gains one check: a project naming a repo that another live (unarchived)
project already names is a defect, reported at admission and refused at `project add`
like every other defect. Permanent, no scaffolding, no new module.

**What forced it.** A repository is one working tree, one integration branch and one
playbook. The cross-project overlap gate (009-era `ScopeOverlaps { in_project }`) catches
two projects' tasks file by file; nothing refused the second owner itself.

## 2. Architecture

C4 L3: `wecode-core/admission.rs` only. The CLI wiring already exists — `project add`,
`check` and the board all call `check_project`. No store change, no new command, no
authority change.

## 3. Requirement details

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-10-01 | core/admission | `Defect::RepoAlreadyHasProject { repo, held_by }` names the repo and the live project holding it |
| FR-10-02 | core/admission | `check_project` reports it when another unarchived project in the plan names the same repo |
| FR-10-03 | core/admission | An archived holder does not count; archiving is the documented repair and the question says so |
| FR-10-04 | core/admission | An archived candidate claims nothing; a project never collides with itself; a blank repo stays `RepoMissing` alone |
| FR-10-05 | cli | `project add` refuses to save on this defect; `--force` waives it like any other |

**Non-functional**

| ID | Component | Requirement |
|---|---|---|
| NFR-10-MNT-01 | core/admission | The live/parked reading matches `check_task`'s `parked` rule — one meaning of "archived" |

## 4. Acceptance criteria

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | `cargo test --workspace` exits 0 | all | task acceptance |
| AC-2 | `cargo clippy --all-targets -- -D warnings` exits 0 | all | task acceptance |
| AC-3 | `bash scripts/max-lines.sh` exits 0 | — | task acceptance |
| AC-4 | `grep -rqi 'RepoAlreadyHasProject\|repo_already' crates/wecode-core/src/admission.rs` exits 0 | FR-10-01 | task acceptance |
| AC-5 | A second live project on one repo is a defect naming the holder; archiving the holder clears it, both directions | FR-10-02..04 | unit tests in `admission.rs` |
| AC-6 | `project add` on a held repo prints the question and does not save; after `archive` the same command saves | FR-10-05 | `tests/plan.rs::a_repo_carries_one_live_project_at_a_time` |

## 4b. Interfaces — user and agent parity

| Action | User via | Agent via | Same gate? |
|---|---|---|---|
| learn a repo is held, and by whom | `project add` verdict, `check <project>`, board defect count | same commands, same text | yes — `check_project` |
| free a repo | `wecode archive <project>` | same command, Broker-gated as before | yes |

No new action; parity is inherited from the commands already carrying the verdict.

## 5. Technical component details

The check sits in `check_project` beside `RepoUnknown`. `plan.projects()` yields only
unarchived projects, so "live" costs no new predicate; the candidate is skipped when
archived or blank-repoed (FR-10-04). Symmetric on purpose, like `ScopeOverlaps`: two
live holders forced past the gate each show the defect, which is what the board should
count.

## 6. Out of scope

| Not doing | Owner / why |
|---|---|
| refusing `unarchive` when the repo was re-let meanwhile | filing commands don't run admission; the board shows the defect the moment both are live |
| migrating plans that already hold two live projects on one repo | the defect surfaces on `check` and the board; archiving one is the operator's call |
| tests outside this scope that stand up two projects on one repo | `tests/plan.rs` helpers now pass `--force`; out-of-scope suites assert exit status only and survive unchanged |

## 7. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | `project add` exiting 0 on a refusal keeps out-of-scope tests (worktree.rs shared-repo test) green while their second project silently isn't saved | those suites fail; the fix is `--force` in them, a one-line edit owned by whoever may write there |

## 8. Decisions

| Decision | Justification | Reference |
|---|---|---|
| A defect, not a hard error | one gate, one waiver path (`--force`), one renderer | `Admission::decide` |
| "Live" = unarchived | archiving already means "competes for nothing" at task level | `parked`, §5 |
| Symmetric between the two holders | which came "first" is not recorded; both owners is the fact | `ScopeOverlaps` precedent |

## 9. References

- `docs/wecode/overlap-cross-project/design.md` — the task-level half of this rule
- `crates/wecode-core/src/admission.rs` — the gate and its vocabulary
