//! Whether this computer can do the work, asked before a task claims it can.
//!
//! Everything wecode does to a task ends in something outside wecode: a `git` that cuts
//! a worktree, a directory that holds it, a repository it is cut from, a coding CLI
//! started inside it with an environment somebody wrote down by hand. None of that is
//! checked anywhere. `company.toml` names it all — `[[repos]] path`, `[agents.*]
//! command`, `[agents.*] env_allowlist` — and every one of those names is true on the
//! machine it was written on and assumed everywhere else.
//!
//! The failure is not silence, which is the hooks' problem; it is **misattribution**. A
//! missing `claude` fails at dispatch, which is after admission, after scheduling, with
//! a worktree cut and a run row opened — so it lands on the board as a task that could
//! not be done. It reads as work that failed, and it is a machine that was never set
//! up. `wecode loop` then does it again on the next promotion, and again, filing one
//! honest-looking record per attempt for a cause none of them names.
//!
//! Four things it deliberately does not do.
//!
//! - **It does not start an agent.** A coding CLI launched to see whether it launches
//!   is a session, a bill and, on some harnesses, a login prompt on a terminal nobody
//!   is watching. What it does instead is answer the question `spawn` will ask —
//!   whether the command resolves to something executable — because that is the whole
//!   of what dispatch gets wrong when a harness is not installed.
//! - **It does not judge what a task declared.** `cargo test` as an acceptance command
//!   lives in the plan, and the drill does not open the store. What is checked here is
//!   what *every* task needs, which is also what makes the report the same on a
//!   workspace with a hundred tasks and one with none.
//! - **It touches nothing anybody owns.** The one thing it writes is a probe file in
//!   wecode's own run directory, which it then removes — see [`writable`]. Repositories
//!   are asked questions and never written to.
//! - **It does not install anything.** Every fault here has a one-line repair in a file
//!   the operator already edits, and the note says which line. A doctor that fixed
//!   things would be a doctor nobody could leave in front of `wecode loop`.
//!
//! An absence is not a fault, here as much as in [`super::hooks`]: a workspace with no
//! repositories yet is a plan somebody is still writing, and an `[agents.*]` block no
//! post is staffed with launches nothing and is nobody's problem.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use wecode_org::{AgentTemplate, Company, Post, Repo, expand_home};

use super::{Check, Outcome, Section};
use crate::{spawn, work};

/// The heading for the tool every worktree is cut with.
const GIT: &str = "git";
/// The heading for the directory they are cut into.
const TREES: &str = "worktree root";

/// The half of the report about the computer, rather than about the person.
pub(super) fn section(company: &Company, org: &Path) -> Section {
    let checks = drill(company, org);
    let note = note(&checks);
    Section {
        title: "machine",
        checks,
        note,
    }
}

/// Everything the drill tries, in the order a dispatch needs it: the tool that cuts a
/// tree, the place it is cut into, the repository it is cut from, and the harness that
/// then runs in it.
fn drill(company: &Company, org: &Path) -> Vec<Check> {
    let mut checks = vec![git(), where_trees_land(org)];
    checks.extend(repositories(company));
    checks.push(grammars(company));
    checks.extend(harnesses(company));
    checks
}

/// The heading for the languages the codemap can parse.
const GRAMMARS: &str = "codemap grammars";

/// Which declared languages the codemap has a grammar for.
///
/// Never `Broken`, and that is the design's own rule rather than leniency. The codemap
/// ranks and never refuses: a project in a language wecode has no grammar for loses a
/// ranking and keeps everything else, and every file in it still reaches the agent
/// through the file layer. Failing the drill would put `wecode doctor && wecode loop`
/// behind a grammar nobody's work depends on.
///
/// Read off each repository's own playbook rather than off the plan, because the drill
/// does not open the store — see the module note. That also makes this the right place
/// for it: `[project] language` is written in the repository it describes.
fn grammars(company: &Company) -> Check {
    let mut unmapped: Vec<String> = company
        .repos
        .iter()
        .filter_map(|r| {
            let declared = wecode_org::Playbook::at(&expand_home(&r.path))
                .ok()
                .flatten()?
                .project
                .language;
            let named = declared.trim();
            (!named.is_empty() && wecode_map::Language::named(named).is_none())
                .then(|| format!("{} says `{named}`", r.name))
        })
        .collect();
    unmapped.sort();

    let have: Vec<&str> = wecode_map::Language::ALL
        .iter()
        .map(|l| l.as_str())
        .collect();
    let outcome = if unmapped.is_empty() {
        Outcome::Sound(have.join(", "))
    } else {
        Outcome::Absent(format!(
            "{} — no grammar, so those files stay at the file layer; wecode has {}",
            unmapped.join(", "),
            have.join(", ")
        ))
    };
    Check::new(GRAMMARS, outcome)
}

