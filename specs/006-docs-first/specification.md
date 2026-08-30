# 006 docs-first — a document declares what it governs, and the gates enforce the join

**Task:** #006 `docs-first` · **Branch:** `wecode/docs-first` · **Target:** `master`
· **Design record:** [docs/wecode/docs-first/design.md](../../docs/wecode/docs-first/design.md)

Execution state is tracked in `report_as_finished.md`. This document is the contract.

## 1. Requirement summary

Documents in `docs/**` declare the paths they govern (`subject:`) and their decay class
(`class:`) in front-matter. Admission refuses a task whose write scope reaches a subject
without reaching its document; verify refuses a branch diff that touched a subject without
touching its document. Permanent — this is mechanism 2 of `docs/design/living-docs.md`,
and no scaffolding is introduced.

Out of this slice: typed fields on `specification.md`, ADRs and `design.md`, and the
admission checks that would consume them. Same unit, later slices. Owner: the same board.

## 2. Architecture

| C4 | Placement |
|---|---|
| L2 container | `wecode` CLI — no new container |
| L3 component | new `wecode-core::docs` (pure parse + join); callers in `wecode-cli::verify` and the admission path |
| L4 | `docs::parse(path, text) -> Doc`, `docs::stale(docs, changed, matches) -> Vec<Stale>` |

Core parses and joins and opens no files. Three divergences, ratified by the build of the
verify half:

| As specified | As built | Why |
|---|---|---|
| `stale(changed, docs)` | `stale(docs, changed, matches)` | core is dependency-free, so the glob matcher arrives as a parameter — `wecode_gov::glob::any_matches`, no second dialect |
| the stale list is assembled on `Verdict` | computed in `verify::changed`, read through `Verdict::stale()` | that call is the only moment the diff and the tree holding the pages are in one hand |
| — | `Tier` and `tier_of` moved `verify.rs` → `wecode-core::common` | NFR-06-MNT-02: the room had to come from a split, and the `live:` marker is part of a `Measure::Command` line's grammar |

## 3. Requirement details

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-06-01 | core::docs | Parse leading `---` front-matter into `subject:` globs and a `class:` value; a file without front-matter parses to a document that governs nothing |
| FR-06-02 | core::docs | Join a changed-path list against documents: a document is *stale* when a changed path matches one of its subjects and its own path is not in the list |
| FR-06-03 | core::docs | Only `class: evergreen` and `class: hand-tended` participate; `generated` and `record` are never reported |
| FR-06-04 | cli::verify | `Verdict` carries the stale list; `Verdict::passed()` is false while it is non-empty |
| FR-06-05 | cli::verify | The verdict render names each stale document and the changed path that implicated it |
| FR-06-06 | core::admission | A write glob overlapping a document's subject (by `globs_overlap`) is a defect unless that document's path is also in the write scope |
| FR-06-07 | cli::verify | No `git::refuse` note is written for a stale finding — there is no write to hold back |

**Non-functional**

| ID | Component | Requirement (ISO 25010) |
|---|---|---|
| NFR-06-MNT-01 | core::docs | *Modifiability*: subject globs use `wecode_gov::glob`, the write-scope language, with no second dialect |
| NFR-06-REL-01 | core::docs | *Reliability*: no finding may depend on git history — a run is refusable only for coupling it created |
| NFR-06-MNT-02 | build | `verify.rs` and `admission.rs` are at the 1600-line `src` limit; the slice lands new modules and must leave `bash scripts/max-lines.sh` green |

## 4. Acceptance criteria

State: AC-1 to AC-4, AC-6 and AC-7 are met by the verify half. **AC-5 is open** — FR-06-06
is the admission half and lands with a sibling task. Until it does, a stale finding on a
task whose write scope excludes the page is unrepairable inside the run; the mitigation for
now is that coverage is one page (`docs/reference/front-matter.md`) and ratchets by hand.

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | Diff touching a subject without its doc → verdict fails, naming both | FR-06-02, 04, 05 | `cargo test --workspace` — verify test over a fixture worktree |
| AC-2 | Diff touching a subject *and* its doc → verdict unaffected | FR-06-02 | `cargo test --workspace` |
| AC-3 | A `generated`/`record` doc is never reported stale | FR-06-03 | `cargo test --workspace` |
| AC-4 | A doc with no front-matter is never reported stale | FR-06-01 | `cargo test --workspace` |
| AC-5 | Scope reaching a subject but not its doc is refused at admission | FR-06-06 | `cargo test --workspace` — admission test |
| AC-6 | The tree stays under the ratchet | NFR-06-MNT-02 | `bash scripts/max-lines.sh` |
| AC-7 | Lint clean | all | `cargo clippy --all-targets -- -D warnings` |

