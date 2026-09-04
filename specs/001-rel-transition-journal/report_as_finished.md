# 001 — Report as finished

**Task:** `rel-transition-journal` · **Branch:** `wecode/rel-transition-journal`
· **Base:** `master`

## 1. Summary

Built and executed. Every step of a dispatch with an effect outside the database now
writes its intent first and settles it after; `wecode reclaim` adjudicates what a dead
supervisor left, `wecode loop` runs it once at startup, and `wecode doctor` reports what
it would do without touching anything. 2250 lines added in six new files, 349 added and
473 removed across nine existing ones — a net reduction in `spawn.rs` and
`commands/exec.rs`, because both were at the `.max-lines` ceiling and had to be split
before a line could be added.

**Not done:** `wecode reclaim` is absent from `wecode help`. That is a scope defect, not
a decision — §5 below, and it is the first thing a reviewer should read. AC-8 is proven
by a unit test rather than by the drill. Read §2, then §5.

## 2. Requirement status — detail

| ID | Satisfied by | Proven |
|---|---|---|
| FR-01-01 | `prepare`, `run_task` open a row before the worktree, the spawn, the commit and the verdict | executed — `a_finished_run_leaves_nothing_in_doubt`, and every drill below |
| FR-01-02 | `journal::Resolve`, parsed not free text | executed — `reclaim::outcome_of` unit tests, `a_step_the_schema_allows_and_the_domain_does_not_is_corruption` |
| FR-01-03 | `identity::me()` on every intent | executed — `this_process_is_alive_by_its_own_account` |
| FR-01-04 | `spawn::Watch::token` → `WECODE_RUN` after `env_clear` | executed — `an_orphan_whose_pid_was_never_recorded_is_found_by_its_token` |
| FR-01-05 | `Watch::born`, called between `Command::spawn` returning and the pipes | executed — the drill polls the journal for the pid rather than sleeping |
| FR-01-06 | `store.settle` at each step; `outcome_of` on the reclaim path | executed |
| FR-01-07 | `stranded` keeps only `Life::Gone` | executed — `a_run_whose_supervisor_is_alive_is_left_alone` |
| FR-01-08 | `reclaim::settle`, in the design's order | executed — `a_crashed_run_is_settled_and_its_task_handed_back`, `the_worktree_stands_and_the_attempt_is_committed` |
| FR-01-09 | `identity::holding` scans `/proc/*/environ` | executed — `an_orphan_whose_pid_was_never_recorded_is_found_by_its_token` |
| FR-01-10 | `reclaim::at_startup` before `serve`'s first pass | executed — `the_loop_dispatches_the_task_again_after_a_crash` |
| FR-01-11 | `doctor::runs` section | executed — `doctor_reports_the_same_run_and_touches_nothing` |
| FR-01-12 | `reclaim::record`, `Action::Staff` / `Allow` / `Supervisor` | met in code; the row is written, no test asserts on it |
| NFR-01-REC-01 | `settle` is `WHERE settled IS NULL`; every step is a no-op twice | executed — `reclaiming_twice_changes_nothing_the_second_time` compares the database byte length |
| NFR-01-REC-02 | boot id + pid + start time; no clock anywhere in `identity` | executed — `a_pid_with_the_wrong_start_time_is_a_different_process` |
| NFR-01-PERF-01 | four rows per run, one insert and one update each | met in code |
| NFR-01-COMP-01 | schema 12, `(11, RUN_JOURNAL)` | executed — `a_version_eleven_file_gains_the_journal_and_keeps_its_plan` (AC-8) |
| NFR-01-MAIN-01 | `reclaim.rs` is its own module; two splits landed to make room | executed — tallest src file 1599 of 1600 |
| NFR-01-PORT-01 | `Life::Unproven` where `/proc` cannot answer; `stop_the_agent` says which | executed — `a_row_with_no_start_time_names_a_pid_and_proves_nothing` |

Every AC in §4 of the specification is executed except AC-8, which is a `schema.rs`
migration test as the specification itself proposed, and not part of the drill.

## 3. Repository diff

| Path | Change | Lines | FR / NFR / AC | Status | Notes |
|---|:-:|--:|---|---|---|
| `crates/wecode-store/src/journal.rs` | A | 569 | FR-01-01/02/03/06 | done | The table's types and I/O |
| `crates/wecode-store/src/schema.rs` | M | +102 −2 | NFR-01-COMP-01, AC-8 | done | Version 12; `RUN_JOURNAL` is one text used by both install and upgrade |
| `crates/wecode-store/src/lib.rs` | M | +2 | — | done | Module and re-exports |
| `crates/wecode-cli/src/identity.rs` | A | 358 | FR-01-03/09, NFR-01-REC-02/PORT-01 | done | The proof: boot id, pid, start time, token scan |
| `crates/wecode-cli/src/reclaim.rs` | A | 474 | FR-01-07/08/12, AC-1..6 | done | The adjudicator and `wecode reclaim` |
| `crates/wecode-cli/src/commands/exec.rs` | M | +118 −233 | FR-01-01/04/06/10 | done | Journal calls; worktree commands moved out |
| `crates/wecode-cli/src/commands/trees.rs` | A | 238 | NFR-01-MAIN-01 | done | Split out of `exec.rs`, which had one line of headroom |
| `crates/wecode-cli/src/spawn.rs` | M | +43 −223 | FR-01-04/05 | done | `Watch`; the run report moved out |
| `crates/wecode-cli/src/render/run.rs` | A | 235 | NFR-01-MAIN-01 | done | Split out of `spawn.rs`, which was exactly at the ceiling |
| `crates/wecode-cli/src/render.rs` | M | +12 −4 | — | done | Registers `run`; corrects the note that placed it in `spawn` |
| `crates/wecode-cli/src/doctor.rs` | M | +58 −11 | FR-01-11, AC-7 | done | Third section; the store is now opened read-only — §6 |
| `crates/wecode-cli/src/main.rs` | M | +9 | — | partial | Dispatch entry; **no USAGE line** — §4 |
| `crates/wecode-cli/src/commands/mod.rs` | M | +1 | — | done | Registers `trees` |
| `crates/wecode-cli/Cargo.toml` | M | +4 | AC-6 | done | `rusqlite` as a dev-dependency, for the one state no API can reach |
| `crates/wecode-cli/tests/reclaim.rs` | A | 376 | AC-1..7, AC-9 | done | The drill: real processes, real kills |
| `specs/001-rel-transition-journal/report_as_finished.md` | A | — | — | done | This file |