/// Runs `git --version`.
///
/// The one command in this half that is executed rather than resolved, because it is
/// free and because a `git` that is present and cannot run — a broken symlink, a
/// wrapper whose interpreter is missing, a WSL mount that lost its executable bit — is
/// exactly as fatal as one that is absent and looks nothing like it in a `which`. Every
/// repository row below leans on the same binary, so it is asked first: the answer
/// there should be *this path is not a repository*, not the same missing tool reported
/// once per repo.
fn git() -> Check {
    let outcome = match Command::new("git").arg("--version").output() {
        Err(e) => Outcome::Broken(format!(
            "not runnable: {e} — every worktree wecode cuts is cut with it"
        )),
        Ok(out) if out.status.success() => Outcome::Sound(said(&out.stdout)),
        Ok(out) => Outcome::Broken(format!("`git --version` {}", exited(&out))),
    };
    Check::new(GIT, outcome)
}

/// Whether a worktree could be put where worktrees go.
///
/// Named in the report whatever the answer is, because *where* is a question operators
/// ask constantly — the directory is outside both the repository and the workspace, and
/// a report that only mentioned it when it was broken would be hiding the answer to the
/// commonest question about it.
fn where_trees_land(org: &Path) -> Check {
    let dir = work::run_root().join(work::org_name(org));
    let outcome = match writable(&dir) {
        Ok(()) => Outcome::Sound(dir.display().to_string()),
        Err(e) => Outcome::Broken(format!("{}: {e}", dir.display())),
    };
    Check::new(TREES, outcome)
}

/// Makes the directory and writes one file in it.
///
/// Both, because a dispatch does both and neither is answered by reading permission
/// bits: a directory owned by another user, a read-only mount, a `$WECODE_CONFIG`
/// pointing somewhere that no longer exists, and a full disk are four different errors
/// that a mode check reports as fine. The probe carries the process id so two drills
/// running at once cannot delete each other's, and it is removed either way — the
/// directory itself is left standing because the first dispatch would create it anyway.
fn writable(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(format!(".doctor-{}", std::process::id()));
    std::fs::write(&probe, [])?;
    std::fs::remove_file(&probe)
}

/// One row per `[[repos]]`, or one row saying there are none.
fn repositories(company: &Company) -> Vec<Check> {
    if company.repos.is_empty() {
        return vec![Check::new(
            "[[repos]]",
            Outcome::Absent(
                "none declared — a project names one, so nothing can be dispatched yet".to_string(),
            ),
        )];
    }
    company.repos.iter().map(repository).collect()
}

/// Whether a declared repository is there, and is a repository.
///
/// The likeliest wrong line in a new workspace, and the one that reads least like a
/// mistake: `wecode init` ships `path = "~/projects/your-repo"`, which parses, validates
/// and names a directory that has never existed. Nothing asks about it until a project
/// on that repo dispatches its first task.
fn repository(repo: &Repo) -> Check {
    let at = format!("[[repos]] {}", repo.name);
    let path = expand_home(&repo.path);
    let outcome = if !path.is_dir() {
        Outcome::Broken(format!(
            "{} is not there — every worktree for this repo is cut from it",
            path.display()
        ))
    } else {
        match is_repository(&path) {
            Ok(()) => Outcome::Sound(path.display().to_string()),
            Err(e) => Outcome::Broken(format!("{}: {e}", path.display())),
        }
    };
    Check::new(at, outcome)
}

