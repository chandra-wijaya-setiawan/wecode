# A verdict with no diff in it

Notes for `acceptance-only-verdict`. The question is narrow: `wecode verify` is built on
three findings and one of them stops applying when nobody was dispatched. What the
verdict says instead — and what it must stop saying — is decided here.

The task this is about is the one [manual-task-kind](../manual-task-kind/design.md)
added: `Doer::Person`, work that stops on an operator and advances on a signature. It is
also the shape record mode needs, since work a person already did is work no agent was
launched for either. Both arrive at verification from the side it was not built for.

## What happens today

`wecode verify` on a manual task is not merely uninformative. It is wrong three times
over, and each fault comes out of the same line: `judge` judges "wherever the work
happened", and where a task has no worktree that is **the operator's own checkout**.

- `verify::changed` reads that checkout's uncommitted and untracked files. Whatever the
  operator had in flight this afternoon becomes this task's diff.
- `violations` is asked whether those paths are inside the task's write scope. A manual
  task is admitted with no write scope at all — the gate stops asking, deliberately — and
  an empty scope refuses everything. So every dirty file in the operator's tree is filed
  against the task as a sanctioned denial, in the governance channel, under
  `Source::Supervisor`.
- The verdict therefore fails, and `judge` writes `failed` onto a task whose only claim
  was that a person would do it later. `notify::on_status_change` announces that.

The same fallback is *right* for the acceptance half. A manual task's probe — `test -n
"$TRAVELPAYOUTS_TOKEN"`, the bucket-exists check — belongs in the operator's environment,
which is the one place the credential is. One directory, two halves, and the fallback
that makes one of them correct is what breaks the other.

## The doer decides, not the tree

Three things could switch the diff half off, and only one of them is the property being
asked about.

Not the tree. `dir.starts_with(work::run_root())` is tempting because that is where the
damage comes from, but a spike is dispatched to an agent with `worktree = false` and
judged in that same checkout, and there the diff *is* the agent's work. A rule keyed on
the directory would stop reading the diff of the one dispatched kind that has no tree.

Not a flag on the invocation. `WECODE_LIVE` is per-invocation for a good reason — a tier
in the plan would be a standing instruction — but the argument does not transfer. A
`--no-diff` would let an operator turn off the diff half of an *agent's* verdict, which
is the one thing this module's opening sentence forbids: the diff always wins because it
is the only evidence that was not self-reported.

So `Task::is_dispatched()`, the predicate the admission gate already turns on three
times, decides a fourth thing. It is stored, it is in the plan, and every reader of a
verdict gets the same answer from it — a hand-typed `verify`, a retry, a board tick,
whatever record mode grows later. The rule is one sentence: **wecode judges the diff of
work it dispatched, and of nothing else.**

Concretely, `judge` skips both `verify::changed` and `verify::violations` for such a
task. Not "runs them and ignores the result" — the call to `violations` is what writes
refusals into the ledger and, in a tree wecode owns, what leaves a `git::refuse` note
behind. Nothing may run.

## Not read is not empty

`Verdict::changed` becomes an `Option<Changed>`, and `None` means nobody looked.

The bool alternative fails on the property that matters. `Changed::default()` is an empty
path list, and an empty path list is exactly what "we read the diff and the work is
missing" looks like — the module already carries a `Cell<bool>` called `owed` because
that ambiguity bit once. A verdict that never opened git must not be able to answer
`len()`, `is_empty()` or `delivered_nothing()` at all, and the type is where to say so.

The render follows from it. Where the block says `diff — 0 files` / `nothing changed` it
must instead say that the question was not put:

```text
chore aov-token  mint the Travelpayouts token
  in       /home/cws/projects/fares

diff — not judged
  nothing was dispatched for this task, so no diff is its own

acceptance
  ✓ test -n "$TRAVELPAYOUTS_TOKEN"                 exit 0

  ✓ its checks pass
    nothing here reports the work done — a signature does, and only a person has one
  needs-approval   unchanged
