//! The company profile: who exists, what they may do, and what outranks them.
//!
//! Deserialised straight from `company.toml`. Everything in this file is
//! hand-editable on purpose — a role's write scope is exactly the thing you want to
//! review in a diff, which is why configuration is not in the database.
//!
//! The vision lives here as a sentence rather than as a node in the work tree. It
//! was never executable, and it cost a level of hierarchy to carry.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::Duration;

use serde::Deserialize;
use wecode_gov::{ActionKind, Charter, Effective, Grant, Introspect, Invariant, Network, WorkKind};

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
// Shapes that mirror company.toml exactly. Converted to the domain types below,
// so a config field renaming never leaks into the rest of the codebase.

#[derive(Deserialize, Debug)]
struct Wire {
    company: CompanyBlock,
    #[serde(default)]
    attention: AttentionBlock,
    #[serde(default)]
    invariants: InvariantBlock,
    #[serde(default)]
    session: SessionBlock,
    #[serde(default)]
    notify: NotifyBlock,
    #[serde(default)]
    telegram: TelegramBlock,
    #[serde(default)]
    repos: Vec<Repo>,
    #[serde(default)]
    roles: BTreeMap<String, RoleBlock>,
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

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct AttentionBlock {
    #[serde(default = "five")]
    max_open_items: u64,
    #[serde(default = "three")]
    max_interrupts_per_hour: u64,
    #[serde(default = "twenty")]
    digest_interval_mins: u64,
}

fn five() -> u64 {
    5
}
fn three() -> u64 {
    3
}
fn twenty() -> u64 {
    20
}

impl Default for AttentionBlock {
    fn default() -> Self {
        Self {
            max_open_items: 5,
            max_interrupts_per_hour: 3,
            digest_interval_mins: 20,
        }
    }
}

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
struct InvariantBlock {
    #[serde(default)]
    never_touch: Vec<String>,
    #[serde(default)]
    never_run: Vec<String>,
    #[serde(default)]
    approval_to_merge: Vec<String>,
    max_tokens: Option<u64>,
    max_wall_secs: Option<u64>,
    /// The strongest model any seat may be staffed with, as a level.
    ///
    /// Beside `max_tokens`, and for the same reason: the two are the expensive
    /// variables, and an invariant outranks every grant that would exceed it.
    max_intelligence: Option<Intelligence>,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct SessionBlock {
    #[serde(default = "eight_hours")]
    ttl: String,
}

fn eight_hours() -> String {
    "8h".to_string()
}

impl Default for SessionBlock {
    fn default() -> Self {
        Self { ttl: eight_hours() }
    }
}

/// The hook run when a task starts waiting on a person.
///
/// `command` is an `Option` rather than a defaulted string so that writing it empty
/// can be refused: a `[notify]` block with nothing to run means to notify and does
/// not, and the whole point of the block is to be believed.
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct NotifyBlock {
    command: Option<String>,
    #[serde(default = "ten_seconds")]
    timeout: String,
}

fn ten_seconds() -> String {
    "10s".to_string()
}

// Hand-written, like `SessionBlock`'s: a derived `Default` would take the empty
// string rather than the `#[serde(default)]` function, and an absent block would
// then fail to parse the timeout it never named.
impl Default for NotifyBlock {
    fn default() -> Self {
        Self {
            command: None,
            timeout: ten_seconds(),
        }
    }
}

/// The command that hands back replies, and how long it may take.
///
/// `fetch` is an `Option` for the reason `[notify] command` is: a block that reads as
/// configured and does nothing is worse than no block, so writing it empty is refused.
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct TelegramBlock {
    fetch: Option<String>,
    #[serde(default = "thirty_seconds")]
    timeout: String,
}

fn thirty_seconds() -> String {
    "30s".to_string()
}

// Hand-written for the same reason `NotifyBlock`'s is.
impl Default for TelegramBlock {
    fn default() -> Self {
        Self {
            fetch: None,
            timeout: thirty_seconds(),
        }
    }
}

/// A role as written in the file. Converted to a [`Grant`].
#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
struct RoleBlock {
    #[serde(default)]
    read: Vec<String>,
    #[serde(default)]
    write: Vec<String>,
    #[serde(default)]
    run: Vec<String>,
    #[serde(default)]
    network: Option<String>,
    #[serde(default)]
    hosts: Vec<String>,
    tokens: Option<u64>,
    wall_secs: Option<u64>,
    #[serde(default)]
    merge_to: Vec<String>,
    #[serde(default)]
    approve: Vec<String>,
    #[serde(default)]
    define: Vec<String>,
    #[serde(default)]
    introspect: Option<String>,
    #[serde(default)]
    staff: bool,
}

// ---------------------------------------------------------------- domain ------

/// How clever the occupant of a seat should be, on a scale of 1 to 10.
///
/// A level, not a model name. Names churn and a chart pinned to one rots at the next
/// release; what is stable is *order* — which of a harness's models is stronger than
/// which — and that is what [`AgentTemplate::models`] declares. The number here is
/// matched against the scale derived from that list, so adding a model or reordering
/// one leaves every seat meaning roughly what it meant.
///
/// Held as tenths of a point rather than as an `f64`, for two reasons that both matter
/// here: config types in this file are compared for equality, which floats cannot do
/// honestly, and the index arithmetic in [`AgentTemplate::model_at`] is exact in
/// integers and a question of epsilons in floats. One decimal place is all the written
/// form ever needs — a four-model catalogue lands on 2.5, 5, 7.5 and 10.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Intelligence(i32);

impl Intelligence {
    /// The lowest level anything may be configured at.
    pub const MIN: Self = Self(10);
    /// The top of the scale, and what the strongest model in any catalogue answers to.
    pub const MAX: Self = Self(100);

