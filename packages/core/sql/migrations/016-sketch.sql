-- A sketch: a drawing made before there is any work to hang it on.
--
-- Every other picture in this record arrives late. A `design` needs a `story_id`, so it
-- cannot exist until somebody has already decided the story is worth writing down — which
-- means the drawing a person does *first*, to find out whether there is a story at all,
-- has nowhere to live. It lived in a browser tab, and the tab got closed.
--
-- | column | what it holds |
-- |---|---|
-- | `name` | what the operator calls it — their word, not a generated one |
-- | `kind` | what sort of drawing it is |
-- | `says` | one line on what it is for, so a list of these can be read |
-- | `html` | where the drawing is: a path in the repo, not a URL and not prose |
-- | `story_id` | the story it was promoted into, NULL until one exists |
--
-- No parent, and that is the design rather than an omission. A sketch is drawn before
-- there is work, so there is nothing above it to hang from: a NOT NULL parent would mean
-- inventing a story to hold the drawing that was supposed to decide whether to write one.
-- `story_id` is the reverse direction — the story this sketch *became*, recorded after the
-- fact, the way `lesson.assignment_id` records the attempt a lesson came out of. It is an
-- outcome, not an owner, and nothing cascades along it.
--
-- No `state` either, and so no row in config/machines.yaml. A state machine is for a thing
-- that is worked on; a sketch is drawn and then it is either kept or it is not. `there or
-- gone` needs no vocabulary, and giving it `draft`/`final` would be inviting a workflow
-- onto the one artefact whose value is that it has none.
--
-- `kind` is not constrained here, by the convention 001 sets for `state`: which kinds
-- there are is policy, and policy read from a CHECK constraint can only be changed by a
-- migration. `html` rather than `mockup` because that is what it is — a file a browser
-- opens, held as the path so the drawing stays in the repo and the record stays small.
--
-- `name` is not UNIQUE. An operator redrawing the same idea twice has made two sketches,
-- and refusing the second would be the record deciding which of them is the real one.
CREATE TABLE sketch (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  says       TEXT NOT NULL,
  html       TEXT NOT NULL,
  story_id   INTEGER REFERENCES story(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
