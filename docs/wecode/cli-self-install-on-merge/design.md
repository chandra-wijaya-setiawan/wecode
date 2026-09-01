# Installing the executable a merge just produced

Status: **decided, not built**.

Notes for `cli-self-install-on-merge`. What the build step knows about this decision it
knows from this file.

## The reach problem

`wecode approve` can be answered from a phone. Nothing else can. `telegram` closed the
one hole it was built for — a task that stops at 02:14 gets a tap instead of a walk to a
desk — and left `board`, `verify`, `task add`, `audit`, `check`, `rollback` where they
were: reachable from one directory, through `./wecode`, which is `cargo run`.

So the operator's reach is a property of their working directory. Two things follow, and
the second is the worse one. They cannot ask what is happening from anywhere else; and
the `wecode` they *do* run is whatever their checkout happens to be on, which after a
morning of branch-switching is nobody's idea of the released code. A stale binary that
answers confidently is worse than no binary.

The moment the code becomes the code is the merge. That is when a branch stops being one
agent's attempt and becomes what the project is, and it is the only moment in the
lifecycle where wecode already knows a sha it is willing to stand behind.

## The decision

A merge that lands on the integration branch builds the executable that repository
produces from the merge commit, and moves it to a path the operator named. It is a step
after landing, like teardown and like the record — reported in the report, and unable to
fail the merge.

Five parts, each with a cheaper alternative that is wrong.

**The opt-in is a destination, and it lives in `company.toml`.** One field on the repo
that already has to be declared:

```toml
[[repos]]
name     = "wecode"
path     = "~/projects/wecode"
installs = "~/.local/bin/wecode"   # absent → nothing is installed, silently
```

Naming a destination *is* the opt-in; a second boolean would be a second place for the
answer to live. It is not in the playbook, and that is the load-bearing half: the
playbook is committed inside the repository being merged, so a playbook field would let
any repository acquire the right to write to the operator's machine by committing a line
to itself. `company.toml` is hand-edited, outside every repo, by the person whose home
directory this is. It is the only file that can carry an authority to write outside a
repository, because it is the only one an agent cannot reach.

**Which repo is "wecode's own" is not inferred.** It is the one carrying `installs`. The
obvious alternative — compare `current_exe()`'s ancestry against the repo path and
recognise yourself — breaks precisely when the feature works: an installed wecode's
`current_exe` is `~/.local/bin/wecode`, which is under no repository at all. Detection
that fails on its own success is not detection.

**It builds; it does not copy anything that already exists.** Two artefacts are lying
around and both are the wrong bytes. `current_exe()` is the wecode from *before* the
merge — installing it would put yesterday's code on the PATH and name today's sha in the
report. The worktree's `target/debug/wecode` is the branch tip, which is not the merge
result whenever the target has moved since the branch was cut, and the worktree is torn
down a step earlier anyway.

So it compiles a checkout of the target branch — the same tree `git::tree_for` hands the
merge and the record, borrowed or scratch, dirty-tree refusal included — with
`CARGO_TARGET_DIR` pointed at the repository's own `target/`. A scratch worktree has a
cold cache, and a build from zero here would cost the minutes and the gigabytes
`plan.md` already complains about; sharing the cache makes the usual install a link
rather than a compile. Cargo locks the target directory, so a `cargo run` from the loop
blocks and neither corrupts.

This has a side effect worth more than the feature: it is the **first thing that ever
compiles the merge result.** Acceptance ran on the branch, pre-merge; both sides of a
merge can pass and the merge still not build. When that happens the report says
`master does not compile`, which the operator wants to know more urgently than they want
a new binary.

**Debug, the same profile the loop runs.** The operator's installed binary is then the
byte-identical artefact their cache already holds, so installing is usually free.
`cargo install --path crates/wecode-cli` is the idiomatic line and is rejected on three
counts: it forces release, so the merge path pays a full rebuild in a second target
directory; it installs into cargo's prefix and cargo's bookkeeping rather than the path
the operator named; and release code is code the loop has never run. The cost accepted
in exchange is disk — a debug binary is tens of megabytes, replaced every merge — and
the lever if that ever matters is a profile on the field, not a redesign.

