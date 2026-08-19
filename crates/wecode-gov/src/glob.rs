//! Path and command matching.
//!
//! Small on purpose: `**` spans segments, `*` and `?` stay within one, and a leading
//! `!` denies instead of allowing. That is the whole language, and it is enough for
//! every scope this system enforces.

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

/// What a `!`-prefixed entry denies, or `None` for an ordinary allow.
///
/// `!` is the whole syntax, and it needs no escape: nothing anyone runs is a command
/// whose first character is `!`, so the prefix is free to mean this.
#[must_use]
pub fn denial(pattern: &str) -> Option<&str> {
    pattern.strip_prefix('!')
}

/// Every allow in `patterns`, denials dropped.
pub fn allows(patterns: &[String]) -> impl Iterator<Item = &str> {
    patterns
        .iter()
        .map(String::as_str)
        .filter(|p| denial(p).is_none())
}

/// What every denial in `patterns` denies, allows dropped.
pub fn denials(patterns: &[String]) -> impl Iterator<Item = &str> {
    patterns.iter().filter_map(|p| denial(p))
}

/// Whether `s` is permitted by a list that may carry denials.
///
/// A denial outranks every allow in the list, wherever it sits in it. Position is
/// deliberately not authority: under a last-match-wins rule what a grant means
/// depends on where a line happened to be appended, and appending is how a list
/// grows. So `["aws *", "!aws * rm *"]` reads as "the aws CLI, but nothing that
/// deletes", and it still reads that way after somebody adds another `aws` allow
/// under it.
///
/// This is what makes a read-only slice of a CLI grantable at all. The verbs live in
/// one binary, an allow glob can only name a prefix of them, and enumerating the safe
/// ones means revisiting the list every time the vendor ships a verb — a list that is
/// wrong in the permissive direction between releases. Naming the destructive verbs
/// instead is a list that is wrong in the safe direction: a verb nobody thought of is
/// denied by the fact that no allow reached it.
#[must_use]
pub fn permits(patterns: &[String], s: &str) -> bool {
    if denials(patterns).any(|d| wildcard(d, s)) {
        return false;
    }
    allows(patterns).any(|p| wildcard(p, s))
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

    fn set(patterns: &[&str]) -> Vec<String> {
        patterns.iter().map(|p| (*p).to_string()).collect()
    }

    #[test]
    fn a_denial_outranks_an_allow() {
        let p = set(&["aws *", "!aws * rm *"]);
        assert!(permits(&p, "aws s3 ls s3://logs"));
        assert!(!permits(&p, "aws s3 rm s3://logs/a"));
    }

    #[test]
    fn a_denial_outranks_it_from_anywhere_in_the_list() {
        // The same two rules in the other order. Appending an allow must not defeat a
        // denial already in the list.
        let p = set(&["!aws * rm *", "aws *"]);
        assert!(permits(&p, "aws s3 ls s3://logs"));
        assert!(!permits(&p, "aws s3 rm s3://logs/a"));
    }

    #[test]
    fn a_denial_alone_permits_nothing() {
        // It subtracts; it does not grant the complement.
        assert!(!permits(&set(&["!aws * rm *"]), "aws s3 ls s3://logs"));
        assert!(!permits(&[], "aws s3 ls s3://logs"));
    }

    #[test]
    fn a_denial_may_name_one_command() {
        let p = set(&["kubectl *", "!kubectl delete*", "!kubectl drain*"]);
        assert!(permits(&p, "kubectl get pods"));
        assert!(permits(&p, "kubectl describe pod api-0"));
        assert!(!permits(&p, "kubectl delete pod api-0"));
        assert!(!permits(&p, "kubectl drain node-3"));
    }

    #[test]
    fn denials_split_out_of_the_list() {
        let p = set(&["aws *", "!aws * rm *"]);
        assert_eq!(allows(&p).collect::<Vec<_>>(), vec!["aws *"]);
        assert_eq!(denials(&p).collect::<Vec<_>>(), vec!["aws * rm *"]);
        assert_eq!(denial("aws *"), None);
        assert_eq!(denial("!aws *"), Some("aws *"));
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
