# <issue> — <what this slice delivers, in one line>

**Task:** #<number> `<task>` · **Branch:** `wecode/<task>` · **Target:** `main`
· **User story:** <US-nn>

Execution state is tracked in `report_as_finished.md`. This document is the contract.

> <small>*Copy this file to `specs/<issue>-<slug>/specification.md` and replace the
> placeholders. Keep the section headings and the hints — the hints are what make the next
> engineer's document match this one. Written against the delivery model in
> `specs/reference/v0-development-practice.html` §3.*</small>

## 1. Requirement summary

> <small>*What is being built, and why. Name each component and state its **lifespan** — permanent, or scaffolding with a known expiry. Say what is out of this project's delivery scope and who owns it instead.*</small>

<!-- … -->

## 2. Architecture

> <small>*Where this slice sits at C4 L1–L4. Write **TBD** where the diagrams do not exist yet and record the *assumed* placement, so it is agreed before the drawing rather than after. List any divergence from the drawn architecture as something needing ratification, not as a free choice.*</small>

<!-- … -->

## 3. Requirement details

> <small>*Two tables — functional and non-functional. One row per requirement, using a **Component** column rather than splitting into separate sections. Provisional slice-local IDs are fine when no project baseline exists; say so. Record withdrawn requirements rather than deleting them.*</small>

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-nn-01 | | |

**Non-functional**

| ID | Component | Requirement |
|---|---|---|
| NFR-nn-…-01 | | |

## 4. Acceptance criteria

> <small>*Observable conditions that demonstrate the requirements. An FR states a capability; an AC is evidence for one or more of them, many-to-many. Trace each AC back to IDs, and flag any AC added beyond the ticket with the reason.*</small>

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | | | |

## 4b. Interfaces — user and agent parity

> <small>*One row per user-facing action. The agent column names how an agent does the
> same thing with the same information — an empty agent cell needs a stated reason.
> Parity of capability, never of authority: who MAY act stays with the Broker/gates.
> See wecode docs/design/ax.md.*</small>

| Action | User via | Agent via | Same gate? |
|---|---|---|---|
| | | | |

## 5. Technical component details

> <small>*The design specific to this ticket, one sub-section per component — storage layout, catalog, schemas, jobs. Say *why* a structure is the way it is, not only what it is. If the slice contains temporary scaffolding, describe its footprint and how to remove it.*</small>

<!-- … -->

## 6. Out of scope

> <small>*What this slice deliberately does not do — especially work owned by the client or another team. Naming the owner prevents it being read as an omission.*</small>

<!-- … -->

## 7. Assumptions

> <small>*Unresolved items, each with an assumption made so the work is not blocked, and what breaks if the assumption is wrong. **Known data defects belong here**, framed as someone's to resolve. Anything genuinely open goes here rather than stalling the slice.*</small>

| # | Assumption | If wrong |
|---|---|---|
| A1 | | |

## 8. Decisions

> <small>*The counterpart to §7: choices that are settled, with the justification and a reference where one exists. Mark any that need the Tech Lead's agreement.*</small>

| Decision | Justification | Reference |
|---|---|---|
| | | |

## 9. References

> <small>*A flat list of the documents, papers and specifications this document rests on. Separate project documents from published literature, and state any caveat about what a citation does and does not cover.*</small>

<!-- … -->
