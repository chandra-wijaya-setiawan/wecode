//! Value types shared by projects and tasks.

/// How we know something is done. Ordered by trustworthiness: a command either
/// exits zero or it does not; a judgement is an opinion.
#[derive(Clone, PartialEq, Debug)]
pub enum Measure {
    Command { cmd: String, expect_status: i32 },
    Metric { name: String, target: f64, cmp: Cmp },
    Deliverable { path: String },
    /// Human-judged. Legal on a project's objective, never on a task.
    Judged { note: String },
}

impl Measure {
    /// Whether this can be evaluated without asking anyone.
    #[must_use]
    pub fn is_executable(&self) -> bool {
        !matches!(self, Self::Judged { .. })
    }

    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::Command { cmd, expect_status } => format!("`{cmd}` exits {expect_status}"),
            Self::Metric { name, target, cmp } => format!("{name} {} {target}", cmp.symbol()),
            Self::Deliverable { path } => format!("file exists: {path}"),
            Self::Judged { note } => format!("judged: {note}"),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cmp {
    Lt,
    Lte,
    Gt,
    Gte,
    Eq,
}

impl Cmp {
    #[must_use]
    pub fn symbol(self) -> &'static str {
        match self {
            Self::Lt => "<",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::Eq => "==",
        }
    }
}

/// Paths a piece of work may read and write. Write globs are the enforced guardrail.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct Scope {
    pub read: Vec<String>,
    pub write: Vec<String>,
}

impl Scope {
    #[must_use]
    pub fn write(globs: &[&str]) -> Self {
        Self {
            read: Vec::new(),
            write: globs.iter().map(|g| (*g).to_string()).collect(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.read.is_empty() && self.write.is_empty()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct Budget {
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
}

impl Budget {
    #[must_use]
    pub fn is_set(&self) -> bool {
        self.tokens.is_some() || self.wall_secs.is_some()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum Status {
    #[default]
    Draft,
    Ready,
    Active,
    Blocked,
    Done,
    Dropped,
}

impl Status {
    #[must_use]
    pub fn is_done(self) -> bool {
        matches!(self, Self::Done)
    }

    /// Whether work is finished with, either way.
    #[must_use]
    pub fn is_closed(self) -> bool {
        matches!(self, Self::Done | Self::Dropped)
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Ready => "ready",
            Self::Active => "active",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Dropped => "dropped",
        }
    }

    #[must_use]
    pub fn mark(self) -> char {
        match self {
            Self::Draft => '·',
            Self::Ready => '○',
            Self::Active => '>',
            Self::Blocked => '!',
            Self::Done => 'x',
            Self::Dropped => '-',
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_judged_measures_need_a_person() {
        assert!(!Measure::Judged { note: "looks right".into() }.is_executable());
        assert!(
            Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 0
            }
            .is_executable()
        );
        assert!(
            Measure::Metric {
                name: "p99".into(),
                target: 500.0,
                cmp: Cmp::Lt
            }
            .is_executable()
        );
    }

    #[test]
    fn measures_describe_themselves_for_the_terminal() {
        let m = Measure::Metric {
            name: "p99_ms".into(),
            target: 500.0,
            cmp: Cmp::Lt,
        };
        assert_eq!(m.describe(), "p99_ms < 500");
    }

    #[test]
    fn closed_covers_dropped_as_well_as_done() {
        assert!(Status::Done.is_done());
        assert!(!Status::Dropped.is_done());
        assert!(Status::Dropped.is_closed());
        assert!(!Status::Active.is_closed());
    }
}
