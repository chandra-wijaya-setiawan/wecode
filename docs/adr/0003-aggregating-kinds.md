---
class: record
---
# ADR-0003: Grouping is a task kind, not a project

Status: accepted (31 Aug 2026)

## Context
ADR-0002 made the project a repo's standing container, so grouping needs a new
home. Tasks already nest (`--parent`), but every existing kind is a WORK type
(feature, bug, chore, spike, design, docs) — none aggregates. The classical
hierarchy (epic → story → task) had nowhere to live.

## Decision
Two aggregating kinds: `milestone` (a release or outcome worth naming) and
`story` (one user-visible capability). They carry no write scope and no
acceptance of their own; they are done when their children are — the rule the
board already uses for project completion. Work kinds stay exactly as they are.

    project (repo mission)
      milestone
        story
          feature | bug | chore   ← scope, acceptance, agents
            design | build | test ← --expand

## Consequences
The roadmap stops being prose: maturity-roadmap.md's P0/P1 rows become
milestones with stories under them, visible on the board and countable.
Admission must exempt aggregating kinds from the scope and acceptance checks
(a container that declared a scope would collide with its own children — the
`nested` rule already anticipates this). Risk: kind inflation; two aggregating
kinds is the ceiling, and a third needs its own ADR.
