---
class: record
---
# ADR-0002: One repo, one standing project

Status: accepted (31 Aug 2026)

## Context
Nine projects accumulated on the wecode repo, five at 0% and dormant for days.
wecode's model permits it — "a project owns one repo and carries an
objective" — but at solo scale the population became context the owner had to
carry: nine boards, nine objectives, one pair of hands.

## Decision
One standing project per repo. Objectives live in task titles; the project
carries the repo's mission, its measure, and its budget. wecode's repo work
consolidates under `wecode-loop`; wemail's under `wemailng`.

## Consequences
Less to hold: one board per repo, one place to look. Lost: per-objective
measure commands and budgets — acceptable at this scale, revisit if a repo
ever serves two teams. NOT fixed by this: scope collisions, which are between
TASKS regardless of project — their cure is narrow scopes from `wecode map`
(ADR-0001). Archived projects keep their history; `unarchive` restores any of
them if an objective earns its own board again.
