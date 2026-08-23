# milestones — a version the board can answer for

The owner, 23 Aug: "as SDLC, wecode is missing feature/architecture/docs/roadmap/
version… we don't know the overall status of wemail; when does 0.1 land? wecode is
SDLC management for agentic code."

The division decided in that conversation: **definition in the repo, accountability
in the tool.** A repo's plan.md declares versions (see wemail's "## Versions"); wecode
reads the declaration and holds work to it.

## The shape

- `[project] milestone = "wemail-0.1"` in the playbook (or per-project setting) names
  which version a project's work serves.
- The board's OKR line gains the rollup: `wemail 0.1 ── 6/8 units ── next: tree-ui`,
  computed from tasks tagged to the milestone — outcome, not output.
- `wecode milestone <name>` prints the version's units, states, spend, and what
  blocks it — the "when is 0.1" answer as one command.
- The digest carries a milestone line when one moved.

## Not doing

- No dates machinery, no burndown charts: a target date is prose in plan.md; wecode
  reports state, humans forecast.
- No release automation (tagging, changelogs) in this unit — read + report first.
