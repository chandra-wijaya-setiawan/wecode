# The database

One file per workspace, `wecode.db`. Everything machine-written lives here; everything
hand-edited lives in `company.toml` (see [config/company.md](config/company.md)), because a binary blob
cannot be diffed, reviewed or opened in an editor.

Currently **schema version 11**. Tables: `projects`, `tasks`, `task_depends_on`, `task_scopes`, `project_measures`, `task_acceptance`, `sessions`, `audit_log`, `task_executions`, `worktrees`, `inbox_cursor`, `short_numbers`.

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
short_numbers  the number each project and task also answers to
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

`short_numbers.id` is unreferenced for a third variant of it: the row has to outlive the
task so the number it held is never handed to anything else. See below.

## Two properties worth knowing

`audit_log.seq` is `AUTOINCREMENT`, which is what makes the ledger monotonic across
every process that writes to it — a per-process counter got this wrong once, and every
record claimed to be first.

`short_numbers.n` is `AUTOINCREMENT` for the mirror reason. Without it SQLite reuses the
highest free rowid, so deleting the newest task would hand its number to the next one
created — and a notification sent six hours ago saying `#7 needs your signature` would
then sign something nobody had looked at. `sqlite_sequence` remembers the high-water mark,
so a number is never handed out twice however much is deleted.

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

The 8→9 step adds `task_executions.replayed_tokens` and leaves it NULL on every attempt
already in the file, which is the same rule read one more time. Those runs re-read
whatever they re-read; the figure was printed on a run line and kept nowhere. `DEFAULT 0`
would replace *nobody wrote this down* with *this conversation had no cache behind it*,
and the second is a claim about the past.

The 5→6 step creates `inbox_cursor` empty for the same reason, and there it is
load-bearing: a guessed cursor is a claim about which chat replies have already been
handled. Too low re-reads a month of conversation, too high swallows the reply that is
waiting. Absent means "read nothing", which the fetch asks for as offset 0.

**The 6→7 step is the exception, and deliberately.** It creates `short_numbers` and then
backfills every project and task already in the file. Nothing about that is a claim about
the past: a short number is a name being minted now, and minting it during the upgrade is
exactly as valid as minting it at `task add`. Not backfilling would leave a workspace
where the only things without handles are the things already in it — which is every
workspace that has been used. Projects first, then tasks, each in id order, so the same
file restored on another machine is numbered the same way.

The 9→10 step adds `tasks.doer` with `DEFAULT 'agent'`, and that default is a record
rather than a guess — the same distinction 8→9 turns on, read from the other side. Until
this column existed there was no way to say *a person does this*: the flag that says it
refused the task outright instead of recording half of it. So every task already in the
file is an agent's, writing that down claims nothing about the past, and it is the reading
that leaves the scheduler doing tomorrow exactly what it did yesterday.

