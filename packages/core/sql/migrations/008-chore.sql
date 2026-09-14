-- Work wecode created for itself. docs/design/18.
--
-- A chore is not a task: it proves no acceptance_test, so it hangs off no test. It hangs
-- off the project it serves and names its target — the story whose branch will not merge,
-- the project whose lessons need sweeping — as a (type, id) pair rather than one nullable
-- foreign key per kind.
--
-- `check` is the one command that says whether it worked. A chore is proved by that and
-- never by a task_test, which is why there is no child table here. The name collides with
-- SQL's CHECK keyword, so every statement that touches the column quotes it.
--
-- (kind, target_type, target_id) is unique. A condition stays true for as long as nobody
-- has fixed it, and the runner is level-triggered: it reads that condition on every tick.
-- Without this constraint a story that will not merge grows one chore a second. The
-- constraint, not a flag the runner has to remember to set, is what makes it one.
--
-- `approved_at` is null until a person says go. Only the kinds that ask for approval
-- consult it — which kinds those are is the interpreter's table, not a column here, for
-- the same reason `state` is not a CHECK: two copies of a rule disagree eventually.
CREATE TABLE chore (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  project_id  INTEGER NOT NULL REFERENCES project(id),
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  "check"     TEXT NOT NULL,
  state       TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (kind, target_type, target_id)
);

CREATE INDEX chore_target  ON chore (target_type, target_id);
CREATE INDEX chore_project ON chore (project_id);
CREATE INDEX chore_open    ON chore (state) WHERE state <> 'done';
