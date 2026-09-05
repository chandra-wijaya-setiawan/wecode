//! The seat, the grant and the charter the tests under `broker` are written against.
//!
//! Shared, because the split is by what decides an action while a test needs all of it
//! at once: a session to act, a charter to be held to, and a grant narrow enough that
//! the denials mean something.

use crate::grant::{Effective, Grant};

use super::{Broker, Charter, Invariant, Session};

pub(super) fn session(effective: Effective) -> Session {
    Session::new("s1", "impl-api", "claude-code", effective)
        .on(Some("caching".into()), Some("cache-layer".into()))
}

pub(super) fn confined() -> Session {
    session(Effective::of(vec![
        Grant::writer(&["crates/export/**"])
            .with_run(&["cargo *"])
            .with_spend(100_000, 1800),
    ]))
}

pub(super) fn broker() -> Broker {
    Broker::new(Charter::with(vec![
        Invariant::NeverTouch(vec![".github/**".into(), "**/*.pem".into()]),
        Invariant::NeverRun(vec!["git push --force*".into(), "npm publish*".into()]),
        Invariant::ApprovalToMerge(vec!["main".into()]),
    ]))
}
