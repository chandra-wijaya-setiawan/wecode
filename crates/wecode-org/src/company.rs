//! The company profile: who exists, what they may do, and what outranks them.
//!
//! Deserialised straight from `company.toml`. Everything under here is hand-editable
//! on purpose — a role's write scope is exactly the thing you want to review in a
//! diff, which is why configuration is not in the database.
//!
//! One file, but not one subject, so the reading of it is split the way the file is:
//! a module per block, holding that block's wire shape, the domain type it becomes,
//! the questions [`Company`] answers about it, and what makes it incoherent.
//!
//! | | |
//! |---|---|
//! | `chart` | `[[repos]]`, `[[posts]]`, `[[users]]` — what exists and who is in it |
//! | `role` | `[roles.*]` — what a seat may do |
//! | `agent` | `[agents.*]` — how a harness is invoked, and how clever a seat is |
//! | `limits` | `[attention]`, `[invariants]`, `[session]` — what may be spent |
//! | `reach` | `[notify]`, `[telegram]` — how the operator hears, and answers |
//!
//! What stays here is what belongs to the file rather than to any block: the shape it
//! parses into, the error every block reports through, the whole-file coherence check,
//! and the two smallest blocks — `[company]` itself and `[templates]` — which are a
//! sentence and a string.
//!
//! The vision lives here as a sentence rather than as a node in the work tree. It
//! was never executable, and it cost a level of hierarchy to carry.

mod agent;
mod chart;
mod limits;
mod reach;
mod role;

pub use agent::{AgentTemplate, Intelligence};
pub use chart::{Post, Repo, User};
pub use limits::Attention;
pub use reach::{Notify, Telegram};

use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use serde::Deserialize;
use wecode_gov::{Charter, Grant};

#[derive(Debug)]
pub enum OrgError {
    Parse(toml::de::Error),
    UnknownRole {
        post: String,
        role: String,
    },
    UnknownPost {
        user: String,
        post: String,
    },
    UnknownAgent {
        post: String,
        agent: String,
    },
    BadValue {
        at: String,
        value: String,
    },
    /// A role wider than the operator's own grant.
    Escalation {
        role: String,
    },
    /// The chief manages; it must not be able to do the work itself.
    ChiefMayNotExecute {
        detail: &'static str,
    },
    /// A seat that says how clever its occupant should be, staffed by a harness that
    /// has not said which of its models is stronger than which.
    ///
    /// Refused at load rather than ignored at dispatch: the number reads as configured
    /// and would decide nothing, which is the one shape of wrong this file must not
    /// have. The repair is one line — `models` on the agent — and this says so.
    UnrankedAgent {
        post: String,
        agent: String,
    },
    /// A seat configured above the charter's ceiling. Invariants outrank every grant,
    /// so this is the config being wrong rather than the run being clamped.
    AboveCeiling {
        post: String,
        want: Intelligence,
        ceiling: Intelligence,
    },
    /// Two people claim the same chat account.
    ///
    /// A reply carries an account, not a name, so this is not a cosmetic clash: the
    /// account would resolve to whichever user the file happens to list first, and a
    /// signature would be attributed to a person who did not give it.
    TelegramClash {
        id: String,
        users: (String, String),
    },
    /// An acknowledgement configured with nothing to acknowledge.
    ///
    /// A tap is read by `fetch` like every other update; `answer` only says what came of
    /// one. Without a fetch it would never run, and the operator who wrote it would be
    /// left tapping buttons that stay silent for a reason nothing states.
    AnswerWithoutFetch,
}

