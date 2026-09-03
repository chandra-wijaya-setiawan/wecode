//! The dispatcher: whether anything is there to start work at all.
//!
//! An execution's beat says *this run is being watched*. It can only ever speak for a
//! run that exists, so on a workspace with a full queue and nothing running it says
//! nothing — which is the exact state a board has to explain. Three ready tasks and no
//! `wecode loop` looks like three ready tasks and a loop that has not reached them yet,
//! and until this table those were the same database.
//!
//! One row per driver process, opened when it starts, stamped every pass, closed on the
//! way out. Alive means **open and beating**: `closed IS NULL` says it did not exit, and
//! a recent beat says the machine it was on did not stop either. A pid would answer
//! neither — after a reboot it names somebody else's process.
//!
//! How recent is the caller's to decide, because the pass interval is the caller's. What
//! this module owes is the two facts a reader needs to say more than *nothing is
//! moving*: which drivers are open, and when one was last heard from.

use std::time::Duration;

use rusqlite::{OptionalExtension, params};

use crate::{Store, StoreError, now_secs};

/// One `wecode loop` process, as a reader sees it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Driver {
    pub id: i64,
    /// Whose machine it is dispatching from. Nothing joins on it; it is what a stale
    /// beat is read beside, where *which* laptop went to sleep is the next question.
    pub host: String,
    pub started: u64,
    /// The second it last completed a pass. Never absent: no row here predates the
    /// column, and the insert is the first pass.
    pub beat: u64,
}

impl Driver {
    /// How long since it last said it was dispatching.
    ///
    /// Saturating, so a beat that reads future-dated — a wall clock stepped backwards
    /// under a running loop — reads as *this moment* rather than as an age near
    /// `u64::MAX`. A driver wrongly called live is corrected by the next pass; one
    /// wrongly called absent sends an operator to restart a loop that is already there.
    #[must_use]
    pub fn silent_secs(&self, now: u64) -> u64 {
        now.saturating_sub(self.beat)
    }

    #[must_use]
    pub fn is_live(&self, within: Duration, now: u64) -> bool {
        self.silent_secs(now) <= within.as_secs()
    }
}

impl Store {
    /// Opens a row for a driver that is starting, and returns its id.
    ///
    /// `beat` opens equal to `started` for the reason [`Store::start_execution`]'s does:
    /// the insert is the first report of being here, and a row whose beat were absent
    /// for its first pass would read as a driver that had already gone quiet.
    pub fn driver_start(&self, host: &str) -> Result<i64, StoreError> {
        let c = self.conn();
        c.execute(
            "INSERT INTO drivers (host, started, beat) VALUES (?1, ?2, ?2)",
            params![host, crate::int::to_db(now_secs())],
        )?;
        Ok(c.last_insert_rowid())
    }

    /// Stamps a driver's row: it was still dispatching at this second.
    ///
    /// Only while the row is open, on [`Store::beat`]'s rule — a closed driver's last
    /// beat is history, and a late stamp must not put a stopped loop back on the board.
    /// Waits briefly on a locked database for the same reason too: a beat lost to a
    /// dispatch writing beside it is a beat that has to be waited for, not skipped.
    pub fn driver_beat(&self, id: i64) -> Result<(), StoreError> {
        self.conn().busy_timeout(Duration::from_secs(5))?;
        self.conn().execute(
            "UPDATE drivers SET beat = ?2 WHERE id = ?1 AND closed IS NULL",
            params![id, crate::int::to_db(now_secs())],
        )?;
        Ok(())
    }

