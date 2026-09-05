//! `project add` — the objective, the repository, and what will judge the work.
//!
//! One spelling, and the only path that creates a project, which is why both gates sit
//! here rather than at dispatch: the authority check that says who may define work at
//! all, and the admission check that asks whether this definition can be answered. A
//! project that names no measure is printed back with the question it left open instead
//! of being saved, which is a cheaper conversation now than at merge.
//!
//! …and, with `--amend`, the one field of that declaration that can be re-declared
//! afterwards: the repository. It reads as one command because it is one — the gates
//! above are the gates below, asked of the project as it would be — and it is spelled
//! as an amendment of the command that made the project for [`amend`]'s reason, which
//! is sharper a level up: defining the project again under another id abandons its
//! tasks, their spend, their refusals and the obligations they answer to, all of which
//! key on the project that holds them.
//!
//! [`amend`]: super::amend
//!
//! …and one thing every other module here asks of a project rather than of a task:
//! [`refuses`], the paths its playbook says no task of its own may write. It reads like a
//! task check and is a project's statement, made once, about work nobody has declared yet
//! — so it is answered beside the command that declares a project, and through one
//! function, the shape [`ctx::design_gate`] already has. A refusal each site resolved for
//! itself would be a refusal each site could resolve differently.
//!
//! [`ctx::design_gate`]: crate::commands::ctx::design_gate

use wecode_core::{Admission, Defect, Measure, Plan, Project, ProjectId, Task, admission};
use wecode_gov::{Action, WorkKind};
use wecode_org::Company;

use super::{budget_from, parse_metric};
use crate::args::Args;
use crate::commands::ctx::*;
use crate::{git, render, work};

/// What a task's project refuses, as defects against the scope it declares.
///
/// A playbook that cannot be read refuses nothing, for the reason `design_gate` gates
/// nothing: an unregistered repo is already reported as its own defect, and a read-only
/// verdict must not fail on it. A task naming a project the plan does not hold refuses
/// nothing either: the guidance is a file in that project's repository, and until there is
/// a project there is nothing that names one.
pub(super) fn refuses(company: &Company, plan: &Plan, t: &Task) -> Vec<Defect> {
    let stated = plan
        .project(&t.project)
        .and_then(|p| playbook_of(company, p).ok().flatten())
        .map(|pb| pb.project.refuses)
        .unwrap_or_default();
    admission::check_refusals(t, &stated)
}

pub(crate) fn project_add(a: &Args) -> Res {
    if a.has("amend") {
        return set_repo(a);
    }
    let (store, company) = open(a)?;
    let id = require(a.cmd(2), "project id")?;
    let repo = require(a.get("repo").unwrap_or(""), "--repo <name>")?;
    let objective = require(a.cmd(3), "objective")?;

    let mut p = Project::new(ProjectId::new(id), objective, repo);
    for cmd in a.all("measure-cmd") {
        p = p.measured(Measure::Command {
            cmd: cmd.to_string(),
            expect_status: 0,
        });
    }
    for spec in a.all("measure-metric") {
        p = p.measured(parse_metric(spec, "--measure-metric")?);
    }
    if let Some(b) = budget_from(a) {
        p = p.budgeted(b);
    }

    // A post may never define the work it will be judged by. This is the only path
    // that creates a project, so the check belongs here.
    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(p.id.to_string()), None),
        &Action::Define {
            kind: WorkKind::Project,
        },
        "defining a project",
    )?;

    let plan = store.load_plan()?;
    let defects = admission::check_project(&p, &plan, &repo_names(&company));
    let verdict = Admission::decide(defects.clone(), "operator", Vec::new());
    let mut out = render::plan::admission(&render::plan::project_heading(&p), &defects, Some(&verdict));

    if defects.is_empty() || a.has("force") {
        let mut probe = plan;
        probe.add_project(p.clone())?;
        store.save_project(&p)?;
        if a.has("force") && !defects.is_empty() {
            out.push_str("\n  forced — defects recorded as waivers\n");
        }
        out.push_str(&format!(
            "\n  saved project {}\n  next: wecode task add <id> --project {} \"<title>\"\n",
            p.id, p.id
        ));
    } else {
        out.push_str("\n  not saved — answer the above, or pass --force\n");
    }
    Ok(out)
}

// ---------------------------------------------------- moving the project ------

