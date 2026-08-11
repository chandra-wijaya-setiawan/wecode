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
pub const VERSION: i64 = 1;

const SCHEMA: &str = r"
CREATE TABLE projects (
    id            TEXT PRIMARY KEY,
    repo          TEXT NOT NULL,      -- a [[repos]] name; checked in code
    objective     TEXT NOT NULL,
    status        TEXT NOT NULL,
    budget_tokens INTEGER,
    budget_wall   INTEGER
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

-- Deferred: task_executions. One row per run of a task, holding the worktree
-- path, pid, the A2A-aligned status lifecycle, spend totals, and `attempt` as a
-- retry counter. Not created until a scheduler exists to write it — every column
-- would otherwise be a guess about code that does not exist. The execution is the
-- entity; attempt is which try it is.
";

/// Applies the schema if the database is empty, and enables foreign keys plus WAL.
///
/// `AUTOINCREMENT` on `audit_log.seq` is what makes the ledger monotonic across
/// every process that writes — a property a per-process counter got wrong once.
/// WAL is what lets the cockpit read while a scheduler writes.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version >= VERSION {
        return Ok(());
    }
    if version == 0 {
        // WAL is a persistent property of the file, so it is set once here.
        // In-memory databases do not support it, hence the ignored result.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "user_version", VERSION)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
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
