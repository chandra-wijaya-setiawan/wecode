//! The database schema, and the migration that installs it.
//!
//! One file per workspace holds everything machine-written. Hand-edited
//! configuration stays in `company.toml`, because a binary blob cannot be diffed,
//! reviewed, or opened in an editor. See `docs/ERD.md`.
//!
//! Three columns point at names declared in `company.toml` and so cannot be
//! foreign keys: `projects.repo`, `tasks.assignee`, `sessions.post`. They are
//! validated in code on write. That is the one real cost of keeping config in a
//! file, and it is a deliberate trade.

use rusqlite::Connection;

/// Bumped whenever the schema changes. Stored in `user_version`.
///
/// 2 adds `projects.archived`. 3 adds `task_executions`. 4 adds
/// `task_executions.spent_tokens`, once something wrote it. 5 adds `worktrees`.
/// 6 adds `inbox_cursor`. 7 adds `short_numbers`.
pub const VERSION: i64 = 7;

const SCHEMA: &str = r"
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
";

/// The `task_executions` table, as an upgrade for a database that predates it.
///
/// Frozen at the shape version 3 had. A file arriving from version 2 runs this and
/// then the 3→4 step, which is the whole point of chaining them — editing this to
/// include a later column would leave every file that already ran it behind.
const ADD_EXECUTIONS: &str = "
CREATE TABLE task_executions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id  TEXT NOT NULL,
    attempt     INTEGER NOT NULL,
    status      TEXT NOT NULL,
    worktree    TEXT,
    pid         INTEGER,
    started     INTEGER NOT NULL,
    ended       INTEGER,
    wall_secs   INTEGER,
    detail      TEXT NOT NULL DEFAULT '',
    UNIQUE (task_id, attempt)
) STRICT;

CREATE INDEX executions_by_task ON task_executions(task_id);
";

/// The `worktrees` table, as an upgrade for a database that predates it.
///
/// Frozen at the shape version 4 had, like `ADD_EXECUTIONS` above and for the same
/// reason. A later column belongs in a later step, not in an edit to this one.
///
/// Nothing backfills. A workspace upgrading here has worktrees on disk that wecode made
/// and did not write down, and inventing rows for them would put a creation date in the
/// database that nobody observed. They read as unrecognised until they are made again,
/// which `wecode start` does on the next attempt.
const ADD_WORKTREES: &str = "
CREATE TABLE worktrees (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    path    TEXT NOT NULL,
    repo    TEXT NOT NULL,
    branch  TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created INTEGER NOT NULL,
    removed INTEGER
) STRICT;

CREATE UNIQUE INDEX worktrees_live    ON worktrees(path) WHERE removed IS NULL;
CREATE INDEX        worktrees_by_task ON worktrees(task_id);
";

/// The `inbox_cursor` table, as an upgrade for a database that predates it.
///
/// Frozen at the shape version 5 had, like the two above. Nothing backfills, and here
/// that is load-bearing rather than merely honest: an invented cursor would be a claim
/// about which replies have already been read, and the two ways of getting it wrong
/// are acting on a month of chat or silently dropping the reply that is waiting. An
/// absent row means "nothing read yet", which the fetch turns into an offset of 0 —
/// whatever the channel still holds.
const ADD_INBOX: &str = "
CREATE TABLE inbox_cursor (
    channel TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL,
    at      INTEGER NOT NULL
) STRICT;
";

/// The `short_numbers` table, as an upgrade for a database that predates it — and the
/// one migration in this list that **backfills**.
///
/// The three above it deliberately do not, because inventing their rows would be a claim
/// about the past: a worktree's creation date nobody observed, a cursor position saying
/// which replies have already been read. A short number is not an observation. It is a
/// name being minted now, and minting it during the upgrade is exactly as valid as
/// minting it at `task add` — the alternative is a workspace where the projects that
/// already exist are the only ones with no handle, which is every workspace that has
/// been used.
///
/// Projects first, then tasks, each in id order, so two machines upgrading the same file
/// from a backup agree about which number is which. That ordering is also why projects
/// tend to hold the low numbers: they are what an operator reads first.
const ADD_SHORT_NUMBERS: &str = "
CREATE TABLE short_numbers (
    n    INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    id   TEXT NOT NULL,
    UNIQUE (kind, id)
) STRICT;

