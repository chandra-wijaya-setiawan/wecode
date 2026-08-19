//! Projects: the unit of work a company pursues.
//!
//! A project owns exactly one repository, carries its own objective, and holds the
//! budget and measures that say when it is done. What used to be a separate `Vision`
//! and `Goal` are now attributes — the company has a vision, a project has an
//! objective — because neither was ever executable and both cost a level of tree.
//!
//! Because it owns the repository, it also owns the tracker that repository files
//! against: an [`IssueRef`] is a bare number until a project says where numbers point.

use crate::common::{Budget, Measure, ProjectStatus};
use crate::id::ProjectId;
use crate::short::Number;
use std::fmt;

/// A reference to an issue in a tracker wecode does not own.
///
/// The handle already existed; it was just being smuggled. An id is a slug and slugs
/// are typed by hand, so the way to say "this is issue 412" was to *call* the work
/// `gh-412-retry-backoff` — and an id is the one field everything else keys on. Once a
/// number is in there it cannot be corrected without breaking the ledger, it cannot be
/// resolved to an address because nothing knows it is a number, and it costs the id the
/// thing ids are for: `oauth-device-flow` beats a UUID for a reader, and `gh-412` is a
/// UUID with extra steps. So the reference is a field, and the id goes back to naming.
///
/// Two forms, not three. `#412` is a number in the project's own tracker; anything else
/// is the address itself. The obvious third — `owner/repo#412`, for an issue in some
/// other repository — is deliberately absent: resolving it means guessing a forge out
/// of a string that never said which one it was, and an operator holding another
/// repository's issue is already holding its URL.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum IssueRef {
    /// A number in the tracker this project declares. Resolvable only through
    /// [`Project::issue_url`], which is where the rest of the address lives.
    Number(u64),
    /// An absolute URL. Carries its own tracker, so it needs nothing from the project.
    Url(String),
}

impl IssueRef {
    /// Reads a reference the way an operator writes one, or `None`.
    ///
    /// Deliberately narrow. Everything else about a task can be argued with later; a
    /// wrong issue number is a link to somebody else's work, and the failure is silent
    /// because a number is always plausible. So `412`, `#412` and a `http(s)` URL are
    /// accepted and nothing else is — no bare hostnames, no `GH-412`, no ranges.
    pub fn parse(raw: &str) -> Option<Self> {
        let s = raw.trim();
        if s.starts_with("http://") || s.starts_with("https://") {
            // A URL with a space in it is a pasted sentence, not an address.
            return (!s.contains(char::is_whitespace)).then(|| Self::Url(s.to_string()));
        }
        s.strip_prefix('#').unwrap_or(s).parse().ok().map(Self::Number)
    }
}

impl fmt::Display for IssueRef {
    /// Back out in the form it was typed in, so what an operator reads on the board is
    /// what they can type at the next command.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(n) => write!(f, "#{n}"),
            Self::Url(u) => f.write_str(u),
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct Project {
    pub id: ProjectId,
    /// The short number this project also answers to. `None` for a plan nothing has
    /// minted numbers for — an in-memory one in a test, or a project being built to be
    /// saved. See [`crate::short`] for why they are stored rather than counted.
    pub number: Option<Number>,
    /// What this project is trying to achieve. One sentence.
    pub objective: String,
    /// The repository this project works in, by the name the company registers it
    /// under. Exactly one: a project that spans two codebases is two projects.
    pub repo: String,
    /// Where a bare `#412` is a number: the URL an issue in this project's tracker
    /// hangs off, such as `https://github.com/acme/api/issues`.
    ///
    /// On the project rather than beside each reference, because it is a property of
    /// the repository and a project owns exactly one of those. A reference that had to
    /// carry its own base would be a URL repeated once per task, and the one thing
    /// worse than an unresolvable reference is a hundred that disagree about where they
    /// point. `None` means references are still stored and shown — they just do not
    /// resolve, which is what a project with no declared tracker should say.
    pub tracker: Option<String>,
    /// The external issue this project answers to, if it was filed somewhere first.
    ///
    /// A whole project usually answers to an epic or a tracking issue rather than to a
    /// single ticket, so this is not where most references live — see [`IssueRef`] for
    /// what it is and why an id must not carry it.
    pub issue: Option<IssueRef>,
    /// How we know the project succeeded.
    pub measures: Vec<Measure>,
    pub budget: Budget,
    pub status: ProjectStatus,
    /// Whether the operator has filed this away. Orthogonal to `status`: a project
    /// can be `done` and still on the board, or `active` and hidden while parked.
    ///
    /// Archiving *parks* a project rather than merely hiding it: [`crate::Plan::ready_tasks`]
    /// and the scheduler both skip it, so nothing in it is promoted or dispatched, and
    /// the admission gate stops treating its tasks as competition for files. All of
    /// that reverses on `unarchive`; nothing is lost, and the ledger keeps what ran.
    pub archived: bool,
}

impl Project {
    /// Argument order follows the field order — `objective` then `repo`. It used
    /// to be the other way round, which reads as a plausible call either way and
    /// so silently swapped the two on a mistake.
    pub fn new(
        id: impl Into<ProjectId>,
        objective: impl Into<String>,
        repo: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            number: None,
            objective: objective.into(),
            repo: repo.into(),
            tracker: None,
            issue: None,
            measures: Vec::new(),
            budget: Budget::default(),
            status: ProjectStatus::Draft,
            archived: false,
        }
    }

    #[must_use]
    pub fn measured(mut self, m: Measure) -> Self {
        self.measures.push(m);
        self
    }

    #[must_use]
    pub fn budgeted(mut self, b: Budget) -> Self {
        self.budget = b;
        self
    }

