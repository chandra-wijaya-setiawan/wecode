---
class: hand-tended-state
subject:
  - "crates/wecode-core/src/admission.rs"
  - "crates/wecode-cli/src/verify.rs"
---
# Overlap is not conflict

Owner's challenge, 4 Sep 2026: *"modifying same file can hold; i don't think we
should do that. We can't avoid conflict; but the agent should do resolution —
either group them in the same story if similar, or assess risk of merge and back
off if too risky. Our threshold is too low."*

Largely right. What follows separates the part that is right from the part the
evidence contradicts, because both matter.

## What is wrong today
The gate refuses when two schedulable tasks' write globs **intersect at all**. It
therefore refuses on:

| Overlap | Real conflict? |
|---|---|
| both declare `docs/reference/**` and each appends its own page | **No.** Different files entirely |
| both declare `.max-lines` and each bumps a different row | **No.** One number each, git merges it |
| both declare `crates/**` and touch unrelated crates | **No.** The glob was lazy, not the work |
| both add a different function to the end of one file | **Rarely.** git merges disjoint hunks |
| both edit the same function | **Yes** |
| both add the same concept in different files | **Yes, and no gate here sees it** |

Four of six refusals are false. On 3–4 Sep that cost roughly twenty dispatch
attempts and most of an operator's evening, which is the actual bug.

## What the evidence says NOT to do
Let agents resolve freely. Tonight's own record, and the field's:

- `semantic-search-live` and `inbox-filter-query-pagination` were allowed to run
  concurrently on three shared files after the ordering edges were deleted. Their
  branches **took each other's commits**, `server.ts` conflicted in four places,
  and 999 verified lines were discarded because rebasing was worse than redoing.
- *"when five parallel Claudes rewrite the exact same base class for their own
  local needs, you're gonna end up with a merge conflict no neural net could ever
  untangle"* — and the practitioners who tried it report settling on **one agent
  at a time**, which is the outcome to avoid in both directions.
- Anthropic's own Agent Teams reportedly uses file locking, i.e. it requires
  file-disjoint tasks. Nobody has made free-for-all concurrency work.

So: raise the threshold, do not remove the gate.

## The decision — three tiers instead of one
1. **Append-only paths never conflict.** A path the project marks append-only
   (`docs/**`, `.max-lines`, `specs/**`) is excluded from the overlap test. This
   alone removes most of tonight's refusals.
2. **Same file, disjoint symbols, is allowed.** `wecode map` already parses the
   tree; the comparison becomes *do the declared scopes touch the same named
   symbols*, not *do the globs intersect*. A scope naming a component (the
   `components` feature, landed 4 Sep) is what makes this expressible.
3. **A dry-run merge decides the rest.** Before a real merge, rebase the branch
   onto the target in a scratch tree. Clean → land. Conflicting → the task goes
   back with the conflicting paths named, and **nothing is discarded**. This is
   the risk assessment the owner asked for, and it is measured rather than
   predicted.

## The owner's best idea, stated as a rule
**A symbol collision is a planning signal, not only a refusal.** If two tasks
want the same symbols, they are one piece of work: the gate should say *"these
two belong in one story"* and offer the move, rather than only telling the second
one to wait. That is the difference between a gate that teaches and a gate that
nags — and it is why `epic`/`story` exist.

## What stays refused, and why
Two tasks editing the same function, and any task whose branch fails the dry-run
rebase. Not because concurrency is dangerous in principle, but because the cost is
asymmetric: a false refusal costs a minute of sequencing, and a false permit cost
999 lines and an hour tonight.