/// Asks git whether this is a repository, rather than looking for a `.git` directory.
///
/// A linked worktree's `.git` is a file, a submodule's is somewhere else entirely, and
/// `$GIT_DIR` overrides both — so the only reading of *is this a repository* that agrees
/// with what wecode does to the path is the one git itself gives for `git -C`, which is
/// how every other call in [`crate::git`] reaches it.
fn is_repository(path: &Path) -> Result<(), String> {
    match Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--git-dir"])
        .output()
    {
        Err(e) => Err(format!("git could not be run: {e}")),
        Ok(out) if out.status.success() => Ok(()),
        // git's own sentence, which names the case better than a guess would: *not a
        // repository*, *dubious ownership*, *unsafe directory*.
        Ok(out) => Err(match said(&out.stderr) {
            reason if reason.is_empty() => format!("`git rev-parse` {}", exited(&out)),
            reason => reason,
        }),
    }
}

/// Two rows per staffed harness, one for a harness nothing is staffed with.
fn harnesses(company: &Company) -> Vec<Check> {
    if company.agents.is_empty() {
        return vec![Check::new(
            "[agents.*]",
            Outcome::Absent("none declared — nothing runs the work".to_string()),
        )];
    }
    company
        .agents
        .iter()
        .flat_map(|(name, t)| harness(company, name, t))
        .collect()
}

fn harness(company: &Company, name: &str, t: &AgentTemplate) -> Vec<Check> {
    let seats: Vec<&Post> = company.posts.iter().filter(|p| p.agent == *name).collect();
    if seats.is_empty() {
        return vec![Check::new(
            format!("[agents.{name}]"),
            Outcome::Absent("no post is staffed with it — nothing launches it".to_string()),
        )];
    }
    vec![
        launches(company, name, t, &seats),
        environment(name, t, &seats),
    ]
}

/// Whether this harness could be started, and which seats are waiting on the answer.
///
/// The charter first, because an invariant outranks the question of whether the binary
/// is there: a launch line `never_run` forbids is refused at dispatch however well
/// installed the harness is, and reporting *found it* about a command that will never
/// be run would be the wrong half of the truth.
fn launches(company: &Company, name: &str, t: &AgentTemplate, seats: &[&Post]) -> Check {
    let at = format!("[agents.{name}] command");
    let outcome = if let Some((seat, pattern)) = forbidden(company, t, seats) {
        Outcome::Broken(format!(
            "the charter refuses the line `{seat}` would be dispatched on: never_run {pattern}"
        ))
    } else {
        match resolve(&t.command) {
            Some(path) => Outcome::Sound(format!("{} — {}", path.display(), staffing(seats))),
            None => Outcome::Broken(format!(
                "`{}` is not on wecode's PATH, and {} would be dispatched to it",
                t.command,
                staffing(seats)
            )),
        }
    };
    Check::new(at, outcome)
}

/// The first seat whose launch line the charter forbids, and the pattern that does it.
///
/// Built exactly as `exec` builds it — the same `argv`, the same unsubstituted
/// `{{prompt}}`, the same tools and model derived from the seat — because a `never_run`
/// pattern matches a whole command line. Checking the bare command instead would agree
/// with dispatch only by accident: `claude *` forbids every real launch and matches
/// `claude` not at all.
fn forbidden(company: &Company, t: &AgentTemplate, seats: &[&Post]) -> Option<(String, String)> {
    seats.iter().find_map(|post| {
        let tools = company
            .grant_of(post)
            .map(spawn::allowed_tools)
            .unwrap_or_default();
        let line = spawn::argv(t, "{{prompt}}", &tools, company.model_for(post)).join(" ");
        crate::commands::exec::forbidden_by_charter(company, &line)
            .map(|pattern| (post.name.clone(), pattern))
    })
}

