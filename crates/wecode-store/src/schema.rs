//! The database schema, and the migration that installs it.
//!
//! One file per workspace holds everything machine-written: projects, tasks,
//! sessions, the audit ledger. Hand-edited configuration stays in `company.toml`,
//! because a binary blob cannot be diffed, reviewed, or opened in an editor.
//!
//! Two shapes here are worth noting, because they are the reason a flat record
//! format was awkward:
//!
//! - `task_deps` is its own table. Dependencies are many-to-many.
//! - `measures` is owned polymorphically by a project *or* a task, so it carries
//!   `owner_kind` alongside `owner_id`.

use rusqlite::Connection;

/// Bumped whenever the schema changes. Stored in `user_version`.
pub const VERSION: i64 = 1;

const SCHEMA: &str = r"
CREATE TABLE projects (
    id            TEXT PRIMARY KEY,
    repo          TEXT NOT NULL,
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
    -- hierarchy: is part of. Not a scheduling constraint.
    parent_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    status        TEXT NOT NULL,
    assignee      TEXT,
    budget_tokens INTEGER,
    budget_wall   INTEGER
) STRICT;

CREATE INDEX tasks_by_project ON tasks(project_id);
CREATE INDEX tasks_by_parent  ON tasks(parent_id);

-- scheduling: must come after. Many-to-many, hence its own table.
CREATE TABLE task_deps (
    task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_id TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_id)
) STRICT;

CREATE TABLE scopes (
    owner_kind TEXT NOT NULL,          -- 'task'
    owner_id   TEXT NOT NULL,
    access     TEXT NOT NULL,          -- 'read' | 'write'
    glob       TEXT NOT NULL,
    PRIMARY KEY (owner_kind, owner_id, access, glob)
) STRICT;

CREATE TABLE measures (
    owner_kind    TEXT NOT NULL,       -- 'project' | 'task'
    owner_id      TEXT NOT NULL,
    seq           INTEGER NOT NULL,    -- keeps author order stable
    kind          TEXT NOT NULL,       -- 'command' | 'metric' | 'deliverable' | 'judged'
    cmd           TEXT,
    expect_status INTEGER,
    name          TEXT,
    target        REAL,
    cmp           TEXT,
    path          TEXT,
    note          TEXT,
    PRIMARY KEY (owner_kind, owner_id, seq)
) STRICT;

CREATE TABLE sessions (
    id        TEXT PRIMARY KEY,
    post      TEXT NOT NULL,
    agent     TEXT NOT NULL,
    human     TEXT,                    -- NULL means autonomous
    opened    INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    closed    INTEGER                  -- NULL while open
) STRICT;

CREATE TABLE audit (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    post       TEXT NOT NULL,
    agent      TEXT NOT NULL,
    human      TEXT,
    project_id TEXT,
    task_id    TEXT,
    source     TEXT NOT NULL,          -- 'broker' | 'supervisor' | 'harness'
    action     TEXT NOT NULL,
    target     TEXT NOT NULL,
    outcome    TEXT NOT NULL,          -- 'allow' | 'deny' | 'alarm' | 'approval'
    mode       TEXT,                   -- 'regimented' | 'sanctioned'
    detail     TEXT NOT NULL
) STRICT;

CREATE INDEX audit_by_task    ON audit(task_id);
CREATE INDEX audit_by_project ON audit(project_id);
CREATE INDEX audit_by_outcome ON audit(outcome);
";

/// Applies the schema if the database is empty, and enforces foreign keys.
///
/// `AUTOINCREMENT` on `audit.seq` is what makes the ledger's sequence monotonic
/// across every process that ever writes — the property a per-process counter got
/// wrong in an earlier version.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version >= VERSION {
        return Ok(());
    }
    if version == 0 {
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
    fn foreign_keys_are_enforced() {
        let c = db();
        // A task must belong to a project that exists.
        let err = c.execute(
            "INSERT INTO tasks (id, project_id, kind, title, status)
             VALUES ('t', 'ghost', 'feature', 'x', 'draft')",
            [],
        );
        assert!(err.is_err(), "an orphan task should be refused by the schema");
    }

    #[test]
    fn audit_sequence_is_assigned_by_the_database() {
        // The property a per-process counter got wrong: monotonic across writers.
        let c = db();
        for _ in 0..3 {
            c.execute(
                "INSERT INTO audit (at, session_id, post, agent, source, action, target, outcome, detail)
                 VALUES (0, 's', 'p', 'a', 'broker', 'write', 'x', 'allow', '')",
                [],
            )
            .unwrap();
        }
        let seqs: Vec<i64> = c
            .prepare("SELECT seq FROM audit ORDER BY seq")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn deleting_a_project_takes_its_tasks_and_deps() {
        let c = db();
        c.execute(
            "INSERT INTO projects (id, repo, objective, status) VALUES ('p','r','o','draft')",
            [],
        )
        .unwrap();
        for id in ["a", "b"] {
            c.execute(
                "INSERT INTO tasks (id, project_id, kind, title, status)
                 VALUES (?1, 'p', 'feature', 'x', 'draft')",
                [id],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO task_deps (task_id, depends_on_id) VALUES ('b','a')",
            [],
        )
        .unwrap();

        c.execute("DELETE FROM projects WHERE id = 'p'", []).unwrap();
        let tasks: i64 = c
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        let deps: i64 = c
            .query_row("SELECT count(*) FROM task_deps", [], |r| r.get(0))
            .unwrap();
        assert_eq!((tasks, deps), (0, 0), "cascade should clear both");
    }

    #[test]
    fn a_duplicate_dependency_is_rejected_by_the_primary_key() {
        let c = db();
        c.execute(
            "INSERT INTO projects (id, repo, objective, status) VALUES ('p','r','o','draft')",
            [],
        )
        .unwrap();
        for id in ["a", "b"] {
            c.execute(
                "INSERT INTO tasks (id, project_id, kind, title, status)
                 VALUES (?1, 'p', 'feature', 'x', 'draft')",
                [id],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO task_deps (task_id, depends_on_id) VALUES ('b','a')",
            [],
        )
        .unwrap();
        assert!(
            c.execute(
                "INSERT INTO task_deps (task_id, depends_on_id) VALUES ('b','a')",
                [],
            )
            .is_err()
        );
    }
}
