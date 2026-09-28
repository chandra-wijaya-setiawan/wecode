# A story landed outside wecode can never be recorded as landed

**Status:** waiting for human approval. Reported 2026-09-23 from workspace `cws`,
project 107 (`student-success-competition`), schema 19.

**Severity:** high. Work merged by hand is re-offered to the lander forever, and a
tick that acts on that offer can rewrite an integration branch a human is using.

---

## The shape of the problem

wecode is meant to own a slice of a repository while everyone else works around it.
Today it cannot. The landing record has no way to say *this story shipped, and not
through you*, so any story delivered and merged outside the runner stays accused for
the life of the workspace. That turns a tool meant to enable a mixed team into one
that only tolerates work it performed itself.

## Steps to reproduce

1. In a workspace at schema 19, create a project, release, epic and story, and take
   the story to `delivered`. That is its terminal state; nothing follows it.
2. Land the work by hand: merge `story/<slug>` into the project's base branch in the
   base checkout, then delete the branch. Deleting is not a mistake — `docs/design/14`
   lists it as the final step of landing.
3. Let the runner tick, or run the doctor.
4. `delivered_story_has_landed` reports the story. A merge chore is raised.
5. Close the chore. The accusation regenerates, because it is derived from the story's
   state rather than from the chore.
6. Try the two documented escapes: record the landing commit, or mark the story as
   landed elsewhere. Neither exists. `PRAGMA table_info(story)` returns exactly
   `id, slug, epic_id, title, state, created_at, updated_at`.

## Evidence

`packages/core/dist/invariants.js`, `deliveredStoryHasLanded`:

```js
.filter((n) => n.state === "delivered"
  && (n.landed_sha ?? null) === null
  && !landedElsewhere(n.landed_elsewhere))
```

Both guards read columns the schema does not have, so both are always false and no
story can ever be excluded. Driving the real function with a row shaped as schema 19
stores it:

| Case | Accusations |
|---|---|
| Schema-19 story row | 1 |
| Same row with `landed_sha` set | 0 |
| Same row with `landed_elsewhere` set | 0 |
| Branch still an ancestor of the base | 0 |
| Branch deleted after a correct landing | 1 |

The last two rows are `keepUnlanded`, the only check that works at schema 19. It asks
whether `story/<slug>` is still an ancestor of the base — so the designed final step,
deleting the branch, is what converts a correctly landed story into a permanent
violation. The cleanup and the audit contradict each other.

## Why adding the columns is not the fix

New columns are empty. Every existing delivered story still has no commit recorded and
is still accused, and a backfill has nothing reliable to read because the branches are
already gone.

There is a second problem underneath. The landing commit is written by the lander. An
audit whose purpose is to catch the lander failing would then be asking the lander's own
bookkeeping whether it succeeded. If the column existed and were set, the check would
pass without ever looking at the repository.

## Proposed solution

**1. Record the landing, and verify it rather than trust it.** Add `landed_sha` and
`landed_elsewhere` to `story`. Then have the invariant ask git whether the recorded
commit is an ancestor of the base, instead of asking whether the branch still is. A
commit survives branch deletion, so the check keeps working after the designed cleanup,
and it is a question about the repository rather than about the record.

**2. Give the orchestrator a way in.** A verb — `wecode story landed <id> --sha <sha>`
— that records a landing performed outside the runner. With (1) in place it is
self-verifying: a wrong sha fails the ancestry check and the story stays accused, so the
escape hatch cannot be used to lie.

**3. Backfill honestly.** For stories already delivered with no record and no branch,
mark `landed_elsewhere` with a note rather than inventing a commit. An unverifiable
past is better recorded as unverifiable than as a sha `git show` cannot find.

**4. Make the accusation safe while unresolved.** A raised merge chore should not be
able to rewrite a branch that has moved on since the story was delivered. Today the
integration branch carries no lease, so a tick and a human can write to it at the same
time; that happened in this workspace on 2026-09-22 and re-merged 85 commits over
eleven minutes.

## What this looked like in practice

Project 107's sixteen stories were all delivered and merged by hand into the feature
branch. Fifteen merge chores were raised. They are quiet now only because they were
closed into a terminal failed state and the story branches were deleted — two accidents,
not a resolution. Any sweep or reopen brings them back.