    /// The level `n` points is, rounded to the tenth the written form carries.
    ///
    /// A level off the scale — `0`, `11`, `-3` — is *built* here rather than refused,
    /// which is also why the representation is signed. Refusing it in the deserialiser
    /// would report it at a TOML span; [`Company::validate`] refuses it naming the seat
    /// that wrote it, which is what whoever is editing the file is looking for.
    #[must_use]
    pub fn of(points: f64) -> Option<Self> {
        // Not a number, or wider than any scale could be: there is nothing to carry,
        // and a saturating cast would invent something.
        if !points.is_finite() || !(-1000.0..=1000.0).contains(&points) {
            return None;
        }
        #[expect(
            clippy::cast_possible_truncation,
            reason = "range-checked directly above, and rounded before the cast"
        )]
        Some(Self((points * 10.0).round() as i32))
    }

    /// Whether this is a level the scale actually has.
    #[must_use]
    pub fn in_range(self) -> bool {
        (Self::MIN..=Self::MAX).contains(&self)
    }

    /// The highest level the `i`th of `n` models answers to, counting from zero and
    /// weakest first.
    ///
    /// The scale is *spread* over the catalogue rather than written down per model:
    /// four entries give 2.5, 5, 7.5, 10. Hand-written levels would drift the moment a
    /// name changed; an order will not. Truncating rather than rounding is what keeps
    /// this the exact top of the band [`AgentTemplate::model_at`] selects — three
    /// entries answer up to 3.3, 6.6 and 10, and 6.7 is already the third.
    #[must_use]
    pub fn of_rank(i: usize, n: usize) -> Self {
        if n == 0 {
            return Self::MAX;
        }
        let i = i32::try_from(i.min(n - 1)).unwrap_or(0);
        let n = i32::try_from(n).unwrap_or(1);
        Self(Self::MAX.0 * (i + 1) / n)
    }

    /// The level as it was written, for a message a person reads.
    #[must_use]
    pub fn points(self) -> f64 {
        f64::from(self.0) / 10.0
    }
}

impl fmt::Display for Intelligence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // A whole number stays whole: `10`, not `10.0`, because that is how it was
        // written and this is read beside the file it came from.
        if self.0 % 10 == 0 {
            write!(f, "{}", self.0 / 10)
        } else {
            write!(f, "{}", self.points())
        }
    }
}

impl<'de> Deserialize<'de> for Intelligence {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let points = f64::deserialize(d)?;
        Self::of(points).ok_or_else(|| {
            serde::de::Error::custom(format!("intelligence must be a number, got {points}"))
        })
    }
}

/// A code repository this company works on. Declared by path, and deliberately
/// outside the workspace: a company is not a codebase.
#[derive(Clone, PartialEq, Eq, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Repo {
    pub name: String,
    pub path: String,
}

/// A seat in the org chart.
#[derive(Clone, PartialEq, Eq, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Post {
    pub name: String,
    pub role: String,
    /// Which agent template types for this seat.
    #[serde(default = "unstaffed")]
    pub agent: String,
    /// How capable the occupant should be, and `None` for whatever the harness runs by
    /// default.
    ///
    /// It sits here, beside `agent`, and not on the role. A role is enforced capability
    /// — what a seat *may do*. Intelligence is a property of who occupies it, exactly
    /// like the harness name it sits next to. On the role it would make two seats with
    /// the same authority and different models impossible to express, which is the one
    /// thing the post/role split exists for.
    #[serde(default)]
    pub intelligence: Option<Intelligence>,
}

fn unstaffed() -> String {
    "unstaffed".to_string()
}

/// A person, holding a seat. Authority lives on the post's role, so naming a user
/// adds accountability, not power.
#[derive(Clone, PartialEq, Eq, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct User {
    pub name: String,
    pub post: String,
    /// The numeric Telegram account this person replies from, if they do.
    ///
    /// Written as a string because it is an identifier rather than a quantity —
    /// nothing adds to it, and Telegram's chat ids are already wider than a signed
    /// 32-bit integer. Its authority is entirely the post's: naming an account here
    /// says *this account is this person*, and everything they may then sign is
    /// decided by the role, checked by the Broker, at the moment they sign it.
    #[serde(default)]
    pub telegram: Option<String>,
}

/// How to invoke one coding CLI. Consumed by the execution layer.
#[derive(Clone, PartialEq, Eq, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct AgentTemplate {
    pub command: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env_allowlist: Vec<String>,
    #[serde(default)]
    pub wall_secs: Option<u64>,
    #[serde(default)]
    pub idle_secs: Option<u64>,
    /// This harness's models, **weakest first**.
    ///
    /// The one line that needs hand-maintaining, and it is an ordering rather than a
    /// set of numbers — see [`Intelligence`] for why. Empty, which is the default,
    /// means wecode names no model and the harness runs whatever it would have run.
    #[serde(default)]
    pub models: Vec<String>,
    /// How this harness spells *use this model*.
    ///
    /// A field rather than a `{{model}}` placeholder in `args`, and the difference is
    /// the absent case: a placeholder the operator positions after their own `--model`
    /// would, when no level resolves, leave the flag standing with nothing behind it.
    /// Naming the flag lets both halves appear together or not at all.
    #[serde(default = "model_flag")]
    pub model_flag: String,
}

