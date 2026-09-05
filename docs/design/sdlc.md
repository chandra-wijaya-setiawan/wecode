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

## The gap the owner named, 5 Sep: integration evidence is not enforced

The V&V row above is true per task and false per story. Acceptance commands prove
the component a task touched; nothing requires the capability the task belongs to
to be exercised through its real interface on the assembled revision — so a task
can be *done* while its story is *undelivered*. The spend circuit breaker is the
standing example: the helper exists and its unit tests pass, and no dispatch is
stopped, because no check ever drove a dispatch through the real CLI and asserted
the refusal. The owner's framing: the missing wiring is an SDLC enforcement
defect — the process allowed "the component exists" to stand in for "the
capability is delivered."

The evidence ladder this SDLC owes (proposed, not yet enforced):

| level | required evidence |
|---|---|
| requirement | an observable behaviour with a defined pass/fail |
| implementation task | its component behaves correctly |
| integration task | the behaviour works through the actual public interface |
| story closure | every required behaviour passing on the assembled revision |
| release | the complete product passes from a clean installation |

A component task may finish while its story remains incomplete — the ladder is
what stops that reading as delivery. The rule that makes it a gate rather than a
wish: **an executable story cannot enter delivery without an integration
acceptance declared, and cannot close without evidence that acceptance passed
against its assembled revision.** Admission checks the obligation, command and
scope exist; the acceptance definition is frozen before implementation;
verification records the tested revision; changing the revision invalidates the
evidence. And the test is itself tested: disconnect the wiring and the
integration check must fail, or it protects nothing. This is the campaign the
Conduit delivery (see [maturity-roadmap.md](maturity-roadmap.md)) exists to
prove — autonomy at every step, a deterministic check at every step.

## What this deliberately does not adopt

Process-heavy readings of the standards (phase sign-offs, document-per-clause).
The empirical line wecode follows: traceability pays, ceremony does not — teams
"respond to release problems by adding processes, then struggle to enforce them."
wecode adds *checks*, not processes; a row of this table only moves left when it
becomes something a gate can refuse.
