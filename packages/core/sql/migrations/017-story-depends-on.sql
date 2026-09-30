-- What a story is waiting on, and which of the ones that are not waiting to do first.
--
-- Every edge in the record until now is containment: an epic holds stories, a story holds
-- requirements, and the shape of the tree is the shape of the work. Containment cannot say
-- "checkout cannot start until the cart is done" — the two are siblings under one epic, so
-- the record draws them side by side and the allocator is free to pick either. That
-- ordering lived in the operator's head, and a machine that cannot read it will reliably
-- start the wrong one.
--
-- Two things arrive here, and they are two halves of one question. `story_depends_on` says
-- which stories are not yet eligible. `story.priority` says which of the eligible ones goes
-- first. A dependency is a fact about the work — checkout genuinely cannot be written
-- before the cart — and a priority is a preference about it; keeping them in separate
-- columns keeps a preference from being able to claim a story is blocked.
--
-- | column | what it holds |
-- |---|---|
-- | `story_id` | the story that is waiting |
-- | `depends_on_id` | the story it is waiting on |
--
-- The row is the edge and nothing else: no id, no slug, no state, no timestamps. A
-- dependency is not worked on and is not reported about, so it has no machine in
-- config/machines.yaml and no row interface in entities.ts — it is a pair of ids, the way
-- an index is. Adding `created_at` would invite somebody to ask when the dependency was
-- noticed, which is a question about the conversation and not about the work.
--
-- Direction is fixed by the names and only by them: `story_id` depends on `depends_on_id`,
-- so `depends_on_id` is the one that has to finish. `blocked_by`/`blocks` would have read
-- the same either way round, which is exactly the confusion an edge table has to avoid.
--
-- Both ends are NOT NULL. "Waiting on nothing" is not an edge, it is the absence of one.
--
-- The pair is the primary key, so an edge stated twice is one edge. Nothing about the
-- second statement is new — there is no `said_by` and no `said_at` to tell them apart —
-- and two rows would make "is this story blocked" a question with a count in the answer.
--
-- A story may not depend on itself. This is a CHECK and not policy read from config, by the
-- distinction 001 draws: which states exist is policy and changes without a migration,
-- whereas a story waiting on itself is not a rule somebody chose — it is a row that can
-- never be discharged, and a record that accepts one is a record that can deadlock. Longer
-- cycles are past what a CHECK can see and are left to the doctor, which is where a check
-- that has to walk the graph belongs; refusing the one-step cycle here costs nothing and
-- catches the typo that makes it.
--
-- Plain REFERENCES, no cascade, like every other foreign key in 001. Deleting a story that
-- something is waiting on is refused rather than quietly un-blocking the thing that waited.
CREATE TABLE story_depends_on (
  story_id      INTEGER NOT NULL REFERENCES story(id),
  depends_on_id INTEGER NOT NULL REFERENCES story(id),
  PRIMARY KEY (story_id, depends_on_id),
  CHECK (story_id <> depends_on_id)
);

-- The primary key indexes "what is this story waiting on". The other direction — "what is
-- waiting on this story", the one a lander asks the moment a story is delivered — would be
-- a scan without this.
CREATE INDEX story_depends_on_blocks ON story_depends_on (depends_on_id);

-- Which ready story to start first, among the ones nothing is blocking.
--
-- An integer, lower first, so the plain `ORDER BY priority` reading is the right one and a
-- story can always be squeezed in above another without renumbering the ones below it.
-- Unbounded in both directions on purpose: a fixed scale of one to five would be policy,
-- and policy does not go in a migration.
--
-- `DEFAULT 0` rather than NULL, and NOT NULL with it. Every story that exists today was
-- written before anybody could say, and 0 says "nobody has ranked this" in the same breath
-- as it sorts them together in the middle — whereas a NULL would sort to one end and quietly
-- make every unranked story either the most or the least urgent work in the record.
ALTER TABLE story ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
