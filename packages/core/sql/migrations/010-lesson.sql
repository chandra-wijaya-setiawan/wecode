-- What an attempt learned, kept where the next one will read it — docs/design/17.
--
-- Against the project rather than the task: the thing a lesson is about is the repository,
-- and the task that hit it first is not what it is about. `assignment_id` is attribution,
-- not ownership, so it survives as a number nobody can follow once the assignment is gone —
-- a lesson outliving its attempt is the whole point.
CREATE TABLE lesson (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES project(id),
  text          TEXT NOT NULL,
  assignment_id INTEGER REFERENCES assignment(id),
  created_at    TEXT NOT NULL
);

CREATE INDEX lesson_by_project ON lesson (project_id, id DESC);