fn model_flag() -> String {
    "--model".to_string()
}

impl AgentTemplate {
    /// The model this level names, and `None` when this harness declared no catalogue.
    ///
    /// The weakest model whose derived level reaches the one asked for — so a seat at 5
    /// against `["haiku", "sonnet", "opus", "fable"]` gets `sonnet`, and a seat asking
    /// for more than the catalogue holds gets its best rather than nothing.
    #[must_use]
    pub fn model_at(&self, want: Intelligence) -> Option<&str> {
        let n = u32::try_from(self.models.len()).ok().filter(|n| *n > 0)?;
        // Integer arithmetic on tenths, and exact: `want` is the level, `n` models
        // divide the scale, so this is the first rank whose share of it reaches `want`.
        // Clamped to the scale first — a level off it is refused at load, and this
        // still has to answer with a model rather than an index nobody has.
        let want = want.clamp(Intelligence::MIN, Intelligence::MAX);
        #[expect(
            clippy::cast_sign_loss,
            reason = "clamped to the positive scale on the line above"
        )]
        let rank = ((want.0 as u32) * n)
            .div_ceil(Intelligence::MAX.0 as u32)
            .max(1)
            - 1;
        self.models
            .get(rank as usize)
            .or_else(|| self.models.last())
            .map(String::as_str)
    }
}

/// Prompt templates, inlined so a workspace stays two files.
#[derive(Clone, PartialEq, Eq, Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub struct Templates {
    #[serde(default)]
    pub task_envelope: String,
}

/// The operator's attention budget — the binding constraint on concurrency.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Attention {
    pub max_open_items: u64,
    pub max_interrupts_per_hour: u64,
    pub digest_interval_mins: u64,
}

/// What to run when a task stops for a person, and how long to let it take.
///
/// The other half of the attention budget. `max_open_items` bounds what may be in
/// flight; this is how the operator finds out that one of those things now needs
/// them, without having to be watching when it happens.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Notify {
    /// `None` — the default — is no hook, and nothing is run.
    pub command: Option<String>,
    /// How long the hook may take before it is killed. A notifier that hangs must
    /// not take the loop with it.
    pub timeout: Duration,
}

/// How replies get back from the chat the notification went out to.
///
/// The other half of [`Notify`]. That one pushes *a task has stopped for you* to
/// wherever the operator is; without this, the way back was still a terminal, and a
/// signature nobody is near to give is a queue standing still.
///
/// wecode holds no network client and no bot token. `fetch` is a command the operator
/// writes — a `curl` of the Bot API's `getUpdates`, usually — and what it prints on
/// stdout is what wecode reads. The offset to ask from arrives in its environment as
/// `WECODE_TELEGRAM_OFFSET`, so the secret stays in the operator's shell and wecode
/// stays a program that runs commands.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Telegram {
    /// `None` — the default — means replies are not read at all.
    pub fetch: Option<String>,
    /// How long the fetch may take before it is killed. `wecode loop` runs this every
    /// pass; a poll that hangs must not take the loop with it.
    pub timeout: Duration,
}

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
    /// it is written — a post above it is refused at load, by [`Company::validate`],
    /// and there is no run-time action for the Broker to judge. The other invariants
    /// describe things an agent does; this one describes what it is.
    pub max_intelligence: Option<Intelligence>,
}

impl Company {
    /// The post that configures and assigns. By convention, named `chief`.
    #[must_use]
    pub fn chief(&self) -> Option<&Post> {
        self.posts.iter().find(|p| p.role == "chief")
    }

    #[must_use]
    pub fn post(&self, name: &str) -> Option<&Post> {
        self.posts.iter().find(|p| p.name == name)
    }

    #[must_use]
    pub fn user(&self, name: &str) -> Option<&User> {
        self.users.iter().find(|u| u.name == name)
    }

    /// Whose Telegram account this is, if it is anyone's.
    ///
    /// The whole of the identity check on a reply. An account nobody claims resolves
    /// to nothing and therefore signs nothing — there is no fallback seat, because a
    /// default seat for strangers is the one thing this must never have.
    #[must_use]
    pub fn user_by_telegram(&self, id: &str) -> Option<&User> {
        self.users
            .iter()
            .find(|u| u.telegram.as_deref() == Some(id))
    }

    /// The people in a seat. Empty means the seat is agent-only.
    #[must_use]
    pub fn users_of(&self, post: &str) -> Vec<&User> {
        self.users.iter().filter(|u| u.post == post).collect()
    }

    #[must_use]
    pub fn repo(&self, name: &str) -> Option<&Repo> {
        self.repos.iter().find(|r| r.name == name)
    }

    /// Repo names, for the admission check that a project names a real one.
    #[must_use]
    pub fn repo_names(&self) -> Vec<String> {
        self.repos.iter().map(|r| r.name.clone()).collect()
    }

    #[must_use]
    pub fn grant_of(&self, post: &Post) -> Option<&Grant> {
        self.roles.get(&post.role)
    }

    /// The level this seat is staffed at.
    ///
    /// `max_intelligence` is deliberately absent here. A post above the ceiling is
    /// refused by [`Self::validate`], so by the time anything asks this question the
    /// number has already been held to it — and clamping as well would be both an
    /// unreachable branch and the wrong repair, since a seat silently lowered is a file
    /// lying about what it staffs. The ceiling is a ceiling and not a default: a post
    /// under it keeps its own number, which is what stops this from being an elaborate
    /// way to spell "always use the best model".
    ///
    /// It exists as its own step because this is the single point of resolution — where
    /// a per-task override would land if one were built, and where the clamp would then
    /// belong, since a task is asked for rather than written down.
    #[must_use]
    pub fn intelligence_of(&self, post: &Post) -> Option<Intelligence> {
        post.intelligence
    }

