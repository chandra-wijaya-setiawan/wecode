//! A minimal TOML subset, enough for hand-edited configuration.
//!
//! Supports `[table]`, `[[array-of-tables]]`, comments, and values that are
//! strings, integers, booleans or string arrays. That covers every field the
//! company profile needs. Anything richer is rejected with a line number rather
//! than silently misread.
//!
//! Exists because `serde`/`toml` need a host proc-macro this machine cannot link.
//! When that changes, delete this and swap in the real crate: only `company.rs`
//! touches it.

use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Value {
    Str(String),
    Int(i64),
    Bool(bool),
    List(Vec<String>),
}

impl Value {
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Self::Int(i) => Some(*i),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// A single string reads as a one-element list, which is the ergonomic thing
    /// for `write = "src/**"` versus `write = ["src/**"]`.
    #[must_use]
    pub fn as_list(&self) -> Option<Vec<String>> {
        match self {
            Self::List(v) => Some(v.clone()),
            Self::Str(s) => Some(vec![s.clone()]),
            _ => None,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ConfError {
    pub line: usize,
    pub message: String,
}

impl fmt::Display for ConfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for ConfError {}

fn err<T>(line: usize, message: impl Into<String>) -> Result<T, ConfError> {
    Err(ConfError {
        line,
        message: message.into(),
    })
}

/// A parsed document: a root table, named tables, and arrays of tables.
#[derive(Clone, Default, Debug)]
pub struct Doc {
    pub root: BTreeMap<String, Value>,
    pub tables: BTreeMap<String, BTreeMap<String, Value>>,
    pub arrays: BTreeMap<String, Vec<BTreeMap<String, Value>>>,
}

impl Doc {
    /// Value from the root table.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.root.get(key)
    }

    /// Value from a named table.
    #[must_use]
    pub fn table_get(&self, table: &str, key: &str) -> Option<&Value> {
        self.tables.get(table)?.get(key)
    }

    #[must_use]
    pub fn table(&self, name: &str) -> Option<&BTreeMap<String, Value>> {
        self.tables.get(name)
    }

    /// Named tables whose name starts with `prefix.`, paired with their suffix.
    /// Used for `[roles.engineer]`-style blocks.
    #[must_use]
    pub fn tables_under(&self, prefix: &str) -> Vec<(String, &BTreeMap<String, Value>)> {
        let head = format!("{prefix}.");
        self.tables
            .iter()
            .filter_map(|(k, v)| k.strip_prefix(&head).map(|s| (s.to_string(), v)))
            .collect()
    }

    #[must_use]
    pub fn array(&self, name: &str) -> &[BTreeMap<String, Value>] {
        self.arrays.get(name).map_or(&[], Vec::as_slice)
    }
}

/// Parses a document.
pub fn parse(text: &str) -> Result<Doc, ConfError> {
    let mut doc = Doc::default();
    // None => root table.
    let mut current: Option<(bool, String)> = None;

    let lines: Vec<&str> = text.lines().collect();
    let mut idx = 0;
    while idx < lines.len() {
        let raw = lines[idx];
        let line = idx + 1;
        idx += 1;

        let s = strip_comment(raw).trim();
        if s.is_empty() {
            continue;
        }

        if let Some(rest) = s.strip_prefix("[[") {
            let name = rest
                .strip_suffix("]]")
                .ok_or_else(|| ConfError {
                    line,
                    message: "unterminated [[array]] header".into(),
                })?
                .trim()
                .to_string();
            if name.is_empty() {
                return err(line, "empty [[array]] name");
            }
            doc.arrays
                .entry(name.clone())
                .or_default()
                .push(BTreeMap::new());
            current = Some((true, name));
            continue;
        }

        if let Some(rest) = s.strip_prefix('[') {
            let name = rest
                .strip_suffix(']')
                .ok_or_else(|| ConfError {
                    line,
                    message: "unterminated [table] header".into(),
                })?
                .trim()
                .to_string();
            if name.is_empty() {
                return err(line, "empty [table] name");
            }
            doc.tables.entry(name.clone()).or_default();
            current = Some((false, name));
            continue;
        }

        // Re-split on the raw line: a `#` inside a multi-line string must not be
        // treated as a comment, and `strip_comment` has already run on `s`.
        let Some((key, _)) = s.split_once('=') else {
            return err(line, format!("expected `key = value`, got `{s}`"));
        };
        let key = key.trim().to_string();
        if key.is_empty() {
            return err(line, "empty key");
        }
        let rhs_raw = raw
            .split_once('=')
            .map(|(_, r)| r.trim())
            .unwrap_or_default();

        let value = if rhs_raw.starts_with("\"\"\"") {
            let (text, consumed) = read_multiline(&lines, idx - 1, line)?;
            idx = consumed;
            Value::Str(text)
        } else {
            parse_value(strip_comment(rhs_raw).trim(), line)?
        };

        let slot = match &current {
            None => &mut doc.root,
            Some((false, name)) => doc.tables.entry(name.clone()).or_default(),
            Some((true, name)) => doc
                .arrays
                .get_mut(name)
                .and_then(|v| v.last_mut())
                .expect("array table pushed on header"),
        };
        slot.insert(key, value);
    }
    Ok(doc)
}

/// Reads a `"""`-delimited string starting on `lines[start]`.
///
/// Returns the body and the index of the line after the closing delimiter. As in
/// TOML, a newline immediately following the opening delimiter is dropped, so
/// prose can begin on the next line without a leading blank.
fn read_multiline(
    lines: &[&str],
    start: usize,
    line_no: usize,
) -> Result<(String, usize), ConfError> {
    let first = lines[start];
    let after_eq = first.split_once('=').map(|(_, r)| r.trim()).unwrap_or("");
    let opened = &after_eq[3..];

    // Closing delimiter on the same line.
    if let Some(body) = opened.strip_suffix("\"\"\"") {
        return Ok((body.to_string(), start + 1));
    }

    let mut body = String::new();
    if !opened.is_empty() {
        body.push_str(opened);
        body.push('\n');
    }
    let mut i = start + 1;
    while i < lines.len() {
        let l = lines[i];
        i += 1;
        if let Some(pos) = l.find("\"\"\"") {
            body.push_str(&l[..pos]);
            // Trim the trailing newline the loop added for the final fragment.
            while body.ends_with('\n') {
                body.pop();
            }
            return Ok((body, i));
        }
        body.push_str(l);
        body.push('\n');
    }
    err(line_no, "unterminated \"\"\" string")
}

/// Strips a trailing `#` comment, ignoring `#` inside quotes.
fn strip_comment(s: &str) -> &str {
    let mut in_quote = false;
    for (i, c) in s.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            '#' if !in_quote => return &s[..i],
            _ => {}
        }
    }
    s
}

