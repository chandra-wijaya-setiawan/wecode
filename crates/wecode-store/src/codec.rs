//! A minimal line record format: `kind\tkey=value\tkey=value…`.
//!
//! Deliberately hand-rolled and boring. The design calls for JSONL, which needs
//! serde, which needs a host proc-macro, which this machine cannot link. This
//! format is a stand-in with the properties that actually matter now: one record
//! per line, append-only, human-readable, and round-trip tested. Swapping it for
//! JSONL later touches this file only.

use std::collections::BTreeMap;
use std::fmt;

use wecode_core::{
    Budget, Cmp, Horizon, Intent, IntentId, IntentKind, Link, Measure, Polarity, Scope, Sphere,
    StandaloneReason, Status,
};

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CodecError {
    UnknownRecord(String),
    MissingField(&'static str),
    BadvalueField { field: &'static str, value: String },
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownRecord(k) => write!(f, "unknown record kind `{k}`"),
            Self::MissingField(k) => write!(f, "missing field `{k}`"),
            Self::BadvalueField { field, value } => {
                write!(f, "bad value for `{field}`: {value}")
            }
        }
    }
}

impl std::error::Error for CodecError {}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\n', "\\n")
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Builds a record line from ordered fields.
struct Writer {
    parts: Vec<String>,
}

impl Writer {
    fn new(kind: &str) -> Self {
        Self {
            parts: vec![kind.to_string()],
        }
    }

    fn put(&mut self, key: &str, value: &str) -> &mut Self {
        self.parts.push(format!("{key}={}", escape(value)));
        self
    }

    fn finish(&self) -> String {
        self.parts.join("\t")
    }
}

/// Parsed fields of one record line.
#[derive(Debug)]
pub struct Fields<'a> {
    pub kind: &'a str,
    map: BTreeMap<&'a str, String>,
}

impl<'a> Fields<'a> {
    pub fn parse(line: &'a str) -> Self {
        let mut it = line.split('\t');
        let kind = it.next().unwrap_or_default();
        let mut map = BTreeMap::new();
        for part in it {
            if let Some((k, v)) = part.split_once('=') {
                map.insert(k, unescape(v));
            }
        }
        Self { kind, map }
    }

    pub fn get(&self, key: &'static str) -> Result<&str, CodecError> {
        self.map
            .get(key)
            .map(String::as_str)
            .ok_or(CodecError::MissingField(key))
    }

    pub fn opt(&self, key: &str) -> Option<&str> {
        self.map.get(key).map(String::as_str)
    }

    fn list(&self, key: &str) -> Vec<String> {
        match self.map.get(key) {
            None => Vec::new(),
            Some(v) if v.is_empty() => Vec::new(),
            Some(v) => v.split('\u{1f}').map(str::to_string).collect(),
        }
    }
}

fn join(items: &[String]) -> String {
    items.join("\u{1f}")
}

fn kind_to_str(k: IntentKind) -> &'static str {
    k.as_str()
}

fn kind_from_str(s: &str) -> Result<IntentKind, CodecError> {
    Ok(match s {
        "vision" => IntentKind::Vision,
        "goal" => IntentKind::Goal,
        "project" => IntentKind::Project,
        "task" => IntentKind::Task,
        other => {
            return Err(CodecError::BadvalueField {
                field: "kind",
                value: other.to_string(),
            });
        }
    })
}

fn horizon_to_str(h: Horizon) -> &'static str {
    match h {
        Horizon::Now => "now",
        Horizon::Week => "week",
        Horizon::Month => "month",
        Horizon::Quarter => "quarter",
        Horizon::Year => "year",
        Horizon::Indefinite => "indefinite",
    }
}

/// Parses a horizon name. Public so the CLI can accept `--horizon`.
pub fn horizon_from_str(s: &str) -> Result<Horizon, CodecError> {
    Ok(match s {
        "now" => Horizon::Now,
        "week" => Horizon::Week,
        "month" => Horizon::Month,
        "quarter" => Horizon::Quarter,
        "year" => Horizon::Year,
        "indefinite" => Horizon::Indefinite,
        other => {
            return Err(CodecError::BadvalueField {
                field: "horizon",
                value: other.to_string(),
            });
        }
    })
}

/// Parses an intent kind name. Public so the CLI can accept a kind argument.
pub fn intent_kind_from_str(s: &str) -> Result<IntentKind, CodecError> {
    kind_from_str(s)
}

fn status_to_str(s: Status) -> &'static str {
    match s {
        Status::Draft => "draft",
        Status::Active => "active",
        Status::Blocked => "blocked",
        Status::Done => "done",
        Status::Dropped => "dropped",
    }
}

fn status_from_str(s: &str) -> Status {
    match s {
        "active" => Status::Active,
        "blocked" => Status::Blocked,
        "done" => Status::Done,
        "dropped" => Status::Dropped,
        _ => Status::Draft,
    }
}

fn cmp_to_str(c: Cmp) -> &'static str {
    match c {
        Cmp::Lt => "lt",
        Cmp::Lte => "lte",
        Cmp::Gt => "gt",
        Cmp::Gte => "gte",
        Cmp::Eq => "eq",
    }
}