/// What a declaration carries that an amendment does not touch.
///
/// Listed so they are refused rather than dropped. `--tokens` on an amendment is an
/// operator saying two things at once, and the half that goes unheard is the one they
/// would only discover from a later run being cut short.
const DECLARED_ONCE: &[&str] = &["measure-cmd", "measure-metric", "tokens", "wall"];

/// `project add <id> --repo <name> --amend` — the repository, re-declared.
///
/// One field, and deliberately not the objective. A project pursuing something else is
/// another project; a project whose repository was named wrongly — misspelled, split in
/// two, registered under a name that changed — is this one, working somewhere else.
///
/// Recorded as a `define`, the capability that created it, on [`super::amend`]'s rule
/// and for a stronger reading of it: the repository decides where every task in the
/// project is confined, what its scope globs are measured against and which playbook
/// judges it, so a signature given while the project sat on one repo said nothing about
/// the same project sitting on another.
fn set_repo(a: &Args) -> Res {
    let (ws, store, company) = open_full(a)?;
    let typed = require(a.cmd(2), "project id")?;
    let repo = require(a.get("repo").unwrap_or(""), "--repo <name>")?;
    if let Some(f) = DECLARED_ONCE.iter().find(|f| a.has(f)) {
        return Err(format!(
            "--{f} is not amendable: `project add --amend` re-declares the repository and \
             nothing else\n  \
             what a project is trying to achieve, and what will judge it, are what makes it \
             that project"
        )
        .into());
    }

    let plan = store.load_plan()?;
    let p = the_project(&plan, typed)?.clone();
    let was = p.repo.clone();
    if was == repo {
        // Not an error. Repointing at where it already is is a command that has nothing
        // to do, which is worth saying rather than reporting a move that never happened.
        return Ok(format!("  {} already works in {was}\n", p.id));
    }

    // A worktree is cut in the repository the project named, and everything a run has
    // not merged yet is on a branch there. Moving the project out from under one leaves
    // a tree that `verify`, `merge` and teardown will look for in the wrong repository —
    // the same fact `task add --amend` refuses a re-parenting over, one level up.
    let standing = standing_in(&company, &plan, &p, &work::org_name(ws.root()));
    if !standing.is_empty() {
        return Err(format!(
            "moving {} would leave worktrees standing in {was}: {}\n  \
             a tree is cut in the repository the project names, and what is in it has not \
             landed anywhere else\n{}",
            p.id,
            standing.join(", "),
            standing
                .iter()
                .map(|t| format!("  `wecode worktree remove {t}` first, or merge it"))
                .collect::<Vec<_>>()
                .join("\n")
        )
        .into());
    }

    let who = actor(a, &store, &company)?;
    require_allowed(
        &store,
        &company,
        &who,
        (Some(p.id.to_string()), None),
        &Action::Define {
            kind: WorkKind::Project,
        },
        "repointing a project at another repository",
    )?;

    // The same verdict the declaration faced, asked of the project as it would be. What
    // holds it back is only what the new repo is the cause of: a name the company does
    // not register, and a repo another live project already holds. Everything else it
    // reports is a defect the project was already carrying, and settling a repository
    // does not answer a missing measure.
    let mut now = p.clone();
    now.repo = repo.to_string();
    let defects = admission::check_project(&now, &plan, &repo_names(&company));
    let blocking = defects.iter().any(|d| {
        matches!(
            d,
            Defect::RepoMissing | Defect::RepoUnknown { .. } | Defect::RepoAlreadyHasProject { .. }
        )
    });
    if blocking && !a.has("force") {
        let mut out = render::plan::admission(&render::plan::project_heading(&now), &defects, None);
        out.push_str("\n  not moved — register the repo in company.toml, or pass --force\n");
        return Ok(out);
    }

    // A whole save rather than one column, because the store has no narrower write for a
    // project — and it is safe here for the reason it is not on a task: `now` is the
    // project as the plan holds it with one field replaced, so every column it rewrites
    // it rewrites with what was already there.
    store.save_project(&now)?;

    let mut out = format!("  {} works in\n    was  {was}\n    now  {repo}\n", p.id);
    if plan.tasks_of(&p.id).next().is_some() {
        out.push_str(&format!(
            "\n  Nothing moved with it — what earlier tasks merged is on {was}, and their \
             `wecode/<task>` branches are still cut there\n"
        ));
    }
    out.push_str(&format!(
        "  The guidance it is held to is now {repo}'s — `wecode playbook --project {}`\n\
         \n  When it moved is in the ledger — `wecode audit --project {}`\n",
        p.id, p.id
    ));
    if !defects.is_empty() {
        out.push('\n');
        out.push_str(&render::plan::admission(
            &render::plan::project_heading(&now),
            &defects,
            None,
        ));
    }
    Ok(out)
}

