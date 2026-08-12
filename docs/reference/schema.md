# The database

One file per workspace, `wecode.db`. Everything machine-written lives here; everything
hand-edited lives in `company.toml` (see [config.md](config.md)), because a binary blob
cannot be diffed, reviewed or opened in an editor.

Currently **schema version 3**. Tables: `projects`, `tasks`, `task_depends_on`, `task_scopes`, `project_measures`, `task_acceptance`, `sessions`, `audit_log`, `task_executions`.

## Shape

```
projects ──┬── project_measures
           └── tasks ──┬── task_depends_on   (many-to-many: comes after)
                       ├── task_scopes       (read and write globs)
                       ├── task_acceptance
                       └── task_executions   (one row per attempt)

sessions       who is connected
audit_log      every decision and observation
```

`tasks.parent_id` is a self-reference: at most one parent, hence a column.
`task_depends_on` is a join table because a task may come after several.

## Three columns that cannot be foreign keys

`projects.repo`, `tasks.assignee` and `sessions.post` name things declared in
`company.toml`. SQLite cannot reference a file, so they are validated in code on write.
That is the one real cost of keeping config in a file, and it is a deliberate trade.

`audit_log` deliberately has **no** foreign keys either: a ledger row survives the
deletion of the task it describes. Everything under `projects` cascades away.

## Two properties worth knowing

`audit_log.seq` is `AUTOINCREMENT`, which is what makes the ledger monotonic across
every process that writes to it — a per-process counter got this wrong once, and every
record claimed to be first.

The database runs in **WAL** mode, so the cockpit can read while a scheduler writes.

## Migrations

`user_version` holds the schema version. On open, `step_for` decides: up to date,
install, upgrade from here, or refuse.

Refusing matters. Before that arm existed, a database between versions matched neither
branch and was left un-migrated *while reporting success* — the caller then queried
columns the file did not have. Upgrades are an ordered list applied in sequence, and a
gap in the chain is refused rather than half-applied.

## Full DDL

The schema as it actually is, extracted from `crates/wecode-store/src/schema.rs`:

```sql
CREATE TABLE projects (
    id            TEXT PRIMARY KEY,
    repo          TEXT NOT NULL,      -- a [[repos]] name; checked in code
    objective     TEXT NOT NULL,
    status        TEXT NOT NULL,
    budget_tokens INTEGER,
    budget_wall   INTEGER,
    -- Filed away by the operator. STRICT tables have no BOOLEAN, hence INTEGER.
    -- Display only: archiving never changes what is dispatchable.
    archived      INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE tasks (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    -- hierarchy: is part of. At most one parent, hence a column.
    parent_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    status        TEXT NOT NULL,
    assignee      TEXT,               -- a [[posts]] name; checked in code
    budget_tokens INTEGER,
    budget_wall   INTEGER
) STRICT;

CREATE INDEX tasks_by_project ON tasks(project_id);
CREATE INDEX tasks_by_parent  ON tasks(parent_id);
CREATE INDEX tasks_by_status  ON tasks(status);

-- scheduling: must come after. Many-to-many, hence its own table.
CREATE TABLE task_depends_on (
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    prerequisite_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, prerequisite_id)
) STRICT;

CREATE TABLE task_scopes (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    access  TEXT NOT NULL,            -- 'read' | 'write'
    glob    TEXT NOT NULL,
    PRIMARY KEY (task_id, access, glob)
) STRICT;

CREATE TABLE project_measures (
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,   -- keeps author order stable
    kind          TEXT NOT NULL,      -- 'command'|'metric'|'deliverable'|'judged'
    cmd           TEXT,
    expect_status INTEGER,
    name          TEXT,
    target        REAL,
    cmp           TEXT,
    path          TEXT,
    note          TEXT,
    PRIMARY KEY (project_id, seq)
) STRICT;

CREATE TABLE task_acceptance (
    task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    cmd           TEXT,
    expect_status INTEGER,
    name          TEXT,
    target        REAL,
    cmp           TEXT,
    path          TEXT,
    note          TEXT,
    PRIMARY KEY (task_id, seq)
) STRICT;

CREATE TABLE sessions (
    id        TEXT PRIMARY KEY,
    post      TEXT NOT NULL,          -- a [[posts]] name; checked in code
    agent     TEXT NOT NULL,
    human     TEXT,                   -- NULL means autonomous
    opened    INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    closed    INTEGER                 -- NULL while open
) STRICT;

CREATE TABLE audit_log (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    post       TEXT NOT NULL,
    agent      TEXT NOT NULL,
    human      TEXT,
    project_id TEXT,
    task_id    TEXT,
    source     TEXT NOT NULL,         -- 'broker'|'supervisor'|'harness'
    action     TEXT NOT NULL,
    target     TEXT NOT NULL,
    outcome    TEXT NOT NULL,         -- 'allow'|'deny'|'alarm'|'approval'
    mode       TEXT,                  -- 'regimented'|'sanctioned'
    detail     TEXT NOT NULL
) STRICT;

CREATE INDEX audit_by_task    ON audit_log(task_id);
CREATE INDEX audit_by_project ON audit_log(project_id);
CREATE INDEX audit_by_outcome ON audit_log(outcome);

-- One run of one task. The execution is the entity; `attempt` is which try it is.
--
-- Deferred until something wrote it, which is why `spent_tokens` is absent: nothing
-- counts tokens yet, and a column that is always NULL is a guess wearing a schema.
-- `pid` is written at spawn and left behind if wecode dies, so a row still saying
-- `working` is exactly the recovery information wanted.
--
-- No foreign key on session_id: the ledger and its executions outlive sessions.
CREATE TABLE task_executions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id  TEXT NOT NULL,
    attempt     INTEGER NOT NULL,
    status      TEXT NOT NULL,          -- A2A's eight states
    worktree    TEXT,
    pid         INTEGER,
    started     INTEGER NOT NULL,
    ended       INTEGER,
    wall_secs   INTEGER,
    detail      TEXT NOT NULL DEFAULT '',
    UNIQUE (task_id, attempt)
) STRICT;

CREATE INDEX executions_by_task ON task_executions(task_id);
```