fn cmp_from_str(s: &str) -> Cmp {
    match s {
        "lte" => Cmp::Lte,
        "gt" => Cmp::Gt,
        "gte" => Cmp::Gte,
        "eq" => Cmp::Eq,
        _ => Cmp::Lt,
    }
}

/// Measures are encoded compactly, one per unit-separated slot.
fn measure_to_str(m: &Measure) -> String {
    match m {
        Measure::Command { cmd, expect_status } => format!("cmd|{expect_status}|{cmd}"),
        Measure::Metric { name, target, cmp } => {
            format!("metric|{}|{target}|{name}", cmp_to_str(*cmp))
        }
        Measure::Deliverable { path } => format!("file|{path}"),
        Measure::Rollup => "rollup".to_string(),
        Measure::Proxy { note } => format!("proxy|{note}"),
    }
}

fn measure_from_str(s: &str) -> Option<Measure> {
    let mut it = s.splitn(2, '|');
    let tag = it.next()?;
    let rest = it.next().unwrap_or_default();
    match tag {
        "rollup" => Some(Measure::Rollup),
        "proxy" => Some(Measure::Proxy {
            note: rest.to_string(),
        }),
        "file" => Some(Measure::Deliverable {
            path: rest.to_string(),
        }),
        "cmd" => {
            let (status, cmd) = rest.split_once('|')?;
            Some(Measure::Command {
                cmd: cmd.to_string(),
                expect_status: status.parse().ok()?,
            })
        }
        "metric" => {
            let (cmp, tail) = rest.split_once('|')?;
            let (target, name) = tail.split_once('|')?;
            Some(Measure::Metric {
                name: name.to_string(),
                target: target.parse().ok()?,
                cmp: cmp_from_str(cmp),
            })
        }
        _ => None,
    }
}

fn link_to_fields(link: &Link, w: &mut Writer) {
    match link {
        Link::Requires => {
            w.put("link", "requires");
        }
        Link::Alternative => {
            w.put("link", "alternative");
        }
        Link::Unlinked => {
            w.put("link", "unlinked");
        }
        Link::Standalone { reason } => {
            w.put("link", "standalone");
            w.put(
                "reason",
                match reason {
                    StandaloneReason::Maintenance => "maintenance",
                    StandaloneReason::Urgent => "urgent",
                    StandaloneReason::Exploration => "exploration",
                    StandaloneReason::Personal => "personal",
                },
            );
        }
        Link::Contributes {
            rationale,
            polarity,
        } => {
            w.put("link", "contributes");
            w.put("rationale", rationale);
            w.put(
                "polarity",
                match polarity {
                    Polarity::Positive => "positive",
                    Polarity::Negative => "negative",
                },
            );
        }
    }
}

/// Parses a standalone reason name. Public for the CLI's `--standalone`.
pub fn standalone_reason_from_str(s: &str) -> Result<StandaloneReason, CodecError> {
    Ok(match s {
        "maintenance" => StandaloneReason::Maintenance,
        "urgent" => StandaloneReason::Urgent,
        "exploration" => StandaloneReason::Exploration,
        "personal" => StandaloneReason::Personal,
        other => {
            return Err(CodecError::BadvalueField {
                field: "standalone",
                value: other.to_string(),
            });
        }
    })
}

fn link_from_fields(f: &Fields<'_>) -> Link {
    match f.opt("link").unwrap_or("unlinked") {
        "requires" => Link::Requires,
        "alternative" => Link::Alternative,
        "standalone" => Link::Standalone {
            reason: standalone_reason_from_str(f.opt("reason").unwrap_or("maintenance"))
                .unwrap_or(StandaloneReason::Maintenance),
        },
        "contributes" => Link::Contributes {
            rationale: f.opt("rationale").unwrap_or_default().to_string(),
            polarity: if f.opt("polarity") == Some("negative") {
                Polarity::Negative
            } else {
                Polarity::Positive
            },
        },
        _ => Link::Unlinked,
    }
}

/// Encodes an intent as one line.
#[must_use]
pub fn encode_intent(i: &Intent) -> String {
    let mut w = Writer::new("intent");
    w.put("id", i.id.as_str());
    w.put("kind", kind_to_str(i.kind));
    w.put("statement", &i.statement);
    if let Some(p) = &i.parent {
        w.put("parent", p.as_str());
    }
    link_to_fields(&i.link, &mut w);
    match &i.sphere {
        Sphere::Org => w.put("sphere", "org"),
        Sphere::Personal => w.put("sphere", "personal"),
        Sphere::Unit(u) => w.put("sphere", &format!("unit:{u}")),
    };
    w.put("horizon", horizon_to_str(i.horizon));
    w.put("weight", &i.weight.to_string());
    w.put("status", status_to_str(i.status));
    if !i.measures.is_empty() {
        let encoded: Vec<String> = i.measures.iter().map(measure_to_str).collect();
        w.put("measures", &join(&encoded));
    }
    if !i.scope.read.is_empty() {
        w.put("read", &join(&i.scope.read));
    }
    if !i.scope.write.is_empty() {
        w.put("write", &join(&i.scope.write));
    }
    if let Some(t) = i.budget.tokens {
        w.put("tokens", &t.to_string());
    }
    if let Some(s) = i.budget.wall_secs {
        w.put("wall", &s.to_string());
    }
    w.finish()
}

