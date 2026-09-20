-- A design: the mockup a person signed before anybody drew it.
--
-- UI work that skipped this produced eight boxes nobody asked for and a fifth row drawn
-- over the fourth. The fix is not more review at the end — it is a row that exists before
-- the drawing does, naming the picture and naming the person who approved it. Until this
-- table, "the wireframe was signed off" lived in a conversation, so nothing could be asked
-- and nothing could refuse.
--
-- | column | what it holds |
-- |---|---|
-- | `story_id` | the story the design is for — the level a person decides at |
-- | `title` | what the design is of, in the words the person would use |
-- | `mockup` | where the picture is: a path in the repo, not a URL and not prose |
-- | `signed_by` | the worker who approved it, NULL until somebody has |
-- | `signed_at` | when they did, NULL with it |
--
-- `mockup` rather than `artefact`: a test's artefact is something to run, a design's is
-- something to look at, and one name for both would let `artefact_resolves` be pointed at
-- a picture.
--
-- `signed_by` names `worker.name` rather than `worker.id`, the same way `task.role` names a
-- role: a signature outlives the row of whoever gave it, and a foreign key that took the
-- signature away when a worker was deleted would be the record forgetting an approval.
-- `signature_is_a_persons` is what holds it to a human; the schema does not, because who
-- may sign is policy and policy is not a CHECK constraint.
--
-- `state` holds a value from the design machine in config/machines.yaml, by the convention
-- 001 sets: the table does not constrain it, the interpreter does.
CREATE TABLE design (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL,
  story_id   INTEGER NOT NULL REFERENCES story(id),
  title      TEXT NOT NULL,
  mockup     TEXT NOT NULL,
  signed_by  TEXT,
  signed_at  TEXT,
  state      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (story_id, slug)
);
