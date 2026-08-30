---
class: record
---
# ADR-0001: The codemap is a commit-keyed cache, never authority

Status: accepted (30 Aug 2026)

## Context
`wecode map` derives a repository's component map with tree-sitter. Derived
data needs a home; the candidates were the company workspace, the governed
repo, the ledger db, and a cache.

## Decision
`~/.wecode/cache/<repo>/codemap-<commit>.json` — lazy, demand-driven, keyed by
commit; evicted by keeping the last N commits per repo (N pinned by the unit's
design), swept on write, deletable wholesale at any time.

- NOT the workspace: that directory is hand-edited authority a post's cwd must
  never reach; machine-derived data would blur the boundary it exists to hold.
- NOT committed to the repo: generated artifacts are rebuilt, never authored
  (living-docs.md); committed derivatives rot and conflict.
- NOT the ledger db: wecode.db records what happened; a regenerable cache has
  no place in an audit surface.

## Update model
No schedule, no daemon, no TTL. A consumer resolves the commit its context
names (master HEAD for planning; the task branch tip for envelopes and
verify), then hits or rebuilds. Commits are the only update events; between
commits the map cannot change because it reads the committed tree. Dirty
worktree edits are in no cache by design — gates judge committed diffs.

## Worktrees
A worktree does not have a cache; a commit has a map. Three worktrees at
three tips are three entries under one repo directory; none can clobber
another because the keys differ. Concurrent misses on one key write
byte-identical output by atomic rename. The scaling path keeps the shape:
per-file entries keyed by git BLOB hash, so branches sharing a base share
every unchanged file's parse — git's content addressing is the deduplication.

## Consequences
Staleness is impossible by construction (the key is the freshness proof — the
same move as the transition journal for crashes and git history for doc
freshness). Cost: a cold miss parses the tree (milliseconds per file); an old
commit's map is correct forever and merely evicted as useless. The
codemap-scan design.md builds on this record and cites it.