    /// The model to launch this seat's harness with, and `None` for the harness default.
    ///
    /// `None` is the whole of the compatibility story: a seat with no level, a harness
    /// with no catalogue, or a post naming no agent at all each yield it, and a company
    /// that has never heard of any of this behaves exactly as it did before.
    #[must_use]
    pub fn model_for(&self, post: &Post) -> Option<&str> {
        self.agents
            .get(&post.agent)?
            .model_at(self.intelligence_of(post)?)
    }

    /// The effective grant for a post. An unknown role yields an empty
    /// intersection, which permits nothing.
    #[must_use]
    pub fn effective(&self, post: &Post) -> Effective {
        match self.grant_of(post) {
            Some(g) => Effective::of(vec![g.clone()]),
            None => Effective::default(),
        }
    }

    /// Parses and validates a company profile.
    pub fn parse(text: &str) -> Result<Self, OrgError> {
        let w: Wire = toml::from_str(text)?;

        let mut roles = BTreeMap::new();
        for (name, block) in &w.roles {
            roles.insert(name.clone(), grant_of(name, block)?);
        }

        let company = Self {
            name: w.company.name,
            description: w.company.description,
            profile: w.company.profile,
            vision: w.company.vision,
            attention: Attention {
                max_open_items: w.attention.max_open_items,
                max_interrupts_per_hour: w.attention.max_interrupts_per_hour,
                digest_interval_mins: w.attention.digest_interval_mins,
            },
            notify: notify_of(&w.notify)?,
            telegram: telegram_of(&w.telegram)?,
            charter: charter_of(&w.invariants),
            session_ttl: parse_duration(&w.session.ttl).ok_or_else(|| OrgError::BadValue {
                at: "[session] ttl".into(),
                value: w.session.ttl.clone(),
            })?,
            max_intelligence: w.invariants.max_intelligence,
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
    fn validate(&self) -> Result<(), OrgError> {
        let root = Grant::root();
        if let Some(cap) = self.max_intelligence
            && !cap.in_range()
        {
            return Err(OrgError::BadValue {
                at: "[invariants] max_intelligence".into(),
                value: cap.to_string(),
            });
        }
        // A catalogue is checked before anything is indexed into it. A blank entry
        // would reach the harness as `--model ""`, and a blank flag as an empty
        // argument — both are a setting that reads as configured and launches wrong.
        for (name, agent) in &self.agents {
            if let Some(blank) = agent.models.iter().find(|m| m.trim().is_empty()) {
                return Err(OrgError::BadValue {
                    at: format!("[agents.{name}] models"),
                    value: blank.clone(),
                });
            }
            if !agent.models.is_empty() && agent.model_flag.trim().is_empty() {
                return Err(OrgError::BadValue {
                    at: format!("[agents.{name}] model_flag"),
                    value: agent.model_flag.clone(),
                });
            }
        }
        for (name, grant) in &self.roles {
            if !grant.narrows(&root) {
                return Err(OrgError::Escalation { role: name.clone() });
            }
        }
        for post in &self.posts {
            if !self.roles.contains_key(&post.role) {
                return Err(OrgError::UnknownRole {
                    post: post.name.clone(),
                    role: post.role.clone(),
                });
            }
            // An unstaffed seat is legal; a seat naming an agent that has no
            // template is a typo that would only surface at dispatch.
            if post.agent != "unstaffed" && !self.agents.contains_key(&post.agent) {
                return Err(OrgError::UnknownAgent {
                    post: post.name.clone(),
                    agent: post.agent.clone(),
                });
            }
            if let Some(want) = post.intelligence {
                if !want.in_range() {
                    return Err(OrgError::BadValue {
                        at: format!("[[posts]] {} intelligence", post.name),
                        value: want.to_string(),
                    });
                }
                // The ceiling refuses the config rather than quietly lowering it: a
                // post is written by hand, and a number the file states and the run
                // does not use is the file lying about what it staffs.
                if let Some(cap) = self.max_intelligence
                    && want > cap
                {
                    return Err(OrgError::AboveCeiling {
                        post: post.name.clone(),
                        want,
                        ceiling: cap,
                    });
                }
                if !self
                    .agents
                    .get(&post.agent)
                    .is_some_and(|a| !a.models.is_empty())
                {
                    return Err(OrgError::UnrankedAgent {
                        post: post.name.clone(),
                        agent: post.agent.clone(),
                    });
                }
            }
        }
        let mut chat: BTreeMap<&str, &str> = BTreeMap::new();
        for user in &self.users {
            if self.post(&user.post).is_none() {
                return Err(OrgError::UnknownPost {
                    user: user.name.clone(),
                    post: user.post.clone(),
                });
            }
            // Refused at load, where every other incoherence in this file is. A reply
            // carries an account and no name, so a shared one is not a duplicate
            // entry — it is a signature attributable to two people, resolved by which
            // of them was typed first.
            if let Some(id) = user.telegram.as_deref()
                && let Some(first) = chat.insert(id, &user.name)
            {
                return Err(OrgError::TelegramClash {
                    id: id.to_string(),
                    users: (first.to_string(), user.name.clone()),
                });
            }
        }
        // The chief holds Define and Staff, which is exactly why it must not also
        // hold write or run: an agent that can both set the criteria and do the
        // work can satisfy itself.
        if let Some(chief) = self.chief()
            && let Some(g) = self.grant_of(chief)
        {
            if !g.write.is_empty() {
                return Err(OrgError::ChiefMayNotExecute {
                    detail: "write files",
                });
            }
            if !g.run.is_empty() {
                return Err(OrgError::ChiefMayNotExecute {
                    detail: "run commands",
                });
            }
        }
        Ok(())
    }
}

/// The notify hook as configured, with the two ways of writing it wrong refused.
///
/// A blank command and a zero timeout are both a block that reads as configured and
/// behaves as absent — the first announces nothing, the second kills the hook before
/// it can run. Neither is a shape anyone means, and both are silent.
fn notify_of(b: &NotifyBlock) -> Result<Notify, OrgError> {
    let command = match b.command.as_deref().map(str::trim) {
        None => None,
        Some("") => {
            return Err(OrgError::BadValue {
                at: "[notify] command".into(),
                value: b.command.clone().unwrap_or_default(),
            });
        }
        Some(cmd) => Some(cmd.to_string()),
    };
    let timeout = parse_duration(&b.timeout)
        .filter(|d| !d.is_zero())
        .ok_or_else(|| OrgError::BadValue {
            at: "[notify] timeout".into(),
            value: b.timeout.clone(),
        })?;
    Ok(Notify { command, timeout })
}

/// The reply channel as configured, refused the two ways it can read as on and behave
/// as off. Exactly [`notify_of`]'s argument, at the other end of the same round trip.
fn telegram_of(b: &TelegramBlock) -> Result<Telegram, OrgError> {
    let fetch = match b.fetch.as_deref().map(str::trim) {
        None => None,
        Some("") => {
            return Err(OrgError::BadValue {
                at: "[telegram] fetch".into(),
                value: b.fetch.clone().unwrap_or_default(),
            });
        }
        Some(cmd) => Some(cmd.to_string()),
    };
    let timeout = parse_duration(&b.timeout)
        .filter(|d| !d.is_zero())
        .ok_or_else(|| OrgError::BadValue {
            at: "[telegram] timeout".into(),
            value: b.timeout.clone(),
        })?;
    Ok(Telegram { fetch, timeout })
}

fn charter_of(b: &InvariantBlock) -> Charter {
    let mut out = Vec::new();
    if !b.never_touch.is_empty() {
        out.push(Invariant::NeverTouch(b.never_touch.clone()));
    }
    if !b.never_run.is_empty() {
        out.push(Invariant::NeverRun(b.never_run.clone()));
    }
    if !b.approval_to_merge.is_empty() {
        out.push(Invariant::ApprovalToMerge(b.approval_to_merge.clone()));
    }
    if let Some(n) = b.max_tokens {
        out.push(Invariant::MaxTokens(n));
    }
    if let Some(n) = b.max_wall_secs {
        out.push(Invariant::MaxWallSecs(n));
    }
    Charter::with(out)
}

fn grant_of(name: &str, b: &RoleBlock) -> Result<Grant, OrgError> {
    let at = |k: &str| format!("[roles.{name}] {k}");

    let mut approve = BTreeSet::new();
    for a in &b.approve {
        approve.insert(ActionKind::parse(a).ok_or_else(|| OrgError::BadValue {
            at: at("approve"),
            value: a.clone(),
        })?);
    }
    let mut define = BTreeSet::new();
    for d in &b.define {
        define.insert(WorkKind::parse(d).ok_or_else(|| OrgError::BadValue {
            at: at("define"),
            value: d.clone(),
        })?);
    }
    let introspect = match b.introspect.as_deref() {
        None | Some("none") => Introspect::None,
        Some("own") => Introspect::Own,
        Some("tree") => Introspect::Tree,
        Some(other) => {
            return Err(OrgError::BadValue {
                at: at("introspect"),
                value: other.to_string(),
            });
        }
    };
    let network = match b.network.as_deref() {
        None | Some("none") => Network::None,
        Some("allowlist") => Network::Allowlist,
        Some("any") => Network::Any,
        Some(other) => {
            return Err(OrgError::BadValue {
                at: at("network"),
                value: other.to_string(),
            });
        }
    };

    Ok(Grant {
        read: b.read.clone(),
        write: b.write.clone(),
        run: b.run.clone(),
        network,
        hosts: b.hosts.clone(),
        tokens: b.tokens,
        wall_secs: b.wall_secs,
        merge_to: b.merge_to.clone(),
        approve,
        define,
        introspect,
        staff: b.staff,
    })
}

/// Parses `30m`, `8h`, `7d`, or a bare number of seconds.
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let text = format!("{MINIMAL}\n[company]\n");
        let _ = text; // the vision lives in the existing [company] block
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
    fn a_bad_ttl_names_where_it_was() {
        let text = format!("{MINIMAL}\n[session]\nttl = \"whenever\"\n");
        match Company::parse(&text).unwrap_err() {
            OrgError::BadValue { at, value } => {
                assert!(at.contains("ttl"), "{at}");
                assert_eq!(value, "whenever");
            }
            other => panic!("expected BadValue, got {other}"),
        }
    }

    #[test]
    fn no_notify_block_is_no_hook() {
        // The default has to be silence: a workspace that has never heard of the
        // setting must not try to run anything when a task stops.
        let c = Company::parse(MINIMAL).unwrap();
        assert_eq!(c.notify.command, None);
        assert_eq!(c.notify.timeout, Duration::from_secs(10));
    }

    #[test]
    fn a_notify_command_is_taken_with_its_own_timeout() {
        let text = format!("{MINIMAL}\n[notify]\ncommand = \"say hello\"\ntimeout = \"2m\"\n");
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.notify.command.as_deref(), Some("say hello"));
        assert_eq!(c.notify.timeout, Duration::from_secs(120));
    }