fn parse_value(s: &str, line: usize) -> Result<Value, ConfError> {
    if s.is_empty() {
        return err(line, "missing value");
    }
    if s == "true" {
        return Ok(Value::Bool(true));
    }
    if s == "false" {
        return Ok(Value::Bool(false));
    }
    if s.starts_with('"') {
        return Ok(Value::Str(parse_string(s, line)?));
    }
    if let Some(inner) = s.strip_prefix('[') {
        let inner = inner
            .strip_suffix(']')
            .ok_or_else(|| ConfError {
                line,
                message: "unterminated array (arrays must be on one line)".into(),
            })?
            .trim();
        if inner.is_empty() {
            return Ok(Value::List(Vec::new()));
        }
        let mut items = Vec::new();
        for part in split_top_level(inner) {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            if !part.starts_with('"') {
                return err(line, format!("array items must be quoted, got `{part}`"));
            }
            items.push(parse_string(part, line)?);
        }
        return Ok(Value::List(items));
    }
    // Integers may use `_` separators.
    let cleaned: String = s.chars().filter(|c| *c != '_').collect();
    cleaned
        .parse::<i64>()
        .map(Value::Int)
        .map_err(|_| ConfError {
            line,
            message: format!("unsupported value `{s}` (want string, integer, bool or array)"),
        })
}

fn parse_string(s: &str, line: usize) -> Result<String, ConfError> {
    let body = s
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .ok_or_else(|| ConfError {
            line,
            message: format!("unterminated string `{s}`"),
        })?;
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => return err(line, format!("unknown escape `\\{other}`")),
            None => return err(line, "trailing backslash"),
        }
    }
    Ok(out)
}

