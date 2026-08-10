//! Path and command matching.
//!
//! Small on purpose: `**` spans segments, `*` and `?` stay within one. That is the
//! whole language, and it is enough for every scope this system enforces.

/// Whether `path` matches `pattern`.
#[must_use]
pub fn matches(pattern: &str, path: &str) -> bool {
    let p: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let t: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    segments(&p, &t)
}

/// Whether any pattern in `patterns` matches `path`.
#[must_use]
pub fn any_matches(patterns: &[String], path: &str) -> bool {
    patterns.iter().any(|p| matches(p, path))
}

fn segments(p: &[&str], t: &[&str]) -> bool {
    match p.first() {
        None => t.is_empty(),
        // `**` absorbs zero or more segments.
        Some(&"**") => (0..=t.len()).any(|i| segments(&p[1..], &t[i..])),
        Some(seg) => !t.is_empty() && wildcard(seg, t[0]) && segments(&p[1..], &t[1..]),
    }
}

/// `*` and `?` matching within a single segment (or across a whole string, which
/// is what command patterns want).
#[must_use]
pub fn wildcard(pattern: &str, s: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = s.chars().collect();
    go(&p, &t)
}

fn go(p: &[char], s: &[char]) -> bool {
    match p.first() {
        None => s.is_empty(),
        Some('*') => (0..=s.len()).any(|i| go(&p[1..], &s[i..])),
        Some('?') => !s.is_empty() && go(&p[1..], &s[1..]),
        Some(c) => !s.is_empty() && s[0] == *c && go(&p[1..], &s[1..]),
    }
}

/// Whether `broad` permits everything `narrow` permits.
///
/// Conservative: it may answer `false` for a pair that genuinely nests. That
/// direction is safe — delegation refuses and someone widens the parent grant
/// deliberately. Answering `true` wrongly would silently escalate privilege.
#[must_use]
pub fn covers(broad: &str, narrow: &str) -> bool {
    if broad == narrow {
        return true;
    }
    let probe = narrow
        .split(['*', '?', '['])
        .next()
        .unwrap_or(narrow)
        .trim_end_matches('/');
    if probe.is_empty() {
        // `narrow` starts with a wildcard, so only an equally broad pattern covers it.
        return broad == "**" || broad == "**/*";
    }
    matches(broad, probe) || matches(broad, &format!("{probe}/probe"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_star_spans_segments() {
        assert!(matches("crates/**", "crates/core/src/lib.rs"));
        assert!(matches("crates/**", "crates"));
        assert!(!matches("crates/**", "src/lib.rs"));
    }

    #[test]
    fn single_star_stays_in_one_segment() {
        assert!(matches("src/*.rs", "src/lib.rs"));
        assert!(!matches("src/*.rs", "src/a/b.rs"));
        assert!(matches("src/*/mod.rs", "src/a/mod.rs"));
    }

    #[test]
    fn question_mark_is_one_char() {
        assert!(wildcard("v?", "v1"));
        assert!(!wildcard("v?", "v10"));
    }

    #[test]
    fn exact_paths_match_themselves() {
        assert!(matches("Cargo.toml", "Cargo.toml"));
        assert!(!matches("Cargo.toml", "Cargo.lock"));
    }

    #[test]
    fn any_matches_scans_the_set() {
        let set = vec!["tests/**".to_string(), "src/lib.rs".to_string()];
        assert!(any_matches(&set, "tests/it/main.rs"));
        assert!(any_matches(&set, "src/lib.rs"));
        assert!(!any_matches(&set, "src/main.rs"));
    }

    #[test]
    fn command_patterns_may_span_spaces() {
        assert!(wildcard("cargo *", "cargo test --workspace"));
        assert!(wildcard("git push --force*", "git push --force-with-lease"));
        assert!(!wildcard("cargo *", "rm -rf /"));
    }

    #[test]
    fn covers_recognises_nesting() {
        assert!(covers("crates/**", "crates/export/**"));
        assert!(covers("crates/**", "crates/export/cache.rs"));
        assert!(covers("**", "anything/at/all"));
    }

    #[test]
    fn covers_refuses_widening() {
        assert!(!covers("crates/export/**", "crates/**"));
        assert!(!covers("tests/**", "src/**"));
        assert!(!covers("crates/export/**", "**"));
    }
}