INSERT INTO short_numbers (kind, id) SELECT 'project', id FROM projects ORDER BY id;
INSERT INTO short_numbers (kind, id) SELECT 'task', id FROM tasks ORDER BY id;
";

/// What `migrate` should do about a file at `current`.
///
/// Split out as a pure function so every case is testable without depending on what
/// `VERSION` happens to be today. Inline, the `Unsupported` arm was unreachable at
/// version 1 and so untested — which is how the original hole survived.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Step {
    /// At or ahead of this build. Nothing to do.
    UpToDate,
    /// Empty file: install the schema.
    Install,
    /// Behind, with a known upgrade from this version.
    Upgrade(i64),
    /// Behind, with no path from here.
    Unsupported,
}

/// `have` is the set of versions an upgrade step exists *from*.
///
/// Taking it as a parameter is what keeps `Unsupported` reachable and therefore
/// tested. Deciding it from a constant instead made the arm dead the moment the first
/// upgrade landed — the same shape of hole this function was extracted to close.
fn step_for(current: i64, target: i64, have: &[i64]) -> Step {
    if current >= target {
        Step::UpToDate
    } else if current == 0 {
        Step::Install
    } else if (current..target).all(|v| have.contains(&v)) {
        Step::Upgrade(current)
    } else {
        // A gap in the chain. Refusing beats running the steps that do exist and
        // leaving the file half-migrated while reporting success.
        Step::Unsupported
    }
}