    #[test]
    fn a_blank_notify_command_is_refused_rather_than_read_as_off() {
        // The failure a gate must not have, in its quiet form: a block that says a
        // notification will happen, and a value that means none ever will.
        for blank in ["\"\"", "\"   \""] {
            let text = format!("{MINIMAL}\n[notify]\ncommand = {blank}\n");
            match Company::parse(&text).unwrap_err() {
                OrgError::BadValue { at, .. } => assert!(at.contains("[notify] command"), "{at}"),
                other => panic!("expected BadValue, got {other}"),
            }
        }
    }

    #[test]
    fn a_notify_timeout_that_could_never_finish_is_refused() {
        // Zero kills the hook before it runs, which is a hook that silently never
        // fires; an unparseable one would default to something nobody asked for.
        for bad in ["0s", "later"] {
            let text = format!("{MINIMAL}\n[notify]\ncommand = \"true\"\ntimeout = \"{bad}\"\n");
            match Company::parse(&text).unwrap_err() {
                OrgError::BadValue { at, value } => {
                    assert!(at.contains("[notify] timeout"), "{at}");
                    assert_eq!(value, bad);
                }
                other => panic!("expected BadValue, got {other}"),
            }
        }
    }

    #[test]
    fn no_telegram_block_reads_no_replies() {
        // The default has to be silence in this direction too: a workspace that has
        // never heard of the setting must not run anything to see whether somebody
        // approved something in a chat it does not know about.
        let c = Company::parse(MINIMAL).unwrap();
        assert_eq!(c.telegram.fetch, None);
        assert_eq!(c.telegram.timeout, Duration::from_secs(30));
    }

