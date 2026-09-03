//! `[[repos]]`, `[[posts]]` and `[[users]]`: what exists, and who is in it.
//!
//! The three lists that name things rather than bound them. A post is a seat and
//! carries no authority of its own — that is on the role it names, which is why a post
//! and its role are separate lines — and a user is accountability rather than power.
//! Repos sit here for the same reason people do: they are declared, by path, and a
//! company is not a codebase.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::{Company, OrgError, agent::Intelligence};

/// A code repository this company works on. Declared by path, and deliberately
/// outside the workspace: a company is not a codebase.
#[derive(Clone, PartialEq, Eq, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Repo {
    pub name: String,
    pub path: String,
    /// Where to put the executable this repository produces, once a merge lands on its
    /// integration branch. Absent means nothing is installed, silently.
    ///
    /// Naming a destination *is* the opt-in; a boolean beside it would be a second place
    /// for the same answer to live. It sits here rather than in the repository's own
    /// playbook because a playbook is committed **inside** the repo being merged, so a
    /// field there would let any repository grant itself the right to write to the
    /// operator's machine by committing one line to itself. `company.toml` is
    /// hand-edited, outside every repo, by the person whose home directory this is — the
    /// only file that can carry an authority to write outside a repository, because it
    /// is the only one an agent cannot reach.
    #[serde(default)]
    pub installs: Option<String>,
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

    /// Everyone who can answer from a chat, in the order the file names them.
    ///
    /// The other direction of [`Self::user_by_telegram`], and it answers a question
    /// that one cannot: *is there anybody at all*. A workspace that reads the channel
    /// and gives no account an entry here resolves every reply to nobody — which is
    /// correct, deliberate, and completely silent, since the refusal is printed on the
    /// machine the operator is not at. Something has to be able to ask before that
    /// arrangement is depended on.
    #[must_use]
    pub fn telegram_users(&self) -> Vec<&User> {
        self.users.iter().filter(|u| u.telegram.is_some()).collect()
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
}

/// That every name one of these lists gives resolves to something the file defines.
///
/// All five failures are typos, and all five would otherwise surface at dispatch: two
/// repositories under one name, a seat with no role, a seat naming a harness that has
/// no block, a person in a seat that does not exist, and two people behind one chat
/// account.
pub(super) fn check(c: &Company) -> Result<(), OrgError> {
    // A name is what a project owns a repository by, and [`Company::repo`] answers with
    // the first block that carries it. So a duplicate is not a tidiness problem: the
    // second path is configured and unreachable, the work lands in whichever worktree
    // was typed first, and [`Company::repo_names`] offers the same name twice to the
    // admission check that a project names a real one.
    let mut paths: BTreeMap<&str, &str> = BTreeMap::new();
    for repo in &c.repos {
        if let Some(first) = paths.insert(&repo.name, &repo.path) {
            return Err(OrgError::RepoClash {
                name: repo.name.clone(),
                paths: (first.to_string(), repo.path.clone()),
            });
        }
    }
    for post in &c.posts {
        if !c.roles.contains_key(&post.role) {
            return Err(OrgError::UnknownRole {
                post: post.name.clone(),
                role: post.role.clone(),
            });
        }
        // An unstaffed seat is legal; a seat naming an agent that has no
        // template is a typo that would only surface at dispatch.
        if post.agent != "unstaffed" && !c.agents.contains_key(&post.agent) {
            return Err(OrgError::UnknownAgent {
                post: post.name.clone(),
                agent: post.agent.clone(),
            });
        }
    }
    let mut chat: BTreeMap<&str, &str> = BTreeMap::new();
    for user in &c.users {
        if c.post(&user.post).is_none() {
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::MINIMAL;

    #[test]
    fn repos_are_declared_by_path_and_listed_by_name() {
        let text =
            format!("{MINIMAL}\n[[repos]]\nname = \"wecode\"\npath = \"~/projects/wecode\"\n");
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.repo_names(), vec!["wecode".to_string()]);
        assert_eq!(c.repo("wecode").unwrap().path, "~/projects/wecode");
        assert!(c.repo("ghost").is_none());
        // Nothing is installed until a destination says where, and that is what makes
        // the absent field an answer rather than an omission.
        assert!(c.repo("wecode").unwrap().installs.is_none());
    }

    #[test]
    fn a_repo_may_name_where_its_executable_is_installed() {
        // The opt-in for installing after a merge, and it lives here rather than in the
        // repository's own playbook: a playbook is committed inside the repo being
        // merged, so a field there would let a repository grant itself the right to
        // write to the operator's machine.
        let text = format!(
            "{MINIMAL}\n[[repos]]\nname = \"wecode\"\npath = \"~/projects/wecode\"\n\
             installs = \"~/.local/bin/wecode\"\n"
        );
        let c = Company::parse(&text).unwrap();
        assert_eq!(
            c.repo("wecode").unwrap().installs.as_deref(),
            Some("~/.local/bin/wecode")
        );
    }

    #[test]
    fn two_repos_may_not_share_one_name() {
        // The name is the whole handle: a project owns a repository by it, and `repo`
        // answers with the first block that matches. Shared, the second path is
        // configured and never reached, and the work goes to the wrong tree in silence.
        let text = format!(
            "{MINIMAL}\n[[repos]]\nname = \"app\"\npath = \"~/projects/app\"\n\
             [[repos]]\nname = \"app\"\npath = \"~/work/app\"\n"
        );
        match Company::parse(&text).unwrap_err() {
            OrgError::RepoClash { name, paths } => {
                assert_eq!(name, "app");
                assert_eq!(
                    paths,
                    ("~/projects/app".to_string(), "~/work/app".to_string())
                );
            }
            other => panic!("expected RepoClash, got {other}"),
        }
        // Two names over one path is not the same fault. A repository checked out twice,
        // or two names for one monorepo, resolves unambiguously in the direction that
        // matters, and nothing here is the file's business.
        let text = format!(
            "{MINIMAL}\n[[repos]]\nname = \"app\"\npath = \"~/projects/app\"\n\
             [[repos]]\nname = \"web\"\npath = \"~/projects/app\"\n"
        );
        assert_eq!(Company::parse(&text).unwrap().repo_names().len(), 2);
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
        assert_eq!(c.telegram_users().len(), 1);
        assert_eq!(c.users_of("impl").len(), 1);
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
}