impl fmt::Display for OrgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(e) => write!(f, "company.toml: {e}"),
            Self::UnknownRole { post, role } => {
                write!(f, "post `{post}` names role `{role}`, which is not defined")
            }
            Self::UnknownPost { user, post } => {
                write!(f, "user `{user}` names post `{post}`, which is not defined")
            }
            Self::UnknownAgent { post, agent } => {
                write!(
                    f,
                    "post `{post}` names agent `{agent}`, which has no [agents.{agent}] block"
                )
            }
            Self::BadValue { at, value } => write!(f, "bad value at {at}: `{value}`"),
            Self::Escalation { role } => {
                write!(f, "role `{role}` is wider than the operator grant")
            }
            Self::ChiefMayNotExecute { detail } => write!(
                f,
                "the chief post may not {detail} — it assigns, it does not execute"
            ),
            Self::UnrankedAgent { post, agent } => write!(
                f,
                "post `{post}` sets an intelligence, but agent `{agent}` declares no \
                 `models` to pick one from — list them weakest first"
            ),
            Self::AboveCeiling {
                post,
                want,
                ceiling,
            } => write!(
                f,
                "post `{post}` asks for intelligence {want}, above the charter's \
                 max_intelligence of {ceiling}"
            ),
            Self::TelegramClash { id, users: (a, b) } => write!(
                f,
                "users `{a}` and `{b}` both give telegram = \"{id}\" — \
                 a reply from it could be signed as either"
            ),
            Self::AnswerWithoutFetch => write!(
                f,
                "[telegram] answer is set but fetch is not — nothing would read \
                 the taps it answers"
            ),
        }
    }
}

impl std::error::Error for OrgError {}

impl From<toml::de::Error> for OrgError {
    fn from(e: toml::de::Error) -> Self {
        Self::Parse(e)
    }
}

// ------------------------------------------------------------------ wire ------
// The file's own shape: one field per block, each typed by the module that reads it.
// Converted to the domain types below, so a config field renaming never leaks into
// the rest of the codebase.

#[derive(Deserialize, Debug)]
struct Wire {
    company: CompanyBlock,
    #[serde(default)]
    attention: limits::AttentionBlock,
    #[serde(default)]
    invariants: limits::InvariantBlock,
    #[serde(default)]
    session: limits::SessionBlock,
    #[serde(default)]
    notify: reach::NotifyBlock,
    #[serde(default)]
    telegram: reach::TelegramBlock,
    #[serde(default)]
    repos: Vec<Repo>,
    #[serde(default)]
    roles: BTreeMap<String, role::RoleBlock>,
    #[serde(default)]
    posts: Vec<Post>,
    #[serde(default)]
    users: Vec<User>,
    #[serde(default)]
    agents: BTreeMap<String, AgentTemplate>,
    #[serde(default)]
    templates: Templates,
}

#[derive(Deserialize, Debug)]
struct CompanyBlock {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_profile")]
    profile: String,
    /// Why the company exists. Prose, judged by a person — never executable.
    #[serde(default)]
    vision: String,
}

fn default_profile() -> String {
    "solo".to_string()
}

/// Prompt templates, inlined so a workspace stays two files.
#[derive(Clone, PartialEq, Eq, Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub struct Templates {
    #[serde(default)]
    pub task_envelope: String,
}

// ---------------------------------------------------------------- domain ------

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Company {
    pub name: String,
    pub description: String,
    pub profile: String,
    pub vision: String,
    pub attention: Attention,
    pub notify: Notify,
    pub telegram: Telegram,
    pub charter: Charter,
    pub repos: Vec<Repo>,
    pub roles: BTreeMap<String, Grant>,
    pub posts: Vec<Post>,
    pub users: Vec<User>,
    pub agents: BTreeMap<String, AgentTemplate>,
    pub templates: Templates,
    /// Idle timeout for interactive sessions.
    pub session_ttl: Duration,
    /// `[invariants] max_intelligence`: the strongest model this company will staff a
    /// seat with, and `None` for no ceiling.
    ///
    /// Carried here rather than as a [`Charter`] invariant because it is enforced where
    /// it is written — a post above it is refused at load, beside the levels it is a
    /// ceiling on, and there is no run-time action for the Broker to judge. The other
    /// invariants describe things an agent does; this one describes what it is.
    pub max_intelligence: Option<Intelligence>,
}

impl Company {
    /// Parses and validates a company profile.
    pub fn parse(text: &str) -> Result<Self, OrgError> {
        let w: Wire = toml::from_str(text)?;
        let roles = role::grants_of(&w.roles)?;

        let company = Self {
            name: w.company.name,
            description: w.company.description,
            profile: w.company.profile,
            vision: w.company.vision,
            attention: limits::attention_of(&w.attention),
            notify: reach::notify_of(&w.notify)?,
            telegram: reach::telegram_of(&w.telegram)?,
            charter: limits::charter_of(&w.invariants),
            session_ttl: limits::session_ttl(&w.session)?,
            max_intelligence: limits::max_intelligence(&w.invariants),
            repos: w.repos,
            roles,
            posts: w.posts,
            users: w.users,
            agents: w.agents,
            templates: w.templates,
        };
        company.validate()?;
        Ok(company)
    }

