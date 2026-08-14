//! Short numbers: the handle an operator can type from a phone.
//!
//! Ids are slugs because ids are read — `oauth-device-flow` beats a UUID in a prompt,
//! in the ledger and on the board, and [`crate::id`] exists to keep them that way. But
//! the *reader* and the *typist* are not always the same person at the same keyboard.
//! A notification arrives at 02:14 saying `cache-warm-on-deploy needs your signature`,
//! and answering it means spelling that back on a phone keyboard, exactly, with the
//! hyphens in the right places. A number does not have that problem.
//!
//! So every project and every task also answers to a number. Three properties make it
//! usable rather than merely shorter:
//!
//! - **One sequence for both levels.** A number names exactly one thing in the
//!   workspace, project or task, so `wecode show 7` never has to ask which 7 was meant
//!   — and neither does the operator, who saw the number on a board that draws both.
//! - **It is a name, not a position.** Numbers are minted once, when the project or
//!   task is created, and stored. A row number would renumber every time something was
//!   added or archived, which is the same as having no handle at all: the number in a
//!   message six hours old has to still mean what it meant when it was sent.
//! - **A name always wins.** A bare `7` is looked up as an id first, so a workspace
//!   that has a task called `7` keeps it. `#7` is a number and nothing else, which is
//!   the way out when the two really do collide.
//!
//! Minting is [`crate::Plan`]'s caller's job — the store, which is the only thing that
//! can keep a sequence unique — so an in-memory plan carries `None` and simply has no
//! numbers. Nothing here invents one.

use std::fmt;

/// The character that says *number* outright, in a place a name would also fit.
pub const SIGIL: char = '#';

/// A short number naming one project or one task.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Number(u32);

impl Number {
    /// Wraps a minted number. The sequence starts at 1, and 0 is refused everywhere
    /// it could be typed, so nothing should hand this a zero.
    #[must_use]
    pub fn new(n: u32) -> Self {
        Self(n)
    }

    /// The number itself, for a store writing it down or a hook passing it on.
    #[must_use]
    pub fn get(self) -> u32 {
        self.0
    }

    /// Reads a number an operator typed: `7` or `#7`.
    ///
    /// Deliberately stricter than `u32::from_str`, which accepts `+7` and surrounding
    /// nothing else — this is matched against words out of a chat message, where a
    /// loose parser turns prose into a task reference.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        let digits = s.strip_prefix(SIGIL).unwrap_or(s);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        // Zero is not a typo worth resolving: no row ever carries it, so reading it as
        // a number and failing to find one says exactly the right thing.
        digits.parse().ok().filter(|n| *n > 0).map(Self)
    }
}

impl fmt::Display for Number {
    /// With the sigil, always. It is what makes `#7` recognisable as a wecode handle
    /// in a chat message that also contains ordinary numbers.
    ///
    /// Through `pad` rather than `write!`, so `{:>4}` aligns a column of these. A
    /// `write!` here would silently drop the width — and every view that draws these
    /// draws them in a column.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.pad(&format!("{SIGIL}{}", self.0))
    }
}

impl fmt::Debug for Number {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Number({})", self.0)
    }
}

/// Resolves what an operator typed against a lookup by name and a lookup by number.
///
/// The order is the whole content of this function, and it is the same order at every
/// call site because there is only one of it:
///
/// 1. A leading `#` says *number*. Nothing else is tried, so an explicit reference
///    cannot be shadowed by a name that happens to be digits.
/// 2. Otherwise the name goes first. An id is what everything else in wecode — the
///    ledger, the branch names, the report paths — is keyed on, and a project must not
///    lose the ability to name its own task because a number could be read out of it.
/// 3. Then the number. This is the case the feature is for: `wecode merge 4`, one
///    keystroke shorter than the sigil, on a keyboard where every keystroke was the
///    reason the answer waited until morning.
pub fn resolve<'a, T: ?Sized>(
    typed: &str,
    by_name: impl FnOnce(&str) -> Option<&'a T>,
    by_number: impl FnOnce(Number) -> Option<&'a T>,
) -> Option<&'a T> {
    let number = Number::parse(typed);
    if typed.starts_with(SIGIL) {
        return number.and_then(by_number);
    }
    match by_name(typed) {
        found @ Some(_) => found,
        None => number.and_then(by_number),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_number_with_or_without_the_sigil() {
        assert_eq!(Number::parse("7"), Some(Number::new(7)));
        assert_eq!(Number::parse("#7"), Some(Number::new(7)));
        assert_eq!(Number::parse("#412"), Some(Number::new(412)));
    }

    #[test]
    fn refuses_everything_that_is_not_a_number() {
        // A slug, the sigil alone, a signed number, whitespace, and the words a chat
        // message is made of. Each of these reaching `by_number` would be a reference
        // to whatever task happened to be numbered.
        for s in [
            "cache-tests", "#", "", "+7", "-7", " 7", "7 ", "7a", "v7", "0", "#0", "0x7",
        ] {
            assert_eq!(Number::parse(s), None, "{s} is not a number");
        }
    }

    #[test]
    fn prints_with_the_sigil() {
        assert_eq!(Number::new(7).to_string(), "#7");
        assert_eq!(format!("{:?}", Number::new(7)), "Number(7)");
    }

    #[test]
    fn pads_to_a_width_so_a_column_of_them_lines_up() {
        // Every view draws these in a gutter. A `Display` that ignored the width would
        // leave the column ragged and nothing would fail.
        assert_eq!(format!("{:>4}", Number::new(7)), "  #7");
        assert_eq!(format!("{:>4}", Number::new(412)), "#412");
        assert_eq!(format!("{:<4}|", Number::new(7)), "#7  |");
    }

    /// A lookup pair over a fixed table, so the resolution order is testable without
    /// a plan or a store.
    fn look(typed: &str) -> Option<&'static str> {
        let names = [("cache-tests", "by name"), ("7", "a task called seven")];
        resolve(
            typed,
            |n| names.iter().find(|(k, _)| *k == n).map(|(_, v)| *v),
            |n| if n.get() == 7 { Some("by number") } else { None },
        )
    }

    #[test]
    fn a_name_beats_a_number_it_could_be_read_as() {
        // The collision case. A workspace is allowed to have a task called `7`, and
        // its own id must keep working.
        assert_eq!(look("7"), Some("a task called seven"));
        // ...and the sigil is the way past it, which is why the sigil exists.
        assert_eq!(look("#7"), Some("by number"));
    }

    #[test]
    fn a_bare_number_resolves_when_no_name_claims_it() {
        assert_eq!(look("cache-tests"), Some("by name"));
        assert_eq!(look("9"), None, "nothing is numbered 9");
    }

    #[test]
    fn an_explicit_reference_never_falls_back_to_a_name() {
        // `#cache-tests` is a typo, not a reference. Falling back would make the sigil
        // decoration rather than a rule.
        assert_eq!(look("#cache-tests"), None);
    }
}
