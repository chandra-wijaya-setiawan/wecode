//! The organisation workspace: one self-contained directory per company.
//!
//! A company holds its profile, roles, posts, agent templates and state together.
//! It is deliberately *not* a code repository — the repos it works on are declared
//! by path and live elsewhere, so a post's working directory can never reach the
//! files that define its own authority.

pub mod company;
pub mod template;
pub mod workspace;

pub use company::{AgentTemplate, Attention, Company, OrgError, Post, Repo, Templates, User};
pub use template::Template;
pub use workspace::{Workspace, WorkspaceError, expand_home, init, resolve};
