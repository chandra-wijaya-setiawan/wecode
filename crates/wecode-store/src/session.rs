//! Sessions: who is connected, and with what authority.
//!
//! A session is *a connection*, not a unit of work. Sessions expire on **idle**;
//! executions are bounded by **budget**. Two limits, two concepts.
//!
//! There is no credential here. Opening a session selects a seat; it does not
//! authenticate. Ids carry enough entropy not to be enumerable, because a future
//! protocol path would accept one, but they protect nothing on their own.

use std::time::Duration;

use rusqlite::{OptionalExtension, params};

use crate::{Store, StoreError, now_secs};

/// One live connection.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SessionInfo {
    pub id: String,
    pub post: String,
    pub agent: String,
    /// `None` means autonomous. The only thing distinguishing an agent session
    /// from a human's — there is no session *kind*.
    pub human: Option<String>,
    pub opened: u64,
    pub last_seen: u64,
}

impl SessionInfo {
    #[must_use]
    pub fn is_autonomous(&self) -> bool {
        self.human.is_none()
    }

    #[must_use]
    pub fn idle_secs(&self, now: u64) -> u64 {
        now.saturating_sub(self.last_seen)
    }

    #[must_use]
    pub fn age_secs(&self, now: u64) -> u64 {
        now.saturating_sub(self.opened)
    }

    #[must_use]
    pub fn is_expired(&self, ttl: Duration, now: u64) -> bool {
        self.idle_secs(now) > ttl.as_secs()
    }

    /// `Chandra via claude-code` / `codex (autonomous)`.
    #[must_use]
    pub fn who(&self) -> String {
        match &self.human {
            Some(h) => format!("{h} via {}", self.agent),
            None => format!("{} (autonomous)", self.agent),
        }
    }
}

/// How stale a session must be before a touch is worth a write.
const TOUCH_INTERVAL: u64 = 60;

/// Builds an id with enough entropy that it cannot be guessed by counting.
///
/// Not cryptographic and not a secret; the point is that `s-1`, `s-2` … would be
/// trivially enumerable if a protocol path ever accepted one.
fn mint_id(seed: u64) -> String {
    let mut h = seed
        ^ now_secs().wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ u64::from(std::process::id()).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 33;
    // The low 32 bits, masked rather than cast: eight hex digits is what makes an id
    // readable in a ledger, and the mask says that outright instead of relying on a
    // truncating cast to mean it.
    format!("s-{:08x}", h & 0xFFFF_FFFF)
}

