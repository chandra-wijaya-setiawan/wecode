# The freshness gate — refusing a diff whose governing document did not move with it

Documentation in this tree goes stale the ordinary way: someone changes the thing a page
describes and nobody opens the page. Martraire's *Living Documentation* names the cure —
**reconciliation**, a mechanical comparison between a document and its subject — and
[docs/design/living-docs.md](../../design/living-docs.md) already picks it as mechanism 2
of three. What was left open is which comparison, and where it runs. This decides that.

## The decision

A document declares, in front-matter, the paths it governs. A change to those paths that
does not also change the document is refused. The join is asked twice, of two different
things, because the two gates hold two different halves of it:

| gate | sees | asks | refuses |
|---|---|---|---|
| admission | the declared write globs | a write glob overlaps a `subject:` — is that document's own path in the write scope? | at planning time, before a budget is spent |
| verify | the branch diff | a changed path matches a `subject:` — is that document's path in the same diff? | on the verdict, beside a scope violation |

Admission's half exists because acceptance and scope are **frozen at creation**. Without
it, verify's refusal is unrepairable: the task cannot write the document it is being
failed for not writing, and the run dies holding a finding nobody in it may answer. That
shape has already cost this repo three tasks, and the playbook warns about it in prose —
this is the same warning as a check.

Admission compares globs with `globs_overlap`, the coarse prefix-containment rule scope
collisions already use, and coarse errs the right way here: it costs one line in a scope
declaration, never a failed run. Verify compares real paths with `glob::any_matches`, the
rule a write scope is enforced by — so a `subject:` line means exactly what a scope line
means, and nobody learns a second glob language.

## Why the diff, and not the history

The obvious reconciliation is over the tree: compare the document's last commit against
its subject's last commit, and call it stale when the subject is newer. It is rejected.
That form fails a task for staleness that existed before the task started — the same
pathology `.max-lines` has, where a file you never opened breaks your acceptance. The
ratchet survives it only because the number can move; here there is no number to move, so
one stale page on `master` would fail every task in flight, and the person it fails is
never the person who can fix it.

The diff form has for free the property the ratchet had to be engineered into: a run can
only be refused for coupling that run created. So it ships enforcing on the day it lands
— no idle period, no threshold that follows the tree, no debt inherited from anybody.

## What a document declares, and what stays silent

Front-matter carries `subject:` globs and the `class:` from living-docs.md. Only
hand-tended and evergreen pages are joined. **Generated** pages are excluded — a
generator's output moving is the generator's problem, and `commands.md` already moves
whether or not you touch it. **Records** are excluded and inverted later: an ADR or a
merge report edited after the fact is the defect, so the gate that eventually watches them
is the opposite one.

Absence of front-matter means *governs nothing*, and the gate never asks. That makes
coverage the thing that ratchets rather than a threshold, and it settles a collision that
would otherwise be waiting: `design-check.sh` reads a design's first line as its title, so
a `---` block at the top of one would fail the design gate. A design record declares no
subject, so the two conventions never meet.

## What "moved with it" does not mean

It means the document's path is in the diff. Not a size floor, not a similarity measure,
not a judgement about whether the edit was any good — a one-word change satisfies it. That
is deliberate and it is the whole modesty of the gate: `design-check.sh` already carries
form, an owner's signature carries substance, and what is left for a machine is the join.
The claim being enforced is only that whoever changed the subject had the page open at the
moment they still knew what changed.

There is no waiver and no per-run override flag. The two answers to a finding are *edit
the page* or *narrow its `subject:`*, and the second is not an escape hatch — it is the
page telling the truth about what it governs, which is the thing the gate is made of. A
flag would be a third state to maintain and the only one nobody would ever read.

## Where the code lands

Neither `verify.rs` nor `admission.rs` can take a line: both are exactly 1600, which is
`src` in `.max-lines`. The build task must therefore split, and the split is the one this
crate boundary already implies — a pure `wecode_core::docs` that parses front-matter and
joins two path lists, with the file reading done by the caller, exactly as `check_refusals`
takes a `Refusal` list it never opened. Core opens no files, and a document is somebody
else's repository's file.

The finding sits on `Verdict` beside `violations` and makes `passed()` false. It gets no
`git::refuse` note: a scope violation has a bad write to hold back, and an absence has
nothing in the tree to sanction. It is recorded, and that is all a record needs to be.

## What would show this was decided wrong

Over the first ten tasks the gate fires on, count how each finding was answered. If more
than half were answered by narrowing a `subject:` rather than by editing the page, the
subject lines are fiction and the gate is measuring the guesses in them. If a page is
given a subject so narrow it can never fire, the coverage is theatre — which is why the
sweep should print how many documents declare a subject and how many have ever fired, the
way `max-lines.sh` and `design-check.sh` both print the number they would allow. A check
nobody can see the reach of is a check nobody trusts the silence of.
