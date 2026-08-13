# The merge report, kept

Status: **built**.

Notes for `merge-record`. They are here rather than on the task because a task has a
title and no description field.

## What went wrong

`wecode merge` builds the one document that says what a task actually did — the files
and their line counts, grouped by area; the acceptance commands that had to pass; what
the merge unblocked; what became of the worktree; the branch, the merge sha, and where
the target stood before. Then it prints it to a terminal and the terminal scrolls.

A week later, the surviving trace of a landed task is a merge commit and whatever the
plan still says about it. Both are thin. The merge commit knows its parents; it does not
know that acceptance was three commands, or that the tree came down, or that two other
tasks were waiting on this one. That was all in the report, and the report is gone.

This is the same fault the ledger exists to prevent, in the one place the ledger cannot
reach: the ledger is the company's database, and the company is not the repository. Six
months on, whoever reads the repo is not reading `wecode.db`.

## The file is the report

`docs/wecode/<task>/report.md`, committed on the integration branch, containing the
report **verbatim** inside a fence — plus a heading and two sentences saying who wrote
it.

Verbatim is the decision worth defending, because the obvious alternative is to render a
proper markdown document: sections as headings, the file list as a table. That would
read better and it would be wrong. This file is *evidence*, and evidence is the thing
that was produced, not a second telling of it. One generator means the committed text
and the terminal text cannot drift, and an operator comparing what they saw against what
landed is comparing identical bytes. Two renderers would be two accounts of one merge,
free to disagree the first time either is edited.

## Who wrote it

The record has a sibling. `docs/wecode/<task>/` is where the design gate already looks:

| file | author | admissible as |
|---|---|---|
| `design.md` | the design subtask, signed by a person | a proposal someone approved |
| `report.md` | wecode, from git and its own record | evidence |

That split is the reason for writing this one down at all. An agent's account of its own
work is inadmissible everywhere else in wecode — `.wecode/result.json` is asked for and
ignored, the handoff is assembled from git rather than from the agent, spend is marked
`harness` rather than `supervisor` precisely because the agent reported it. A `report.md`
an agent could have written would be inadmissible for the same reason, so it is generated
and never authored.

The path is fixed rather than configurable. The design gate's acceptance command is
`test -f docs/wecode/{{task}}/design.md`, a real command only because nobody has to
name the directory; a second, configured location for the sibling file could disagree
with it, and then one task's record sits in two places.

There is also no way to turn it off. A merge that leaves no record is the gap this
closes, and a switch for suppressing the record is a switch for suppressing the audit.
A project that does not want wecode committing to it declines by leaving `merge_to`
unset, which already means *do not merge this through wecode*.

## Its own commit, and why it has to be

The report names the merge sha. No commit can contain its own name, so the record cannot
be part of the merge commit and cannot be an amendment of it — amending changes the sha
the file just quoted. It is therefore a separate, ordinary commit on top:

```
* t: merge record          ← one parent
*   t: <title>             ← the --no-ff merge
|\
```

Not a merge commit itself, which matters more than it looks: `rollback` finds the merge
by grepping `git log --merges` for the task id, and a record commit that was also a merge
would be a second match sitting in front of the real one.

Only that one path is staged. `commit_all` sweeps a whole tree, which is right for an
agent's attempt and wrong here — when the integration branch is checked out in the
operator's own tree, the merge borrows that tree, and a stray untracked file of theirs is
not part of this record.

## The one line it cannot carry

The committed file has no line saying where it was committed. It cannot: that fact
postdates the file. So the terminal prints the file's exact text plus one line at the end
of `provenance`:

```
provenance
  branch     wecode/t
  merge      a1b2c3d4e
  target was 9f8e7d6c5
  record     docs/wecode/t/report.md @ 4e5f6a7
```

Last, because it is the only fact in the report that the report cannot contain — and in
`provenance` because that is where "where did this come from" already lives.

## Failing to record is not failing to merge

By the time this runs the merge has landed. Returning an error would tell an operator
their merge failed when it did not, and there is nothing left to undo — so `keep` cannot
fail. A record that did not land is a line instead:

```
  record     not written to docs/wecode/t/report.md
             git worktree add failed: No space left on device
```

Named by destination, because the operator's next move is to look there, find nothing,
and want to know why. This is the honest shape of the situation: the merge happened, the
note about it did not.

## Rollback keeps it

`rollback` reverts the merge and leaves `report.md` standing, and says so. A revert is a
new commit rather than a rewrite for exactly this reason — the merge *did* happen — and
deleting the record would leave the branch carrying a merge and a revert that nothing
accounts for. The report's own text is still true: it describes a merge that occurred,
and the revert is the next thing in the history.

## What this does not do

It does not write a record for `rollback`, or for a failed verification, or for a run.
Those are events in the ledger, and the ledger is the right place for events; this is the
one document that summarises a whole task at the moment the task stops changing. A repo
accumulating a file per event would be a worse ledger, not a better record.
