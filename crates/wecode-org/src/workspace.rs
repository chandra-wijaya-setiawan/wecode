//! Locating and creating a company workspace.
//!
//! Discovery walks up from the working directory looking for `company.toml`, the
//! way git and cargo do, so `cd`-ing into a company is enough.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::company::{Company, OrgError};
use crate::template;

pub const MARKER: &str = "company.toml";

#[derive(Debug)]
pub enum WorkspaceError {
    NotFound,
    Io(io::Error),
    Org(OrgError),
    AlreadyInitialised(PathBuf),
    UnknownTemplate {
        name: String,
        available: Vec<String>,
    },
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => write!(
                f,
                "no company workspace found\n\
                 \x20 pass --org <dir>, run `wecode use <dir>` to set a default,\n\
                 \x20 or `wecode init <dir>` to make one"
            ),
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Org(e) => write!(f, "{e}"),
            Self::AlreadyInitialised(p) => {
                write!(f, "{} already exists", p.display())
            }
            Self::UnknownTemplate { name, available } => write!(
                f,
                "unknown template `{name}` — available: {}",
                available.join(", ")
            ),
        }
    }
}

impl std::error::Error for WorkspaceError {}

impl From<io::Error> for WorkspaceError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<OrgError> for WorkspaceError {
    fn from(e: OrgError) -> Self {
        Self::Org(e)
    }
}

/// A company directory: config, agent templates, and state, all in one place.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    #[must_use]
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn company_path(&self) -> PathBuf {
        self.root.join(MARKER)
    }

    /// Append-only logs. Inside the workspace, which is safe precisely because a
    /// workspace is not a code repo and no post ever runs here.
    #[must_use]
    pub fn state_dir(&self) -> PathBuf {
        self.root.join("state")
    }

    #[must_use]
    pub fn agents_dir(&self) -> PathBuf {
        self.root.join("agents")
    }

    #[must_use]
    pub fn templates_dir(&self) -> PathBuf {
        self.root.join("templates")
    }

    #[must_use]
    pub fn exists(&self) -> bool {
        self.company_path().is_file()
    }

    /// Loads and validates the profile.
    pub fn load(&self) -> Result<Company, WorkspaceError> {
        let text = fs::read_to_string(self.company_path())?;
        Ok(Company::parse(&text)?)
    }

    /// Agent template names present on disk.
    pub fn agents(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.agents_dir()) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|e| {
                let p = e.path();
                if p.extension().and_then(|s| s.to_str()) == Some("toml") {
                    p.file_stem()?.to_str().map(str::to_string)
                } else {
                    None
                }
            })
            .collect();
        names.sort();
        names
    }
}

/// Walks up from `start` looking for the marker file.
#[must_use]
pub fn find(start: &Path) -> Option<Workspace> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let ws = Workspace::at(d);
        if ws.exists() {
            return Some(ws);
        }
        dir = d.parent();
    }
    None
}

/// Where the chosen default workspace is remembered.
///
/// `$WECODE_CONFIG` overrides the location. That exists so tests cannot clobber a
/// real default — which they did, once, before this was configurable.
#[must_use]
pub fn default_marker() -> PathBuf {
    match std::env::var("WECODE_CONFIG") {
        Ok(dir) => expand_home(&dir).join("current"),
        Err(_) => expand_home("~/.wecode/current"),
    }
}

/// Reads the remembered default, if it still exists.
#[must_use]
pub fn default_workspace() -> Option<Workspace> {
    let path = fs::read_to_string(default_marker()).ok()?;
    let ws = Workspace::at(expand_home(path.trim()));
    ws.exists().then_some(ws)
}

/// Remembers a workspace as the default for commands run outside one.
pub fn set_default(ws: &Workspace) -> Result<(), WorkspaceError> {
    let marker = default_marker();
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(marker, format!("{}\n", ws.root().display()))?;
    Ok(())
}

/// Resolves a workspace: explicit path, then `WECODE_ORG`, then an upward walk,
/// then the remembered default.
///
/// The upward walk beats the default deliberately — standing inside a company
/// should mean that company, whatever was last chosen globally.
pub fn resolve(explicit: Option<&str>) -> Result<Workspace, WorkspaceError> {
    if let Some(p) = explicit {
        let ws = Workspace::at(expand_home(p));
        return if ws.exists() {
            Ok(ws)
        } else {
            Err(WorkspaceError::NotFound)
        };
    }
    if let Ok(p) = std::env::var("WECODE_ORG") {
        let ws = Workspace::at(expand_home(&p));
        return if ws.exists() {
            Ok(ws)
        } else {
            Err(WorkspaceError::NotFound)
        };
    }
    let cwd = std::env::current_dir()?;
    find(&cwd)
        .or_else(default_workspace)
        .ok_or(WorkspaceError::NotFound)
}

