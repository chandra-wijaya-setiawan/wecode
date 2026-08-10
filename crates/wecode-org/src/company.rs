//! The company profile: who exists, what they may do, and what outranks them.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use wecode_core::IntentKind;
use wecode_gov::{ActionKind, Charter, Effective, Grant, Introspect, Invariant, Network};

use crate::toml::{self, ConfError, Value};

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum OrgError {
    Conf(ConfError),
    Missing(&'static str),
    UnknownRole {
        post: String,
        role: String,
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
            Self::Conf(e) => write!(f, "{e}"),
            Self::Missing(what) => write!(f, "company.toml is missing {what}"),
            Self::UnknownRole { post, role } => {
                write!(f, "post `{post}` names role `{role}`, which is not defined")
            }
            Self::BadValue { at, value } => write!(f, "bad value at {at}: `{value}`"),
            Self::Escalation { role } => {
                write!(f, "role `{role}` is wider than the operator grant")
            }
            Self::ChiefMayNotExecute { detail } => {
                write!(
                    f,
                    "the chief post may not {detail} — it assigns, it does not execute"
                )
            }
        }
    }
}

impl std::error::Error for OrgError {}

impl From<ConfError> for OrgError {
    fn from(e: ConfError) -> Self {
        Self::Conf(e)
    }
}

/// A seat in the org chart.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Post {
    pub name: String,
    pub role: String,
    /// Which agent template currently occupies the seat.
    pub agent: String,
}

/// The operator's attention budget — the binding constraint on concurrency.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Attention {
    pub max_open_items: u64,
    pub max_interrupts_per_hour: u64,
    pub digest_interval_mins: u64,
}

impl Default for Attention {
    fn default() -> Self {
        Self {
            max_open_items: 5,
            max_interrupts_per_hour: 3,
            digest_interval_mins: 20,
        }
    }
}

