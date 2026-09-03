//! Persistence: one SQLite file per workspace for everything machine-written.
//!
//! Configuration is deliberately *not* here — `company.toml` stays a file so it can
//! be hand-edited, diffed and reviewed. This holds what only the program writes:
//! projects, tasks, sessions, and the audit ledger.

pub mod audit;
pub mod driver;
pub mod execution;
pub mod inbox;
mod int;
pub mod plan;
pub mod schema;
pub mod session;
pub mod short;
pub mod worktree;

use std::fmt;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

pub use audit::{AuditLine, AuditQuery};
pub use driver::Driver;
pub use execution::Execution;
pub use session::SessionInfo;
pub use short::Level;
pub use worktree::Worktree;

#[derive(Debug)]
pub enum StoreError {
    Db(rusqlite::Error),
    /// A row the schema allows but the domain does not, e.g. an unknown task kind.
    Corrupt {
        what: &'static str,
        value: String,
    },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database: {e}"),
            Self::Corrupt { what, value } => {
                write!(f, "stored {what} is not recognised: `{value}`")
            }
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e)
    }
}

/// Seconds since the epoch. The only place that reads the clock.
#[must_use]
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The workspace database.
pub struct Store {
    conn: Connection,
    path: PathBuf,
}

impl fmt::Debug for Store {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Store").field("path", &self.path).finish()
    }
}

impl Store {
    /// Opens (creating and migrating if needed) the database at `path`.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(&path)?;
        schema::migrate(&conn)?;
        Ok(Self { conn, path })
    }

    /// An in-memory database, for tests.
    pub fn in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        schema::migrate(&conn)?;
        Ok(Self {
            conn,
            path: PathBuf::from(":memory:"),
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_creates_a_usable_database() {
        let s = Store::in_memory().unwrap();
        let v: i64 = s
            .conn()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, schema::VERSION);
    }

    #[test]
    fn opening_a_path_twice_reuses_it() {
        let dir = std::env::temp_dir().join("wecode-store-reopen");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("wecode.db");

        let first = Store::open(&path).unwrap();
        drop(first);
        // Migrating an existing database must not fail or wipe it.
        let again = Store::open(&path).unwrap();
        assert_eq!(again.path(), path.as_path());
    }
}