/// Whether the environment this harness is launched with is the one it was promised.
///
/// Its own row, and not a footnote on the command, because it is the fault that survives
/// everything else being right. A worker is started with [`std::process::Command::env_clear`]
/// and then handed back exactly what `env_allowlist` names — so the list is not a filter
/// over the ambient environment, it *is* the environment, and a name on it that is unset
/// where wecode runs is carried through as nothing at all. The agent then starts, works,
/// and fails on its first authenticated call, spending a task's budget to report a
/// variable that could have been reported here.
///
/// The two faults are separate on purpose. A missing name is a variable that does not
/// arrive; a missing `PATH` is every variable the harness would have looked up for
/// itself — the `git` it commits with, the `cargo` an acceptance command runs — and it
/// is the one that reads as configured, since the list is not empty and every name on
/// it is set.
fn environment(name: &str, t: &AgentTemplate, seats: &[&Post]) -> Check {
    let at = format!("[agents.{name}] env_allowlist");
    if t.env_allowlist.is_empty() {
        return Check::new(
            at,
            Outcome::Broken(format!(
                "empty, so {} are launched into an empty environment — no PATH, no HOME, \
                 and nothing to authenticate with",
                staffing(seats)
            )),
        );
    }

    let mut faults = Vec::new();
    let missing: Vec<&str> = t
        .env_allowlist
        .iter()
        .filter(|k| std::env::var_os(k.as_str()).is_none())
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        faults.push(format!(
            "{} — declared, and not set where wecode runs, so the agent is launched without it",
            missing.join(", ")
        ));
    }
    if !t.env_allowlist.iter().any(|k| k == "PATH") {
        faults.push(
            "PATH is not on the list — the agent, and everything it shells out to, runs \
             without one"
                .to_string(),
        );
    }

    let outcome = if faults.is_empty() {
        Outcome::Sound(format!("{}: all set here", t.env_allowlist.join(", ")))
    } else {
        Outcome::Broken(faults.join("; "))
    };
    Check::new(at, outcome)
}

/// Where a command resolves to, or `None` when nothing would launch.
///
/// The question [`std::process::Command::spawn`] asks, answered the way it answers it: a
/// name with a separator in it is a path and is taken as one, and anything else is
/// looked for along wecode's own `PATH` in order, having to be a file that somebody may
/// execute. A directory called `claude`, or a downloaded release that never got its
/// executable bit, both resolve to nothing here for the same reason they do at dispatch.
fn resolve(command: &str) -> Option<PathBuf> {
    if command.contains('/') {
        let path = expand_home(command);
        return executable(&path).then_some(path);
    }
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        let full = dir.join(command);
        executable(&full).then_some(full)
    })
}

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The seats that depend on this answer, named because the repair depends on which they
/// are: a harness nothing but `test` uses is a different morning's work from the one
/// every seat is staffed with.
fn staffing(seats: &[&Post]) -> String {
    let names: Vec<&str> = seats.iter().map(|p| p.name.as_str()).collect();
    match names.as_slice() {
        [one] => format!("post `{one}`"),
        many => format!("posts {}", many.join(", ")),
    }
}