The 10→11 step adds `tasks.steps` and leaves it NULL, which is 8→9's rule again rather
than 9→10's — one step apart, opposite answers, and the difference is whether a default
would be a record. A task already in the file *was* described to whoever did it: in a
conversation, in an issue, in the envelope an agent is handed at dispatch. None of that
was ever in this column, and there is no value here that would be true of it. Writing the
title in would turn *nobody wrote instructions* into *the instructions are the title
again*, which is the exact distinction the column exists to make.

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
    -- 'agent' | 'person'. Who does the work, which is a different axis from what the
    -- work is: provisioning a bucket by hand is still a chore. Its own column for
    -- exactly that reason, rather than another `kind`.
    --
    -- The one column here that authority depends on. A task read back as an agent's is
    -- one the tick promotes and dispatches, so a person's task losing this on a restart
    -- hands an agent the step that exists to keep the credentials away from it. Hence
    -- `NOT NULL`: absent must not be able to mean `agent` by accident, only by default.
    doer          TEXT NOT NULL DEFAULT 'agent',
    title         TEXT NOT NULL,
    -- What whoever does this is told to do, as written. Beside the title because it is
    -- the same thing at length: an agent's task is described to it at dispatch, out of
    -- the plan and the repository, and a person's task has no dispatch to be described
    -- at — the notification *is* the briefing, so the words have to exist before it.
    --
    -- NULL, not '': the absence is a real state and a reported one, since a person's
    -- task with nothing here reaches a phone as a bare title. Nothing writes an empty
    -- string, so nothing has to tell the two apart.
    steps         TEXT,
    -- hierarchy: is part of. At most one parent, hence a column.
    parent_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    status        TEXT NOT NULL,
    -- Filed away by the operator, with everything that is part of it. Display only,
    -- and here that is the whole of it: unlike `projects.archived`, nothing in the
    -- domain reads this, so an archived task is still dispatchable. The command that
    -- sets it is what refuses to hide work that could still move.
    archived      INTEGER NOT NULL DEFAULT 0,
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
-- `replayed_tokens` is the same report's other half: context the run re-read out of
-- the cache. Its own column rather than part of the spend, because the two are
-- different scales — a forty-turn conversation replays millions while adding
-- thousands — and only one of them is what `tasks.budget_tokens` is compared
-- against. Nullable on the same terms, and for a further reason: a run recorded
-- before this column existed did not re-read nothing, it was never asked.
--
-- No foreign key on session_id: the ledger and its executions outlive sessions.
CREATE TABLE task_executions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id      TEXT NOT NULL,
    attempt         INTEGER NOT NULL,
    status          TEXT NOT NULL,      -- A2A's eight states
    worktree        TEXT,
    pid             INTEGER,
    started         INTEGER NOT NULL,
    ended           INTEGER,
    wall_secs       INTEGER,            -- measured by wecode
    spent_tokens    INTEGER,            -- reported by the agent; NULL if unmetered
    replayed_tokens INTEGER,            -- cache reads, reported; not budgeted
    detail          TEXT NOT NULL DEFAULT '',
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

