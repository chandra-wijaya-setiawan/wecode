# The common ground — where wecode stands in fifty years of SDLC

The owner's observation, 24 Aug: "software is broken down by architecture, by
component, by layer… software has existed forever; there can't NOT be common ground
on these terms." Correct. This document maps the standards to what wecode already
does, and names what it still lacks. Every row is a claim someone can check.

## The standards, and wecode against them

| Common ground | The standard | wecode today | Gap |
|---|---|---|---|
| lifecycle processes | ISO/IEC/IEEE 12207 | gates: admission → dispatch → verify → approve → merge; the ledger | none structural — 12207's "processes produce records" is the ledger's thesis |
| requirements spec | ISO/IEC/IEEE 29148 (SRS) | `specs/<n>-<unit>/specification.md` — FR/NFR tables, ACs, trace IDs (wt-53) | adopted 22 Aug; only wemail wired so far |
| quality model (NFR taxonomy) | ISO/IEC 25010 | NFR rows in specs, ad hoc naming | name NFRs by 25010 characteristics in the spec template |
| **architecture description** | **ISO/IEC/IEEE 42010 + C4** | **nothing** — scopes are raw path globs; no named components | **the real gap — see below** |
| verification & validation | 12207 V&V | acceptance commands (V), owner signature + live-tier (V) | acceptance-strength work of 16 Aug was exactly this |
| configuration management | 12207 CM | git + worktrees + scope-commit; migrations | solid |
| release management | SemVer, keep-a-changelog | `plan.md ## Versions` (definition) + `milestones` feature (accountability), building | CHANGELOG.md + tag at first release |
| traceability | RTM practice; measured 24% faster, 50% more-correct task work when present | spec IDs → ACs → tasks → diffs → reports, per unit | cross-unit tracing is manual; components would carry it |
| measurement | 12207 measurement process | spend/replay per run, budgets, the board's OKR line | trend over time is unread |

## The exposed gap: components (C4 L2–L3, ISO 42010)

Everything wecode governs is addressed by *path glob*. Architecture's whole insight is
that paths have **meaning**: a component is a named responsibility with a boundary —
paths are how a component happens to be shelved. Today the meaning lives only in
heads, which is why:

- scope collisions read as glob accidents ("`src/**` overlaps") instead of
  architecture facts ("both tasks touch the *store* component")
- the file-size ratchet counts lines because it cannot count responsibilities
- "which component does 0.1 still owe?" has no answer anywhere

The fix, sized honestly: each repo carries `docs/architecture.md` with a
machine-readable components table — name, C4 layer, paths, responsibility, one line
each (42010's viewpoint discipline without its ceremony). wecode reads it the way it
reads a playbook: scopes may then be declared *by component name*, collisions are
reported in component terms, the board can roll a version up by component. Definition
in the repo, accountability in the tool — the same division as milestones.

## What this deliberately does not adopt

Process-heavy readings of the standards (phase sign-offs, document-per-clause).
The empirical line wecode follows: traceability pays, ceremony does not — teams
"respond to release problems by adding processes, then struggle to enforce them."
wecode adds *checks*, not processes; a row of this table only moves left when it
becomes something a gate can refuse.
