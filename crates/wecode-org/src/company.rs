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
//! and the smallest blocks — `[company]` itself, `[templates]`, and `[secrets.*]` —
//! which are a sentence, a string, and one table per credential a task may declare.
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
pub use limits::{Attention, Budgets};
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
    /// A harness declaring an output shape nothing here can read.
    ///
    /// Refused at load for the reason every setting in this file is: it reads as
    /// configured and decides nothing. A name outside the list meters nothing on every
    /// run of that harness, which is what an honest `plain` also does — so left to
    /// dispatch, a typo and a decision are the same blank column.
    UnknownProtocol {
        agent: String,
        protocol: String,
    },
    /// A credential declaring a variable that decides which program runs.
    ///
    /// The same rule the build cache has and refused for the same reason: `PATH` and the
    /// loader variables say which program *runs*, not what it may reach, so a resolver
    /// allowed to set one would be choosing the toolchain of every task that declared
    /// the credential. Refused where the list is written rather than where a value comes
    /// back, because the declared list is the half a reviewer reads.
    SecretVarForbidden {
        id: String,
        var: String,
    },
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
            Self::UnknownProtocol { agent, protocol } => write!(
                f,
                "[agents.{agent}] protocol = \"{protocol}\" is not a shape wecode reads — \
                 one of {}, or leave it out for a harness that reports nothing",
                Protocol::NAMES.join(", ")
            ),
            Self::SecretVarForbidden { id, var } => write!(
                f,
                "[secrets.{id}] vars includes `{var}`, which decides which program runs \
                 rather than what it may reach — that belongs to the env allowlist"
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
    budgets: limits::BudgetsBlock,
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
    secrets: BTreeMap<String, SecretBlock>,
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

/// `[secrets.<id>]`: what an id a task declares actually means.
///
/// A command rather than a value, for the reason `[notify]` and `[telegram]` are
/// commands: every machine that has credentials already has something that prints them
/// — `aws`, `pass`, `op`, `vault`, `gcloud` — and a wecode that grew its own vault would
/// be asking operators to copy secrets into a second place in order to keep them out of
/// a first. So wecode holds no vault, and this file holds no value.
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct SecretBlock {
    command: String,
    /// The variables the command may print. The declared list is the contract, which is
    /// also the only defence against `command` being edited into something more generous
    /// than what it was reviewed as.
    vars: Vec<String>,
    /// Required, and the one field here with no defensible default: it is what
    /// [`SecretDef::admits`] refuses a longer run against, and an absent figure would
    /// have to mean either *forever* or *refuse everything*.
    ttl: String,
    #[serde(default = "twenty_seconds")]
    timeout: String,
}

fn twenty_seconds() -> String {
    "20s".to_string()
}

/// Prompt templates, inlined so a workspace stays two files.
#[derive(Clone, PartialEq, Eq, Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub struct Templates {
    #[serde(default)]
    pub task_envelope: String,
}

/// The shape of a harness's output, and so what can be read back out of it.
///
/// `[agents.*] protocol` is the one field in this file whose vocabulary is not the
/// org's own: it names a reader in the layer that runs the process. The list lives
/// beside the type rather than in `agent` for that reason, and an unrecognised name is
/// refused at load rather than ignored at dispatch — a protocol nothing reads meters
/// nothing, on every run of that harness, and says so nowhere. That is
/// indistinguishable from an honest [`Protocol::Plain`], which is exactly why the
/// honest one has to be written down.
///
/// None of it is a list of harnesses. A coding CLI holds a seat by declaring which of
/// these shapes its output has; wecode learns no harness's format, and guesses at none.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Protocol {
    /// `claude --output-format stream-json`: one JSON object per line, usage on the
    /// `assistant` lines and the run's own total on the `result` line.
    ClaudeStreamJson,
    /// The contract wecode publishes for anything else willing to meet it: one JSON
    /// object per line, any line carrying a `usage` object being that turn's spend, a
    /// line typed `result` being the run's total.
    GenericJsonl,
    /// Prose, or a format nobody here has read. Unmetered, and honestly: the spend
    /// column stays blank rather than zero.
    Plain,
}