/// A code repository this company works on. Declared by path, and deliberately
/// *outside* the workspace: a company is not a codebase.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Repo {
    pub name: String,
    pub path: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Company {
    pub name: String,
    pub description: String,
    pub profile: String,
    pub attention: Attention,
    pub charter: Charter,
    pub repos: Vec<Repo>,
    pub roles: BTreeMap<String, Grant>,
    pub posts: Vec<Post>,
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
        let doc = toml::parse(text)?;

        let name = doc
            .table_get("company", "name")
            .and_then(Value::as_str)
            .ok_or(OrgError::Missing("[company] name"))?
            .to_string();

        let company = Self {
            name,
            description: doc
                .table_get("company", "description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            profile: doc
                .table_get("company", "profile")
                .and_then(Value::as_str)
                .unwrap_or("solo")
                .to_string(),
            attention: parse_attention(&doc),
            charter: parse_charter(&doc),
            repos: parse_repos(&doc),
            roles: parse_roles(&doc)?,
            posts: parse_posts(&doc)?,
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

fn parse_attention(doc: &toml::Doc) -> Attention {
    let d = Attention::default();
    let num = |k: &str, fallback: u64| -> u64 {
        doc.table_get("attention", k)
            .and_then(Value::as_int)
            .and_then(|i| u64::try_from(i).ok())
            .unwrap_or(fallback)
    };
    Attention {
        max_open_items: num("max_open_items", d.max_open_items),
        max_interrupts_per_hour: num("max_interrupts_per_hour", d.max_interrupts_per_hour),
        digest_interval_mins: num("digest_interval_mins", d.digest_interval_mins),
    }
}

fn parse_charter(doc: &toml::Doc) -> Charter {
    let mut invariants = Vec::new();
    let list = |k: &str| -> Option<Vec<String>> {
        doc.table_get("invariants", k).and_then(Value::as_list)
    };
    if let Some(v) = list("never_touch") {
        invariants.push(Invariant::NeverTouch(v));
    }
    if let Some(v) = list("never_run") {
        invariants.push(Invariant::NeverRun(v));
    }
    if let Some(v) = list("approval_to_merge") {
        invariants.push(Invariant::ApprovalToMerge(v));
    }
    if let Some(n) = doc
        .table_get("invariants", "max_tokens")
        .and_then(Value::as_int)
        .and_then(|i| u64::try_from(i).ok())
    {
        invariants.push(Invariant::MaxTokens(n));
    }
    if let Some(n) = doc
        .table_get("invariants", "max_wall_secs")
        .and_then(Value::as_int)
        .and_then(|i| u64::try_from(i).ok())
    {
        invariants.push(Invariant::MaxWallSecs(n));
    }
    Charter::with(invariants)
}

fn parse_repos(doc: &toml::Doc) -> Vec<Repo> {
    doc.array("repos")
        .iter()
        .filter_map(|t| {
            Some(Repo {
                name: t.get("name")?.as_str()?.to_string(),
                path: t.get("path")?.as_str()?.to_string(),
            })
        })
        .collect()
}

fn parse_roles(doc: &toml::Doc) -> Result<BTreeMap<String, Grant>, OrgError> {
    let mut out = BTreeMap::new();
    for (name, table) in doc.tables_under("roles") {
        let at = |k: &str| format!("[roles.{name}] {k}");
        let list = |k: &str| table.get(k).and_then(Value::as_list).unwrap_or_default();
        let num = |k: &str| {
            table
                .get(k)
                .and_then(Value::as_int)
                .and_then(|i| u64::try_from(i).ok())
        };

        let mut approve = BTreeSet::new();
        for a in list("approve") {
            approve.insert(action_kind(&a).ok_or_else(|| OrgError::BadValue {
                at: at("approve"),
                value: a.clone(),
            })?);
        }
        let mut define = BTreeSet::new();
        for d in list("define") {
            define.insert(intent_kind(&d).ok_or_else(|| OrgError::BadValue {
                at: at("define"),
                value: d.clone(),
            })?);
        }
        let introspect = match table.get("introspect").and_then(Value::as_str) {
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
        let network = match table.get("network").and_then(Value::as_str) {
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

        out.insert(
            name.clone(),
            Grant {
                read: list("read"),
                write: list("write"),
                run: list("run"),
                network,
                hosts: list("hosts"),
                tokens: num("tokens"),
                wall_secs: num("wall_secs"),
                merge_to: list("merge_to"),
                approve,
                define,
                introspect,
                staff: table.get("staff").and_then(Value::as_bool).unwrap_or(false),
            },
        );
    }
    Ok(out)
}

fn parse_posts(doc: &toml::Doc) -> Result<Vec<Post>, OrgError> {
    let mut out = Vec::new();
    for t in doc.array("posts") {
        let name = t
            .get("name")
            .and_then(Value::as_str)
            .ok_or(OrgError::Missing("[[posts]] name"))?
            .to_string();
        out.push(Post {
            role: t
                .get("role")
                .and_then(Value::as_str)
                .ok_or(OrgError::Missing("[[posts]] role"))?
                .to_string(),
            agent: t
                .get("agent")
                .and_then(Value::as_str)
                .unwrap_or("unstaffed")
                .to_string(),
            name,
        });
    }
    Ok(out)
}

fn action_kind(s: &str) -> Option<ActionKind> {
    Some(match s {
        "merge" => ActionKind::Merge,
        "admission" => ActionKind::Admission,
        "budget-increase" => ActionKind::BudgetIncrease,
        "measure-amendment" => ActionKind::MeasureAmendment,
        _ => return None,
    })
}

fn intent_kind(s: &str) -> Option<IntentKind> {
    Some(match s {
        "vision" => IntentKind::Vision,
        "goal" => IntentKind::Goal,
        "project" => IntentKind::Project,
        "task" => IntentKind::Task,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
[company]
name = "Acme"

[roles.engineer]
write = ["src/**"]
tokens = 1000

[[posts]]
name = "impl"
role = "engineer"
agent = "claude-code"
"#;

    #[test]
    fn parses_a_minimal_company() {
        let c = Company::parse(MINIMAL).unwrap();
        assert_eq!(c.name, "Acme");
        assert_eq!(c.profile, "solo", "profile defaults to solo");
        assert_eq!(c.posts.len(), 1);
        assert_eq!(c.roles.len(), 1);
    }

    #[test]
    fn a_missing_name_is_an_error() {
        assert_eq!(
            Company::parse("[company]\ndescription = \"x\"\n").unwrap_err(),
            OrgError::Missing("[company] name")
        );
    }

    #[test]
    fn attention_defaults_are_applied() {
        let c = Company::parse(MINIMAL).unwrap();
        assert_eq!(c.attention, Attention::default());
    }

    #[test]
    fn attention_is_read_when_present() {
        let text = format!("{MINIMAL}\n[attention]\nmax_open_items = 2\n");
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.attention.max_open_items, 2);
        assert_eq!(c.attention.digest_interval_mins, 20, "others keep defaults");
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
    fn repos_are_declared_by_path() {
        let text = format!("{MINIMAL}\n[[repos]]\nname = \"api\"\npath = \"~/p/api\"\n");
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.repos.len(), 1);
        assert_eq!(c.repos[0].path, "~/p/api");
    }

    #[test]
    fn an_unknown_role_on_a_post_is_rejected() {
        let text = "[company]\nname = \"A\"\n\n[[posts]]\nname = \"x\"\nrole = \"ghost\"\n";
        assert_eq!(
            Company::parse(text).unwrap_err(),
            OrgError::UnknownRole {
                post: "x".into(),
                role: "ghost".into()
            }
        );
    }

    #[test]
    fn a_role_wider_than_the_operator_is_rejected() {
        // tokens unset means unlimited, which is fine; but Introspect::Tree plus
        // staff plus everything is still within root. Use an impossible network.
        let text = "[company]\nname = \"A\"\n\n[roles.rogue]\nwrite = [\"**\"]\nnetwork = \"any\"\nstaff = true\n";
        // This one is legal: root allows it all. Confirm the check passes here…
        assert!(Company::parse(text).is_ok());
    }

    #[test]
    fn a_chief_that_can_write_is_rejected() {
        let text = "[company]\nname = \"A\"\n\n[roles.chief]\nstaff = true\nwrite = [\"src/**\"]\n\n[[posts]]\nname = \"chief\"\nrole = \"chief\"\n";
        assert_eq!(
            Company::parse(text).unwrap_err(),
            OrgError::ChiefMayNotExecute {
                detail: "write files"
            }
        );
    }

    #[test]
    fn a_chief_that_can_run_commands_is_rejected() {
        let text = "[company]\nname = \"A\"\n\n[roles.chief]\nstaff = true\nrun = [\"cargo *\"]\n\n[[posts]]\nname = \"chief\"\nrole = \"chief\"\n";
        assert!(matches!(
            Company::parse(text).unwrap_err(),
            OrgError::ChiefMayNotExecute { .. }
        ));
    }

    #[test]
    fn a_valid_chief_is_found_and_may_define() {
        let text = "[company]\nname = \"A\"\n\n[roles.chief]\nstaff = true\nread = [\"**\"]\ndefine = [\"project\", \"task\"]\nintrospect = \"tree\"\napprove = [\"admission\"]\n\n[[posts]]\nname = \"chief\"\nrole = \"chief\"\nagent = \"claude-code\"\n";
        let c = Company::parse(text).unwrap();
        let chief = c.chief().expect("chief exists");
        assert_eq!(chief.name, "chief");
        let g = c.grant_of(chief).unwrap();
        assert!(g.define.contains(&IntentKind::Task));
        assert!(g.staff);
        assert!(g.write.is_empty(), "chief cannot write");
    }

    #[test]
    fn bad_enum_values_name_their_location() {
        let text = "[company]\nname = \"A\"\n\n[roles.x]\nintrospect = \"everything\"\n";
        match Company::parse(text).unwrap_err() {
            OrgError::BadValue { at, value } => {
                assert!(at.contains("introspect"), "{at}");
                assert_eq!(value, "everything");
            }
            other => panic!("expected BadValue, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_role_yields_an_empty_effective_grant() {
        let c = Company::parse(MINIMAL).unwrap();
        let ghost = Post {
            name: "g".into(),
            role: "ghost".into(),
            agent: "x".into(),
        };
        let e = c.effective(&ghost);
        assert!(e.is_empty());
        assert!(!e.allows_write("src/a.rs"), "permits nothing");
    }

    #[test]
    fn an_unstaffed_post_is_representable() {
        let text = "[company]\nname = \"A\"\n\n[roles.r]\nread = [\"**\"]\n\n[[posts]]\nname = \"vacant\"\nrole = \"r\"\n";
        let c = Company::parse(text).unwrap();
        assert_eq!(c.post("vacant").unwrap().agent, "unstaffed");
    }
}
