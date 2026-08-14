# Handing a design's document to the task built on it

Status: **built**. Written alongside the implementation rather than before it — there was
no design task in front of this one, which is the same irony every slice in this
directory has carried.

## What went wrong

The design gate is the one admission check that reaches for a human. A playbook kind that
sets `design_required` is refused unless a `design` task stands before it; the design
passes its acceptance and does *not* finish, it goes to `needs-approval` and waits for a
signature, because whether a design is right is exactly the part no command can check.
All of that machinery exists to make sure a decision is made, and made by a person,
before anybody builds against it.

And then the decision was never handed to whoever built against it.

The handoff follows `depends_on` and renders each finished predecessor as an artifact.
Every artifact was built the same way: find the predecessor's worktree, look for the
commits wecode made there whose subject starts with that task's id, print the first one's
file list and a 4000-byte diff. For a design, all three steps miss:

- **No worktree.** `[design] worktree = false` — the deliverable is prose, and prose does
  not conflict the way code does. So the design ran in the project's own checkout, and
  the sibling directory the handoff looks for does not exist. It fell back to *this*
  task's tree.
- **No commit.** `commit_attempt` refuses to commit outside the run root, deliberately:
  committing into the operator's own checkout would be wecode writing to a repository
  nobody handed it. A design's document is therefore never committed by wecode at all.
- **No diff worth having even so.** Suppose both of those were fixed. A diff of a design
  says what changed since the previous draft. That is a different question from what the
  design decided, and on a first draft it is the same text with a `+` in front of every
  line.

So the artifact for a signed design read:

```
--- keys — decide the cache key format
  (no commits in this worktree)
```

which is a claim — *this produced nothing* — rather than the absence of one. An
implementer reading it has been told the gate held their work back for a decision, and
that the decision is empty. The best case is that they go and find the file; the ordinary
case is that they re-derive it, differently.

Using wecode on itself, this is the loop that kept happening: the design existed, it was
signed, it was sitting in `docs/wecode/<task>/design.md`, and the task built on it was
dispatched with a prompt that said nothing about it.

## The document is the artifact

A design predecessor is handed over as its **document**, whole. Every other kind keeps
the diff it had.

This is the one place the handoff branches on kind, and it is worth being clear that the
branch is not a special case bolted on. The artifact has always answered "what did this
predecessor produce". For code the answer is a diff, because the code is a change to
something that already existed. For a design the answer is a file, because before it
there was nothing and the file *is* the output. The old code answered the question one
way for both because only one way was implemented.

## Where to find it: the write scope, not a constant

The convention in this repo is `docs/wecode/<task>/design.md`. It is what `playbook init`
writes, what the `[design]` guidance names, and where the merge report lands beside it.

It is still not the path to hardcode. A playbook that templates its steps names its own:

```toml
[feature.design]
kind   = "design"
write  = ["src/design/{{task}}.md"]
accept = ["test -f src/design/{{task}}.md"]
```

That project is not wrong, and a handoff that only knew the convention would hand it
nothing. So the path comes from the design task's **declared write scope** — the one
place a task states where it wrote — and the convention is the fallback for when the
scope does not answer.

Entries with `*`, `?` or `[` in them are skipped. `docs/**` names a directory, not a
document, and picking a file out of it would be a second convention nobody declared;
falling back to the one the starter wrote down is at least a convention that is written
down somewhere a reader can find. Entries that do not end in `.md` are skipped for the
same reason — a design that declares `src/keys.rs` alongside its notes has said which of
the two is prose.

## Three places to look, in that order

The design's own tree, then this task's, then the project's checkout.

- **Its own tree** first, because that is where it worked, on the day a design does get a
  worktree — nothing forbids `[design] worktree = true`.
- **This task's tree** next, because that is the copy the reader can open. When the
  document is found here, the path printed above the text is a path that resolves for
  them.
- **The project's checkout** last, which is where a design with no worktree actually
  wrote, and where the operator's commit of it lives. This is the one that fires in
  practice, and it is why `a2a_task` now takes the repository path as well as the working
  directory: the two are the same directory for a task without a worktree and different
  for a task with one, and the handoff needs both ends of that.

## When it is not there, say which path

Falling back to `(no commits in this worktree)` would have kept the original lie. So a
design whose document cannot be found reports the paths that were tried:

```
  (no design document at docs/wecode/keys/design.md — read it before starting)
```

and the commit rendering follows it, in case there is anything there after all. A signed
design that produced nothing and a document this process could not locate are very
different facts, and the second one is repairable by a reader who is told where to look.

## What it costs

**A bigger prompt.** The cap is 16000 bytes against the diff's 4000. Designs in this
repo run 3–8 KB, so in practice the document arrives whole and the envelope grows by
roughly one diff's worth. Four times the cap is deliberate rather than cautious: a diff
is scanned for what moved, a design is read, and the part an implementer needs most —
what it costs, what it makes harder, what in the tree it reverses — is written last. A
diff-sized cap would cut exactly the sections that this document's own guidance says are
the point of writing one.

**Reading the file system, not just git.** The handoff's guarantee was "assembled from
what wecode observed, never from the agent", and it is easy to read that as "read out of
git". Git was never the guarantee — *not asking the agent* is. A file on disk at a path
the task itself declared is an observation of the same kind. But the sentence in
`lifecycle.md` and in `a2a_task`'s own doc comment said git, so both were corrected
rather than left to be reinterpreted.

**One more branch on `TaskKind` in rendering.** Small, and it is the only one in the
handoff. If a second kind ever wants a non-diff artifact, this is the shape to extend and
not to copy.

## What it does not do

**It does not commit the design.** A design still runs in the operator's checkout and
still leaves its document uncommitted there; nothing here changed `commit_attempt`, and
giving a design a worktree is a separate decision with its own consequences for where the
document then has to be merged from. What this closes is the reader's end.

**It does not verify that the document is the signed one.** The file read is whatever is
at that path now. A design signed on Monday and edited on Tuesday hands over Tuesday's
text without saying so. The dispatch gate already staleness-checks a signature against
task amendments, and doing the same for the file's content would want a hash recorded at
signing time — worth doing, not done here.

**It does not reach a design that is only an ancestor.** The handoff travels
`depends_on`, and in the `--expand` shape the build step is `after = ["design"]`, so the
common case is covered. A design that is a *sibling with no edge to the work* still hands
over nothing, which is the ordering relation saying what it has always said: no edge, no
handoff.
