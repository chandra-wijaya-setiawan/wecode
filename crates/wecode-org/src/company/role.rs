//! `[roles.*]`: what a seat may do, as a [`Grant`].
//!
//! The block a diff is read for. Every other part of `company.toml` names things or
//! bounds them; this one is enforced capability, so a widened glob here is the change
//! a reviewer must be able to see on one line — which is the whole reason authority is
//! configuration rather than a row in the database.
//!
//! Two things are refused at load. A role wider than the operator's own grant cannot
//! be narrowed into by anything, and a chief that can also write or run can satisfy
//! its own criteria.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use wecode_gov::{ActionKind, Effective, Grant, Introspect, Network, WorkKind};

use super::{Company, OrgError, Post};

/// A role as written in the file. Converted to a [`Grant`].
#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct RoleBlock {
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

impl Company {
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
}

/// Every role in the file, converted and keyed by name.
pub(super) fn grants_of(
    blocks: &BTreeMap<String, RoleBlock>,
) -> Result<BTreeMap<String, Grant>, OrgError> {
    let mut roles = BTreeMap::new();
    for (name, block) in blocks {
        roles.insert(name.clone(), grant_of(name, block)?);
    }
    Ok(roles)
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

/// That no role reaches past the operator, and that the one which staffs cannot work.
pub(super) fn check(c: &Company) -> Result<(), OrgError> {
    let root = Grant::root();
    for (name, grant) in &c.roles {
        if !grant.narrows(&root) {
            return Err(OrgError::Escalation { role: name.clone() });
        }
    }
    // The chief holds Define and Staff, which is exactly why it must not also
    // hold write or run: an agent that can both set the criteria and do the
    // work can satisfy itself.
    if let Some(chief) = c.chief()
        && let Some(g) = c.grant_of(chief)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::MINIMAL;

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