/// Splits on commas that are not inside quotes.
fn split_top_level(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut in_quote = false;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            ',' if !in_quote => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_root_values() {
        let d = parse("name = \"acme\"\nseats = 3\nactive = true\n").unwrap();
        assert_eq!(d.get("name").unwrap().as_str(), Some("acme"));
        assert_eq!(d.get("seats").unwrap().as_int(), Some(3));
        assert_eq!(d.get("active").unwrap().as_bool(), Some(true));
    }

    #[test]
    fn parses_tables() {
        let d = parse("[company]\nname = \"acme\"\n\n[attention]\nmax = 5\n").unwrap();
        assert_eq!(
            d.table_get("company", "name").unwrap().as_str(),
            Some("acme")
        );
        assert_eq!(d.table_get("attention", "max").unwrap().as_int(), Some(5));
    }

    #[test]
    fn parses_arrays_of_tables() {
        let d =
            parse("[[posts]]\nname = \"impl\"\n\n[[posts]]\nname = \"test\"\nagent = \"codex\"\n")
                .unwrap();
        let posts = d.array("posts");
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0]["name"].as_str(), Some("impl"));
        assert_eq!(posts[1]["agent"].as_str(), Some("codex"));
    }

    #[test]
    fn parses_string_arrays() {
        let d = parse("write = [\"src/**\", \"tests/**\"]\nempty = []\n").unwrap();
        assert_eq!(
            d.get("write").unwrap().as_list().unwrap(),
            vec!["src/**".to_string(), "tests/**".to_string()]
        );
        assert!(d.get("empty").unwrap().as_list().unwrap().is_empty());
    }

    #[test]
    fn a_bare_string_reads_as_a_one_item_list() {
        let d = parse("write = \"src/**\"\n").unwrap();
        assert_eq!(d.get("write").unwrap().as_list().unwrap(), vec!["src/**"]);
    }

    #[test]
    fn dotted_tables_are_addressable_by_prefix() {
        let d = parse(
            "[roles.engineer]\nwrite = [\"src/**\"]\n\n[roles.tester]\nwrite = [\"tests/**\"]\n",
        )
        .unwrap();
        let mut names: Vec<String> = d
            .tables_under("roles")
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        names.sort();
        assert_eq!(names, vec!["engineer", "tester"]);
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let d = parse("# a comment\n\nname = \"acme\" # trailing\n").unwrap();
        assert_eq!(d.get("name").unwrap().as_str(), Some("acme"));
    }

    #[test]
    fn a_hash_inside_a_string_is_not_a_comment() {
        let d = parse("desc = \"tracks #123\"\n").unwrap();
        assert_eq!(d.get("desc").unwrap().as_str(), Some("tracks #123"));
    }

    #[test]
    fn underscores_in_integers_are_allowed() {
        let d = parse("tokens = 200_000\n").unwrap();
        assert_eq!(d.get("tokens").unwrap().as_int(), Some(200_000));
    }

    #[test]
    fn escapes_are_decoded() {
        let d = parse("s = \"a\\nb\\t\\\"c\\\"\"\n").unwrap();
        assert_eq!(d.get("s").unwrap().as_str(), Some("a\nb\t\"c\""));
    }

    #[test]
    fn commas_inside_strings_do_not_split_arrays() {
        let d = parse("a = [\"x,y\", \"z\"]\n").unwrap();
        assert_eq!(d.get("a").unwrap().as_list().unwrap(), vec!["x,y", "z"]);
    }

    #[test]
    fn parses_multiline_strings() {
        let d =
            parse("description = \"\"\"\nline one\nline two\n\"\"\"\nname = \"after\"\n").unwrap();
        assert_eq!(
            d.get("description").unwrap().as_str(),
            Some("line one\nline two")
        );
        // Parsing must resume correctly after the closing delimiter.
        assert_eq!(d.get("name").unwrap().as_str(), Some("after"));
    }

    #[test]
    fn a_single_line_triple_quoted_string_works() {
        let d = parse("a = \"\"\"short\"\"\"\n").unwrap();
        assert_eq!(d.get("a").unwrap().as_str(), Some("short"));
    }

    #[test]
    fn hashes_and_quotes_inside_multiline_are_literal() {
        let d = parse("a = \"\"\"\nsee #123 and \"quoted\"\n\"\"\"\n").unwrap();
        assert_eq!(
            d.get("a").unwrap().as_str(),
            Some("see #123 and \"quoted\"")
        );
    }

    #[test]
    fn multiline_inside_a_table_lands_in_that_table() {
        let d = parse("[company]\ndescription = \"\"\"\ntext\n\"\"\"\nname = \"x\"\n").unwrap();
        assert_eq!(
            d.table_get("company", "description").unwrap().as_str(),
            Some("text")
        );
        assert_eq!(d.table_get("company", "name").unwrap().as_str(), Some("x"));
    }

    #[test]
    fn an_unterminated_multiline_is_an_error() {
        let e = parse("a = \"\"\"\nnever closed\n").unwrap_err();
        assert!(e.message.contains("unterminated"), "{}", e.message);
    }

    #[test]
    fn missing_equals_names_its_line() {
        let e = parse("name = \"a\"\noops\n").unwrap_err();
        assert_eq!(e.line, 2);
        assert!(e.message.contains("key = value"), "{}", e.message);
    }

    #[test]
    fn unterminated_constructs_are_errors() {
        assert_eq!(parse("[table\n").unwrap_err().line, 1);
        assert_eq!(parse("[[arr\n").unwrap_err().line, 1);
        assert_eq!(parse("a = \"unclosed\n").unwrap_err().line, 1);
        assert_eq!(parse("a = [\"x\"\n").unwrap_err().line, 1);
    }

    #[test]
    fn unsupported_values_are_rejected_not_guessed() {
        // A float would be silently truncated if we tried to coerce it.
        let e = parse("ratio = 1.5\n").unwrap_err();
        assert!(e.message.contains("unsupported value"), "{}", e.message);
    }

    #[test]
    fn unquoted_array_items_are_rejected() {
        let e = parse("a = [x, y]\n").unwrap_err();
        assert!(e.message.contains("must be quoted"), "{}", e.message);
    }
}
