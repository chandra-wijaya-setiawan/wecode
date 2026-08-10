//! Minimal argument parsing: positionals plus `--flag value` and `--flag`.

use std::collections::BTreeMap;

#[derive(Clone, Default, Debug)]
pub(crate) struct Args {
    pub(crate) positional: Vec<String>,
    flags: BTreeMap<String, Vec<String>>,
}

impl Args {
    /// Parses argv. A `--flag` with no following value is a boolean flag.
    pub(crate) fn parse<I: IntoIterator<Item = String>>(argv: I) -> Self {
        let mut out = Self::default();
        let mut it = argv.into_iter().peekable();
        while let Some(arg) = it.next() {
            if let Some(name) = arg.strip_prefix("--") {
                // Support --key=value as well as --key value.
                if let Some((k, v)) = name.split_once('=') {
                    out.flags
                        .entry(k.to_string())
                        .or_default()
                        .push(v.to_string());
                    continue;
                }
                let takes_value = it.peek().is_some_and(|next| !next.starts_with("--"));
                if takes_value {
                    let v = it.next().unwrap_or_default();
                    out.flags.entry(name.to_string()).or_default().push(v);
                } else {
                    out.flags.entry(name.to_string()).or_default();
                }
            } else {
                out.positional.push(arg);
            }
        }
        out
    }

    #[must_use]
    pub(crate) fn cmd(&self, n: usize) -> &str {
        self.positional.get(n).map_or("", String::as_str)
    }

    #[must_use]
    pub(crate) fn has(&self, name: &str) -> bool {
        self.flags.contains_key(name)
    }

    #[must_use]
    pub(crate) fn get(&self, name: &str) -> Option<&str> {
        self.flags.get(name)?.first().map(String::as_str)
    }

    /// Every occurrence of a repeatable flag.
    #[must_use]
    pub(crate) fn all(&self, name: &str) -> Vec<&str> {
        self.flags
            .get(name)
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default()
    }

    #[must_use]
    pub(crate) fn num(&self, name: &str) -> Option<u64> {
        self.get(name)?.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &[&str]) -> Args {
        Args::parse(s.iter().map(|x| (*x).to_string()))
    }

    #[test]
    fn splits_positionals_from_flags() {
        let a = parse(&["intent", "add", "--kind", "task"]);
        assert_eq!(a.positional, vec!["intent", "add"]);
        assert_eq!(a.cmd(0), "intent");
        assert_eq!(a.cmd(1), "add");
        assert_eq!(a.get("kind"), Some("task"));
    }

    #[test]
    fn missing_positional_is_empty_not_a_panic() {
        assert_eq!(parse(&[]).cmd(3), "");
    }

    #[test]
    fn boolean_flags_have_no_value() {
        let a = parse(&["--verbose", "--kind", "goal"]);
        assert!(a.has("verbose"));
        assert_eq!(a.get("verbose"), None);
        assert_eq!(a.get("kind"), Some("goal"));
    }

    #[test]
    fn trailing_boolean_flag_is_recognised() {
        let a = parse(&["tree", "--all"]);
        assert!(a.has("all"));
    }

    #[test]
    fn key_equals_value_works() {
        let a = parse(&["--kind=project", "--tokens=5000"]);
        assert_eq!(a.get("kind"), Some("project"));
        assert_eq!(a.num("tokens"), Some(5000));
    }

    #[test]
    fn repeated_flags_accumulate() {
        let a = parse(&["--write", "src/**", "--write", "tests/**"]);
        assert_eq!(a.all("write"), vec!["src/**", "tests/**"]);
        assert_eq!(a.get("write"), Some("src/**"));
    }

    #[test]
    fn unknown_flag_reads_as_absent() {
        let a = parse(&["--kind", "task"]);
        assert!(!a.has("nope"));
        assert_eq!(a.get("nope"), None);
        assert_eq!(a.num("nope"), None);
    }

    #[test]
    fn non_numeric_number_is_none() {
        assert_eq!(parse(&["--tokens", "lots"]).num("tokens"), None);
    }
}