    /// Invariants that must hold for the org to be coherent.
    ///
    /// Each block checks its own, in the order a name has to resolve in: a role before
    /// the seats that name it, a seat before the level it is staffed at. That ordering
    /// is what keeps a typo reported as a typo — a post naming an agent that has no
    /// block is an unknown agent, not a harness that declared no models.
    fn validate(&self) -> Result<(), OrgError> {
        role::check(self)?;
        chart::check(self)?;
        agent::check(self)?;
        Ok(())
    }
}

/// Parses `30m`, `8h`, `7d`, or a bare number of seconds.
///
/// Here rather than in one of the blocks because three of them write a duration —
/// a session's idle limit, a notifier's, a poll's — and all three are read the same.
#[must_use]
pub fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    let (num, mult) = match s.chars().last()? {
        's' => (&s[..s.len() - 1], 1),
        'm' => (&s[..s.len() - 1], 60),
        'h' => (&s[..s.len() - 1], 3600),
        'd' => (&s[..s.len() - 1], 86_400),
        _ => (s, 1),
    };
    num.trim()
        .parse::<u64>()
        .ok()
        .map(|n| Duration::from_secs(n * mult))
}

/// The smallest file that parses: one role, one harness, one seat.
///
/// Shared with the tests in every module below this one, which each add the block
/// they are about. A fixture per module would drift, and the point of most of these
/// tests is what an otherwise-valid file does with one thing changed.
#[cfg(test)]
const MINIMAL: &str = r#"
[company]
name = "cws"

[roles.engineer]
write = ["src/**"]
tokens = 1000

[agents.claude-code]
command = "claude"

[[posts]]
name = "impl"
role = "engineer"
agent = "claude-code"
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_minimal_company() {
        let c = Company::parse(MINIMAL).unwrap();
        assert_eq!(c.name, "cws");
        assert_eq!(c.profile, "solo", "profile defaults to solo");
        assert_eq!(c.posts.len(), 1);
        assert_eq!(c.roles.len(), 1);
        assert_eq!(c.session_ttl, Duration::from_secs(8 * 3600));
    }

    #[test]
    fn a_missing_name_is_a_parse_error_naming_the_field() {
        let e = Company::parse("[company]\ndescription = \"x\"\n").unwrap_err();
        assert!(e.to_string().contains("name"), "{e}");
    }

    #[test]
    fn a_typo_in_a_key_is_rejected_rather_than_ignored() {
        // deny_unknown_fields is why: a silently ignored `writ = [...]` would mean
        // a role with no write scope and no warning.
        let text = MINIMAL.replace("write = [\"src/**\"]", "writ = [\"src/**\"]");
        let e = Company::parse(&text).unwrap_err();
        assert!(e.to_string().contains("writ"), "{e}");
    }

    #[test]
    fn the_vision_is_a_sentence_on_the_company() {
        let with = MINIMAL.replace(
            "name = \"cws\"",
            "name = \"cws\"\nvision = \"lead on export speed\"",
        );
        let c = Company::parse(&with).unwrap();
        assert_eq!(c.vision, "lead on export speed");
    }

    #[test]
    fn durations_accept_the_common_suffixes() {
        assert_eq!(parse_duration("30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse_duration("30m"), Some(Duration::from_secs(1800)));
        assert_eq!(parse_duration("8h"), Some(Duration::from_secs(28_800)));
        assert_eq!(parse_duration("7d"), Some(Duration::from_secs(604_800)));
        assert_eq!(parse_duration("90"), Some(Duration::from_secs(90)));
        assert_eq!(parse_duration("soon"), None);
    }

    #[test]
    fn agents_and_templates_are_inlined() {
        let text = format!(
            "{MINIMAL}\n[agents.codex]\ncommand = \"codex\"\nargs = [\"exec\"]\n\n[templates]\ntask_envelope = \"\"\"\nGOAL: {{goal}}\n\"\"\"\n"
        );
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.agents.len(), 2);
        assert_eq!(c.agents["codex"].args, vec!["exec".to_string()]);
        assert!(c.templates.task_envelope.contains("GOAL"));
    }
}