/// Expands a leading `~/`.
#[must_use]
pub fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return Path::new(&home).join(rest);
        }
    }
    PathBuf::from(p)
}

/// Scaffolds a new workspace. Refuses to overwrite an existing one.
pub fn init(root: impl Into<PathBuf>, template_name: &str) -> Result<Vec<PathBuf>, WorkspaceError> {
    let ws = Workspace::at(root);
    if ws.exists() {
        return Err(WorkspaceError::AlreadyInitialised(ws.company_path()));
    }
    let tpl = template::find(template_name).ok_or_else(|| WorkspaceError::UnknownTemplate {
        name: template_name.to_string(),
        available: template::all().iter().map(|t| t.name.to_string()).collect(),
    })?;

    let mut written = Vec::new();
    for (rel, contents) in tpl.files {
        let path = ws.root().join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, contents)?;
        written.push(path);
    }
    fs::create_dir_all(ws.state_dir())?;

    // Fail loudly here rather than at first use if a template ever regresses.
    ws.load()?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        let dir = Path::new(&base).join(format!("wecode-ws-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn init_creates_a_loadable_workspace() {
        let root = temp("init");
        let written = init(&root, "software-company").unwrap();
        assert!(!written.is_empty());

        let ws = Workspace::at(&root);
        assert!(ws.exists());
        assert!(ws.state_dir().is_dir());

        let c = ws.load().unwrap();
        assert_eq!(c.name, "Example Software Co");
        assert!(c.chief().is_some());
        assert_eq!(c.posts.len(), 4);
    }

    #[test]
    fn init_writes_agent_templates_for_every_post() {
        let root = temp("agents");
        init(&root, "software-company").unwrap();
        let ws = Workspace::at(&root);
        let agents = ws.agents();
        assert!(agents.contains(&"claude-code".to_string()), "{agents:?}");
        assert!(agents.contains(&"codex".to_string()), "{agents:?}");
    }

    #[test]
    fn init_refuses_to_overwrite() {
        let root = temp("twice");
        init(&root, "solo").unwrap();
        assert!(matches!(
            init(&root, "solo").unwrap_err(),
            WorkspaceError::AlreadyInitialised(_)
        ));
    }

    #[test]
    fn init_rejects_an_unknown_template_and_lists_the_real_ones() {
        let root = temp("badtpl");
        match init(&root, "startup").unwrap_err() {
            WorkspaceError::UnknownTemplate { available, .. } => {
                assert!(available.contains(&"solo".to_string()), "{available:?}");
            }
            other => panic!("expected UnknownTemplate, got {other:?}"),
        }
    }

    #[test]
    fn find_walks_up_from_a_subdirectory() {
        let root = temp("walkup");
        init(&root, "solo").unwrap();
        let nested = root.join("a/b/c");
        fs::create_dir_all(&nested).unwrap();

        let found = find(&nested).expect("walks up to the marker");
        assert_eq!(found.root(), root.as_path());
    }

    #[test]
    fn find_returns_none_outside_any_workspace() {
        let root = temp("nowhere");
        fs::create_dir_all(&root).unwrap();
        assert!(find(&root).is_none());
    }

    #[test]
    fn resolve_prefers_an_explicit_path() {
        let root = temp("explicit");
        init(&root, "solo").unwrap();
        let ws = resolve(Some(root.to_str().unwrap())).unwrap();
        assert_eq!(ws.root(), root.as_path());
    }

    #[test]
    fn resolve_rejects_an_explicit_path_that_is_not_a_workspace() {
        assert!(matches!(
            resolve(Some("/definitely/not/here")).unwrap_err(),
            WorkspaceError::NotFound
        ));
    }

    #[test]
    fn not_found_error_says_what_to_do() {
        let msg = WorkspaceError::NotFound.to_string();
        assert!(msg.contains("--org"), "{msg}");
        assert!(msg.contains("wecode init"), "{msg}");
    }

    #[test]
    fn agents_is_empty_when_the_directory_is_missing() {
        let root = temp("noagents");
        fs::create_dir_all(&root).unwrap();
        assert!(Workspace::at(&root).agents().is_empty());
    }
}
