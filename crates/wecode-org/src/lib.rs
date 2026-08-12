//! The organisation: the company workspace, and the playbooks its projects carry.
//!
//! Two kinds of hand-edited config live here. `company.toml` describes the company
//! and sits in the workspace; a playbook describes one project and sits in that
//! project's own repository, versioned with the code it describes.
//!
//! A company holds its profile, roles, posts, agent templates and state together.
//! It is deliberately *not* a code repository — the repos it works on are declared
//! by path and live elsewhere, so a post's working directory can never reach the
//! files that define its own authority.

pub mod company;
pub mod playbook;
pub mod template;
pub mod workspace;

pub use company::{AgentTemplate, Attention, Company, OrgError, Post, Repo, Templates, User};
pub use playbook::{KindPlaybook, MergePolicy, Playbook, PlaybookError};
pub use template::Template;
pub use workspace::{Workspace, WorkspaceError, expand_home, init, resolve};