/// Every upgrade, in order. Each entry brings a file *from* that version to the next.
///
/// A list rather than a match so `migrate` applies them in sequence: a version-1 file
/// meeting a future version 4 runs 1→2, 2→3, 3→4 rather than needing a direct step.
const UPGRADES: &[(i64, &str)] = &[
    (
        1,
        "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    ),
    (2, ADD_EXECUTIONS),
    (
        3,
        "ALTER TABLE task_executions ADD COLUMN spent_tokens INTEGER",
    ),
    (4, ADD_WORKTREES),
    (5, ADD_INBOX),
    (6, ADD_SHORT_NUMBERS),
];

/// Applies the schema if the database is empty, and enables foreign keys plus WAL.
///
/// `AUTOINCREMENT` on `audit_log.seq` is what makes the ledger monotonic across
/// every process that writes — a property a per-process counter got wrong once.
/// WAL is what lets the cockpit read while a scheduler writes.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let have: Vec<i64> = UPGRADES.iter().map(|(v, _)| *v).collect();
    match step_for(version, VERSION, &have) {
        Step::UpToDate => Ok(()),
        Step::Install => {
            // WAL is a persistent property of the file, so it is set once here.
            // In-memory databases do not support it, hence the ignored result.
            let _ = conn.pragma_update(None, "journal_mode", "WAL");
            conn.execute_batch(SCHEMA)?;
            conn.pragma_update(None, "user_version", VERSION)?;
            Ok(())
        }
        Step::Upgrade(from) => {
            for (version, sql) in UPGRADES {
                if *version >= from {
                    conn.execute_batch(sql)?;
                }
            }
            conn.pragma_update(None, "user_version", VERSION)?;
            Ok(())
        }
        Step::Unsupported => Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(format!(
                "wecode.db is at schema version {version}; this build expects {VERSION} \
                 and has no migration between them"
            )),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    #[test]
    fn a_gap_in_the_upgrade_chain_is_refused() {
        // Running the steps that exist and stopping halfway would report success on a
        // file that is now neither version.
        assert_eq!(step_for(1, 3, &[1]), Step::Unsupported);
        assert_eq!(step_for(1, 4, &[1, 3]), Step::Unsupported);
        assert_eq!(step_for(2, 5, &[]), Step::Unsupported);
    }

    #[test]
    fn a_complete_chain_upgrades_from_where_the_file_is() {
        assert_eq!(step_for(1, 2, &[1]), Step::Upgrade(1));
        assert_eq!(step_for(1, 3, &[1, 2]), Step::Upgrade(1));
        assert_eq!(step_for(2, 3, &[1, 2]), Step::Upgrade(2));
    }

    #[test]
    fn an_empty_file_is_installed_and_a_current_one_left_alone() {
        assert_eq!(step_for(0, 1, &[]), Step::Install);
        assert_eq!(step_for(0, 7, &[1, 2]), Step::Install);
        assert_eq!(step_for(1, 1, &[]), Step::UpToDate);
        // A file written by a newer build: leave it, do not downgrade it.
        assert_eq!(step_for(2, 1, &[]), Step::UpToDate);
    }

    #[test]
    fn this_build_can_upgrade_every_version_it_claims_to() {
        // Guards the real constant: bumping VERSION without adding an UPGRADES entry
        // would make every existing wecode.db unopenable.
        let have: Vec<i64> = UPGRADES.iter().map(|(v, _)| *v).collect();
        assert_eq!(step_for(1, VERSION, &have), Step::Upgrade(1));
    }

    #[test]
    fn a_version_one_file_climbs_every_step_to_the_current_version() {
        // Two upgrades now, so this also proves they chain rather than needing a
        // direct 1→3 step.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE projects (
                 id TEXT PRIMARY KEY, repo TEXT NOT NULL, objective TEXT NOT NULL,
                 status TEXT NOT NULL, budget_tokens INTEGER, budget_wall INTEGER
             ) STRICT;
             CREATE TABLE tasks (id TEXT PRIMARY KEY) STRICT;",
        )
        .unwrap();
        c.pragma_update(None, "user_version", 1i64).unwrap();
        migrate(&c).unwrap();

        let v: i64 = c
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, VERSION);
        // Both upgrades landed. Counting rather than selecting a row, so an empty
        // table still proves the column and the table exist.
        let archived: i64 = c
            .query_row("SELECT count(archived) FROM projects", [], |r| r.get(0))
            .expect("projects.archived exists after 1→2");
        assert_eq!(archived, 0);
        let runs: i64 = c
            .query_row("SELECT count(*) FROM task_executions", [], |r| r.get(0))
            .expect("task_executions exists after 2→3");
        assert_eq!(runs, 0);
        let spent: i64 = c
            .query_row("SELECT count(spent_tokens) FROM task_executions", [], |r| {
                r.get(0)
            })
            .expect("task_executions.spent_tokens exists after 3→4");
        assert_eq!(spent, 0);
        let trees: i64 = c
            .query_row("SELECT count(*) FROM worktrees", [], |r| r.get(0))
            .expect("worktrees exists after 4→5");
        assert_eq!(trees, 0);
        let read: i64 = c
            .query_row("SELECT count(*) FROM inbox_cursor", [], |r| r.get(0))
            .expect("inbox_cursor exists after 5→6");
        assert_eq!(read, 0);
        let numbered: i64 = c
            .query_row("SELECT count(*) FROM short_numbers", [], |r| r.get(0))
            .expect("short_numbers exists after 6→7");
        assert_eq!(numbered, 0, "there was nothing in the plan to number");
    }

    #[test]
    fn a_database_that_predates_the_inbox_gains_it_having_read_nothing() {
        // The upgrade a workspace in use takes to reach this build. A cursor invented
        // for it would be a claim about which replies have already been handled, and
        // both ways of guessing are bad: too low re-reads a month of chat, too high
        // swallows the reply that is waiting. Absent means "read nothing", which the
        // fetch turns into an offset of 0.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute_batch("DROP TABLE inbox_cursor; DROP TABLE short_numbers;")
            .unwrap();
        c.pragma_update(None, "user_version", 5i64).unwrap();

        migrate(&c).unwrap();

        let rows: i64 = c
            .query_row("SELECT count(*) FROM inbox_cursor", [], |r| r.get(0))
            .expect("the cursor table exists");
        assert_eq!(rows, 0, "no channel is claimed to have been read");
    }

    #[test]
    fn a_database_that_predates_the_registry_gains_it_and_keeps_its_work() {
        // The upgrade a workspace in use actually takes. Nothing is backfilled: the
        // trees already on disk were never recorded, and inventing rows for them would
        // put a creation date in the database that nobody observed.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute_batch("DROP TABLE worktrees; DROP TABLE inbox_cursor; DROP TABLE short_numbers;")
            .unwrap();
        c.execute_batch(
            "INSERT INTO projects (id, repo, objective, status)
             VALUES ('p','wecode','an objective','active');
             INSERT INTO tasks (id, project_id, kind, title, status)
             VALUES ('t','p','feature','x','running');",
        )
        .unwrap();
        c.pragma_update(None, "user_version", 4i64).unwrap();

        migrate(&c).unwrap();

        let trees: i64 = c
            .query_row("SELECT count(*) FROM worktrees", [], |r| r.get(0))
            .expect("the registry exists");
        assert_eq!(trees, 0, "a running task's tree is not invented for it");
        let title: String = c
            .query_row("SELECT title FROM tasks WHERE id = 't'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "x", "the plan survived");
    }

    #[test]
    fn a_database_that_predates_short_numbers_has_its_plan_numbered() {
        // The one upgrade in the list that backfills, and the reason it must: a
        // workspace already in use is exactly the workspace whose projects and tasks
        // need handles. Leaving them out would number only what is created next.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute_batch("DROP TABLE short_numbers").unwrap();
        c.execute_batch(
            "INSERT INTO projects (id, repo, objective, status)
             VALUES ('caching','wecode','an objective','active');
             INSERT INTO tasks (id, project_id, kind, title, status)
             VALUES ('layer','caching','feature','x','draft'),
                    ('keys','caching','feature','y','draft');",
        )
        .unwrap();
        c.pragma_update(None, "user_version", 6i64).unwrap();

        migrate(&c).unwrap();

        let mut stmt = c
            .prepare("SELECT kind, id FROM short_numbers ORDER BY n")
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        // Projects first, then tasks in id order, so a file restored from a backup on
        // another machine is numbered the same way.
        assert_eq!(
            rows,
            vec![
                ("project".to_string(), "caching".to_string()),
                ("task".to_string(), "keys".to_string()),
                ("task".to_string(), "layer".to_string()),
            ]
        );
    }

    #[test]
    fn a_path_holds_one_live_tree_and_any_number_of_dead_ones() {
        // The partial index is what lets a directory be used again without the
        // tombstone for its last occupant standing in the way.
        let c = db();
        let insert = "INSERT INTO worktrees (path, repo, branch, task_id, created, removed)
                      VALUES ('/wt/1','wecode','wecode/t','t',0,?1)";
        c.execute(insert, [Some(10)]).unwrap();
        c.execute(insert, [Some(20)]).unwrap();
        c.execute(insert, [None::<i64>]).unwrap();
        assert!(
            c.execute(insert, [None::<i64>]).is_err(),
            "two trees standing at one path is not a state the schema should allow"
        );
    }

    #[test]
    fn a_database_that_predates_spend_gains_the_column_without_losing_its_runs() {
        // The upgrade an existing workspace actually takes. Its old attempts have no
        // token count and must read as unmetered rather than as free.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        // Back to the shape version 3 really had: no spend column, no worktrees, no
        // inbox cursor.
        c.execute_batch(
            "ALTER TABLE task_executions DROP COLUMN spent_tokens;
             DROP TABLE worktrees;
             DROP TABLE inbox_cursor;
             DROP TABLE short_numbers;",
        )
        .unwrap();
        c.execute_batch(
            "INSERT INTO projects (id, repo, objective, status)
             VALUES ('p','wecode','an objective','active');
             INSERT INTO tasks (id, project_id, kind, title, status)
             VALUES ('t','p','feature','x','draft');
             INSERT INTO task_executions (task_id, session_id, attempt, status, started)
             VALUES ('t','s',1,'completed',0);",
        )
        .unwrap();
        c.pragma_update(None, "user_version", 3i64).unwrap();

        migrate(&c).unwrap();

        let spent: Option<i64> = c
            .query_row("SELECT spent_tokens FROM task_executions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(spent, None, "an attempt from before the count is unmetered");
    }

    #[test]
    fn a_version_one_file_gains_the_column_and_keeps_its_rows() {
        // The migration that matters, run for real rather than reasoned about.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE projects (
                 id TEXT PRIMARY KEY, repo TEXT NOT NULL, objective TEXT NOT NULL,
                 status TEXT NOT NULL, budget_tokens INTEGER, budget_wall INTEGER
             ) STRICT;
             -- Version 1 had tasks, and 6→7 reads them to number what is already there.
             -- A stand-in file this test invents still has to have the tables the real
             -- one had, or it proves the migration against a shape that never existed.
             CREATE TABLE tasks (id TEXT PRIMARY KEY) STRICT;
             INSERT INTO projects (id, repo, objective, status)
             VALUES ('old', 'wecode', 'an objective', 'active');",
        )
        .unwrap();
        c.pragma_update(None, "user_version", 1i64).unwrap();

        migrate(&c).unwrap();

        let v: i64 = c
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, VERSION);
        let (obj, archived): (String, i64) = c
            .query_row(
                "SELECT objective, archived FROM projects WHERE id = 'old'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(obj, "an objective", "the row survived");
        assert_eq!(archived, 0, "existing projects default to visible");
    }

    #[test]
    fn a_database_from_the_future_is_opened_without_complaint() {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "user_version", VERSION + 1).unwrap();
        assert!(migrate(&c).is_ok());
    }

    fn seed_project(c: &Connection) {
        c.execute(
            "INSERT INTO projects (id, repo, objective, status)
             VALUES ('p', 'wecode', 'o', 'draft')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn migrating_twice_is_harmless() {
        let c = db();
        migrate(&c).unwrap();
        let v: i64 = c
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, VERSION);
    }

    #[test]
    fn a_task_cannot_belong_to_a_project_that_does_not_exist() {
        let c = db();
        assert!(
            c.execute(
                "INSERT INTO tasks (id, project_id, kind, title, status)
                 VALUES ('t', 'ghost', 'feature', 'x', 'draft')",
                [],
            )
            .is_err(),
            "the schema itself should refuse an orphan task"
        );
    }

    #[test]
    fn audit_sequence_is_assigned_by_the_database() {
        // The property a per-process counter got wrong: monotonic across writers.
        let c = db();
        for _ in 0..3 {
            c.execute(
                "INSERT INTO audit_log (at, session_id, post, agent, source, action, target, outcome, detail)
                 VALUES (0,'s','p','a','broker','write','x','allow','')",
                [],
            )
            .unwrap();
        }
        let seqs: Vec<i64> = c
            .prepare("SELECT seq FROM audit_log ORDER BY seq")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn deleting_a_project_clears_everything_beneath_it() {
        let c = db();
        seed_project(&c);
        for id in ["a", "b"] {
            c.execute(
                "INSERT INTO tasks (id, project_id, kind, title, status)
                 VALUES (?1,'p','feature','x','draft')",
                [id],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO task_depends_on (task_id, prerequisite_id) VALUES ('b','a')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO task_scopes (task_id, access, glob) VALUES ('a','write','src/**')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO task_acceptance (task_id, seq, kind, cmd, expect_status)
             VALUES ('a', 0, 'command', 'cargo test', 0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO project_measures (project_id, seq, kind, cmd, expect_status)
             VALUES ('p', 0, 'command', 'cargo test', 0)",
            [],
        )
        .unwrap();

        c.execute("DELETE FROM projects WHERE id = 'p'", [])
            .unwrap();

        for table in [
            "tasks",
            "task_depends_on",
            "task_scopes",
            "task_acceptance",
            "project_measures",
        ] {
            let n: i64 = c
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} should have cascaded away");
        }
    }

    #[test]
    fn a_dependency_must_point_at_a_real_task() {
        let c = db();
        seed_project(&c);
        c.execute(
            "INSERT INTO tasks (id, project_id, kind, title, status)
             VALUES ('a','p','feature','x','draft')",
            [],
        )
        .unwrap();
        assert!(
            c.execute(
                "INSERT INTO task_depends_on (task_id, prerequisite_id) VALUES ('a','ghost')",
                [],
            )
            .is_err(),
            "a prerequisite that does not exist should be refused"
        );
    }

    #[test]
    fn duplicate_rows_are_refused_by_their_primary_keys() {
        let c = db();
        seed_project(&c);
        c.execute(
            "INSERT INTO tasks (id, project_id, kind, title, status)
             VALUES ('a','p','feature','x','draft')",
            [],
        )
        .unwrap();
        let dup = "INSERT INTO task_scopes (task_id, access, glob) VALUES ('a','write','src/**')";
        c.execute(dup, []).unwrap();
        assert!(c.execute(dup, []).is_err());
    }
}