impl Store {
    /// Opens a session for a seat.
    pub fn login(
        &self,
        post: &str,
        agent: &str,
        human: Option<&str>,
    ) -> Result<SessionInfo, StoreError> {
        let count: i64 = self
            .conn()
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))?;
        let at = now_secs();
        let s = SessionInfo {
            id: mint_id(u64::try_from(count).unwrap_or(0)),
            post: post.to_string(),
            agent: agent.to_string(),
            human: human.map(str::to_string),
            opened: at,
            last_seen: at,
        };
        self.conn().execute(
            "INSERT INTO sessions (id, post, agent, human, opened, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![s.id, s.post, s.agent, s.human, crate::int::to_db(at)],
        )?;
        Ok(s)
    }

    pub fn logout(&self, id: &str) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE sessions SET closed = ?2 WHERE id = ?1 AND closed IS NULL",
            params![id, crate::int::to_db(now_secs())],
        )?;
        Ok(())
    }

    /// Closes every open session that has a human. Task episodes end with their
    /// task, not with a person leaving.
    pub fn logout_all_interactive(&self) -> Result<usize, StoreError> {
        let n = self.conn().execute(
            "UPDATE sessions SET closed = ?1 WHERE closed IS NULL AND human IS NOT NULL",
            [crate::int::to_db(now_secs())],
        )?;
        Ok(n)
    }

    /// Refreshes a session, but only once it is stale enough to be worth a write.
    /// Without the interval a busy agent writes a row per command.
    pub fn touch(&self, id: &str) -> Result<(), StoreError> {
        let now = now_secs();
        self.conn().execute(
            "UPDATE sessions SET last_seen = ?2
             WHERE id = ?1 AND closed IS NULL AND ?2 - last_seen >= ?3",
            params![
                id,
                crate::int::to_db(now),
                crate::int::to_db(TOUCH_INTERVAL)
            ],
        )?;
        Ok(())
    }

    /// Every open session, most recently seen first — expired ones included, so
    /// staleness can be reported rather than hidden.
    pub fn sessions_all(&self) -> Result<Vec<SessionInfo>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT id, post, agent, human, opened, last_seen
             FROM sessions WHERE closed IS NULL ORDER BY last_seen DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SessionInfo {
                    id: r.get(0)?,
                    post: r.get(1)?,
                    agent: r.get(2)?,
                    human: r.get(3)?,
                    opened: crate::int::from_row(r.get(4)?, 4)?,
                    last_seen: crate::int::from_row(r.get(5)?, 5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Open sessions that are not idle-expired.
    pub fn sessions(&self, ttl: Duration) -> Result<Vec<SessionInfo>, StoreError> {
        let now = now_secs();
        Ok(self
            .sessions_all()?
            .into_iter()
            .filter(|s| !s.is_expired(ttl, now))
            .collect())
    }

    pub fn session(&self, id: &str) -> Result<Option<SessionInfo>, StoreError> {
        let found = self
            .conn()
            .query_row(
                "SELECT id, post, agent, human, opened, last_seen
                 FROM sessions WHERE id = ?1 AND closed IS NULL",
                [id],
                |r| {
                    Ok(SessionInfo {
                        id: r.get(0)?,
                        post: r.get(1)?,
                        agent: r.get(2)?,
                        human: r.get(3)?,
                        opened: crate::int::from_row(r.get(4)?, 4)?,
                        last_seen: crate::int::from_row(r.get(5)?, 5)?,
                    })
                },
            )
            .optional()?;
        Ok(found)
    }

    /// Backdates a session, for tests that need staleness without sleeping.
    #[doc(hidden)]
    pub fn backdate_session(&self, id: &str, last_seen: u64) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE sessions SET opened = ?2, last_seen = ?2 WHERE id = ?1",
            params![id, crate::int::to_db(last_seen)],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::in_memory().unwrap()
    }

    #[test]
    fn a_session_opens_and_is_listed() {
        let s = store();
        let opened = s.login("chief", "claude-code", Some("Chandra")).unwrap();
        let live = s.sessions_all().unwrap();
        assert_eq!(live, vec![opened.clone()]);
        assert_eq!(opened.who(), "Chandra via claude-code");
        assert!(!opened.is_autonomous());
    }

    #[test]
    fn a_session_with_no_human_is_autonomous() {
        let s = store();
        let a = s.login("test", "codex", None).unwrap();
        assert!(a.is_autonomous());
        assert!(a.who().contains("autonomous"), "{}", a.who());
    }

    #[test]
    fn logout_removes_it_from_the_live_set() {
        let s = store();
        let a = s.login("chief", "claude-code", Some("Chandra")).unwrap();
        s.logout(&a.id).unwrap();
        assert!(s.sessions_all().unwrap().is_empty());
        assert!(s.session(&a.id).unwrap().is_none());
    }

    #[test]
    fn logout_all_interactive_spares_autonomous_sessions() {
        let s = store();
        s.login("chief", "claude-code", Some("Chandra")).unwrap();
        let robot = s.login("test", "codex", None).unwrap();

        let closed = s.logout_all_interactive().unwrap();
        assert_eq!(closed, 1);
        let left = s.sessions_all().unwrap();
        assert_eq!(left.len(), 1, "the agent episode must survive");
        assert_eq!(left[0].id, robot.id);
    }

    #[test]
    fn expiry_is_measured_from_idle_not_from_age() {
        let s = store();
        let a = s.login("chief", "claude-code", Some("Chandra")).unwrap();
        let ttl = Duration::from_secs(100);

        // Opened long ago but seen a moment ago: still live.
        let busy = SessionInfo {
            opened: 0,
            last_seen: now_secs(),
            ..a.clone()
        };
        assert!(!busy.is_expired(ttl, now_secs()));

        s.backdate_session(&a.id, now_secs().saturating_sub(1000))
            .unwrap();
        assert!(s.sessions(ttl).unwrap().is_empty(), "idle should expire");
        assert_eq!(
            s.sessions_all().unwrap().len(),
            1,
            "but it is still open, so staleness can be reported"
        );
    }

    #[test]
    fn touch_only_writes_once_the_session_is_stale() {
        let s = store();
        let a = s.login("chief", "claude-code", Some("Chandra")).unwrap();

        // Fresh: the touch is a no-op, so last_seen is unchanged.
        s.touch(&a.id).unwrap();
        assert_eq!(s.session(&a.id).unwrap().unwrap().last_seen, a.last_seen);

        let stale_at = now_secs().saturating_sub(TOUCH_INTERVAL + 10);
        s.backdate_session(&a.id, stale_at).unwrap();
        s.touch(&a.id).unwrap();
        assert!(
            s.session(&a.id).unwrap().unwrap().last_seen > stale_at,
            "a stale session should be refreshed"
        );
    }

    #[test]
    fn several_sessions_coexist_and_sort_by_recency() {
        let s = store();
        let older = s.login("chief", "claude-code", Some("Chandra")).unwrap();
        let newer = s.login("review", "claude-code", Some("Chandra")).unwrap();
        s.backdate_session(&older.id, now_secs().saturating_sub(500))
            .unwrap();

        let live = s.sessions_all().unwrap();
        assert_eq!(live.len(), 2);
        assert_eq!(live[0].id, newer.id, "most recently seen first");
    }

    #[test]
    fn ids_are_not_sequential() {
        // Two opens in the same second must not be adjacent, or a protocol path
        // that accepted an id could enumerate the rest.
        let s = store();
        let a = s.login("chief", "claude-code", None).unwrap();
        let b = s.login("chief", "claude-code", None).unwrap();
        assert_ne!(a.id, b.id);
        let (na, nb) = (
            u32::from_str_radix(&a.id[2..], 16).unwrap(),
            u32::from_str_radix(&b.id[2..], 16).unwrap(),
        );
        assert!(
            na.abs_diff(nb) > 1,
            "ids {} and {} are adjacent",
            a.id,
            b.id
        );
    }
}