/// Decodes one `intent` line.
pub fn decode_intent(line: &str) -> Result<Intent, CodecError> {
    let f = Fields::parse(line);
    if f.kind != "intent" {
        return Err(CodecError::UnknownRecord(f.kind.to_string()));
    }
    let kind = kind_from_str(f.get("kind")?)?;
    let mut intent = Intent::new(IntentId::new(f.get("id")?), kind, f.get("statement")?);

    intent.parent = f.opt("parent").map(IntentId::new);
    intent.link = link_from_fields(&f);
    intent.sphere = match f.opt("sphere") {
        Some("personal") => Sphere::Personal,
        Some(u) if u.starts_with("unit:") => Sphere::Unit(u["unit:".len()..].to_string()),
        _ => Sphere::Org,
    };
    if let Some(h) = f.opt("horizon") {
        intent.horizon = horizon_from_str(h)?;
    }
    if let Some(w) = f.opt("weight") {
        intent.weight = w.parse().unwrap_or(1.0);
    }
    intent.status = status_from_str(f.opt("status").unwrap_or("draft"));
    intent.measures = f
        .list("measures")
        .iter()
        .filter_map(|m| measure_from_str(m))
        .collect();
    intent.scope = Scope {
        read: f.list("read"),
        write: f.list("write"),
    };
    intent.budget = Budget {
        tokens: f.opt("tokens").and_then(|t| t.parse().ok()),
        wall_secs: f.opt("wall").and_then(|t| t.parse().ok()),
    };
    Ok(intent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::{Link, Measure, Scope, StandaloneReason};

    fn roundtrip(i: &Intent) {
        let line = encode_intent(i);
        assert!(!line.contains('\n'), "records must be one line: {line}");
        let back = decode_intent(&line).expect("decodes");
        assert_eq!(&back, i, "\nline: {line}");
    }

    #[test]
    fn round_trips_a_minimal_intent() {
        roundtrip(&Intent::new("v", IntentKind::Vision, "be excellent"));
    }

    #[test]
    fn round_trips_a_full_intent() {
        let i = Intent::new("proj", IntentKind::Project, "add response caching")
            .under("goal", Link::Requires)
            .measured(Measure::Command {
                cmd: "cargo test --workspace".into(),
                expect_status: 0,
            })
            .measured(Measure::Metric {
                name: "p95_ms".into(),
                target: 5000.0,
                cmp: Cmp::Lt,
            })
            .scoped(Scope {
                read: vec!["**".into()],
                write: vec!["crates/export/**".into(), "tests/**".into()],
            })
            .budgeted(Budget {
                tokens: Some(200_000),
                wall_secs: Some(1800),
            })
            .horizon(Horizon::Month);
        roundtrip(&i);
    }

    #[test]
    fn round_trips_every_link_variant() {
        for link in [
            Link::Requires,
            Link::Alternative,
            Link::Unlinked,
            Link::Standalone {
                reason: StandaloneReason::Exploration,
            },
            Link::Contributes {
                rationale: "speeds up the hot path".into(),
                polarity: Polarity::Negative,
            },
        ] {
            let mut i = Intent::new("x", IntentKind::Task, "do a thing");
            i.parent = Some(IntentId::new("p"));
            i.link = link.clone();
            if !link.needs_parent() {
                i.parent = None;
            }
            roundtrip(&i);
        }
    }

    #[test]
    fn round_trips_every_measure_variant() {
        for m in [
            Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 1,
            },
            Measure::Metric {
                name: "uptime".into(),
                target: 99.9,
                cmp: Cmp::Gte,
            },
            Measure::Deliverable {
                path: "docs/**".into(),
            },
            Measure::Rollup,
            Measure::Proxy {
                note: "judged by the operator".into(),
            },
        ] {
            let i = Intent::new("x", IntentKind::Vision, "vision").measured(m);
            roundtrip(&i);
        }
    }

    #[test]
    fn survives_tabs_and_newlines_in_text() {
        let i = Intent::new("x", IntentKind::Vision, "line one\nline\ttwo\\three");
        roundtrip(&i);
    }

    #[test]
    fn rejects_a_foreign_record_kind() {
        let err = decode_intent("audit\tid=x").unwrap_err();
        assert_eq!(err, CodecError::UnknownRecord("audit".into()));
    }

    #[test]
    fn reports_a_missing_field() {
        let err = decode_intent("intent\tkind=task").unwrap_err();
        assert_eq!(err, CodecError::MissingField("id"));
    }

    #[test]
    fn escaping_is_reversible() {
        for s in ["", "plain", "a\tb", "a\nb", "a\\b", "\\t literal", "a\\\\b"] {
            assert_eq!(unescape(&escape(s)), s, "failed for {s:?}");
        }
    }
}
