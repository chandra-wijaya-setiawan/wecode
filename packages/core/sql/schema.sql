-- The record. Nothing is true that is not in here.
--
-- One table per entity, and the shape follows docs/design/07. Two conventions:
--   * `state` holds a value from that entity's machine in config/machines.yaml. The table
--     does not constrain it; the interpreter does, because the machine is data and a CHECK
--     here would be a second copy to keep in agreement.
--   * scope and budget are JSON. They are read whole and written whole, never queried into.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_version (version INTEGER NOT NULL);

CREATE TABLE workspace (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE project (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL,
  workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  name         TEXT NOT NULL,
  repo         TEXT NOT NULL,
  objective    TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE release (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL,
  project_id  INTEGER NOT NULL REFERENCES project(id),
  version     TEXT NOT NULL,
  released_at TEXT,
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE epic (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL,
  release_id INTEGER NOT NULL REFERENCES release(id),
  title      TEXT NOT NULL,
  state      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (release_id, slug)
);

CREATE TABLE story (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL,
  epic_id    INTEGER NOT NULL REFERENCES epic(id),
  title      TEXT NOT NULL,
  state      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (epic_id, slug)
);

CREATE TABLE requirement (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL,
  story_id   INTEGER NOT NULL REFERENCES story(id),
  statement  TEXT NOT NULL,
  state      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (story_id, slug)
);

CREATE TABLE acceptance_criteria (
  id             INTEGER PRIMARY KEY,
  slug           TEXT NOT NULL,
  requirement_id INTEGER NOT NULL REFERENCES requirement(id),
  statement      TEXT NOT NULL,
  state          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (requirement_id, slug)
);

CREATE TABLE acceptance_test (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL,
  parent_id   INTEGER NOT NULL REFERENCES acceptance_criteria(id),
  statement   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  artefact    TEXT,
  last_run_at TEXT,
  last_output TEXT,
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (parent_id, slug)
);

CREATE TABLE task (
  id                 INTEGER PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  acceptance_test_id INTEGER NOT NULL REFERENCES acceptance_test(id),
  title              TEXT NOT NULL,
  scope              TEXT NOT NULL,
  role               TEXT NOT NULL,
  budget             TEXT NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  max_retry          INTEGER NOT NULL DEFAULT 3,
  state              TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE task_test (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL,
  parent_id   INTEGER NOT NULL REFERENCES task(id),
  statement   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  artefact    TEXT,
  last_run_at TEXT,
  last_output TEXT,
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (parent_id, slug)
);

CREATE TABLE role (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL,
  worker_kind TEXT NOT NULL,
  harness     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE worker (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- spec is written once; every status column is the runner's to overwrite.
CREATE TABLE assignment (
  id             INTEGER PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  objective_type TEXT NOT NULL,
  objective_id   INTEGER NOT NULL,
  worker_id      INTEGER NOT NULL REFERENCES worker(id),
  scope          TEXT NOT NULL,
  budget         TEXT NOT NULL,
  worktree       TEXT NOT NULL,
  phase          TEXT NOT NULL,
  reason         TEXT,
  kind           TEXT,
  question       TEXT,
  options        TEXT,
  answer         TEXT,
  answered_by    TEXT,
  session        TEXT,
  last_seen      TEXT,
  spent          TEXT NOT NULL,
  commit_sha     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX assignment_open   ON assignment (phase) WHERE phase IN ('pending', 'running', 'waiting');
CREATE INDEX assignment_object ON assignment (objective_type, objective_id);

-- Every transition that happened. Append only; nothing reads it to decide anything.
CREATE TABLE ledger (
  id         INTEGER PRIMARY KEY,
  entity     TEXT NOT NULL,
  entity_id  INTEGER NOT NULL,
  verb       TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  actor      TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE INDEX ledger_entity ON ledger (entity, entity_id);
