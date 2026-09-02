---
class: record
---
# Architecture Decision Records

Nygard-form: one decision per numbered file, immutable once accepted — a later
decision SUPERSEDES it, never edits it. A unit's design.md cites the ADRs it
builds on; when the decision ledger (wecode-decisions) lands, these files are
its import source. Format: Status · Context · Decision · Consequences.

| # | Decision | Status |
|---|---|---|
| [0001](0001-codemap-is-a-commit-keyed-cache.md) | The codemap is a commit-keyed cache, never authority | accepted |
| [0002](0002-one-repo-one-project.md) | One repo, one standing project | accepted |
| [0003](0003-aggregating-kinds.md) | Grouping is a task kind, not a project | superseded by 0004 |
| [0004](0004-epic-is-the-aggregating-kind.md) | The aggregating kind is `epic`, not `milestone` | accepted |
| [0005](0005-requirements-are-records.md) | Requirements, designs and decisions are store records | accepted |
| [0006](0006-story-owns-the-worktree.md) | A story owns the worktree, and its report is generated | accepted |
| [0007](0007-hold-is-not-archive.md) | `hold` suspends work; `archive` files it away | accepted |

A superseded ADR stays in the directory and stays listed — the row is how a
reader arriving from an old citation learns which decision replaced it.
