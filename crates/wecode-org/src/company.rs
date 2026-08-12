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

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Company {
    pub name: String,
    pub description: String,
    pub profile: String,
    pub vision: String,
    pub attention: Attention,
    pub charter: Charter,
    pub repos: Vec<Repo>,
    pub roles: BTreeMap<String, Grant>,
    pub posts: Vec<Post>,
    pub users: Vec<User>,
    pub agents: BTreeMap<String, AgentTemplate>,
    pub templates: Templates,
    /// Idle timeout for interactive sessions.
    pub session_ttl: Duration,
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
            charter: charter_of(&w.invariants),
            session_ttl: parse_duration(&w.session.ttl).ok_or_else(|| OrgError::BadValue {
                at: "[session] ttl".into(),
                value: w.session.ttl.clone(),
            })?,
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
        }
        for user in &self.users {
            if self.post(&user.post).is_none() {
                return Err(OrgError::UnknownPost {
                    user: user.name.clone(),
                    post: user.post.clone(),
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

    #[test]
    fn an_unknown_role_yields_an_empty_effective_grant() {
        let c = Company::parse(MINIMAL).unwrap();
        let ghost = Post {
            name: "g".into(),
            role: "ghost".into(),
            agent: "claude-code".into(),
        };
        let e = c.effective(&ghost);
        assert!(e.is_empty());
        assert!(!e.allows_write("src/a.rs"), "permits nothing");
    }
}
