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

## The decided question (owner, 30 Aug): artifacts are data structures

Docs, specs and SDLC artifacts in a repo are TYPED RECORDS; markdown is their
serialization, chosen because git supplies the transaction (commit), the
concurrency control (merge), and the log (history). The division of substrate:
machine-written concurrent facts → SQLite; authored knowledge → typed records
in git; each side renders read-only projections of the other.

What "typed" buys, per artifact — the schema wecode parses and the gate that
consumes the fields (never grep, which comments have already fooled):

| Artifact | Typed fields | Gate that consumes them |
|---|---|---|
| specification.md | FR/NFR ids, AC id → command, subject globs, unit number | admission: AC ids ⊆ acceptance cmds; subject ⊆ scope |
| ADR | id, status, supersedes, date | admission of a superseding decision: target must exist; records render dated |
| design.md | decides / costs / makes-harder / reverses | design-check upgraded from form to fields |
| report_as_finished.md | numbers from git diff | generated — already pure data |
| doc front-matter | subject: globs, class: generated/executable/record/evergreen | freshness join: subject changed after doc → refuse |

`docs-first` (#006) builds this: a parser in core (the org crate's sibling —
hand-authored records, machine-validated), verify consuming fields. Prose
survives inside fields; structure decides.

## Templates make structure enforceable (owner, 1 Sep)
A document's shape can only be enforced where it is declared, so both
story-level documents are templates, resolved project → workspace → built-in
(the order spec templates already use):

  ~/.wecode/workspaces/<org>/templates/story-design.md   canonical shape
  ~/.wecode/workspaces/<org>/templates/story-report.md
  <repo>/.wecode/templates/*.md                          overrides only

Grounding, read rather than recalled: ISO/IEC/IEEE 15289:2019 §10.15 Design
description, §10.3 Acceptance report, §10.74 Verification report;
DI-IPSC-81435A (SDD) §3–6 for the design's section list; DI-IPSC-81440A
(Software Test Report) §3–5 for the report's, including its rule that an
assessment states each remaining deficiency WITH its impact; NASA NPR 7150.2D
[SWE-034] (acceptance criteria are defined and documented) and [SWE-194] (every
requirement met or DISPOSITIONED before delivery) — the close gate, mandated
elsewhere long before we wanted it.

Every section is marked [gen] or authored. The report is generated entirely
except three prose sections, because the restated requirement text is precisely
what rotted in the wt-53 slice.
