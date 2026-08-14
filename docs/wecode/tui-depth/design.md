# Subtasks on the portfolio screen

Status: **built**. Written alongside the implementation.

## What went wrong

The portfolio drew projects and their **root** tasks, and stopped. `wecode board <id>`
on a project did the same; `wecode up` focused on a task went one level further and
stopped at grandchildren. Every one of those depths was a number written into a
hand-unrolled loop by whoever wrote that view, and no two of them agreed.

That is fine for a plan one level deep. It is wrong for every plan that is not, because
**the row worth looking at is almost always a leaf**. A parent task is a heading: it is
`draft` forever, it spends nothing of its own, nobody assigns it. The task that is
running, over budget, failed, or waiting on a signature is at the bottom of the branch —
and the bottom of the branch was the part the portfolio did not draw.

What reached the top was a rollup: `2 to answer`, `1 stuck` on the project row. Those
counts are right and they are not enough. A count tells the operator to go and look; it
does not say where, and finding out meant descending into each project in turn and then
into each of its tasks. Using wecode on itself, that is the loop that kept happening —
open the board, read a number, spend four keystrokes discovering which subtask it was
about.

## Draw all of it, and let it be folded

Both halves matter, and the second is why the first is safe.

**Draw all of it.** One recursive walk per renderer, from whatever the view's subject is
down to the leaves. In the TUI that is `Tree::push_project` and `Tree::push_task`, used
by all three levels; in `wecode board` it is `subtree`, used by the portfolio and by both
focus levels. No view names a depth any more, so no two views can disagree about one.

**Let it be folded.** A tree drawn in full is a tree that can outgrow the screen, so
`space` folds the selection's children away, `z` folds the whole plan down to its
projects, and `Z` opens it again. The marker column says which way a row points — `▾`
open, `▸` shut, two spaces for a leaf, so ids stay in one column down a branch.

The default is **open**. A collapsed-by-default tree is the old behaviour with more
keystrokes: the operator still cannot see the leaf that needs them, and now they have
been told the view has depth, which is worse than not knowing. What is off screen should
be what the operator put away.

`z` and `Z` are two keys rather than one toggle because what a toggle does next depends
on state the operator cannot see — after folding three rows by hand, is "the plan"
folded? Two keys always mean what they say.

## Folds are remembered by subject

`collapsed` is a set of `Subject`, not of row indices. The view reloads from the store
every 1.5 seconds and rebuilds every row; indices survive none of that, and a fold that
reopened itself every second and a half would be a feature nobody used twice. A subject
also survives a task moving in the tree, which an index does not.

Only rows with children are ever recorded. `z` skips leaves deliberately: a leaf marked
folded is invisible today and wrong the moment somebody hangs a subtask off it.

**Descending opens.** Zooming into a folded row would otherwise land on a screen showing
only the row that was zoomed into — the fold is a statement about a scan, and descending
is asking to see inside.

## The text board does not fold

`wecode board` draws the same tree and has no fold state at all.

A snapshot piped into a pager is already scrollable, and there is nowhere to keep a fold
between two runs of a one-shot command — it would have to become a flag, and a flag for
"show me less than everything" is one nobody sets. `--all` already exists and means
something else.

Depth there is spelled in **spaces, not glyphs**, unlike the TUI. That column truncates
at 26 characters; a `└─` that survives the cut while the id does not costs the reader the
one thing the row is for. The TUI's `what` column is wide and elastic, so it can afford
the glyphs, and they are worth more there because the tree is navigated rather than read
once.

## The rollups stay

`N to answer` and `N stuck` remain on the project row even though every subtask now has a
row. They answer a different question: the rows say *what* to read next, the count says
*whether* to read them at all. A count on the project also survives its own branch
scrolling off the screen, which is exactly the case a long tree creates.

## What this found and did not fix

A plan **three levels deep may not load again**. `Plan` allows any depth and every view
now draws any depth, but `Store::load_plan` orders tasks `(parent_id IS NOT NULL), id`
— roots first, then everything else by id — which happens to put a parent before its
child for exactly two levels. A grandchild whose id sorts before its parent's arrives
first, `add_task` refuses it as `no task <parent>`, and the whole workspace stops loading
with `stored plan structure is not recognised`.

It is real: writing a three-level tree into a test store reproduced it immediately, which
is why the TUI's depth test names its grandchild `salt` and says why in a comment. The
fix is a walk from the roots outward instead of the ordering trick, it is about ten
lines, and it is in `wecode-store`, which this task could not write to. Recorded in
[features.md](../../features.md) under Gaps.

## What is not here

**No filter.** "Only show me what needs me" is a different view from a tree with things
hidden in it, and the needs-you column plus `wecode ready` already answer it. A tree
that silently omits rows is how this gap was created in the first place.

**No auto-fold.** Folding branches that are green, or opening ones that turn amber,
would mean rows appearing and vanishing under the cursor on a timer. The view reloads
every 1.5 seconds; nothing about it should move unless a person moved it.

**Fold state is not persisted.** It lives in the running process and starts open. Storing
it means a schema, a migration and an answer for what happens to a fold whose task was
deleted — for a preference that costs one keystroke to restate.