## 4b. Interfaces — user and agent parity

| Action | User via | Agent via | Same gate? |
|---|---|---|---|
| Learn a diff was refused for staleness | `wecode verify` output, board | verdict text in the retry envelope | yes — one `Verdict` |
| Learn a scope was refused for it | `wecode task add` defect message | same message on the admission failure | yes |
| Declare what a document governs | edit front-matter | edit front-matter, inside declared scope | yes |
| Waive a finding | *(none — by design)* | *(none)* | n/a |

## 5. Technical component details

**Front-matter.** A leading `---` fence, `key: value`, `subject:` taking a list. Parsed
only at the head of a file, so a `---` rule mid-document is prose. `design.md` files carry
none, which is what keeps `design-check.sh`'s first-line title rule from colliding with it.

**The join is over the diff, never the history.** A tree-wide timestamp reconciliation
would fail every task for staleness that predates it, with no ratchet available to absorb
the debt. The argument is in the design record and is not re-run here.

**No note on refusal.** `violations` pairs its finding with `git::refuse` because a bad
write is sitting in the tree; an absent edit has nothing to sanction, so the stale list is
recorded and nothing more.

## 6. Out of scope

| Not doing | Owner |
|---|---|
| Typed fields for specification.md / ADR / design.md, and the gates consuming them | this unit, later slice |
| The inverted gate for records (an edited ADR is the defect) | later slice |
| Generating component docs from a codemap (mechanism 1) | `components` |
| Backfilling `subject:` across `docs/**` | follow-on task per page — coverage ratchets, it is not bulk work |
| The coverage sweep — how many pages declare a subject, how many have ever fired | later slice. `docs::governed` is the primitive and is built; *ever fired* is a ledger question this slice cannot reach, and `verify.rs` is at the ratchet with no room to print half of it |

## 7. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | `globs_overlap`'s coarseness costs only a declared line, never a failed run | admission over-refuses; move that half to the precise matcher |
| A2 | Most pages can name a subject truthfully in a handful of globs | subjects become fiction — the falsifier in the design record fires |
| A3 | Front-matter on `docs/design/*.md` breaks no renderer in this repo | strip it in the render, or move the declaration to a sidecar |

## 8. Decisions

| Decision | Justification | Reference |
|---|---|---|
| Join over the branch diff, not git history | a run is refusable only for coupling it created; no ratchet needed | design record §"Why the diff" |
| Asked at admission *and* verify | scope is frozen, so a verify-only finding is unrepairable | design record §"The decision" |
| Opt-in by front-matter; absence governs nothing | coverage ratchets instead of a threshold | design record §"What a document declares" |
| No waiver, no override flag | the subject line is the waiver, stated as truth | design record §"What moved with it does not mean" |
| Parse and join in core; read files in cli | core opens no files — the `check_refusals` idiom | `wecode-core::admission` |
| An unrecognised `class:` is watched, not exempt | the exemptions are what the gate's silence is made of; a typo must not buy one | `wecode_core::docs::Class::named` |
| Front-matter documented on its own reference page, and that page governs the parser | the first `subject:` in the tree is the gate's own, so it is exercised by the commit that lands it | `docs/reference/front-matter.md` |

## 9. References

Project: `docs/design/living-docs.md`, `docs/design/method.md` (the third place: checked,
but afterwards), `docs/design/sdlc.md`, `docs/wecode/docs-first/design.md`,
`scripts/max-lines.sh` (the ratchet this deliberately does not need).

Published: Martraire, *Living Documentation* (2019) — reconciliation mechanisms;
Procida, *Diátaxis*; ISO/IEC/IEEE 29148 (this document's shape); ISO/IEC 25010 (NFR names).
