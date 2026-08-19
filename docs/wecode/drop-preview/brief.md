# drop-preview — the owner used it and says no

The owner's words: "I don't feel the preview (toggle summary and detail on bottom
using p shortcut) is useful; we can drop that."

Remove the preview pane and its `p` binding from the live TUI. What stays: the `t`
tail (a different thing — the ledger as it is written, which answers "what is the
agent doing"), the three screens, the filter, the palette. The TASK screen itself is
the detail view; a pane that duplicated it under the table earned its keep with
neither of us and costs vertical rows the tree wants.

If dropping `p` frees layout code, delete it rather than leaving it reachable-but-dead;
the ratchet counts lines and dead UI is how files regrow.