/// The first line of what a command printed, trimmed.
fn said(stream: &[u8]) -> String {
    String::from_utf8_lossy(stream)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// How a command ended, for the case where what it printed says nothing.
fn exited(out: &Output) -> String {
    out.status
        .code()
        .map_or_else(|| "was killed by a signal".to_string(), |c| format!("exited {c}"))
}

/// What the rows cannot say for themselves.
fn note(checks: &[Check]) -> String {
    // Said whenever a harness was looked for at all, including when it was not found:
    // *not on the PATH* is a claim about resolution, and an operator who read it as
    // *wecode tried to run it and it failed* would go looking for the wrong fault.
    if checks.iter().any(|c| c.at.ends_with("] command")) {
        return "\n  the harnesses are resolved, not started: a coding agent launched to see \
                whether\n  it launches is a session and a bill, and the drill decides nothing.\n"
            .to_string();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A company with the given blocks appended, parsed as an operator would have
    /// written it.
    fn company(blocks: &str) -> Company {
        Company::parse(&format!(
            "[company]\nname = \"cws\"\n\n[roles.engineer]\nwrite = [\"src/**\"]\nrun = [\"cargo *\"]\n{blocks}"
        ))
        .expect("the profile parses")
    }

    /// A company whose one seat is staffed by an agent with the given attributes.
    fn staffed(attrs: &str) -> Company {
        company(&format!(
            "\n[[posts]]\nname = \"impl\"\nrole = \"engineer\"\nagent = \"harness\"\n\n\
             [agents.harness]\n{attrs}"
        ))
    }

    fn at<'a>(checks: &'a [Check], what: &str) -> &'a Outcome {
        &checks
            .iter()
            .find(|c| c.is(what))
            .unwrap_or_else(|| panic!("no {what} check in {checks:?}"))
            .outcome
    }

    /// A directory of our own, emptied first so a rerun starts where the first run did.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wecode-doctor-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    #[test]
    fn the_rows_come_in_the_order_a_dispatch_needs_them() {
        // Not presentation. `git` is asked first because every repository row below it
        // leans on the same binary, and a machine without one would otherwise report
        // the missing tool once per repo instead of once — and the place worktrees land
        // is asked before the repository they are cut from, which is the order the
        // failures actually happen in.
        let checks = drill(&staffed("command = \"sh\"\nenv_allowlist = [\"PATH\"]\n"), &scratch("order"));
        let at: Vec<&str> = checks.iter().map(|c| c.at.as_str()).collect();
        assert_eq!(
            at,
            vec![
                GIT,
                TREES,
                "[[repos]]",
                // After the repositories, because it is read out of their playbooks.
                GRAMMARS,
                "[agents.harness] command",
                "[agents.harness] env_allowlist",
            ],
            "{checks:?}"
        );
    }

    #[test]
    fn the_tool_every_worktree_is_cut_with_is_named_with_its_version() {
        // Sound on any machine that can build this, which is the point: the row exists
        // for the machine that cannot, where every repository row below it would
        // otherwise report the same missing binary in its own words.
        let check = git();
        assert!(!check.outcome.is_broken(), "{check:?}");
        assert!(check.outcome.note().contains("git"), "{check:?}");
    }

    #[test]
    fn where_worktrees_land_is_reported_whether_or_not_it_is_a_problem() {
        // Outside the repository and outside the workspace, which is the commonest
        // question asked about it — so the answer is in the report on the good day too.
        let check = where_trees_land(&scratch("root").join("cws"));
        assert!(!check.outcome.is_broken(), "{check:?}");
        assert!(check.outcome.note().contains("cws"), "{check:?}");
    }

    #[test]
    fn a_place_that_cannot_hold_a_worktree_is_found_before_one_is_cut() {
        // A file where the directory should be: `create_dir_all` refuses, which is the
        // same refusal `wecode start` would meet with a task's name against it.
        let file = scratch("blocked").join("occupied");
        std::fs::write(&file, "not a directory").unwrap();
        assert!(writable(&file.join("cws")).is_err());
    }

    #[test]
    fn the_probe_leaves_the_directory_as_it_found_it() {
        let dir = scratch("probe").join("cws");
        writable(&dir).expect("a directory of our own is writable");
        assert!(dir.is_dir(), "the run root was not created");
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            0,
            "the probe file was left behind"
        );
    }

    #[test]
    fn a_repository_that_is_there_is_named_by_the_path_it_resolves_to() {
        let dir = scratch("repo");
        git_in(&dir, &["init", "-q"]);
        let check = repository(&Repo {
            name: "app".to_string(),
            path: dir.to_string_lossy().into_owned(),
        });
        assert!(!check.outcome.is_broken(), "{check:?}");
        assert!(check.outcome.note().contains("wecode-doctor-repo"), "{check:?}");
    }

    #[test]
    fn the_example_path_a_new_workspace_ships_with_is_a_fault_and_not_a_shrug() {
        // `wecode init` writes `~/projects/your-repo`, which parses and validates and
        // has never existed. Nothing asked about it until the first task on that repo
        // was dispatched, cut a worktree and failed with the operator's name on it.
        let check = repository(&Repo {
            name: "app".to_string(),
            path: "~/projects/definitely-not-a-repo-9f3a".to_string(),
        });
        assert!(check.outcome.is_broken(), "{check:?}");
        assert!(check.outcome.note().contains("is not there"), "{check:?}");
        // Expanded, because `~` in a report is a path the operator cannot `ls`.
        assert!(!check.outcome.note().contains('~'), "{check:?}");
    }

    #[test]
    fn a_directory_that_is_not_a_repository_is_reported_in_gits_own_words() {
        let dir = scratch("not-a-repo");
        let check = repository(&Repo {
            name: "app".to_string(),
            path: dir.to_string_lossy().into_owned(),
        });
        assert!(check.outcome.is_broken(), "{check:?}");
        assert!(
            check.outcome.note().contains("repository"),
            "git's own sentence names the case: {check:?}"
        );
    }

    #[test]
    fn a_path_that_is_a_file_is_not_a_repository_either() {
        // The likelier shape of this than a missing directory: a `path` pointing at the
        // repository's `.git`, or at a tarball somebody meant to unpack. `is_dir` is
        // what separates them, and a check that only asked `exists` would hand the path
        // to git and report git's confusion instead of the operator's typo.
        let file = scratch("repo-file").join("app.tar.gz");
        std::fs::write(&file, "not a repository").unwrap();
        let check = repository(&Repo {
            name: "app".to_string(),
            path: file.to_string_lossy().into_owned(),
        });
        assert!(check.outcome.is_broken(), "{check:?}");
        assert!(check.outcome.note().contains("is not there"), "{check:?}");
    }

    #[test]
    fn every_declared_repository_answers_for_itself() {
        // One row each, named by the name the operator gave it. A drill that stopped at
        // the first fault would report the workspace as one repair when it is two, and
        // an operator who fixed the named one would run it again to be told about the
        // next — which is the shape that makes people stop running it.
        let c = company(
            "\n[[repos]]\nname = \"app\"\npath = \"~/projects/definitely-not-a-repo-9f3a\"\n\n\
             [[repos]]\nname = \"infra\"\npath = \"~/projects/definitely-not-a-repo-4c1b\"\n",
        );
        let checks = repositories(&c);
        assert_eq!(checks.len(), 2, "{checks:?}");
        assert!(at(&checks, "[[repos]] app").is_broken(), "{checks:?}");
        assert!(at(&checks, "[[repos]] infra").is_broken(), "{checks:?}");
    }

    #[test]
    fn a_workspace_with_nothing_declared_yet_is_absent_rather_than_broken() {
        // A plan somebody is still writing. The drill has to be a thing you can leave
        // in a script from the first day of a workspace, not from the day it is full.
        let checks = repositories(&company(""));
        assert!(at(&checks, "[[repos]]").is_absent(), "{checks:?}");
        let checks = harnesses(&company(""));
        assert!(at(&checks, "[agents.*]").is_absent(), "{checks:?}");
    }

    #[test]
    fn a_harness_that_is_installed_is_found_and_the_seats_waiting_on_it_are_named() {
        let c = staffed("command = \"sh\"\nenv_allowlist = [\"PATH\"]\n");
        let checks = harnesses(&c);
        let note = at(&checks, "[agents.harness] command");
        assert!(!note.is_broken(), "{note:?}");
        assert!(note.note().contains("/sh"), "the path it resolved to: {note:?}");
        // Which seats, because that is what decides whether this is today's problem.
        assert!(note.note().contains("post `impl`"), "{note:?}");
    }

    #[test]
    fn a_harness_that_is_not_installed_is_broken_here_rather_than_at_dispatch() {
        // The whole reason for this half. Left to dispatch it is a failed task with a
        // worktree and a run record against it, which reads as work that could not be
        // done rather than as a machine that was never set up.
        let c = staffed("command = \"wecode-no-such-harness\"\nenv_allowlist = [\"PATH\"]\n");
        let checks = harnesses(&c);
        let note = at(&checks, "[agents.harness] command");
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("not on wecode's PATH"), "{note:?}");
        assert!(note.note().contains("post `impl`"), "{note:?}");
    }

    #[test]
    fn a_launch_line_the_charter_forbids_is_reported_before_the_binary_is_looked_for() {
        // An invariant outranks the question. The line is refused at dispatch however
        // well installed the harness is, so *found it* would be the wrong half of it.
        let c = company(
            "\n[invariants]\nnever_run = [\"sh *\"]\n\n\
             [[posts]]\nname = \"impl\"\nrole = \"engineer\"\nagent = \"harness\"\n\n\
             [agents.harness]\ncommand = \"sh\"\nargs = [\"-c\", \"{{prompt}}\"]\n\
             env_allowlist = [\"PATH\"]\n",
        );
        let checks = harnesses(&c);
        let note = at(&checks, "[agents.harness] command");
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("never_run sh *"), "{note:?}");
        assert!(note.note().contains("impl"), "the seat it would refuse: {note:?}");
    }

    #[test]
    fn the_charter_is_read_against_each_seats_own_launch_line() {
        // Why the check is per-seat and not per-harness: two posts on one harness are
        // launched on two different lines, because the tools come from the role. A
        // `never_run` that catches the engineer's `Edit,Write` leaves the watcher's
        // read-only line alone, and the seat named in the report is the one that would
        // actually be refused — which is also the one whose role has to change.
        let c = company(
            "\n[roles.watcher]\nread = [\"**\"]\n\n\
             [invariants]\nnever_run = [\"*Edit,Write*\"]\n\n\
             [[posts]]\nname = \"eyes\"\nrole = \"watcher\"\nagent = \"harness\"\n\n\
             [[posts]]\nname = \"impl\"\nrole = \"engineer\"\nagent = \"harness\"\n\n\
             [agents.harness]\ncommand = \"sh\"\n\
             args = [\"--allowedTools\", \"{{tools}}\", \"{{prompt}}\"]\n\
             env_allowlist = [\"PATH\"]\n",
        );
        let checks = harnesses(&c);
        let note = at(&checks, "[agents.harness] command");
        assert!(note.is_broken(), "{note:?}");
        // `eyes` is the first seat in the file and is not the one refused, so a check
        // that reported whichever seat it reached first would name it.
        assert!(note.note().contains("`impl`"), "the seat refused: {note:?}");
        assert!(!note.note().contains("`eyes`"), "{note:?}");
    }

    #[test]
    fn a_harness_no_seat_is_staffed_with_is_an_absence_and_not_two_rows() {
        // It launches nothing, so it is nobody's problem — and a workspace that keeps a
        // second harness configured for the day it switches should not be failed for it.
        let c = company("\n[agents.spare]\ncommand = \"wecode-no-such-harness\"\n");
        let checks = harnesses(&c);
        assert_eq!(checks.len(), 1, "{checks:?}");
        assert!(at(&checks, "[agents.spare]").is_absent(), "{checks:?}");
    }

    #[test]
    fn a_variable_the_agent_was_promised_and_will_not_get_is_named() {
        // The list is not a filter over the environment, it *is* the environment: the
        // worker is started with `env_clear`. A name on it that is unset here arrives as
        // nothing, and the agent finds out on its first authenticated call, having
        // already spent the task's budget getting there.
        let c = staffed("command = \"sh\"\nenv_allowlist = [\"PATH\", \"WECODE_DOCTOR_UNSET\"]\n");
        let checks = harnesses(&c);
        let note = at(&checks, "[agents.harness] env_allowlist");
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("WECODE_DOCTOR_UNSET"), "{note:?}");
        assert!(!note.note().contains("PATH is not"), "PATH is set: {note:?}");
    }

    #[test]
    fn a_list_that_carries_no_path_is_the_fault_that_reads_as_configured() {
        // Every name on it is set, so nothing looks wrong — and the harness starts
        // without the `git` it commits with or the `cargo` its acceptance runs.
        let c = staffed("command = \"/bin/sh\"\nenv_allowlist = [\"HOME\"]\n");
        let checks = harnesses(&c);
        let note = at(&checks, "[agents.harness] env_allowlist");
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("PATH is not on the list"), "{note:?}");
    }

    #[test]
    fn an_empty_list_says_what_an_empty_environment_means() {
        let c = staffed("command = \"sh\"\n");
        let checks = harnesses(&c);
        let note = at(&checks, "[agents.harness] env_allowlist");
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("empty environment"), "{note:?}");
    }

    #[test]
    fn a_list_that_all_arrives_is_read_back_so_it_can_be_compared_with_the_file() {
        let c = staffed("command = \"sh\"\nenv_allowlist = [\"PATH\", \"HOME\"]\n");
        let checks = harnesses(&c);
        let note = at(&checks, "[agents.harness] env_allowlist");
        assert!(!note.is_broken(), "{note:?}");
        assert!(note.note().contains("PATH, HOME"), "{note:?}");
    }

    #[test]
    fn every_seat_waiting_on_the_answer_is_named_and_counted_as_one() {
        // Two seats, one harness: the repair is the same repair, and it is a different
        // morning's work from a harness only `test` is staffed with. The plural is part
        // of it — a report that said `post chief, impl` would read as one post with a
        // comma in its name.
        let c = company(
            "\n[[posts]]\nname = \"chief\"\nrole = \"engineer\"\nagent = \"harness\"\n\n\
             [[posts]]\nname = \"impl\"\nrole = \"engineer\"\nagent = \"harness\"\n\n\
             [agents.harness]\ncommand = \"wecode-no-such-harness\"\n\
             env_allowlist = [\"PATH\"]\n",
        );
        let checks = harnesses(&c);
        // Still two rows and not four: the harness is the thing that is broken, not
        // each seat's copy of it.
        assert_eq!(checks.len(), 2, "{checks:?}");
        let note = at(&checks, "[agents.harness] command");
        assert!(note.note().contains("posts chief, impl"), "{note:?}");
    }

    #[test]
    fn a_list_that_is_wrong_in_both_ways_says_both() {
        // They are different repairs — one line to add a name to the list, one to go
        // and export a variable — so a report that stopped at the first would be one
        // more run of the drill for a fault it had already seen.
        let c = staffed("command = \"sh\"\nenv_allowlist = [\"WECODE_DOCTOR_UNSET\"]\n");
        let checks = harnesses(&c);
        let note = at(&checks, "[agents.harness] env_allowlist");
        assert!(note.is_broken(), "{note:?}");
        assert!(note.note().contains("WECODE_DOCTOR_UNSET"), "{note:?}");
        assert!(note.note().contains("PATH is not on the list"), "{note:?}");
    }

    #[test]
    fn a_command_is_resolved_the_way_the_thing_that_launches_it_resolves_it() {
        assert!(resolve("sh").is_some_and(|p| p.ends_with("sh")));
        assert_eq!(resolve("wecode-no-such-harness"), None);
        // A path is a path, and is not looked for on the PATH.
        assert_eq!(resolve("/bin/sh"), Some(PathBuf::from("/bin/sh")));
        assert_eq!(resolve("./wecode-no-such-harness"), None);
    }

    #[test]
    fn something_that_is_not_a_program_does_not_count_as_one() {
        // Both are real: a downloaded release that never got its executable bit, and a
        // directory that happens to be named like the command. `spawn` fails on each.
        let dir = scratch("bits");
        let plain = dir.join("harness");
        std::fs::write(&plain, "#!/bin/sh\n").unwrap();
        assert!(!executable(&plain), "a file nobody may execute");
        assert!(!executable(&dir), "a directory is not a program");
    }

    #[test]
    fn a_harness_installed_at_a_path_is_found_once_it_can_be_run_and_not_before() {
        // A release downloaded to a directory of one's own and named in `command` by
        // its full path — the second commonest way a harness is installed, and the one
        // where the fault is a mode bit rather than a missing file. `spawn` refuses it
        // with `Permission denied` at dispatch; here it is a line to fix beforehand.
        let harness = scratch("installed").join("harness");
        std::fs::write(&harness, "#!/bin/sh\nexit 0\n").unwrap();
        let named = harness.to_string_lossy().into_owned();
        assert_eq!(resolve(&named), None, "a file nobody may execute");

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&harness, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(resolve(&named), Some(harness));
    }

    #[test]
    fn what_a_command_said_is_its_first_line_and_nothing_after_it() {
        // Every note is one row of a report read down a column. `git --version` is one
        // line today and a wrapper that prints its own banner first is not, so the row
        // takes what it can use rather than folding somebody's build info into it.
        assert_eq!(said(b"  git version 2.43.0  \nand more\n"), "git version 2.43.0");
        assert_eq!(said(b""), "");
    }

    #[test]
    fn how_a_command_ended_is_said_for_the_case_where_it_printed_nothing() {
        let out = Command::new("sh").args(["-c", "exit 3"]).output().unwrap();
        assert_eq!(exited(&out), "exited 3");
    }

    #[test]
    fn a_report_with_no_harness_in_it_does_not_claim_one_was_resolved() {
        // The note is a claim about what the drill did. On a workspace whose harnesses
        // nothing is staffed with, nothing was resolved, and saying so would send an
        // operator looking for a row that is not there.
        let out = super::super::render(&[section(&company(""), &scratch("bare-note"))]);
        assert!(!out.contains("resolved, not started"), "{out}");
    }

    #[test]
    fn the_report_says_the_harnesses_were_not_started() {
        // `not on the PATH` is a claim about resolution. An operator reading it as
        // *wecode ran it and it failed* would go looking for the wrong fault.
        let c = staffed("command = \"sh\"\nenv_allowlist = [\"PATH\"]\n");
        let out = super::super::render(&[section(&c, &scratch("note"))]);
        assert!(out.contains("resolved, not started"), "{out}");
        assert!(out.contains("machine"), "the heading: {out}");
    }
}
