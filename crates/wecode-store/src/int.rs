//! Crossing between SQLite's one integer type and the domain's counts.
//!
//! SQLite stores every integer as `i64`. Budgets, spends and durations are `u64`,
//! because a negative one is meaningless. Both directions are lossy in principle, and
//! they are lossy in ways that matter very differently.
//!
//! Going **out** is safe in practice and saturates: a count above `i64::MAX` is not
//! reachable by anything that counts tokens or seconds, and threading an error through
//! every write to guard against 9.2 quintillion would buy nothing.
//!
//! Coming **in** is the direction that matters. `-1 as u64` is 18446744073709551615,
//! so a negative in the database would read back as a budget nothing could exhaust —
//! a corrupt row silently granting unlimited spend, in a system whose entire purpose
//! is enforcing limits. So it is refused as corruption instead, the same way an
//! unrecognised status string already is.

use crate::StoreError;

/// A count on its way into the database.
pub(crate) fn to_db(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// A count on its way out, refused if it could not have been written by us.
pub(crate) fn from_db(n: i64, what: &'static str) -> Result<u64, StoreError> {
    u64::try_from(n).map_err(|_| StoreError::Corrupt {
        what,
        value: n.to_string(),
    })
}

/// The same check inside a `query_map` closure, which owes rusqlite its own error
/// type. `IntegralValueOutOfRange` says exactly this, and carries the column and the
/// offending value, so the reason survives even though the error type changes.
pub(crate) fn from_row(n: i64, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(n).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, n))
}

pub(crate) fn opt_to_db(n: Option<u64>) -> Option<i64> {
    n.map(to_db)
}

pub(crate) fn opt_from_db(n: Option<i64>, what: &'static str) -> Result<Option<u64>, StoreError> {
    n.map(|v| from_db(v, what)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_negative_count_is_corruption_rather_than_an_enormous_one() {
        // The whole reason this module exists: `-1 as u64` is a budget nothing can
        // exhaust, which would disable the limit it was meant to record.
        let e = from_db(-1, "budget tokens").unwrap_err();
        assert!(matches!(e, StoreError::Corrupt { what, .. } if what == "budget tokens"));
    }

    #[test]
    fn ordinary_counts_survive_the_round_trip() {
        for n in [0, 1, 200_000, u64::from(u32::MAX)] {
            assert_eq!(from_db(to_db(n), "n").unwrap(), n);
        }
    }

    #[test]
    fn a_count_too_large_to_store_saturates_rather_than_wrapping() {
        // Unreachable by anything counting tokens, but wrapping would turn a huge
        // budget into a negative one, which the read side would then reject.
        assert_eq!(to_db(u64::MAX), i64::MAX);
    }

    #[test]
    fn absence_stays_absence_in_both_directions() {
        assert_eq!(opt_to_db(None), None);
        assert_eq!(opt_from_db(None, "n").unwrap(), None);
    }
}