Sixteen rows; `git status --porcelain` lists fifteen changed paths plus this one.

## 4. Blockers

| Blocker | Owner | State |
|---|---|---|
| `wecode reclaim` is missing from `wecode help`, because `docs/reference/commands.md` is `wecode help` verbatim, a test holds it to that, and this task's scope is `crates/**` only | next slice | open — five lines in two files |
| `spawn.rs` and `commands/exec.rs` were at the `.max-lines` ceiling | this task | cleared by two capability splits |

## 5. Outstanding

**Unbuilt.** The help entry above. The repository's own playbook warns about exactly
this — *"a task that adds or changes a CLI command also changes
`docs/reference/commands.md` … declare `docs/**` or the scope check refuses the work
after it is done"* — and this dispatch's scope did not. Adding the entry alone would have
made `the_command_reference_is_the_help_verbatim` fail, and `cargo test --workspace` is
the acceptance of four of the seven kinds in this repo, so it would have failed every
task after this one. The command is reachable, dispatched from `main.rs`, and named by
`wecode doctor`'s report; it is not listed in `wecode help`.

**Unproven rather than unbuilt.** FR-01-12: the ledger row is written and nothing asserts
on it. `docs/reference/schema.md` is not regenerated for the new table, for the same
scope reason.

**Deliberately out of this slice**, per specification §6: journalling `merge`, `rollback`
and the teardown hook. The table takes them unchanged and `Resolve::Refuse` is already
implemented and tested, so the first `refuse` step needs no new machinery.

## 6. Key decisions and justification

| Decision | Why | Where |
|---|---|---|
| `run_journal.prior` — one column beyond the design's sketch | FR-01-08 says *restore the task's prior status*, and the claim held it in memory, which is what the crash took. The alternative was guessing `ready`, wrong for every task an operator started by hand | `journal::Intent::prior` |
| The `prepare` row stays open for the life of the run | It is what says a tree was cut and a claim was taken, and both are true until the run has a verdict. `wecode start` settles it on the way out instead: a person is not a process whose liveness anything can prove | `commands::exec` |
| `doctor` now opens the store | The old note there promised the drill never opened it. FR-01-11 makes that impossible to keep — the runs in doubt are in the database. The promise is now *changes nothing*, and it is kept | `doctor::run` |
| A zombie owner counts as gone | A supervisor whose own parent is slow to reap it would otherwise hold its task hostage for as long as the parent took, which is the whole condition this closes | `identity::reaped` |
| `identity::stop` reports liveness from `kill -0`, not from the exit status of its own `TERM` | `kill` answers for *a signal it could deliver*, and a group id naming nothing is a usage error rather than a missing process. Reading the wrong status made every real kill report `agent already gone` | `identity::stop` |
| `spawn::run` became `#[cfg(test)]` | Every dispatch is journalled now, so a production caller of the unwatched entry point would be the bug. The compiler is the cheapest place to find that out | `spawn::run` |

## 7. Lessons learnt

**Scope a CLI command against the pages generated from it.** The playbook names this trap
in as many words and this dispatch still hit it, because the scope was written from the
crates the work touches rather than from the files the work moves. The cost was the one
outstanding item in §5. A dispatch that adds a command should carry
`docs/reference/commands.md` and `docs/reference/schema.md` whether or not the author
expects to open them.

**Budget the ratchet before planning, not after.** `spawn.rs` was at 1600 of 1600 and
`commands/exec.rs` at 1599; the feature could not add a line to either until 456 lines
had moved out. Both splits were worth making on their own terms — a run report is not
process supervision, and listing worktrees is not cutting them — but they were found by
running `wc -l` after the design was fixed, not before. The playbook already says to run
`scripts/max-lines.sh` while planning; this slice is the evidence.

**A failing drill lied about which half was wrong.** `agent already gone` appeared while
the agent was demonstrably still running, and three rounds went into the identity proof
before the fault turned out to be `stop`'s return value. The fix was to make the report
say *why* it found nothing — `pid N had already ended` against `pid N cannot be proved to
be ours` — which is a line an operator needed anyway, and which would have answered the
question in one round. Diagnostics that distinguish the failure modes are cheaper written
first.
