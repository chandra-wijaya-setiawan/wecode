---
class: record
---
# ADR-0004: The aggregating kind is `epic`, not `milestone`

Status: accepted (31 Aug 2026) · supersedes ADR-0003

## Context
ADR-0003 named `milestone` the scope aggregator. The owner named the
imprecision: milestone and epic answer different questions. A MILESTONE is
time — a release, a date, "v0.1 ships" (PMBOK, GitHub's sense). An EPIC is
scope — a large body of work decomposed into stories (Scrum/SAFe, Jira's
epic → story → task). "Group tasks into the same objective" is scope.

## Decision
The aggregating kinds are `epic` and `story`. Both carry no write scope and no
acceptance; both are done when their children are.

    project (repo mission)
      epic    — one objective, decomposed
        story — one user-visible capability
          feature | bug | chore   ← scope, acceptance, agents
            design | build | test ← --expand

A release is a LABEL on work, not a container of it: when wecode needs one, it
becomes a field (`release = "0.1"`), never a third aggregating kind. ADR-0003's
ceiling holds — two aggregating kinds, and a third needs its own ADR.

## Consequences
maturity-roadmap.md's P0/P1 rows become epics with stories under them. The
implementing task keeps its ledger id (`milestones`) because the ledger records
what was asked when it was asked; the kind it ships is `epic`.