/// The tasks of this project whose worktrees are still standing in the repository it
/// is being moved out of, by id.
///
/// Asked of git rather than of the status column, because those are different questions
/// and this one is the one that matters: a task marked `failed` whose tree nobody took
/// down still has its work in that repository, and a task marked `running` in a checkout
/// somebody already removed has nothing left there to strand.
///
/// A repository that cannot be resolved or read strands nothing, on [`refuses`]'s rule
/// and for its reason: an unregistered repo is already reported as its own defect, and
/// repointing away from one is exactly what an operator holding it needs to do.
fn standing_in(company: &Company, plan: &Plan, p: &Project, org: &str) -> Vec<String> {
    let Ok(repo) = repo_path(company, p) else {
        return Vec::new();
    };
    if !git::is_repo(&repo) {
        return Vec::new();
    }
    let listed = git::worktree_list(&repo).unwrap_or_default();
    // The computed path, which is how `wecode worktree` places a tree against a task.
    let mut out: Vec<String> = plan
        .tasks_of(&p.id)
        .filter(|t| {
            let path = work::worktree_for(org, &t.id);
            listed.iter().any(|l| *l == path.to_string_lossy())
        })
        .map(|t| t.id.to_string())
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use wecode_core::{Budget, ProjectStatus};
    use wecode_store::Store;

    use super::*;

    fn parse(s: &[&str]) -> Args {
        Args::parse(s.iter().map(|x| (*x).to_string()))
    }

    /// A scaffolded workspace holding `caching` on `app`, with `api` registered beside
    /// it — the whole of this command is moving between two repositories, and the
    /// starter has no reason to carry a second one.
    ///
    /// Each test gets its own directory, as the filing tests do and for their reason:
    /// they run in parallel, and a shared database file means one wipes another's state
    /// mid-write. Both repo paths are inside that directory and neither is a git
    /// repository, so the standing-worktree guard has nothing to read and says so.
    fn org(name: &str) -> (String, Store) {
        let dir = tmp(&format!("wecode-project-{name}"));
        let _ = fs::remove_dir_all(&dir);
        wecode_org::workspace::init(&dir, "solo").expect("scaffold");

        let toml = dir.join("company.toml");
        let here = dir.display();
        let text = fs::read_to_string(&toml)
            .unwrap()
            .replace("~/projects/your-repo", &format!("{here}/app"))
            + &format!("\n[[repos]]\nname = \"api\"\npath = \"{here}/api\"\n");
        fs::write(&toml, text).unwrap();

        let store = Store::open(dir.join("wecode.db")).expect("store");
        let mut project = Project::new("caching", "cut export p99 below 500ms", "app")
            .measured(Measure::Command {
                cmd: "cargo test".into(),
                expect_status: 0,
            })
            .budgeted(Budget {
                tokens: Some(200_000),
                wall_secs: Some(1800),
            });
        project.status = ProjectStatus::Active;
        store.save_project(&project).unwrap();
        store
            .save_task(&Task::new("layer", "caching", "write the cache layer"))
            .unwrap();
        (dir.to_string_lossy().into_owned(), store)
    }

    fn tmp(name: &str) -> PathBuf {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
        Path::new(&base).join(name)
    }

    /// `wecode project add <id> --repo <name> --amend` against that workspace.
    fn amend(dir: &str, id: &str, repo: &str, force: bool) -> Res {
        let mut argv = vec![
            "project", "add", id, "--repo", repo, "--amend", "--org", dir, "--as", "operator",
        ];
        if force {
            argv.push("--force");
        }
        project_add(&parse(&argv))
    }

    #[test]
    fn the_repository_moves_and_nothing_else_does() {
        // The whole reason this is not `project add` under a new id: everything already
        // filed under this project has to come with it.
        let (dir, store) = org("moves");
        let before = store.load_plan().unwrap();
        let was = before.project(&"caching".into()).unwrap().clone();

        let out = amend(&dir, "caching", "api", false).unwrap();
        assert!(out.contains("was  app"), "{out}");
        assert!(out.contains("now  api"), "{out}");

        let plan = store.load_plan().unwrap();
        let now = plan.project(&"caching".into()).unwrap();
        assert_eq!(now.repo, "api");
        assert_eq!(now.objective, was.objective);
        assert_eq!(now.status, ProjectStatus::Active, "status untouched");
        assert_eq!(now.budget, was.budget);
        assert_eq!(now.measures, was.measures, "what judges it is unchanged");
        assert_eq!(now.number, was.number, "not renumbered");
        assert!(plan.task(&"layer".into()).is_some(), "its work came with it");
    }

    #[test]
    fn a_repo_the_company_does_not_register_is_refused() {
        // The defect the declaration faced, asked again: a project on a repo nothing
        // knows about cannot be started, and finding that out here is free.
        let (dir, store) = org("unknown");
        let out = amend(&dir, "caching", "nowhere", false).unwrap();
        assert!(out.contains("not moved"), "{out}");
        assert!(out.contains("nowhere"), "it names what was typed: {out}");
        assert_eq!(
            store
                .load_plan()
                .unwrap()
                .project(&"caching".into())
                .unwrap()
                .repo,
            "app",
            "nothing was written"
        );

        let out = amend(&dir, "caching", "nowhere", true).unwrap();
        assert!(out.contains("now  nowhere"), "{out}");
    }

    #[test]
    fn repointing_at_the_repo_it_already_works_in_says_so() {
        let (dir, _store) = org("already");
        let out = amend(&dir, "caching", "app", false).unwrap();
        assert!(out.contains("already works in app"), "{out}");
    }

    #[test]
    fn an_amendment_names_a_project_that_exists() {
        // An amendment is about work that is there, so a mistyped id is answered rather
        // than quietly creating something.
        let (dir, _store) = org("ghost");
        let err = amend(&dir, "ghost", "api", false)
            .expect_err("no such project")
            .to_string();
        assert!(err.contains("no such project"), "{err}");
    }

    #[test]
    fn a_flag_an_amendment_cannot_honour_is_refused_rather_than_dropped() {
        // The failure this guards against is silent: the repo moves, the budget does
        // not, and the operator hears about it from a run that stops early.
        let (dir, store) = org("declared-once");
        let argv = [
            "project", "add", "caching", "--repo", "api", "--amend", "--tokens", "400000",
            "--org", &dir, "--as", "operator",
        ];
        let err = project_add(&parse(&argv))
            .expect_err("not amendable")
            .to_string();
        assert!(err.contains("not amendable"), "{err}");
        assert_eq!(
            store
                .load_plan()
                .unwrap()
                .project(&"caching".into())
                .unwrap()
                .repo,
            "app",
            "the whole command was refused, not half of it"
        );
    }

    #[test]
    fn a_worktree_still_standing_holds_the_project_where_it_is() {
        // The load-bearing guard. A tree is cut in the repository the project names and
        // what is in it has landed nowhere else, so moving the project would leave it
        // where `verify`, `merge` and teardown will not look for it.
        let (dir, store) = org("standing");
        let repo = Path::new(&dir).join("app");
        fs::create_dir_all(&repo).unwrap();
        for argv in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            Command::new("git").args(&argv).current_dir(&repo).status().unwrap();
        }
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        for argv in [vec!["add", "."], vec!["commit", "-qm", "first"]] {
            Command::new("git").args(&argv).current_dir(&repo).status().unwrap();
        }

        // At the path `wecode start` would have put it, since that is how a tree is
        // placed against a task.
        let org_name = work::org_name(Path::new(&dir));
        let tree = work::worktree_for(&org_name, &"layer".into());
        let _ = fs::remove_dir_all(&tree);
        fs::create_dir_all(tree.parent().unwrap()).unwrap();
        git::worktree_add(&repo, &tree, "wecode/layer", Some("main")).unwrap();

        let err = amend(&dir, "caching", "api", false)
            .expect_err("a standing tree holds it")
            .to_string();
        assert!(err.contains("layer"), "it names the tree's task: {err}");
        assert!(err.contains("worktree remove"), "{err}");
        assert_eq!(
            store
                .load_plan()
                .unwrap()
                .project(&"caching".into())
                .unwrap()
                .repo,
            "app",
            "nothing was written"
        );

        // And once it is down, the project moves.
        git::worktree_remove(&repo, &tree).unwrap();
        let out = amend(&dir, "caching", "api", false).unwrap();
        assert!(out.contains("now  api"), "{out}");
        let _ = fs::remove_dir_all(tree.parent().unwrap());
    }
}
