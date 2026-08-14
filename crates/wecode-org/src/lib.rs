//! The organisation: the company workspace, and the playbooks its projects carry.
//!
//! Two kinds of hand-edited config live here. `company.toml` describes the company
//! and sits in the workspace; a playbook describes one project and sits in that
//! project's own repository, versioned with the code it describes.
//!
//! Beside them sits one file neither is: `gaps.toml`, where a planner records what a
//! playbook did not say. It is appended by machine and emptied by hand, and it is
//! guidance's inbox rather than guidance — see [`gap`].
//!
//! One module here is neither config nor a reader of it: [`toolchain`] is the table a
//! starter playbook is written from — real acceptance commands, the build cache a
//! language's worktrees can share, the files its builds rewrite. It is read once, while
//! a file is being scaffolded, and never again; what it produces is hand-edited from
//! there like everything else in this crate.
//!
//! A company holds its profile, roles, posts, agent templates and state together.
//! It is deliberately *not* a code repository — the repos it works on are declared
//! by path and live elsewhere, so a post's working directory can never reach the
//! files that define its own authority.

pub mod company;
pub mod gap;
pub mod playbook;
pub mod template;
pub mod toolchain;
pub mod workspace;

pub use company::{
    AgentTemplate, Attention, Company, Notify, OrgError, Post, Repo, Telegram, Templates, User,
};
pub use gap::{Gap, GapError};
pub use playbook::{
    CacheDir, DispatchPolicy, KindPlaybook, MergePolicy, Playbook, PlaybookError, Subtask,
    SubtaskTemplate, Written,
};
pub use template::Template;
pub use toolchain::Toolchain;
pub use workspace::{Workspace, WorkspaceError, expand_home, init, resolve};
