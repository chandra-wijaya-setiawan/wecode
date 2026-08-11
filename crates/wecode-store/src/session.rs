//! Sessions: who is connected, and with what authority.
//!
//! A session is *a connection*, not a unit of work. One session may run many
//! attempts over its life; an attempt belongs to exactly one session. Sessions
//! expire on **idle**; attempts are bounded by **budget**. Two limits, two types.
//!
//! There is no credential here. `open` selects a seat; it does not authenticate.
//! Ids carry enough entropy not to be enumerable, because a future protocol path
//! would accept one, but they protect nothing on their own.

use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::codec::Fields;

/// Seconds since the epoch. The only place in the workspace that reads the clock.
#[must_use]
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// One live connection.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SessionInfo {
    pub id: String,
    pub post: String,
    pub agent: String,
    /// `None` means autonomous. This is the only thing distinguishing an agent
    /// session from a human's — there is no session *kind*.
    pub user: Option<String>,
    pub opened: u64,
    pub last_seen: u64,
}

impl SessionInfo {
    #[must_use]
    pub fn is_autonomous(&self) -> bool {
        self.user.is_none()
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

    /// `chandra via claude-code` / `claude-code (autonomous)`.
    #[must_use]
    pub fn who(&self) -> String {
        match &self.user {
            Some(u) => format!("{u} via {}", self.agent),
            None => format!("{} (autonomous)", self.agent),
        }
    }
}

impl fmt::Display for SessionInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {} {}", self.id, self.post, self.who())
    }
}

/// Builds a session id with enough entropy that it cannot be guessed by counting.
///
/// Not cryptographic and not a secret; the point is only that `s-1`, `s-2` … would
/// be trivially enumerable if a protocol path ever accepted an id.
fn mint_id(seed: u64) -> String {
    let mut h = seed
        ^ now_secs().wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ u64::from(std::process::id()).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    // xorshift, enough to scramble the low bits that would otherwise be sequential
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 33;
    format!("s-{:08x}", h as u32)
}

/// One line of the session log.
#[derive(Clone, PartialEq, Eq, Debug)]
enum Event {
    Open(SessionInfo),
    Touch { id: String, at: u64 },
    Close { id: String },
}

pub(crate) fn encode_open(s: &SessionInfo) -> String {
    let mut parts = vec![
        "session".to_string(),
        format!("id={}", s.id),
        "event=open".to_string(),
        format!("post={}", s.post),
        format!("agent={}", s.agent),
        format!("at={}", s.opened),
    ];
    if let Some(u) = &s.user {
        parts.push(format!("user={u}"));
    }
    parts.join("\t")
}

pub(crate) fn encode_touch(id: &str, at: u64) -> String {
    format!("session\tid={id}\tevent=touch\tat={at}")
}

pub(crate) fn encode_close(id: &str, at: u64) -> String {
    format!("session\tid={id}\tevent=close\tat={at}")
}

fn decode(line: &str) -> Option<Event> {
    let f = Fields::parse(line);
    if f.kind != "session" {
        return None;
    }
    let id = f.opt("id")?.to_string();
    let at: u64 = f.opt("at")?.parse().ok()?;
    match f.opt("event")? {
        "open" => Some(Event::Open(SessionInfo {
            id,
            post: f.opt("post").unwrap_or_default().to_string(),
            agent: f.opt("agent").unwrap_or("unknown").to_string(),
            user: f.opt("user").map(str::to_string),
            opened: at,
            last_seen: at,
        })),
        "touch" => Some(Event::Touch { id, at }),
        "close" => Some(Event::Close { id }),
        _ => None,
    }
}

/// Folds a session log into the sessions still open, most recent first.
///
/// Unparseable lines are skipped: losing every session because one line is torn
/// would be the worse failure.
#[must_use]
pub fn fold(log: &str) -> Vec<SessionInfo> {
    let mut open: Vec<SessionInfo> = Vec::new();
    for line in log.lines() {
        match decode(line) {
            Some(Event::Open(s)) => {
                if !open.iter().any(|e| e.id == s.id) {
                    open.push(s);
                }
            }
            Some(Event::Touch { id, at }) => {
                if let Some(s) = open.iter_mut().find(|s| s.id == id) {
                    s.last_seen = s.last_seen.max(at);
                }
            }
            Some(Event::Close { id }) => open.retain(|s| s.id != id),
            None => {}
        }
    }
    open.sort_by_key(|s| std::cmp::Reverse(s.last_seen));
    open
}

/// Sessions that are open and not idle-expired.
#[must_use]
pub fn active(log: &str, ttl: Duration, now: u64) -> Vec<SessionInfo> {
    fold(log)
        .into_iter()
        .filter(|s| !s.is_expired(ttl, now))
        .collect()
}

/// Mints a session. The caller persists the returned line.
#[must_use]
pub fn open(
    post: impl Into<String>,
    agent: impl Into<String>,
    user: Option<String>,
    seed: u64,
) -> SessionInfo {
    let at = now_secs();
    SessionInfo {
        id: mint_id(seed),
        post: post.into(),
        agent: agent.into(),
        user,
        opened: at,
        last_seen: at,
    }
}