    /// Closes a driver's row: it exited, and is not coming back to this row.
    ///
    /// The clean half of the pair. What is left open is either a driver still running or
    /// a machine that stopped without running any code, and the beat is what tells those
    /// two apart — so nothing here has to guess on behalf of an exit that never happened.
    pub fn driver_stop(&self, id: i64) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE drivers SET closed = ?2 WHERE id = ?1 AND closed IS NULL",
            params![id, crate::int::to_db(now_secs())],
        )?;
        Ok(())
    }

    /// Every driver that has not exited, freshest beat first — silent ones included, so
    /// a loop that stopped being one can be reported rather than hidden.
    ///
    /// What [`Store::sessions_all`] is to sessions: the raw set, with the judgement about
    /// staleness left to whoever knows the interval.
    pub fn open_drivers(&self) -> Result<Vec<Driver>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT id, host, started, beat
               FROM drivers WHERE closed IS NULL ORDER BY beat DESC, id DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Driver {
                    id: r.get(0)?,
                    host: r.get(1)?,
                    started: crate::int::from_row(r.get(2)?, 2)?,
                    beat: crate::int::from_row(r.get(3)?, 3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// The driver dispatching this workspace now, if one is: open, and beaten inside
    /// `within`.
    ///
    /// The freshest, when a workspace is driven from two machines. Which one it is
    /// matters less than that there is one — the question this answers is whether the
    /// queue has anything to move it.
    pub fn live_driver(&self, within: Duration) -> Result<Option<Driver>, StoreError> {
        let now = now_secs();
        Ok(self
            .open_drivers()?
            .into_iter()
            .find(|d| d.is_live(within, now)))
    }

    /// When a driver was last heard from at all, or `None` if none ever ran here.
    ///
    /// Across closed rows as well as open ones, because the reading is *how long has
    /// nothing been dispatching* and a loop somebody shut down on purpose stopped
    /// dispatching at its last pass, exactly like one whose laptop closed.
    ///
    /// `None` is not *a long time ago*. A workspace nobody has ever driven is a fresh
    /// checkout, and telling its operator that the loop has been down for 56 years is
    /// worse than telling them there has not been one.
    pub fn last_driver_beat(&self) -> Result<Option<u64>, StoreError> {
        let newest: Option<i64> = self
            .conn()
            .query_row("SELECT max(beat) FROM drivers", [], |r| r.get(0))
            .optional()?
            .flatten();
        crate::int::opt_from_db(newest, "driver beat")
    }

    /// Backdates a driver, for tests that need silence without waiting — what
    /// [`Store::backdate_run`] is to executions.
    #[doc(hidden)]
    pub fn backdate_driver(&self, id: i64, beat: u64) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE drivers SET started = min(started, ?2), beat = ?2 WHERE id = ?1",
            params![id, crate::int::to_db(beat)],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Twelve passes at the loop's five-second interval, as the design fixed the window.
    /// The store takes it as an argument; this is a test's stand-in for what the caller
    /// will pass.
    const WINDOW: Duration = Duration::from_secs(60);

    fn store() -> Store {
        Store::in_memory().unwrap()
    }

    #[test]
    fn a_workspace_nobody_has_driven_says_so_rather_than_saying_nothing() {
        let s = store();
        assert!(s.open_drivers().unwrap().is_empty());
        assert_eq!(s.live_driver(WINDOW).unwrap(), None);
        assert_eq!(
            s.last_driver_beat().unwrap(),
            None,
            "never driven is not driven long ago"
        );
    }

    #[test]
    fn a_driver_is_live_from_the_moment_it_starts() {
        // Before its second pass there is nothing but the insert to go on, and a loop
        // that reads as absent for its first five seconds is one the board reports as
        // missing while it is dispatching.
        let s = store();
        let id = s.driver_start("laptop").unwrap();
        let live = s.live_driver(WINDOW).unwrap().expect("it just started");
        assert_eq!(live.id, id);
        assert_eq!(live.host, "laptop");
        assert_eq!(live.beat, live.started, "starting is the first pass");
    }

    #[test]
    fn an_idle_loop_is_told_from_an_absent_one() {
        // The whole point of the table. Two workspaces with an empty board: one has a
        // loop beating through a quiet queue, the other has nobody. Before this they
        // were the same file.
        let s = store();
        let idle = s.driver_start("laptop").unwrap();
        assert!(s.live_driver(WINDOW).unwrap().is_some());

        s.backdate_driver(idle, now_secs() - WINDOW.as_secs() - 1)
            .unwrap();
        assert_eq!(
            s.live_driver(WINDOW).unwrap(),
            None,
            "a loop silent past the window is not dispatching"
        );
        assert!(
            s.last_driver_beat().unwrap().is_some(),
            "and how long it has been silent is still answerable"
        );
    }

    #[test]
    fn a_driver_that_beats_stays_live_through_a_silence_that_would_have_buried_it() {
        let s = store();
        let id = s.driver_start("laptop").unwrap();
        s.backdate_driver(id, now_secs() - WINDOW.as_secs() - 1)
            .unwrap();
        s.driver_beat(id).unwrap();
        assert_eq!(
            s.live_driver(WINDOW).unwrap().map(|d| d.id),
            Some(id),
            "the pass that beat is the evidence it is still here"
        );
    }

    #[test]
    fn a_driver_that_exited_is_not_live_however_recently_it_beat() {
        // `closed` is a report and the beat is only evidence, so the report wins: a
        // loop that stopped a second ago has a beat a second old and is not dispatching.
        let s = store();
        let id = s.driver_start("laptop").unwrap();
        s.driver_stop(id).unwrap();
        assert!(s.open_drivers().unwrap().is_empty());
        assert_eq!(s.live_driver(WINDOW).unwrap(), None);
        assert!(
            s.last_driver_beat().unwrap().is_some(),
            "when it was last dispatching is what the board prints"
        );
    }

    #[test]
    fn a_beat_never_reopens_a_driver_that_stopped() {
        // A stamp arriving after the exit — a shutdown racing the pass that was already
        // in flight — must not put a dead loop back on the board.
        let s = store();
        let id = s.driver_start("laptop").unwrap();
        s.backdate_driver(id, 1_000).unwrap();
        s.driver_stop(id).unwrap();
        s.driver_beat(id).unwrap();

        let (beat, closed): (i64, Option<i64>) = s
            .conn()
            .query_row("SELECT beat, closed FROM drivers WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(beat, 1_000, "history is not rewritten");
        assert!(closed.is_some(), "and it is still closed");
    }

    #[test]
    fn two_machines_can_drive_one_workspace_and_the_freshest_answers() {
        let s = store();
        let stale = s.driver_start("desk").unwrap();
        let fresh = s.driver_start("laptop").unwrap();
        s.backdate_driver(stale, now_secs() - WINDOW.as_secs() - 1)
            .unwrap();

        let open = s.open_drivers().unwrap();
        assert_eq!(open.len(), 2, "a silent driver is reported, not hidden");
        assert_eq!(open[0].id, fresh, "freshest beat first");
        assert_eq!(s.live_driver(WINDOW).unwrap().map(|d| d.id), Some(fresh));
    }

    #[test]
    fn the_last_beat_is_the_newest_across_every_driver_that_ever_ran() {
        // What "no loop for 6m" is measured from. A loop somebody shut down cleanly on
        // Friday still says when this workspace was last dispatched.
        let s = store();
        let old = s.driver_start("desk").unwrap();
        s.backdate_driver(old, 1_000).unwrap();
        s.driver_stop(old).unwrap();
        let newer = s.driver_start("laptop").unwrap();
        s.backdate_driver(newer, 5_000).unwrap();
        s.driver_stop(newer).unwrap();

        assert_eq!(s.last_driver_beat().unwrap(), Some(5_000));
    }

    #[test]
    fn a_beat_from_the_future_reads_as_this_moment_rather_than_as_an_age() {
        // A wall clock stepped backwards under a running loop. Reading the difference
        // as an enormous silence would send an operator to restart the loop they are
        // watching work.
        let d = Driver {
            id: 1,
            host: "laptop".into(),
            started: 100,
            beat: 500,
        };
        assert_eq!(d.silent_secs(400), 0);
        assert!(d.is_live(WINDOW, 400));
    }
}