impl Protocol {
    /// Every name that may be written, for the message that refuses the rest.
    pub const NAMES: [&'static str; 3] = ["claude-stream-json", "generic-jsonl", "plain"];

    /// The protocol this name is, or `None` for a name nothing reads.
    ///
    /// Absent is [`Protocol::Plain`] — which is what every company written before this
    /// list existed already says, and what it already got.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        match name.trim() {
            "" | "plain" => Some(Self::Plain),
            "claude-stream-json" => Some(Self::ClaudeStreamJson),
            "generic-jsonl" => Some(Self::GenericJsonl),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------- domain ------

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Company {
    pub name: String,
    pub description: String,
    pub profile: String,
    pub vision: String,
    pub attention: Attention,
    pub budgets: Budgets,
    pub notify: Notify,
    pub telegram: Telegram,
    pub charter: Charter,
    pub repos: Vec<Repo>,
    pub roles: BTreeMap<String, Grant>,
    pub posts: Vec<Post>,
    pub users: Vec<User>,
    pub agents: BTreeMap<String, AgentTemplate>,
    /// `[secrets.*]`: the credentials this workspace can mint, by the id a task names.
    ///
    /// Definitions only — a command, the variables it may print, how long the result
    /// lives. No value ever lands here, or anywhere else this type can be serialised
    /// from: what a resolver printed lives in a [`Held`] for the length of one dispatch.
    pub secrets: BTreeMap<String, SecretDef>,
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
            budgets: limits::budgets_of(&w.budgets),
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
            secrets: secrets_of(w.secrets)?,
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
    ///
    /// The last is the file's own rather than a block's: `protocol` is held to a list
    /// that belongs to the layer reading the harness's output, so it is checked beside
    /// [`Protocol`] and not in `agent`.
    fn validate(&self) -> Result<(), OrgError> {
        role::check(self)?;
        chart::check(self)?;
        agent::check(self)?;
        self.protocols()?;
        Ok(())
    }

    /// Every harness declares an output shape this build can read.
    fn protocols(&self) -> Result<(), OrgError> {
        for (name, agent) in &self.agents {
            if Protocol::parse(&agent.protocol).is_none() {
                return Err(OrgError::UnknownProtocol {
                    agent: name.clone(),
                    protocol: agent.protocol.clone(),
                });
            }
        }
        Ok(())
    }

    /// The credential named `id`, or a refusal naming what this workspace declares.
    ///
    /// A [`String`] rather than an [`OrgError`]: the file is coherent — nothing is wrong
    /// with `company.toml` — and what is wrong is the id a task was written with, which
    /// is the dispatch's problem to report.
    pub fn secret(&self, id: &str) -> Result<&SecretDef, String> {
        self.secrets.get(id).ok_or_else(|| {
            let known: Vec<&str> = self.secrets.keys().map(String::as_str).collect();
            if known.is_empty() {
                format!("unknown secret `{id}` — company.toml declares no [secrets.*] block")
            } else {
                format!(
                    "unknown secret `{id}` — company.toml declares {}",
                    known.join(", ")
                )
            }
        })
    }

    /// Resolves every id a task declared, once, for one dispatch.
    ///
    /// `mint` runs the resolver and returns what it printed on stdout. It is the caller's
    /// because it is the only part of this that starts a program: this crate reads a
    /// hand-edited file and decides what is coherent, and the CLI is what runs commands
    /// — the same split `[notify]` already has.
    ///
    /// Existence and [`SecretDef::admits`] are checked for *every* id before the first
    /// resolver runs. A dispatch refused on its second credential must not have logged in
    /// for its first: that is an entry in somebody's audit trail, and a live credential,
    /// for a run that never happened.
    ///
    /// `wall` is the clock the run will actually be held to, and `None` is no clock —
    /// which no `ttl` can outlive, so nothing is refused.
    pub fn hold(
        &self,
        ids: &[String],
        wall: Option<Duration>,
        mint: impl Fn(&SecretDef) -> Result<String, String>,
    ) -> Result<Held, String> {
        let defs = ids
            .iter()
            .map(|id| self.secret(id))
            .collect::<Result<Vec<&SecretDef>, String>>()?;
        if let Some(wall) = wall {
            for def in &defs {
                def.admits(wall)?;
            }
        }
        let mut held = Held::default();
        for def in defs {
            held.take(def, &mint(def)?)?;
        }
        Ok(held)
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

// --------------------------------------------------------------- secrets ------
// A credential a task may use and never keeps. Two halves live here: what an id means,
// read off `[secrets.*]`, and what came back from resolving one, checked against that
// declaration and held for the length of one dispatch.
//
// Ids, not variable names, and that is the first decision. One `aws sso` login yields
// three variables today and a different number the day the operator moves to OIDC — so
// a task that named variables would be encoding somebody else's credential plumbing,
// and every task in the plan would need editing when the plumbing changed.

/// Variables that decide *which program runs* rather than what it may reach.
///
/// The same list the build cache refuses — see [`OrgError::SecretVarForbidden`]. Written
/// out twice rather than shared, because the two blocks are read by different modules
/// and neither of them owns the rule.
const NOT_A_CREDENTIAL: &[&str] = &[
    "PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
];

/// What an id means: a program that prints a credential, the variables it may print,
/// and how long what it prints stays usable.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SecretDef {
    /// The id a task declares, carried so a refusal can name itself.
    pub id: String,
    pub command: String,
    pub vars: Vec<String>,
    /// How long the credential lives, as the operator states it. wecode cannot verify
    /// this and believes it: the real expiry is enforced by whoever issued the
    /// credential, and the only thing this figure buys is [`SecretDef::admits`].
    pub ttl: Duration,
    /// How long the resolver may take before it is killed.
    pub timeout: Duration,
}

impl SecretDef {
    /// Refuses a dispatch whose run could outlive the credential it would hold.
    ///
    /// Refused at the front rather than re-resolved mid-run. A credential that dies at
    /// minute 20 of a 90-minute run produces a failure 70 minutes later that reads as a
    /// broken test; the agent retries it, the retry fails the same way, and the budget is
    /// gone before anyone reads the word `ExpiredToken`. Re-resolution would mean writing
    /// into a live process's environment, which needs either a file — never — or a helper
    /// the agent has to cooperate with, and an agent that can decline to refresh its
    /// credential is a control that is really a request.
    pub fn admits(&self, wall: Duration) -> Result<(), String> {
        if self.ttl >= wall {
            return Ok(());
        }
        Err(format!(
            "{} lives {} and the run may take {}\n  \
             shorten the wall budget to {}, or declare a longer-lived credential",
            self.id,
            say(self.ttl),
            say(wall),
            say(self.ttl)
        ))
    }
}

/// The credentials one dispatch is holding: the id that minted each value, the variable
/// it sets, and the value itself.
///
/// Values live here and in the environment of the process wecode starts, and nowhere
/// else. Not in a file — no `.env`, no `~/.aws/credentials`, no `git config` — because a
/// file lands in the diff or in the operator's `git status`, and a worktree survives a
/// killed run, so the file outlives the process that needed it. Environment variables die
/// with the process group. Not in the store either, which is what makes *how does wecode
/// encrypt secrets at rest* a question with no surface: it holds none.
#[derive(Clone, Default)]
pub struct Held {
    vars: Vec<(String, String, String)>,
}

/// Names, never values.
///
/// Hand-written because a derived one would print a credential into any error report,
/// panic message or trace that ever touched a [`Held`] — which is the one way a value
/// gets out of here that no rule about files could catch.
impl fmt::Debug for Held {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map()
            .entries(self.vars.iter().map(|(id, key, _)| (id, key)))
            .finish()
    }
}

impl Held {
    /// Reads what one resolver printed, and refuses everything that is not what its
    /// declaration promised.
    ///
    /// `KEY=VALUE`, one per line, on stdout. Everything else is refused, with the id
    /// named:
    ///
    /// - **A key not in `vars`.** A resolver that starts printing a fourth variable
    ///   cannot start setting a fourth variable.
    /// - **An empty value.** Every credential helper on a bad day prints a variable with
    ///   nothing after the `=`, and the run that follows fails inside a cloud SDK ten
    ///   minutes later with an error about signatures.
    /// - **A value with a newline in it.** A line-based protocol cannot tell a two-line
    ///   value from two variables, so the second line arrives as a line that is not
    ///   `KEY=VALUE` and is refused as one.
    /// - **A variable it declared and did not print.** Same failure as an empty value,
    ///   ten minutes later and further away.
    /// - **The same key twice.** Two values, one of which would silently lose.
    ///
    /// No refusal quotes a line back, only the key: the rest of the line is the
    /// credential, and a message is a thing that gets logged.
    pub fn take(&mut self, def: &SecretDef, stdout: &str) -> Result<(), String> {
        let id = &def.id;
        let mut got: Vec<(String, String)> = Vec::new();
        for line in stdout.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let (key, value) = line
                .split_once('=')
                .ok_or_else(|| format!("{id}: the resolver printed a line that is not KEY=VALUE"))?;
            if !def.vars.iter().any(|v| v == key) {
                return Err(format!(
                    "{id}: the resolver printed `{key}`, which [secrets.{id}] vars does not declare"
                ));
            }
            if value.is_empty() {
                return Err(format!("{id}: the resolver printed `{key}` with no value"));
            }
            if got.iter().any(|(k, _)| k == key) {
                return Err(format!("{id}: the resolver printed `{key}` twice"));
            }
            got.push((key.to_string(), value.to_string()));
        }
        if let Some(missing) = def
            .vars
            .iter()
            .find(|v| !got.iter().any(|(k, _)| k == v.as_str()))
        {
            return Err(format!(
                "{id}: the resolver printed nothing for `{missing}`"
            ));
        }
        self.vars
            .extend(got.into_iter().map(|(k, v)| (id.clone(), k, v)));
        Ok(())
    }

    /// The variables to set on the process that does the work, and nothing else.
    pub fn env(&self) -> impl Iterator<Item = (&str, &str)> {
        self.vars.iter().map(|(_, k, v)| (k.as_str(), v.as_str()))
    }

    /// The credentials this dispatch held, for the record and for the envelope. Ids,
    /// which is the whole of what either of those may say about a secret.
    #[must_use]
    pub fn ids(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for (id, _, _) in &self.vars {
            if !out.contains(&id.as_str()) {
                out.push(id);
            }
        }
        out
    }

    /// One line of captured output, with every value replaced by the id that minted it.
    ///
    /// A net over **accidents** — an agent running `env`, a stack trace quoting a key, a
    /// `pytest -vv` dump — and it is worth having because those are the ways a secret
    /// actually reaches a log. It is not a control: an agent that wants the value out has
    /// `base64`, and saying so here is better than a later reader taking the scrubber for
    /// a boundary. `«id»` rather than `***`, so the record says which credential leaked.
    #[must_use]
    pub fn redact(&self, line: String) -> String {
        let mut line = line;
        for (id, _, value) in &self.vars {
            if line.contains(value.as_str()) {
                line = line.replace(value.as_str(), &format!("«{id}»"));
            }
        }
        line
    }
}

/// The `[secrets.*]` blocks as declared, with every way of writing one wrong refused.
///
/// All of it at load: a credential whose declaration is incoherent fails a dispatch far
/// from the file that caused it, and the operator reading `ExpiredToken` out of a cloud
/// SDK is nowhere near the line they mistyped.
fn secrets_of(blocks: BTreeMap<String, SecretBlock>) -> Result<BTreeMap<String, SecretDef>, OrgError> {
    let mut out = BTreeMap::new();
    for (id, b) in blocks {
        let at = |field: &str| format!("[secrets.{id}] {field}");
        if b.command.trim().is_empty() {
            return Err(OrgError::BadValue {
                at: at("command"),
                value: b.command,
            });
        }
        // A credential that may set nothing is a block that reads as configured and hands
        // over an empty environment — and, since the list is also the contract, one that
        // would refuse whatever its own command printed.
        if b.vars.is_empty() {
            return Err(OrgError::BadValue {
                at: at("vars"),
                value: "[]".to_string(),
            });
        }
        for var in &b.vars {
            if NOT_A_CREDENTIAL.contains(&var.as_str()) {
                return Err(OrgError::SecretVarForbidden {
                    id: id.clone(),
                    var: var.clone(),
                });
            }
            if var.trim().is_empty() || var.contains('=') {
                return Err(OrgError::BadValue {
                    at: at("vars"),
                    value: var.clone(),
                });
            }
        }
        let ttl = duration_at(&b.ttl, &at("ttl"))?;
        let timeout = duration_at(&b.timeout, &at("timeout"))?;
        out.insert(
            id.clone(),
            SecretDef {
                id,
                command: b.command.trim().to_string(),
                vars: b.vars,
                ttl,
                timeout,
            },
        );
    }
    Ok(out)
}

/// A duration as written, refusing zero along with nonsense: a `ttl` of nothing refuses
/// every run, and a `timeout` of nothing kills the resolver before it can print.
fn duration_at(written: &str, at: &str) -> Result<Duration, OrgError> {
    parse_duration(written)
        .filter(|d| !d.is_zero())
        .ok_or_else(|| OrgError::BadValue {
            at: at.to_string(),
            value: written.to_string(),
        })
}

/// A duration as an operator would write it in `company.toml`.
///
/// Only refusals print one, and a refusal that answers `3600s lives less than 5400s`
/// leaves the arithmetic to whoever has to edit the figure.
fn say(d: Duration) -> String {
    let s = d.as_secs();
    match (s / 3600, (s % 3600) / 60, s % 60) {
        (0, 0, s) => format!("{s}s"),
        (0, m, 0) => format!("{m}m"),
        (h, 0, 0) => format!("{h}h"),
        (0, m, s) => format!("{m}m{s}s"),
        (h, m, 0) => format!("{h}h{m}m"),
        (h, m, s) => format!("{h}h{m}m{s}s"),
    }
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

    /// The minimal file plus whatever blocks a test is about.
    fn declaring(blocks: &str) -> Result<Company, OrgError> {
        Company::parse(&format!("{MINIMAL}\n{blocks}"))
    }

    /// The minimal file with its one harness declaring an output shape.
    fn speaking(protocol: &str) -> Result<Company, OrgError> {
        Company::parse(&MINIMAL.replace(
            "command = \"claude\"",
            &format!("command = \"claude\"\nprotocol = \"{protocol}\""),
        ))
    }

    #[test]
    fn a_harness_holds_a_seat_by_naming_a_shape_wecode_reads() {
        // The whole vocabulary, and the point of there being one: what a seat needs
        // from its occupant is a declaration, not an integration.
        for name in Protocol::NAMES {
            assert!(speaking(name).is_ok(), "{name} should be a protocol");
        }
        assert_eq!(Protocol::parse("plain"), Some(Protocol::Plain));
        assert_eq!(
            Protocol::parse(""),
            Some(Protocol::Plain),
            "a harness that declares nothing reports nothing — every file written \
             before this list says so by saying nothing"
        );
        assert!(Company::parse(MINIMAL).is_ok(), "and still loads");
    }

    #[test]
    fn a_shape_nothing_reads_is_refused_where_it_is_written() {
        // Left to dispatch this is a blank spend column on every run of that harness —
        // which is exactly what an honest `plain` looks like, so the typo and the
        // decision would be indistinguishable afterwards.
        match speaking("claude-stream-jsonl").unwrap_err() {
            OrgError::UnknownProtocol { agent, protocol } => {
                assert_eq!(agent, "claude-code");
                assert_eq!(protocol, "claude-stream-jsonl");
            }
            other => panic!("expected UnknownProtocol, got {other}"),
        }
        // And the message carries the repair, which is the list itself.
        let said = speaking("opencode-json").unwrap_err().to_string();
        for name in Protocol::NAMES {
            assert!(said.contains(name), "{said} should offer {name}");
        }
    }

    /// One credential, declared the way the first real one is: a command that prints
    /// what an `aws sso` session already prints, and the variables it may print.
    fn one_secret() -> Company {
        declaring(
            "[secrets.aws-cloud-test]\n\
             command = \"aws configure export-credentials --format env-no-export\"\n\
             vars = [\"AWS_ACCESS_KEY_ID\", \"AWS_SESSION_TOKEN\"]\n\
             ttl = \"1h\"\n",
        )
        .expect("a valid credential")
    }

    /// A resolver that printed exactly what it declared, without running anything.
    fn printed(_: &SecretDef) -> Result<String, String> {
        Ok("AWS_ACCESS_KEY_ID=AKIAFIXTURE\nAWS_SESSION_TOKEN=t0ken\n".to_string())
    }

    #[test]
    fn a_credential_is_declared_by_the_id_a_task_names() {
        let c = one_secret();
        let def = c.secret("aws-cloud-test").expect("declared");
        assert!(def.command.starts_with("aws configure"));
        assert_eq!(def.vars, vec!["AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN"]);
        assert_eq!(def.ttl, Duration::from_secs(3600));
        // A resolver that wants longer says so; twenty seconds is enough for every
        // credential helper that is not waiting for a person.
        assert_eq!(def.timeout, Duration::from_secs(20));
        // And no block at all is no credential, rather than a default one.
        assert!(Company::parse(MINIMAL).unwrap().secrets.is_empty());
    }

    #[test]
    fn a_credential_with_no_ttl_does_not_parse() {
        // The one field with no defensible default: absent, it would have to mean either
        // forever or refuse everything, and neither is a thing an operator meant to say.
        let e = declaring("[secrets.x]\ncommand = \"true\"\nvars = [\"T\"]\n").unwrap_err();
        assert!(e.to_string().contains("ttl"), "{e}");
    }

    #[test]
    fn a_credential_that_could_hand_over_nothing_is_refused_at_load() {
        // Both shapes read as configured and behave as absent — the first has nothing to
        // run, and the second would refuse whatever its own command printed.
        for (block, at) in [
            ("command = \"\"\nvars = [\"T\"]\nttl = \"1h\"", "command"),
            ("command = \"true\"\nvars = []\nttl = \"1h\"", "vars"),
        ] {
            match declaring(&format!("[secrets.x]\n{block}\n")).unwrap_err() {
                OrgError::BadValue { at: got, .. } => assert!(got.contains(at), "{got}"),
                other => panic!("expected BadValue for {block}, got {other}"),
            }
        }
    }

    #[test]
    fn a_credential_may_not_set_which_program_runs() {
        // The same rule the build cache has. A resolver that could set `PATH` would be
        // choosing the toolchain of every task that declared the credential, which is a
        // different power wearing this feature's clothes.
        for var in ["PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"] {
            let block = format!("[secrets.x]\ncommand = \"true\"\nvars = [\"{var}\"]\nttl = \"1h\"\n");
            match declaring(&block).unwrap_err() {
                OrgError::SecretVarForbidden { id, var: got } => {
                    assert_eq!(id, "x");
                    assert_eq!(got, var);
                }
                other => panic!("expected SecretVarForbidden for {var}, got {other}"),
            }
        }
    }

    #[test]
    fn a_ttl_or_timeout_that_could_never_work_is_refused() {
        for (field, bad, written) in [
            ("ttl", "0s", "ttl = \"0s\""),
            ("ttl", "soon", "ttl = \"soon\""),
            ("timeout", "0s", "ttl = \"1h\"\ntimeout = \"0s\""),
            ("timeout", "later", "ttl = \"1h\"\ntimeout = \"later\""),
        ] {
            let block = format!("[secrets.x]\ncommand = \"true\"\nvars = [\"T\"]\n{written}\n");
            match declaring(&block).unwrap_err() {
                OrgError::BadValue { at, value } => {
                    assert!(at.contains(field), "{at}");
                    assert_eq!(value, bad);
                }
                other => panic!("expected BadValue for {field} = {bad}, got {other}"),
            }
        }
    }

    #[test]
    fn an_unknown_id_names_what_this_workspace_declares() {
        // The typo belongs to the day the task was written, and the repair is a name the
        // operator can read off the refusal rather than out of company.toml.
        let e = one_secret().secret("aws-cloud").unwrap_err();
        assert!(e.contains("unknown secret `aws-cloud`"), "{e}");
        assert!(e.contains("aws-cloud-test"), "{e}");

        let e = Company::parse(MINIMAL).unwrap().secret("x").unwrap_err();
        assert!(e.contains("no [secrets.*] block"), "{e}");
    }

    #[test]
    fn a_run_that_could_outlive_its_credential_is_refused_before_it_starts() {
        let c = one_secret();
        let e = c
            .hold(&["aws-cloud-test".to_string()], Some(hours(1.5)), printed)
            .unwrap_err();
        assert!(e.contains("aws-cloud-test lives 1h and the run may take 1h30m"), "{e}");
        assert!(e.contains("shorten the wall budget to 1h"), "{e}");

        // A run inside the credential's life is fine, and so is a run held to no clock
        // at all: there is no figure for a ttl to be shorter than.
        for wall in [Some(hours(1.0)), Some(Duration::from_secs(60)), None] {
            assert!(
                c.hold(&["aws-cloud-test".to_string()], wall, printed).is_ok(),
                "{wall:?}"
            );
        }
    }

    fn hours(h: f64) -> Duration {
        Duration::from_secs_f64(h * 3600.0)
    }

    #[test]
    fn nothing_is_resolved_until_every_id_has_been_checked() {
        // A dispatch refused on its second credential must not have logged in for its
        // first: that is an entry in somebody's audit trail, and a live credential, for a
        // run that never happened.
        let c = one_secret();
        let calls = std::cell::Cell::new(0);
        let mint = |d: &SecretDef| {
            calls.set(calls.get() + 1);
            printed(d)
        };
        let ids = ["aws-cloud-test".to_string(), "aws-prod".to_string()];
        assert!(c.hold(&ids, None, mint).unwrap_err().contains("aws-prod"));
        assert_eq!(calls.get(), 0, "an unknown id refused nothing late");

        // Same for the ttl, which is checked against the clock before any of it runs.
        assert!(c.hold(&ids[..1], Some(hours(2.0)), mint).is_err());
        assert_eq!(calls.get(), 0);

        // And the resolver runs once per credential when the dispatch is admitted.
        let held = c.hold(&ids[..1], Some(hours(1.0)), mint).unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(held.ids(), vec!["aws-cloud-test"]);
        assert_eq!(
            held.env().collect::<Vec<_>>(),
            vec![
                ("AWS_ACCESS_KEY_ID", "AKIAFIXTURE"),
                ("AWS_SESSION_TOKEN", "t0ken")
            ]
        );
    }

    #[test]
    fn a_resolver_that_printed_something_else_is_refused_with_its_id_named() {
        let c = one_secret();
        let def = c.secret("aws-cloud-test").unwrap();
        for (printed, expected) in [
            (
                "AWS_ACCESS_KEY_ID=k\nAWS_SESSION_TOKEN=t\nAWS_SECRET_ACCESS_KEY=s\n",
                "printed `AWS_SECRET_ACCESS_KEY`, which [secrets.aws-cloud-test] vars does not declare",
            ),
            ("AWS_ACCESS_KEY_ID=\nAWS_SESSION_TOKEN=t\n", "printed `AWS_ACCESS_KEY_ID` with no value"),
            ("AWS_ACCESS_KEY_ID=k\n", "printed nothing for `AWS_SESSION_TOKEN`"),
            (
                "AWS_ACCESS_KEY_ID=k\nAWS_ACCESS_KEY_ID=k2\nAWS_SESSION_TOKEN=t\n",
                "printed `AWS_ACCESS_KEY_ID` twice",
            ),
            // A two-line value: the second line is not KEY=VALUE, which is the only
            // thing a line-based protocol can tell about it.
            (
                "AWS_ACCESS_KEY_ID=-----BEGIN\nkey-----\nAWS_SESSION_TOKEN=t\n",
                "printed a line that is not KEY=VALUE",
            ),
            ("Enter your MFA code:\n", "printed a line that is not KEY=VALUE"),
        ] {
            let e = Held::default().take(def, printed).unwrap_err();
            assert!(e.starts_with("aws-cloud-test: "), "{e}");
            assert!(e.contains(expected), "{e}");
        }
    }

    #[test]
    fn a_value_that_comes_back_out_is_replaced_by_the_id_that_minted_it() {
        // A net over accidents — an agent running `env`, a stack trace quoting a key.
        // The id rather than `***`, so the record says which credential was echoed.
        let c = one_secret();
        let held = c
            .hold(&["aws-cloud-test".to_string()], None, printed)
            .unwrap();
        assert_eq!(
            held.redact("aws: signing with AKIAFIXTURE / t0ken".to_string()),
            "aws: signing with «aws-cloud-test» / «aws-cloud-test»"
        );
        // A line with nothing of the sort in it comes back as it was.
        let line = "cargo test --workspace".to_string();
        assert_eq!(held.redact(line.clone()), line);
        // And holding nothing changes nothing, which is every run that declared no
        // credential.
        assert_eq!(Held::default().redact(line.clone()), line);
    }

    #[test]
    fn a_held_credential_debugs_as_names_and_never_as_values() {
        // The one way out that no rule about files could catch: a `{:?}` in an error
        // report, a panic message, a trace. A derived Debug would print the key itself.
        let held = one_secret()
            .hold(&["aws-cloud-test".to_string()], None, printed)
            .unwrap();
        let shown = format!("{held:?}");
        assert!(shown.contains("aws-cloud-test"), "{shown}");
        assert!(shown.contains("AWS_ACCESS_KEY_ID"), "{shown}");
        assert!(!shown.contains("AKIAFIXTURE"), "{shown}");
        assert!(!shown.contains("t0ken"), "{shown}");
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