**The write is a rename.** Copy to a temporary name in the destination's own directory,
`chmod 0755`, then rename over the destination. Writing in place gives `ETXTBSY` exactly
when the operator is running `wecode board`, and a rename swaps a directory entry while
leaving the running process on its old inode. A crash mid-copy leaves the previous
binary intact instead of a truncated one. Same directory because rename across
filesystems does not work.

## Where it declines, and how it says so

The automatic caller has to be able to decline, for the reason `teardown::after_landing`
does: nobody asked for this at this moment, so anything surprising is a report rather
than an action.

| situation | what happens |
|---|---|
| no `installs` on the repo | nothing, and nothing said — absent is an answer |
| the destination's directory does not exist | declines. Creating directories in someone's home is more than was asked |
| the destination is a directory, or a symlink | declines and names it. Renaming over a link replaces the link, not the file the operator thinks they installed |
| `cargo build` fails | reported with the exit code and the sha. The merge stands |
| the destination is not on wecode's own `PATH` | installs, and says so with the line to add. The install worked; whether a shell finds it is the shell's business, and a refusal would leave the operator with neither the binary nor a way to test the path |

None of these fail the command. By the time this runs the merge has landed, there is
nothing left to undo, and telling an operator their merge failed when it did not is the
same lie `record::keep` refuses to tell. It also matters *which* retry the report
suggests: re-merging is the one response that makes things worse — git counts the branch
merged and the second attempt lands nothing — so the way to try again is
`wecode install`.

Which is the other caller. `wecode install [--repo <name>]` runs the same function on
demand: the escape hatch after a decline, and the only way the *first* install can
happen at all, since bootstrapping reach out of a merge you must already be at a
terminal to run is circular.

## What records it

A line in the merge report, beside the other fact a merge creates about the machine:

```text
summary
  2 files, +225 −64
  how        signed off
  worktree   removed /home/cws/.wecode/run/cws/cli-self-install-on-merge
  install    ~/.local/bin/wecode ← 4e5f6a7 (debug)
  undo       wecode rollback cli-self-install-on-merge   (was 407063de2)
```

and on a decline, named by destination, because the operator's next move is to look
there and find the old binary:

```text
  install    not installed to ~/.local/bin/wecode
             cargo build failed (exit 101) on 4e5f6a7 — master does not compile
```

No new ledger row. `report.md` is committed, generated, and already the document that
says what a merge did; a second record of the same event in `wecode.db` would be a
second thing to keep in agreement. `wecode install` prints the same line from the same
renderer.

## No agent installs anything

The parity row for this action is deliberately empty, and it is an authority answer
rather than a capability one. The destination is outside every write scope by
construction, and a seat that could write there could replace the supervisor's own
executable — which is arbitrary code execution as the process that enforces the Broker,
i.e. the one hole that makes every other check advisory. `never_touch` is exactly this
rule; this feature is compatible with it because the installer is the supervisor acting
after the work became evidence, never a task with a widened scope. That is the same
argument `teardown` makes for holding cloud credentials the worker never sees, and the
same reason `plan.md` still refuses deploy as a task kind.

## What would show this was decided wrong

- An operator running `wecode` from the PATH and getting an answer that disagrees with
  the repository. The binary cannot yet say which commit it is — there is no
  `--version` carrying a build stamp — so today the answer is only in the report. That
  gap is named, not closed, and it is the first thing to build if this confuses anybody.
- Merges getting slower. The shared cache is the bet; a cold build on the merge path
  would mean the bet lost, and the fix is to install from a warm tree only and decline
  otherwise.
- A second destination appearing — a per-project override, a `--prefix` — which would
  mean one machine's `wecode` is two binaries and nobody knows which one answered.