/// How stale a session must be before `touch` bothers writing.
///
/// Without this a busy agent appends a record per command, which is pure noise in
/// an append-only log.
pub const TOUCH_INTERVAL: u64 = 60;

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, user: Option<&str>, opened: u64) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            post: "chief".into(),
            agent: "claude-code".into(),
            user: user.map(str::to_string),
            opened,
            last_seen: opened,
        }
    }

    fn log_of(lines: &[String]) -> String {
        lines.join("\n")
    }

    #[test]
    fn an_open_session_folds_out() {
        let log = log_of(&[encode_open(&s("s-1", Some("chandra"), 100))]);
        let out = fold(&log);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "s-1");
        assert_eq!(out[0].user.as_deref(), Some("chandra"));
        assert_eq!(out[0].post, "chief");
    }

    #[test]
    fn a_closed_session_disappears() {
        let log = log_of(&[
            encode_open(&s("s-1", Some("chandra"), 100)),
            encode_close("s-1", 200),
        ]);
        assert!(fold(&log).is_empty());
    }

    #[test]
    fn touch_advances_last_seen_but_not_opened() {
        let log = log_of(&[
            encode_open(&s("s-1", Some("chandra"), 100)),
            encode_touch("s-1", 500),
        ]);
        let out = fold(&log);
        assert_eq!(out[0].opened, 100, "age is measured from the open");
        assert_eq!(out[0].last_seen, 500);
        assert_eq!(out[0].age_secs(600), 500);
        assert_eq!(out[0].idle_secs(600), 100);
    }

    #[test]
    fn an_out_of_order_touch_never_moves_last_seen_backwards() {
        let log = log_of(&[
            encode_open(&s("s-1", Some("chandra"), 100)),
            encode_touch("s-1", 500),
            encode_touch("s-1", 300),
        ]);
        assert_eq!(fold(&log)[0].last_seen, 500);
    }

    #[test]
    fn a_session_with_no_user_is_autonomous() {
        let log = log_of(&[encode_open(&s("s-9", None, 100))]);
        let out = fold(&log);
        assert!(out[0].is_autonomous());
        assert!(out[0].who().contains("autonomous"), "{}", out[0].who());
    }

    #[test]
    fn expiry_is_measured_from_idle_not_from_age() {
        let ttl = Duration::from_secs(100);
        let mut a = s("s-1", Some("chandra"), 0);
        a.last_seen = 950;
        // Opened long ago, but busy a moment ago: still live.
        assert!(!a.is_expired(ttl, 1000));
        // Same age, idle too long: expired.
        a.last_seen = 800;
        assert!(a.is_expired(ttl, 1000));
    }

    #[test]
    fn active_filters_expired_but_fold_does_not() {
        let mut old = s("s-old", Some("a"), 0);
        old.last_seen = 0;
        let fresh = s("s-new", Some("b"), 990);
        let log = log_of(&[encode_open(&old), encode_open(&fresh)]);

        assert_eq!(fold(&log).len(), 2, "fold reports what is open");
        let live = active(&log, Duration::from_secs(100), 1000);
        assert_eq!(live.len(), 1, "active drops the idle one");
        assert_eq!(live[0].id, "s-new");
    }

    #[test]
    fn several_sessions_coexist_and_sort_by_recency() {
        let log = log_of(&[
            encode_open(&s("s-1", Some("chandra"), 100)),
            encode_open(&s("s-2", Some("priya"), 200)),
            encode_touch("s-1", 300),
        ]);
        let out = fold(&log);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "s-1", "most recently seen first");
    }

    #[test]
    fn a_torn_line_is_skipped_not_fatal() {
        let log = log_of(&[
            encode_open(&s("s-1", Some("chandra"), 100)),
            "session\tid=s-2\tevent=op".to_string(),
            "not a record at all".to_string(),
            encode_open(&s("s-3", Some("priya"), 200)),
        ]);
        let out = fold(&log);
        assert_eq!(out.len(), 2, "the good records survive");
    }

    #[test]
    fn a_foreign_record_kind_is_ignored() {
        let log = log_of(&[
            "intent\tid=x\tkind=task".to_string(),
            encode_open(&s("s-1", Some("chandra"), 100)),
        ]);
        assert_eq!(fold(&log).len(), 1);
    }

    #[test]
    fn reopening_the_same_id_does_not_duplicate() {
        let log = log_of(&[
            encode_open(&s("s-1", Some("chandra"), 100)),
            encode_open(&s("s-1", Some("chandra"), 200)),
        ]);
        assert_eq!(fold(&log).len(), 1);
    }

    #[test]
    fn ids_are_not_sequential() {
        // Distinct seeds must not produce adjacent ids, or a protocol path that
        // accepted one could enumerate the rest.
        let a = open("chief", "claude-code", None, 1).id;
        let b = open("chief", "claude-code", None, 2).id;
        assert_ne!(a, b);
        assert!(a.starts_with("s-") && a.len() == 10, "{a}");
        let (na, nb) = (
            u32::from_str_radix(&a[2..], 16).unwrap(),
            u32::from_str_radix(&b[2..], 16).unwrap(),
        );
        assert!(na.abs_diff(nb) > 1, "ids {a} and {b} are adjacent");
    }

    #[test]
    fn open_records_round_trip() {
        let before = open("chief", "claude-code", Some("chandra".into()), 7);
        let out = fold(&encode_open(&before));
        assert_eq!(out[0], before);
    }
}
