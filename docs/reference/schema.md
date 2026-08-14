# The database

One file per workspace, `wecode.db`. Everything machine-written lives here; everything
hand-edited lives in `company.toml` (see [config.md](config.md)), because a binary blob
cannot be diffed, reviewed or opened in an editor.

Currently **schema version 6**. Tables: `projects`, `tasks`, `task_depends_on`, `task_scopes`, `project_measures`, `task_acceptance`, `sessions`, `audit_log`, `task_executions`, `worktrees`, `inbox_cursor`.

## Shape

```
projects ──┬── project_measures
           └── tasks ──┬── task_depends_on   (many-to-many: comes after)
                       ├── task_scopes       (read and write globs)
                       ├── task_acceptance
                       └── task_executions   (one row per attempt)

sessions       who is connected
audit_log      every decision and observation
worktrees      the checkouts wecode made, and which are still standing
inbox_cursor   how far each reply channel has been read
```

`tasks.parent_id` is a self-reference: at most one parent, hence a column.
`task_depends_on` is a join table because a task may come after several.

## Three columns that cannot be foreign keys

`projects.repo`, `tasks.assignee` and `sessions.post` name things declared in
`company.toml`. SQLite cannot reference a file, so they are validated in code on write.
That is the one real cost of keeping config in a file, and it is a deliberate trade.

`audit_log` deliberately has **no** foreign keys either: a ledger row survives the
deletion of the task it describes. Everything under `projects` cascades away.

`worktrees.task_id` is unreferenced for the same reason. Deleting a task does not delete
the directory, and a row that cascaded away would turn one of wecode's own checkouts back
into a stranger — which is the exact confusion the table exists to end.

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

Each step stays frozen at the shape it produced. The 2→3 step still creates
`task_executions` without `spent_tokens` and the 3→4 step adds the column, because
every file that already ran the older step would otherwise never be given it.

Nothing is backfilled. The 4→5 step creates `worktrees` empty, even for a workspace with
checkouts already on disk: wecode made them and cannot prove when, and inventing a
creation date would put a fact in the database that nobody observed. They are recorded
the next time `wecode start` prepares them.

The 5→6 step creates `inbox_cursor` empty for the same reason, and there it is
load-bearing: a guessed cursor is a claim about which chat replies have already been
handled. Too low re-reads a month of conversation, too high swallows the reply that is
waiting. Absent means "read nothing", which the fetch asks for as offset 0.

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
    -- Parks the project: hidden, never promoted or dispatched, and not counted as
    -- competition for files by the admission gate. All of it reverses on unarchive.
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
-- `pid` is written at spawn and left behind if wecode dies, so a row still saying
-- `working` is exactly the recovery information wanted.
--
-- `spent_tokens` was held back until something counted them, and is nullable because
-- the two cases are different facts: NULL is an agent whose output wecode cannot read
-- a count out of, 0 is a run that reported burning nothing. Collapsing them would
-- make every unmetered agent look free. `wall_secs` beside it is measured here;
-- `spent_tokens` is the agent's own report, and the ledger row for the same run
-- carries that provenance.
--
-- No foreign key on session_id: the ledger and its executions outlive sessions.
CREATE TABLE task_executions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id   TEXT NOT NULL,
    attempt      INTEGER NOT NULL,
    status       TEXT NOT NULL,         -- A2A's eight states
    worktree     TEXT,
    pid          INTEGER,
    started      INTEGER NOT NULL,
    ended        INTEGER,
    wall_secs    INTEGER,               -- measured by wecode
    spent_tokens INTEGER,               -- reported by the agent; NULL if unmetered
    detail       TEXT NOT NULL DEFAULT '',
    UNIQUE (task_id, attempt)
) STRICT;

CREATE INDEX executions_by_task ON task_executions(task_id);

-- The worktrees wecode made, so a directory git hands back can be told apart from one
-- another tool created. Keyed on the path because that is what git reports and what a
-- listing has to match against.
--
-- No foreign key on `task_id`, and that is the point rather than an oversight. The row
-- has to outlive the task: a tree whose task was deleted is still a directory wecode
-- put on disk, and a row that cascaded away would turn it back into the stranger this
-- table exists to distinguish it from. `task_executions.session_id` stands unreferenced
-- for the same shape of reason.
--
-- `removed` is a tombstone rather than a delete: *we made one here and tore it down*
-- and *there was never one here* are different facts, and the second must not be able
-- to impersonate the first. So the uniqueness is a partial index — one live row per
-- path, any number of dead ones — and a path can therefore be used a second time
-- without erasing what stood there before.
CREATE TABLE worktrees (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    path    TEXT NOT NULL,
    repo    TEXT NOT NULL,      -- a [[repos]] name; the repo is the unit, not the project
    branch  TEXT NOT NULL,
    task_id TEXT NOT NULL,      -- the main task; subtasks share the tree and own none
    created INTEGER NOT NULL,
    removed INTEGER             -- NULL while it stands
) STRICT;

