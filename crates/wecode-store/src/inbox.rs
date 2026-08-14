//! How far a reply channel has been read.
//!
//! A chat channel hands the same message over until it is told not to. Something has
//! to remember where reading got to, and that something cannot be the audit ledger:
//! a signature records that a holder approved a thing, not that a particular *message*
//! was looked at. The two come apart in both directions — a reply saying `no` writes
//! no signature and must still never be read twice, and a task can be signed at a
//! terminal without any message being involved at all.
//!
//! One row per channel, holding the highest update id the channel has handed over.
//! Whatever came of that update — signed, refused, or not a decision at all — it has
//! been read, and reading it again would act on a week-old "yes" every pass.
//!
//! The cursor only ever moves **forward**. Replaying an older batch of updates, which
//! a retried fetch or a hand-run command can produce, must not reopen messages already
//! consumed.

use rusqlite::{OptionalExtension, params};

use crate::{Store, StoreError, now_secs};

impl Store {
    /// The highest update id read on `channel`, or `None` if none ever was.
    ///
    /// `None` is not zero. A channel nobody has read yet is asking for everything it
    /// still holds; a channel sitting at 0 has read update 0 and wants what follows.
    pub fn inbox_cursor(&self, channel: &str) -> Result<Option<i64>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT last_id FROM inbox_cursor WHERE channel = ?1",
                [channel],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Records that everything up to and including `last_id` has been read.
    ///
    /// Monotonic in SQL rather than in the caller, because the caller is not the only
    /// writer: two `wecode telegram` runs racing on the same workspace would otherwise
    /// let the slower one's older batch rewind the faster one's progress.
    pub fn mark_inbox_read(&self, channel: &str, last_id: i64) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT INTO inbox_cursor (channel, last_id, at) VALUES (?1, ?2, ?3)
             ON CONFLICT(channel) DO UPDATE
             SET last_id = max(last_id, excluded.last_id), at = excluded.at",
            params![channel, last_id, crate::int::to_db(now_secs())],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;

    #[test]
    fn a_channel_nobody_has_read_has_no_position() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.inbox_cursor("telegram").unwrap(), None);
    }

    #[test]
    fn reading_moves_the_cursor_and_stays_where_it_was_put() {
        let s = Store::in_memory().unwrap();
        s.mark_inbox_read("telegram", 41).unwrap();
        assert_eq!(s.inbox_cursor("telegram").unwrap(), Some(41));
        s.mark_inbox_read("telegram", 42).unwrap();
        assert_eq!(s.inbox_cursor("telegram").unwrap(), Some(42));
    }

    #[test]
    fn an_older_batch_does_not_rewind_a_channel() {
        // The property that makes re-running safe. A fetch that hands back updates
        // already consumed — a retry, a second operator, a dump replayed by hand —
        // must not put a week-old "approve" back in front of the signer.
        let s = Store::in_memory().unwrap();
        s.mark_inbox_read("telegram", 100).unwrap();
        s.mark_inbox_read("telegram", 7).unwrap();
        assert_eq!(s.inbox_cursor("telegram").unwrap(), Some(100));
    }

    #[test]
    fn channels_are_read_independently() {
        let s = Store::in_memory().unwrap();
        s.mark_inbox_read("telegram", 5).unwrap();
        assert_eq!(s.inbox_cursor("signal").unwrap(), None);
        s.mark_inbox_read("signal", 2).unwrap();
        assert_eq!(s.inbox_cursor("telegram").unwrap(), Some(5));
        assert_eq!(s.inbox_cursor("signal").unwrap(), Some(2));
    }

    #[test]
    fn update_zero_is_a_position_and_not_an_absence() {
        // Telegram numbers updates from wherever the bot's history starts, and the
        // difference between "read nothing" and "read update 0" is which offset the
        // next fetch asks for.
        let s = Store::in_memory().unwrap();
        s.mark_inbox_read("telegram", 0).unwrap();
        assert_eq!(s.inbox_cursor("telegram").unwrap(), Some(0));
    }
}
