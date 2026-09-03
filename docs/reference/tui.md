---
class: hand-tended
subject:
  - crates/wecode-cli/src/tui.rs
  - crates/wecode-cli/src/tui/**
---

# The cockpit

`wecode tui` — one application whose screens call each other. State lives in the app, so
moving between screens is navigation rather than a fresh invocation, and no screen is
reachable only by restarting with a different command. `wecode board` is the same state
printed once and exited; `wecode up` and `wecode cockpit` are older spellings of `tui`.

## Screens

| screen | holds | reached by |
|---|---|---|
| `HOME` | the four attention groups over the portfolio, with the is-part-of tree under them | the bottom of the stack, `v h` |
| `PROJECT` | that project's task tree, to the leaves | `enter` on a project row |
| `TASK` | one task in full: where it sits, what it waits on, each attempt against its budget, its report, its incidents | `enter` on a task row |
| `ACTIVE AGENTS` | every run still in flight | `v a` |

`esc` goes back to the row the screen was opened from, never up the is-part-of chain:
the stack is history, not hierarchy. `wecode tui <id>` opens *on* a screen with HOME
still underneath it.

## Keys

| key | what it does |
|---|---|
| `j` `k` / `↓` `↑` | next, previous — on `TASK`, which is a page, they scroll it |
| `g` `G` | first, last |
| `enter` `l` `→` | open what the cursor is on |
| `esc` `⌫` `h` `←` | back to the screen it came from |
| `space` | fold or unfold the selection |
| `z` `Z` | fold or unfold everything |
| `/` | narrow this screen to the rows that answer what you type |
| `:` | ask the same of the whole workspace, and open what it finds |
| `t` | the ledger as it is written, under the table |
| `w` | show or hide what waits on you |
| `a` | show or hide what is filed away |
| `r` | reload now · `?` keys · `q` quit |

## What waits on you

The panel names every row stopped on the operator and, beside each, **the one command
that clears it** — with the id already in it, so it can be typed as printed.

| column | reading |
|---|---|
| where | `<project>/<task>` — a row torn out of the tree says which project it came from |
| what it asks | the category: `needs-approval`, `needs-input`, `failed`, `yours to do`, `stuck` |
| the key | `wecode merge <id>`, `wecode approve design --task <id>`, `wecode run <id>`, … |

Both halves are `board.rs`'s, read off `attention_groups` rather than off the statuses a
second time — so the panel, the snapshot on a phone and HOME's own `NEEDS YOU` group
cannot come to disagree about what needs a person. `docs/reference/board.md` holds the
closed list of categories and the command each maps to.

Three rules, and each of them is a row the panel does not draw:

- **Not on HOME**, where the four groups already lead with these same rows. A screen
  that answers one question twice teaches a reader to skip both answers.
- **Nothing when nothing waits.** An empty box on every screen would cost the tree a row
  in order to say there was nothing to say.
- **Five, then a count.** The company's own `[attention] max_open_items`, as on the
  board; the tail is `… and N more` rather than silence.

It reads the whole workspace, not the screen: work stopped in another project is still
stopped. `w` takes it away and brings it back, like `t`.

## It watches, it does not steer

Nothing in the cockpit signs anything. The panel names `wecode approve` and
`wecode merge`; it does not run them. A signature given from the instrument that watched
the run is the judge and the judged in one place, which is the whole of what `verify`
means — and `approve` has a Broker, a channel and a ledger row of its own.

## See also

`docs/reference/board.md` for the four groups and the categories · `docs/reference/commands.md`
for `wecode tui` among the commands · `crates/wecode-cli/src/board.rs`, which decides
what needs a person for both forms.