    /// Declares where this project's bare numbers point.
    #[must_use]
    pub fn tracked_at(mut self, base: impl Into<String>) -> Self {
        self.tracker = Some(base.into());
        self
    }

    #[must_use]
    pub fn filed_as(mut self, issue: IssueRef) -> Self {
        self.issue = Some(issue);
        self
    }

    /// The address a reference points at, resolved against this project's tracker.
    ///
    /// Takes the reference rather than reading `self.issue`, because a project's own
    /// is the rare case: what needs resolving is the reference on a piece of work, and
    /// the base it resolves against is the project's whichever of the two is asking.
    ///
    /// `None` is not a failure. A number with no declared tracker is still a true
    /// statement about where the work came from, and returning a guessed URL — some
    /// default forge, the repo name pasted into a template — would turn a reference an
    /// operator can read into a link that goes somewhere wrong.
    #[must_use]
    pub fn issue_url(&self, r: &IssueRef) -> Option<String> {
        match r {
            IssueRef::Url(u) => Some(u.clone()),
            IssueRef::Number(n) => {
                let base = self.tracker.as_deref()?.trim().trim_end_matches('/');
                (!base.is_empty()).then(|| format!("{base}/{n}"))
            }
        }
    }

    /// Whether the cockpit should show this. A method rather than reading the field,
    /// so the rule has one home if it ever grows past the flag.
    #[must_use]
    pub fn is_visible(&self) -> bool {
        !self.archived
    }

    #[must_use]
    pub fn has_executable_measure(&self) -> bool {
        self.measures.iter().any(Measure::is_executable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::Cmp;

    #[test]
    fn a_project_starts_as_a_draft_with_nothing_assumed() {
        let p = Project::new("caching", "add response caching", "wecode");
        assert_eq!(p.status, ProjectStatus::Draft);
        assert!(p.measures.is_empty());
        assert!(!p.budget.is_set());
        assert!(!p.has_executable_measure());
    }

    #[test]
    fn builders_compose() {
        let p = Project::new("caching", "add response caching", "wecode")
            .measured(Measure::Metric {
                name: "p99_ms".into(),
                target: 500.0,
                cmp: Cmp::Lt,
            })
            .budgeted(Budget {
                tokens: Some(200_000),
                wall_secs: Some(1800),
            });
        assert!(p.has_executable_measure());
        assert_eq!(p.budget.tokens, Some(200_000));
        assert_eq!(p.repo, "wecode");
    }

    #[test]
    fn a_reference_reads_the_way_an_operator_writes_one() {
        for raw in ["#412", "412", "  #412  "] {
            assert_eq!(IssueRef::parse(raw), Some(IssueRef::Number(412)), "{raw}");
        }
        assert_eq!(
            IssueRef::parse("https://github.com/acme/api/issues/412"),
            Some(IssueRef::Url("https://github.com/acme/api/issues/412".into()))
        );
    }

    #[test]
    fn anything_that_is_not_plainly_a_reference_is_refused() {
        // A wrong number links to somebody else's work and says nothing about it, so
        // the parse would rather return nothing than something plausible.
        for raw in ["", "#", "gh-412", "412-413", "github.com/acme/api/issues/412"] {
            assert_eq!(IssueRef::parse(raw), None, "{raw}");
        }
        assert_eq!(
            IssueRef::parse("https://example.test/a b"),
            None,
            "a pasted sentence is not an address"
        );
    }

    #[test]
    fn a_reference_prints_back_in_the_form_it_was_typed() {
        for raw in ["#412", "https://github.com/acme/api/issues/412"] {
            assert_eq!(IssueRef::parse(raw).unwrap().to_string(), raw);
        }
        assert_eq!(IssueRef::parse("412").unwrap().to_string(), "#412");
    }

    #[test]
    fn a_number_resolves_against_the_projects_tracker() {
        let p = Project::new("api", "ship it", "api")
            .tracked_at("https://github.com/acme/api/issues/");
        assert_eq!(
            p.issue_url(&IssueRef::Number(412)).as_deref(),
            Some("https://github.com/acme/api/issues/412"),
            "the trailing slash on the base is not the operator's problem"
        );
    }

    #[test]
    fn a_number_with_nowhere_to_point_stays_a_number() {
        // Undeclared and declared-empty both mean the same thing, and neither is worth
        // guessing a forge over: the reference is still shown, it just is not a link.
        let bare = Project::new("api", "ship it", "api");
        assert_eq!(bare.issue_url(&IssueRef::Number(412)), None);
        assert_eq!(
            bare.tracked_at("  ").issue_url(&IssueRef::Number(412)),
            None
        );
        // A URL needs nothing from the project, so it resolves either way.
        let url = IssueRef::Url("https://example.test/i/9".into());
        assert_eq!(
            Project::new("api", "ship it", "api").issue_url(&url).as_deref(),
            Some("https://example.test/i/9")
        );
    }

    #[test]
    fn a_project_carries_no_reference_until_one_is_filed() {
        let p = Project::new("api", "ship it", "api");
        assert!(p.issue.is_none());
        assert!(p.tracker.is_none());
        let filed = p.filed_as(IssueRef::Number(7));
        assert_eq!(filed.issue, Some(IssueRef::Number(7)));
        assert_eq!(
            filed.id.as_str(),
            "api",
            "the id names the work; the number is stored beside it"
        );
    }

    #[test]
    fn a_judged_objective_is_not_executable() {
        let p = Project::new("x", "be excellent", "r").measured(Measure::Judged {
            note: "operator decides".into(),
        });
        assert!(!p.has_executable_measure());
    }
}
