# Living documentation — staleness is a design defect, not a discipline failure

Canon: Martraire, *Living Documentation* (2019); Procida, *Diátaxis*; Adzic,
*Specification by Example*; Nygard, ADRs. The shared claim: humans reliably
fail at doc maintenance, so the system must make staleness impossible,
detectable, or harmless — in that order of preference.

## Every wecode document, classified by decay strategy

| Class (Martraire) | Cannot rot because | wecode today | Gap |
|---|---|---|---|
| **Generated** | rebuilt from the source of truth | commands.md/schema.md from source; report.md from git diff; board from db | components/C4-L3 hand-drawn until codemap generates it |
| **Executable** | it runs, so drift fails a gate | acceptance commands; design-check.sh; seam guards; max-lines | specs' ACs not yet traced to tests (traceability, queued) |
| **Record** (append-only, dated) | never edited — superseded | ADRs, merge reports, ledger, waivers | reader confusion: records must be LABELED as history, not state |
| **Evergreen** | states slow truths only | doctrine (sdlc.md, ax.md, boundary sentence) | volatile facts keep leaking in (counts, statuses, "currently") |
| **Hand-tended state** | nothing — this class IS the staleness | plan.md slices, features gaps, playbook traps | shrink it: every fact here must justify not being one of the above |

## The three mechanisms to build (in preference order)

1. **Generate more**: codemap → component docs; board → status sections of
   plan.md (a doc that repeats the db is the db's job to write).
2. **Freshness gate** (Martraire's reconciliation): every docs/design page
   declares `subject:` globs in front-matter; a check fails when the subject
   files changed after the doc's last commit — the doc ratchet, same shape as
   max-lines. Stale then means "the gate said so", not "someone noticed".
3. **Label records**: every ADR/report renders with its date and
   "record, not current state" — harmless staleness.

Stale TASK statuses are the same disease in the db instead of in prose, and
already have their cure in flight: the transition journal + lease reclaim
(wecode-reliability) make a status that lies impossible to keep.

The human rule that remains (the only one): a sentence with a number, a
status, or the word "currently" does not belong in an evergreen page.