CREATE UNIQUE INDEX worktrees_live    ON worktrees(path) WHERE removed IS NULL;
CREATE INDEX        worktrees_by_task ON worktrees(task_id);

-- How far a reply channel has been read. One row per channel; `telegram` is the
-- only one today.
--
-- Not derivable from the ledger, which is why it is a table. A signature records
-- that a holder approved something; it cannot record that a particular *message*
-- has been looked at, and a message that says `no` leaves no signature at all yet
-- must still not be read a second time. `last_id` is the highest update the channel
-- has handed over, whatever came of it.
CREATE TABLE inbox_cursor (
    channel TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL,
    at      INTEGER NOT NULL
) STRICT;
```

## Which worktrees are ours

`worktrees` answers one question the rest of the schema cannot: git reports a directory —
did wecode put it there?

Nothing derived can answer it. The path of a checkout is a pure function of the owning
task, so wecode can always compute where a tree *would* be. It cannot compute whether the
tree it finds is one it made, and another tool keeping worktrees in the same repository is
then indistinguishable from a tree of ours whose task is gone. One is a stranger, the
other is an orphan, and treating them alike is how `wecode worktree` came to print 27 rows
for 4 real checkouts.

`task_executions.worktree` is not the same fact. That says which tree an attempt ran in,
and only `wecode run` opens an execution row — a tree made by `wecode start` would leave
no trace at all. What went unrecorded was an event, not an association, so it needed a
table rather than a column.

Rows are written in `prepare`, which both `start` and `run` go through, and closed when the
tree comes down — by `wecode worktree remove`, or by `wecode merge` once the work has landed
and nothing sharing the tree is still open. Closed **after** git agrees, so a removal that
failed leaves the row saying the tree stands, because it does. An absent directory closes its
row anyway: a row claiming a directory that is provably gone is worse than no row.

The scratch checkout a merge borrows for the integration branch is not recorded: it is created
and torn down inside one command, and belongs to no task. `wecode worktree` recognises it by
its path instead — it is always `<run root>/<org>/.merge` — so the one case where it outlives a
command reads as ours rather than as a stranger's, and `wecode worktree remove <path>` clears
it without needing a row.

Reading the table is `wecode worktree`'s job, and it asks the plan before the registry: a
path that is still the one wecode would compute for a live task is that task's, recorded or
not. That is what keeps a checkout made before the 4→5 upgrade from reading as a stranger,
and it is sound in the one direction a derivation can answer. The registry is what answers
the other — a path with no task at all.

## What a run cost, in two places

A finished run writes its cost twice, and the difference is the point.

`task_executions.spent_tokens` is the count for that attempt, so a task that took three
tries can say which one was expensive. The ledger gets an `Action::Spend` row for the
same run — `<tokens>t/<secs>s` in `target` — because that is what the board rolls up,
and because a spend needs a `source` beside it. The clock is wecode's own, so a run that
reported no tokens is filed as `supervisor`; a run that reported some is filed as
`harness`, because nothing sits between an agent and its model for wecode to count at.
A record is only as admissible as its weakest half.

`Action::Spend` has no room for an absent count, so a `supervisor`-sourced spend row
reads `0t/45s`: the seconds are the fact it carries, and the zero means there was no
token count to record rather than that none were spent. `task_executions.spent_tokens`
is where that difference is kept, because a nullable column can hold it and a `u64`
cannot.

Both are written however the run ended. A run killed on its wall limit spent what it
spent, and a cost recorded only for clean exits would hide exactly the expensive
failures.

## What a merge left behind is not in here

There is no `merges` table and there is not going to be one. Which merge commit landed a
task is read out of git — the merge message names the task, and a second copy in the
database could disagree with the branch. The report that summarises the whole task is
committed to the repository as `docs/wecode/<task>/report.md`, for a reason this file
cannot fix: the database is the company's, and the company is not the repository. Whoever
opens the repo six months from now is not opening `wecode.db`.

So the two halves of a landed task's record sit where each is readable. The ledger holds
the events — the approval, the spend, the decisions — and answers *what happened, in
order*. The repository holds one generated document per task and answers *what this task
did*, to a reader who has only the code.