```

`0 files` beside a green check is the precise misreading `Verdict::passed` was built to
prevent, and printing it here would manufacture the finding out of nothing. The
acceptance block itself is byte-identical to an agent's, tiers included. A manual task's
probes are the ones most likely to be `live:`, so the deferred block matters more here
than anywhere else, and an operator who has learned to read one verdict has learned to
read both.

## Three outcomes, not two

`Verdict::passed()` keeps its meaning — *passed what was asked* — and a verdict with
nothing asked did not pass. That is the rule the module holds everywhere: a pass earned
by asking nothing is refused even for an empty `live:` marker.

What has to change is what follows from not passing. `judge` maps `!passed()` to
`Failed`, and there is a third state under that: a manual task is admitted with **no
acceptance at all**, so the ordinary case is zero checks, and "✗ nothing to judge by"
lands as a failure on work nobody has been asked about yet.

So the verdict reports one of three outcomes:

| outcome | when | means |
|---|---|---|
| passed | something was asked and all of it passed | the probes agree |
| failed | something was asked and some of it did not pass | a real finding |
| nothing asked | no check, no deferred check, no unjudgeable measure | this verdict has no content |

"Nothing to judge by" stays a **failure** on a dispatched task and becomes "nothing was
asked" on an undispatched one, and the asymmetry is the whole point. A dispatch was owed
evidence: an agent ran, and if nothing can say whether it worked, that is a fault. A
person's task was never held together by evidence in the first place — the signature is,
and it is the one piece of evidence in this system that was never an agent's word about
itself.

A measure no command can settle is a fourth line rather than a fold into the third. Once
the gate stops requiring executable acceptance, `Measure::Deliverable` becomes legal on a
task, and `run_tier` sends it to `unjudgeable`. Something *was* asked, so it is not
"nothing asked"; nothing can settle it here, so it is not a pass. It prints as it does
today and says who settles it.

## The verdict reports; the signature transitions

`judge` must not write a status onto a task it did not dispatch. Not `failed`, not
`done`, not `needs-approval` — the status line at the foot of the verdict prints the
status the task already had, and says `unchanged`.

This is the existing rule taken seriously rather than a new one: *nothing advances a
manual task but a signature*. The cost of getting it wrong is concrete. A probe that
fails before the person has done the work is the expected state, not a fault, and
`failed` would take the row out of `yours to do` — where it is the operator's whole
reminder — and put it somewhere nothing will ever ask them again. A verdict that cannot
move the task is a verdict safe to run at any time, before the work or after, which is
the only thing that makes a cheap probe worth having.

It follows that whatever record mode builds to take the signature is what transitions,
and it may run this verdict first and print it as the evidence beside the tap. The
verdict hands back an outcome; the command holding the signature decides.

## What the ledger holds, and the silence in it

The checks land exactly as they do now: one `Allow` per command with its exit code on the
line, `Source::Supervisor`, because running it was the supervisor's own permitted act.
That record is the durable half — the reason a probe is worth writing down even though it
cannot finish the task.

What is *not* there needs saying out loud somewhere a reader will meet it: no denial was
filed, and that is not a clean scope report. It is a scope question nobody asked. The
same words that make `deferred` a list rather than an `if` apply here.

## What this costs

A class of task whose verdict cannot fail for doing nothing. The empty-diff finding is
the sharpest thing wecode has — the quiet failure it was written for was a run that
delivered nothing and came back green — and record mode is a hole in it by construction.
Any task marked done by a person is a task exempt from the only check that catches
silence, so `--doer person` is a load-bearing flag and a way of buying an exemption from
the strongest guard in the system. That is the bargain the kind already struck; this
design widens the surface it applies to, and the answer is that the signature is
attributable and a green check on an untouched tree is not.

It also makes citing the work harder, and deliberately. The obvious next want is for the
record to name the commits the person made. It should not come from here: a tree wecode
did not confine carries whatever else the operator was doing, and attributing those files
to the task would be inventing attribution rather than observing it. If record mode wants
commits cited, the operator names them and their signature is what makes it admissible.

Two things in the tree say something else today, and both should move with this:

- `verify::verdict` asks `task.kind.needs_a_signature()` when it decides what a pass
  means. A manual **chore** answers no, so it falls through to `the branch is not merged
  — wecode merge <id> lands it`, pointing an operator at a branch that was never cut.
  `Task::needs_a_signature` is the doer-aware answer, and `wecode verify` is already
  supposed to be asking it.
- `crates/wecode-cli/src/commands/gov.rs` still gates `approve design` on the kind, so
  the signature this design leans on cannot yet be given to a manual chore. That is
  `manual-task-kind`'s third loose end, not this one's, and until it lands the honest
  reading of the output above is that the verdict is now correct and the gesture it points
  at is still missing.

## What would show this was decided wrong

An operator reading `diff — not judged` and going looking for the flag that turns it back
on. The line is meant to be read as *this task has no diff of its own*, and if it reads
as *wecode declined to check*, the wording is wrong even though the rule is right.