-- The short number each project and task also answers to, so an operator can type `4`
-- where `cache-warm-on-deploy` was wanted. One sequence for both levels: a number names
-- exactly one thing, and `wecode show 4` never has to ask which kind of 4 was meant.
--
-- `AUTOINCREMENT` rather than `max(n) + 1`, and that is the whole design. Without it
-- SQLite reuses the highest free rowid, so deleting the newest task would hand its
-- number to the next one created — and a notification sent six hours ago saying `#7
-- needs your signature` would then sign something nobody had looked at. AUTOINCREMENT
-- keeps the high-water mark in `sqlite_sequence`, so a number is never handed out
-- twice however much is deleted. `audit_log.seq` is monotonic for the mirror reason.
--
-- No foreign key, for the same reason `worktrees.task_id` has none: the row has to
-- outlive the task. A cascade would free the number, which is exactly what must not
-- happen. What it does mean is that `wecode task rm` followed by re-adding the same id
-- gets the same number back — the number names the id, permanently, which is a simpler
-- promise than one depending on what has been deleted since.
CREATE TABLE short_numbers (
    n    INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                     -- 'project' | 'task'
    id   TEXT NOT NULL,
    UNIQUE (kind, id)
) STRICT;
```

## Who does the work, and why that is a column

`tasks.doer` holds `agent` or `person`. It is the only column on `tasks` that authority
depends on, and it is the reason the table has two words for one task where it could have
had one.

It is not a `kind`. The kind says what the work *is* and the doer says whose hands are on
it, and the two vary independently: provisioning a bucket by hand is a chore, and so is
rotating a key by hand. Folding them together would buy one column and lose which chore
it was — the same conflation `parent_id` and `task_depends_on` are kept apart to avoid,
one column over.

The column exists because a plan is read back out of SQLite on every tick. Everything
above the store already reads the doer: admission stops demanding the write scope, budget
and acceptance that describe a dispatch, since a person's task has none; the scheduler
stops such a task on the operator instead of launching anything; `show`, the tree and the
board all say so. All of that is decided from the loaded plan, so before this column a
manual task read back as an agent's on the next tick — admitted with no scope, no budget
and no acceptance, promoted to `ready`, and handed to precisely the agent the declaration
existed to keep away from the work, while the operator held a receipt saying a person
would do it. `wecode task add --by person` refused the task outright rather than record
half of it, which was the safe answer and not a usable one. The column is what made it
recordable, and the refusal came out with it: the flag now saves what it says.

A word this build does not recognise is **corruption, not a default**. Every other
enum-shaped column read out of `tasks` is parsed the same strict way, but here falling
back would be actively unsafe: the unreadable word might be the one that says *not an
agent*, and guessing `agent` dispatches the work the row was written to protect. The whole
plan fails to load instead, which is the loud version of the same answer.

Nothing narrows the write. `set_task_status`, `set_task_budget`, `set_task_shape` and
`set_task_archived` leave the doer alone, so a person's task keeps its doer through
promotion, signature, reshaping and filing — and the restart that reads it back is usually
the one right after a status change.

## What a person is told to do, and why the plan does not carry it

`tasks.steps` holds the instructions the task carries, as written — the runbook for the
console step, the six lines that say which token to mint where. It is the other half of
`doer`: that column stops an agent being handed the work, and this one is how a person
is handed it instead.

An agent is described its task at dispatch. wecode assembles the envelope — the
objective, the playbook, the scope, the repository map — and none of it is stored here,
because all of it is derived at the moment of the run. A person's task has no dispatch to
be described at. The notification *is* the briefing, so the words have to have been
written before it, which means they have to be somewhere: `wecode task add --steps
<file>` reads a file and this is where it lands.

**Stored as text, not as a path.** The file the operator wrote is read once, at
declaration, and copied in. A path would be a promise about a filesystem kept by the
notification that goes out days later, from a loop on a machine that may have moved,
against a branch that may have been merged; the store is the record and a path is a
lookup that can fail after the fact.

**Not in the loaded plan.** `load_plan` does not select this column, and `Task` has no
field for it. The plan is read on every tick, by the board, by the cockpit and by every
command that resolves a short number — none of which show a runbook, and all of which
would carry every one of them in memory to do it. Two things read it, both holding a
single task: `Store::task_steps`, asked by the command that prints a task in full and by
the notification hook. Writing goes the same way, through `Store::set_task_steps`,
narrow for the reason `set_task_budget` is narrow — a task's instructions must not be
able to move what it is judged by.

That is also why `save_task` cannot lose them. Its `INSERT … ON CONFLICT DO UPDATE`
names every column it means to write, `steps` is not one of them, and so assigning a
person's task or re-declaring it leaves the briefing where it was. A `REPLACE` would
take the instructions out from under the notification.

## A number is a name, not a position

`short_numbers` is a second name for something that already has one, which normally
earns a column rather than a table. It has a table for two reasons.

The first is the sequence. A number has to be **unique across projects and tasks
together**, or `wecode show 4` has to ask what kind of 4 was meant — and the operator
reading a board that draws both levels has no way to know either. One `AUTOINCREMENT`
rowid is that sequence; two columns on two tables is two sequences and a join to keep them
apart.

The second is that the row must **outlive what it names**. A number is only worth having
if the number in a message an hour old still means what it meant, so it can never be
recycled — and a column on `tasks` would go away with the task, freeing it. `wecode task
rm` therefore leaves the row standing, and re-adding a task with the same id gets its old
number back. That is the honest promise: the number names the *id*, permanently, and never
a particular row.

What is stored elsewhere is always the id. The CLI resolves a number before anything is
written, so `audit_log.task_id`, the branch names and `docs/wecode/<task>/report.md` are
keyed exactly as they were — the number is a way of typing, never a way of storing. See
[commands.md](commands.md) for the resolution rules, including why a bare `7` loses to a
task genuinely called `7`.

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

Both figures are in one unit: tokens the run **added**, cache writes included, cache
*reads* excluded. That is the unit `tasks.budget_tokens` is compared against, and the
comparison is the reason `spent_tokens` holds only one of the two numbers a harness
reports.

The other one is `task_executions.replayed_tokens`, in its own column beside it. A
harness reports two figures and they are different scales — a forty-turn conversation
over a growing context replays millions of tokens while adding a couple of hundred
thousand — so adding them together produces a number in no unit at all, and the unit it
most resembles is the one budgets are checked in. Keeping the replay out of the spend is
what stops every task's row from going red on its first turn. Keeping it in a column is
what stops that decision from hiding real money: cache reads are billed, at a tenth of
the rate, and until this column existed the figure was printed on one run line and kept
nowhere. `wecode show` prints it per attempt, so three tries that each added ninety
tokens can still say which one held the long conversation.

Nothing rolls the replay up and nothing checks it against anything. It is recorded, not
enforced — the ledger's `Action::Spend` row still carries only the budgeted count, since
that is what the board compares.

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
