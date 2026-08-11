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
/// 2 adds `projects.archived`. 3 adds `task_executions`.
pub const VERSION: i64 = 3;

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
";

/// The `task_executions` table, as an upgrade for a database that predates it.
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
