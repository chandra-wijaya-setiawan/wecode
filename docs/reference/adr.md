---
class: hand-tended
---
# The ADR index

Every decision the repository has taken, in `wecode.db`. The text stays in
`docs/adr/*.md`, where review, diff and history already live — ADR-0005 draws the
line: *"the table is the index (id, status, supersedes), `docs/adr/*.md` is the
text"*.

## What the index holds

| Field | From | Note |
|---|---|---|
| `id` | `# ADR-0004: <title>` | Names `docs/adr/0004-*.md` for ever, so no path is stored |
| `title` | the same heading | |
| `project` | the caller | The repository, as its standing project (ADR-0002) |
| `superseded_by` | `Status:` line | `None` until something replaces it |
| `at`, `by` | the row | When it was last indexed, and by whom |

`status()` is derived: `accepted`, or `superseded by ADR-0004`. Not a column, for
ADR-0005's own reason about a requirement's `status` — a word written into a row
goes stale the moment the next decision lands, and a successor cannot be recorded
without naming what it replaces.

## Rows, not a table

No new table: a decision is *taken* by somebody at a moment, which is a row in the
audit ledger. Two actions, both `source = supervisor` and both with a NULL
`task_id`, because a decision outlives every task that cites it:

| Action | `target` | `detail` |
|---|---|---|
| `decide` | `ADR-0004` | the title |
| `supersede` | the replaced id | the replacing id |

`Store::adrs()` folds them, keyed by id — which for a four-digit handle sorts as
the numbers do, the order `docs/adr/README.md` lists them in. Superseded decisions
stay in the index exactly as they stay in the directory: the row is how a reader
arriving from an old citation learns which decision replaced it. A `supersede`
naming a decision nothing recorded is dropped rather than conjured, so a citation
to a decision the index has never seen stays visible.

## Indexing a page

`AdrHead::parse(text)` reads the first lines; `Store::record_adr(by, project,
&head)` writes them. The store never opens a file — the caller hands the text over,
the idiom `wecode_core::docs` already uses. Indexing is minted from the text on
every pass and is idempotent, so a pass over the directory can be run as often as
anyone likes; the newest pass wins.

`parse` returns nothing for a page without an `# ADR-nnnn:` heading, which is what
`docs/adr/README.md` is. `record_adr` returns `None`, and writes nothing, for a
page whose status is neither `accepted` nor `superseded`: a proposal is a document
about a decision nobody has taken, and listing it beside the decisions would answer
*what did we decide?* with something nobody decided. It joins the index when its
status changes.

## Gaps

- **Nothing walks `docs/adr/` in a command yet.** The index is exercised by
  `crates/wecode-cli/tests/adr.rs`, which walks the directory itself. A `wecode`
  command to index and to print the table is the next step.
- **No digest.** ADR-0005's first sketch had one, for detecting a page that moved
  without its record. Nothing reads it yet, so nothing writes it.
- **A conflicting supersession is not flagged.** If two pages disagree about what
  replaced what, the last row folded wins. The test above compares the two ends of
  every supersession in this repository, which is where a disagreement would show.