    #[test]
    fn a_fetch_command_is_taken_with_its_own_timeout() {
        let text = format!("{MINIMAL}\n[telegram]\nfetch = \"curl -s x\"\ntimeout = \"5s\"\n");
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.telegram.fetch.as_deref(), Some("curl -s x"));
        assert_eq!(c.telegram.timeout, Duration::from_secs(5));
    }

    #[test]
    fn a_blank_fetch_or_an_impossible_timeout_is_refused_at_load() {
        // Same two shapes as `[notify]`, refused in the same place: a block that says
        // replies will be read, and a value that means none ever are.
        for (block, at) in [
            ("fetch = \"\"", "[telegram] fetch"),
            ("fetch = \"true\"\ntimeout = \"0s\"", "[telegram] timeout"),
            ("fetch = \"true\"\ntimeout = \"soon\"", "[telegram] timeout"),
        ] {
            let text = format!("{MINIMAL}\n[telegram]\n{block}\n");
            match Company::parse(&text).unwrap_err() {
                OrgError::BadValue { at: got, .. } => assert!(got.contains(at), "{got}"),
                other => panic!("expected BadValue for {block}, got {other}"),
            }
        }
    }

    #[test]
    fn a_user_may_name_the_account_they_reply_from() {
        let text =
            format!("{MINIMAL}\n[[users]]\nname = \"you\"\npost = \"impl\"\ntelegram = \"481\"\n");
        let c = Company::parse(&text).unwrap();
        assert_eq!(
            c.user_by_telegram("481").map(|u| u.name.as_str()),
            Some("you")
        );
        // No fallback seat. An account nobody claims is nobody, which is what keeps a
        // stranger's message from being a signature.
        assert!(c.user_by_telegram("482").is_none());
        assert!(c.user("you").unwrap().telegram.is_some());
    }

    #[test]
    fn two_people_may_not_share_one_account() {
        // A reply carries an account and no name. Shared, it would be signed as
        // whichever user appears first in the file — a signature attributed to
        // someone who did not give it.
        let text = format!(
            "{MINIMAL}\n[[users]]\nname = \"you\"\npost = \"impl\"\ntelegram = \"481\"\n\
             [[users]]\nname = \"them\"\npost = \"impl\"\ntelegram = \"481\"\n"
        );
        match Company::parse(&text).unwrap_err() {
            OrgError::TelegramClash { id, users } => {
                assert_eq!(id, "481");
                assert_eq!(users, ("you".to_string(), "them".to_string()));
            }
            other => panic!("expected TelegramClash, got {other}"),
        }
    }

    #[test]
    fn invariants_are_collected() {
        let text =
            format!("{MINIMAL}\n[invariants]\nnever_touch = [\"**/*.pem\"]\nmax_tokens = 500\n");
        let c = Company::parse(&text).unwrap();
        assert!(
            c.charter
                .invariants
                .contains(&Invariant::NeverTouch(vec!["**/*.pem".to_string()]))
        );
        assert!(c.charter.invariants.contains(&Invariant::MaxTokens(500)));
    }

    #[test]
    fn repos_are_declared_by_path_and_listed_by_name() {
        let text =
            format!("{MINIMAL}\n[[repos]]\nname = \"wecode\"\npath = \"~/projects/wecode\"\n");
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.repo_names(), vec!["wecode".to_string()]);
        assert_eq!(c.repo("wecode").unwrap().path, "~/projects/wecode");
        assert!(c.repo("ghost").is_none());
    }

    #[test]
    fn an_unknown_role_on_a_post_is_rejected() {
        let text = "[company]\nname = \"A\"\n\n[[posts]]\nname = \"x\"\nrole = \"ghost\"\n";
        assert!(matches!(
            Company::parse(text).unwrap_err(),
            OrgError::UnknownRole { .. }
        ));
    }

    #[test]
    fn a_post_naming_an_agent_with_no_template_is_rejected() {
        // Otherwise the typo only surfaces when something tries to dispatch.
        let text = MINIMAL.replace("agent = \"claude-code\"", "agent = \"clade-code\"");
        match Company::parse(&text).unwrap_err() {
            OrgError::UnknownAgent { agent, .. } => assert_eq!(agent, "clade-code"),
            other => panic!("expected UnknownAgent, got {other}"),
        }
    }

    #[test]
    fn an_unstaffed_seat_is_legal() {
        let text = "[company]\nname = \"A\"\n\n[roles.r]\nread = [\"**\"]\n\n[[posts]]\nname = \"vacant\"\nrole = \"r\"\n";
        let c = Company::parse(text).unwrap();
        assert_eq!(c.post("vacant").unwrap().agent, "unstaffed");
    }

    #[test]
    fn a_user_naming_an_unknown_post_is_rejected() {
        let text = format!("{MINIMAL}\n[[users]]\nname = \"Chandra\"\npost = \"ghost\"\n");
        match Company::parse(&text).unwrap_err() {
            OrgError::UnknownPost { user, .. } => assert_eq!(user, "Chandra"),
            other => panic!("expected UnknownPost, got {other}"),
        }
    }

    #[test]
    fn a_chief_that_can_write_or_run_is_rejected() {
        for bad in ["write = [\"src/**\"]", "run = [\"cargo *\"]"] {
            let text = format!(
                "[company]\nname=\"A\"\n\n[roles.chief]\nstaff = true\n{bad}\n\n[[posts]]\nname=\"chief\"\nrole=\"chief\"\n"
            );
            assert!(
                matches!(
                    Company::parse(&text).unwrap_err(),
                    OrgError::ChiefMayNotExecute { .. }
                ),
                "a chief with `{bad}` should be refused"
            );
        }
    }

    #[test]
    fn a_valid_chief_may_define_and_staff_but_not_execute() {
        let text = r#"
[company]
name = "cws"

[roles.chief]
read = ["**"]
define = ["project", "task"]
approve = ["admission"]
introspect = "tree"
staff = true

[[posts]]
name = "chief"
role = "chief"
"#;
        let c = Company::parse(text).unwrap();
        let chief = c.chief().expect("chief exists");
        let g = c.grant_of(chief).unwrap();
        assert!(g.define.contains(&WorkKind::Task));
        assert!(g.define.contains(&WorkKind::Project));
        assert!(g.staff);
        assert!(g.write.is_empty());
    }

    #[test]
    fn define_only_accepts_project_and_task() {
        // Vision and goal are no longer levels, so naming them is a stale config.
        let text = format!(
            "{}\n",
            MINIMAL.replace("tokens = 1000", "define = [\"vision\"]")
        );
        match Company::parse(&text).unwrap_err() {
            OrgError::BadValue { at, value } => {
                assert!(at.contains("define"), "{at}");
                assert_eq!(value, "vision");
            }
            other => panic!("expected BadValue, got {other}"),
        }
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

    /// The minimal company with a four-model catalogue on its harness, plus whatever
    /// top-level block the test wants after it.
    fn ranked(extra: &str) -> String {
        format!("{}\n{extra}", with_agent_line(MINIMAL, ATTRS))
    }

    const ATTRS: &str = "models = [\"haiku\", \"sonnet\", \"opus\", \"fable\"]";

    /// Adds lines to `[agents.claude-code]`, which is where they have to land: appended
    /// to the file they would join `[[posts]]` and be refused as unknown keys.
    fn with_agent_line(text: &str, line: &str) -> String {
        text.replace(
            "command = \"claude\"",
            &format!("command = \"claude\"\n{line}"),
        )
    }

    #[test]
    fn a_scale_is_spread_over_the_catalogue_rather_than_written_per_model() {
        // The whole reason a level is not a model name: four entries land on 2.5, 5,
        // 7.5, 10, and adding a fifth re-spreads them without any seat being edited.
        assert_eq!(Intelligence::of_rank(0, 4).to_string(), "2.5");
        assert_eq!(Intelligence::of_rank(1, 4).to_string(), "5");
        assert_eq!(Intelligence::of_rank(2, 4).to_string(), "7.5");
        assert_eq!(Intelligence::of_rank(3, 4).to_string(), "10");
        // Whatever the length, the strongest answers to the top of the scale.
        for n in 1..12 {
            assert_eq!(Intelligence::of_rank(n - 1, n), Intelligence::MAX, "n={n}");
        }
    }

    #[test]
    fn a_level_picks_the_weakest_model_that_reaches_it() {
        let c = Company::parse(&ranked("")).unwrap();
        let a = &c.agents["claude-code"];
        let at = |points: f64| a.model_at(Intelligence::of(points).unwrap()).unwrap();
        assert_eq!(at(1.0), "haiku");
        assert_eq!(at(2.5), "haiku", "the top of its band is still its band");
        assert_eq!(at(2.6), "sonnet", "and a tenth past it is the next one");
        assert_eq!(at(5.0), "sonnet");
        assert_eq!(at(7.5), "opus");
        assert_eq!(at(10.0), "fable");
    }

    #[test]
    fn a_harness_with_no_catalogue_names_no_model_at_all() {
        // The compatibility story, and the whole of it: this is what every company
        // that has never heard of the setting keeps doing.
        let c = Company::parse(MINIMAL).unwrap();
        let post = c.post("impl").unwrap();
        assert!(post.intelligence.is_none());
        assert_eq!(c.model_for(post), None);
        assert_eq!(
            c.agents["claude-code"].model_at(Intelligence::MAX),
            None,
            "an empty list has nothing to index into"
        );
        assert_eq!(
            c.agents["claude-code"].model_flag, "--model",
            "the flag most harnesses spell it with, so most need not say"
        );
    }

    #[test]
    fn a_seat_with_a_level_resolves_it_to_a_model() {
        let c = Company::parse(&ranked("").replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 7.5",
        ))
        .unwrap();
        let post = c.post("impl").unwrap();
        assert_eq!(c.intelligence_of(post), Intelligence::of(7.5));
        assert_eq!(c.model_for(post), Some("opus"));
    }

    #[test]
    fn an_integer_level_is_as_valid_as_a_decimal_one() {
        // TOML tells the two apart and a person writing `5` means the same thing.
        let c = Company::parse(&ranked("").replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 5",
        ))
        .unwrap();
        assert_eq!(c.model_for(c.post("impl").unwrap()), Some("sonnet"));
    }

    #[test]
    fn a_ceiling_is_a_ceiling_and_not_a_default() {
        // A seat under it keeps its own number. If the ceiling were also the default,
        // every task would run at the top of the scale and this would be an elaborate
        // way to spell "always use the best model".
        let text = ranked("[invariants]\nmax_intelligence = 10\n").replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 5",
        );
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.max_intelligence, Intelligence::of(10.0));
        assert_eq!(c.model_for(c.post("impl").unwrap()), Some("sonnet"));
    }

    #[test]
    fn a_seat_configured_above_the_ceiling_is_refused_rather_than_lowered() {
        // A post is written by hand. A number the file states and the run does not use
        // is the file lying about what it staffs.
        let text = ranked("[invariants]\nmax_intelligence = 5\n").replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 10",
        );
        match Company::parse(&text).unwrap_err() {
            OrgError::AboveCeiling {
                post,
                want,
                ceiling,
            } => {
                assert_eq!(post, "impl");
                assert_eq!(want.to_string(), "10");
                assert_eq!(ceiling.to_string(), "5");
            }
            other => panic!("expected AboveCeiling, got {other}"),
        }
    }

    #[test]
    fn a_level_on_a_harness_with_no_models_is_refused_at_load() {
        // The failure this file refuses everywhere: a setting that reads as configured
        // and decides nothing. The message names the one line that repairs it.
        let text = MINIMAL.replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 7.5",
        );
        match Company::parse(&text).unwrap_err() {
            OrgError::UnrankedAgent { post, agent } => {
                assert_eq!(post, "impl");
                assert_eq!(agent, "claude-code");
            }
            other => panic!("expected UnrankedAgent, got {other}"),
        }
    }

    #[test]
    fn a_level_off_the_scale_is_refused_by_the_seat_that_wrote_it() {
        for bad in ["0", "0.5", "11", "-3"] {
            let text = ranked("").replace(
                "role = \"engineer\"",
                &format!("role = \"engineer\"\nintelligence = {bad}"),
            );
            match Company::parse(&text).unwrap_err() {
                OrgError::BadValue { at, .. } => {
                    assert!(at.contains("impl"), "{at} should name the seat");
                    assert!(at.contains("intelligence"), "{at}");
                }
                other => panic!("expected BadValue for {bad}, got {other}"),
            }
        }
    }

    #[test]
    fn a_ceiling_off_the_scale_is_refused_too() {
        let text = ranked("[invariants]\nmax_intelligence = 25\n");
        match Company::parse(&text).unwrap_err() {
            OrgError::BadValue { at, value } => {
                assert!(at.contains("max_intelligence"), "{at}");
                assert_eq!(value, "25");
            }
            other => panic!("expected BadValue, got {other}"),
        }
    }

    #[test]
    fn a_catalogue_entry_that_would_launch_as_an_empty_argument_is_refused() {
        // `--model ""` is not a model, and neither is an empty flag. Both are settings
        // that parse and launch wrong.
        for (bad, at) in [
            ("models = [\"haiku\", \"\"]", "models"),
            ("models = [\"haiku\"]\nmodel_flag = \"  \"", "model_flag"),
        ] {
            match Company::parse(&with_agent_line(MINIMAL, bad)).unwrap_err() {
                OrgError::BadValue { at: got, .. } => assert!(got.contains(at), "{got}"),
                other => panic!("expected BadValue for {bad}, got {other}"),
            }
        }
    }

    #[test]
    fn an_unknown_role_yields_an_empty_effective_grant() {
        let c = Company::parse(MINIMAL).unwrap();
        let ghost = Post {
            name: "g".into(),
            role: "ghost".into(),
            agent: "claude-code".into(),
            intelligence: None,
        };
        let e = c.effective(&ghost);
        assert!(e.is_empty());
        assert!(!e.allows_write("src/a.rs"), "permits nothing");
    }
}
