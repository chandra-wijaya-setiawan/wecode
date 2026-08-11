//! End-to-end tests: run the real binary against a real workspace.
//!
//! These exist because the three worst bugs so far were all integration bugs that
//! unit tests structurally could not catch — a hardcoded attribution, a
//! per-process audit sequence, and a root-kind being refused admission. Each
//! needed the whole pipeline running.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Result of one invocation, with both streams decoded.
struct Run {
    status: i32,
    stdout: String,
    stderr: String,
}

impl Run {
    fn ok(&self) -> bool {
        self.status == 0
    }

    /// Everything the command emitted, for assertions that do not care which
    /// stream carried it.
    fn all(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }

    fn assert_ok(&self, what: &str) -> &Self {
        assert!(
            self.ok(),
            "{what} failed (status {})\nstdout:\n{}\nstderr:\n{}",
            self.status,
            self.stdout,
            self.stderr
        );
        self
    }

    fn assert_contains(&self, needle: &str) -> &Self {
        assert!(
            self.all().contains(needle),
            "expected {needle:?} in output:\n{}",
            self.all()
        );
        self
    }

    fn assert_lacks(&self, needle: &str) -> &Self {
        assert!(
            !self.all().contains(needle),
            "did not expect {needle:?} in output:\n{}",
            self.all()
        );
        self
    }
}

fn decode(out: Output) -> Run {
    Run {
        status: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

/// A company workspace scoped to one test.
struct Org {
    dir: PathBuf,
}

impl Org {
    /// Creates a fresh workspace. Each test gets its own: they run in parallel,
    /// and the store is append-only shared state.
    fn new(name: &str, template: &str) -> Self {
        let org = Self::unattended(name, template);
        // Most tests act as somebody. The few that check the refusal path use
        // `unattended` instead.
        org.run(&["login", "you"]).assert_ok("login");
        org
    }

    /// A workspace with nobody logged in.
    fn unattended(name: &str, template: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("wecode-e2e-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        let org = Self { dir };
        org.run(&["init", org.dir.to_str().unwrap(), "--template", template])
            .assert_ok("init");
        org
    }

    /// Runs the binary against this workspace.
    fn run(&self, args: &[&str]) -> Run {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_wecode"));
        // `init` names its own target directory, so --org would be wrong there.
        if args.first() != Some(&"init") {
            cmd.arg("--org").arg(&self.dir);
        }
        cmd.args(args);
        // Never inherit — or clobber — anything from the developer's environment.
        // WECODE_CONFIG in particular: `use` writes a default there, and without
        // isolation a test run overwrites the real one.
        cmd.env_remove("WECODE_ORG");
        cmd.env("WECODE_CONFIG", self.dir.join("config"));
        decode(cmd.output().expect("binary runs"))
    }

    /// Creates a real git repository and points the workspace's `app` repo at it.
    ///
    /// Real git, because git is a subprocess here — a fake would test nothing.
    fn repo(&self) -> PathBuf {
        let repo = self.dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            git(&repo, &args);
        }
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "first"]);

        let conf = self.path("company.toml");
        let text = std::fs::read_to_string(&conf).unwrap();
        std::fs::write(
            &conf,
            text.replace("~/projects/your-repo", repo.to_str().unwrap()),
        )
        .unwrap();
        repo
    }

    /// Replaces the agent template so a test can stand in a shell script for a
    /// coding CLI. Real process, real supervision — only the binary differs.
    fn agent(&self, script: &str) {
        let conf = self.path("company.toml");
        let text = std::fs::read_to_string(&conf).unwrap();
        let args = format!("args = [\"-c\", \"{}\"]", script.replace('"', "\\\""));
        let replaced = text
            .replace("command = \"claude\"", "command = \"sh\"")
            .replace(
                "args = [\"-p\", \"{{prompt}}\", \"--output-format\", \"stream-json\", \"--verbose\"]",
                &args,
            );
        assert_ne!(replaced, text, "agent template was not replaced");
        std::fs::write(&conf, replaced).unwrap();
    }

    /// Writes a playbook into the repo. Explicit rather than via `playbook init`, so
    /// a test states exactly the guidance it depends on.
    fn playbook(&self, repo: &Path, body: &str) {
        let dir = repo.join(".wecode");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("playbook.toml"), body).unwrap();
        // Committed, as it would be in a real repo. Left uncommitted it shows up in
        // every diff as a change the task did not make.
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-qm", "playbook"]);
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }

    /// Builds the project and tasks used by several tests.
    ///
    /// `bench` depends on `cache-tests` so the dependency relation is exercised
    /// end to end, not just in unit tests.
    fn seed(&self) {
        self.run(&[
            "project",
            "add",
            "caching",
            "add response caching to the export endpoint",
            "--repo",
            "app",
            "--measure-cmd",
            "cargo test",
            "--tokens",
            "200000",
            "--wall",
            "1800",
        ])
        .assert_ok("add project");
        self.run(&[
            "task",
            "add",
            "cache-tests",
            "cover the cache layer with tests",
            "--project",
            "caching",
            "--accept-cmd",
            "cargo test",
            "--write",
            "tests/**",
            "--tokens",
            "50000",
        ])
        .assert_ok("add task");
        self.run(&[
            "task",
            "add",
            "bench",
            "benchmark the cache under load",
            "--project",
            "caching",
            "--after",
            "cache-tests",
            "--accept-cmd",
            "cargo bench",
            // Under tests/, so the tester's grant covers it. It overlaps
            // cache-tests, which is legal precisely because it is sequenced after.
            "--write",
            "tests/bench/**",
            "--tokens",
            "20000",
        ])
        .assert_ok("add dependent task");
    }
}

fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A well-formed `project add`, for tests about sessions and authority rather
/// than about the plan. Defined once so a change to admission does not need
/// editing in a dozen places.
const ADD_PROJECT: &[&str] = &[
    "project",
    "add",
    "v",
    "add response caching to the export endpoint",
    "--repo",
    "app",
    "--measure-cmd",
    "cargo test",
    "--tokens",
    "100",
    "--wall",
    "60",
];

/// Runs the binary with no workspace at all.
fn bare(args: &[&str]) -> Run {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wecode"));
    cmd.args(args);
    cmd.env_remove("WECODE_ORG");
    cmd.env(
        "WECODE_CONFIG",
        std::env::temp_dir().join("wecode-e2e-noconfig"),
    );
    // A directory guaranteed to contain no company.toml, and no parent that does.
    cmd.current_dir(Path::new("/"));
    decode(cmd.output().expect("binary runs"))
}

// ---------------------------------------------------------------- setup --------

#[test]
fn init_scaffolds_a_self_contained_workspace() {
    let org = Org::new("init", "software-company");
    for f in ["company.toml", "README.md", ".gitignore"] {
        assert!(org.path(f).is_file(), "missing {f}");
    }
    // Agents and the task envelope are inlined in company.toml, so a workspace has
    // no subdirectories to keep in sync.
    assert!(!org.path("agents").exists(), "no agents/ directory");
    assert!(!org.path("templates").exists(), "no templates/ directory");
    // The database appears on first use, not at init.
    org.run(&["tree"]).assert_ok("tree");
    assert!(org.path("wecode.db").is_file(), "wecode.db not created");
}

#[test]
fn init_refuses_to_overwrite_an_existing_workspace() {
    let org = Org::new("twice", "solo");
    let again = org.run(&["init", org.dir.to_str().unwrap()]);
    assert!(!again.ok(), "second init should fail");
    again.assert_contains("already exists");
}

#[test]
fn a_missing_workspace_explains_how_to_make_one() {
    let r = bare(&["tree"]);
    assert!(!r.ok());
    r.assert_contains("no company workspace found")
        .assert_contains("wecode init");
}

#[test]
fn company_show_reports_posts_and_invariants() {
    let org = Org::new("company", "software-company");
    org.run(&["company", "show"])
        .assert_ok("company show")
        .assert_contains("Example Software Co")
        .assert_contains("chief of staff")
        .assert_contains("never touch")
        // The tester writes tests only — the guarantee, visible in the output.
        .assert_contains("tests/**");
}

#[test]
fn a_broken_company_file_names_the_problem() {
    let org = Org::new("broken", "solo");
    std::fs::write(org.path("company.toml"), "[company]\nprofile = \"solo\"\n").unwrap();
    let r = org.run(&["company", "show"]);
    assert!(!r.ok());
    r.assert_contains("name");
}

#[test]
fn a_remembered_default_is_used_outside_any_workspace() {
    let org = Org::unattended("default-org", "solo");

    // `use` records it; a later command run from `/` finds it with no flags.
    org.run(&["use", org.dir.to_str().unwrap()])
        .assert_ok("use")
        .assert_contains("default org is now");

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wecode"));
    cmd.arg("company").arg("show");
    cmd.env_remove("WECODE_ORG");
    cmd.env("WECODE_CONFIG", org.dir.join("config"));
    cmd.current_dir(Path::new("/"));
    decode(cmd.output().expect("runs"))
        .assert_ok("company show via default")
        .assert_contains("My Project");
}

#[test]
fn a_bare_name_resolves_under_the_workspaces_root() {
    // `--org cws` should find ~/.wecode/workspaces/cws without typing the path.
    let cfg = std::env::temp_dir().join("wecode-e2e-named-cfg");
    let _ = std::fs::remove_dir_all(&cfg);

    let run = |args: &[&str]| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_wecode"));
        cmd.args(args);
        cmd.env_remove("WECODE_ORG");
        cmd.env("WECODE_CONFIG", &cfg);
        cmd.current_dir(Path::new("/"));
        decode(cmd.output().expect("runs"))
    };

    run(&["init", "acme", "--template", "solo"]).assert_ok("init by name");
    assert!(
        cfg.join("workspaces/acme/company.toml").is_file(),
        "a bare name should land under the workspaces root"
    );

    run(&["--org", "acme", "company", "show"])
        .assert_ok("show by name")
        .assert_contains("My Project");

    run(&["orgs"]).assert_ok("orgs").assert_contains("acme");
}

#[test]
fn an_unknown_org_name_lists_the_ones_that_exist() {
    let cfg = std::env::temp_dir().join("wecode-e2e-unknown-cfg");
    let _ = std::fs::remove_dir_all(&cfg);

    let run = |args: &[&str]| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_wecode"));
        cmd.args(args);
        cmd.env_remove("WECODE_ORG");
        cmd.env("WECODE_CONFIG", &cfg);
        cmd.current_dir(Path::new("/"));
        decode(cmd.output().expect("runs"))
    };

    run(&["init", "real", "--template", "solo"]).assert_ok("init");
    let r = run(&["--org", "ghost", "company", "show"]);
    assert!(!r.ok());
    r.assert_contains("no org `ghost`").assert_contains("real");
}

#[test]
fn a_path_is_still_taken_as_a_path() {
    // Anything with a separator must bypass the name lookup entirely.
    let org = Org::unattended("named-path", "solo");
    org.run(&["--org", org.dir.to_str().unwrap(), "company", "show"])
        .assert_ok("full path")
        .assert_contains("My Project");
}

#[test]
fn use_refuses_a_directory_that_is_not_a_workspace() {
    let org = Org::unattended("default-bad", "solo");
    let r = org.run(&["use", "/tmp"]);
    assert!(!r.ok());
    r.assert_contains("not a company workspace");
}

// -------------------------------------------------------------- session --------

#[test]
fn a_session_survives_between_processes() {
    // The mechanism the whole agent workflow rests on: log in once, then every
    // later invocation is a separate process that finds the seat by itself.
    let org = Org::unattended("sess-persist", "solo");
    org.run(&["login", "you"]).assert_ok("login");

    org.run(ADD_PROJECT)
        .assert_ok("no flags needed")
        .assert_contains("saved");

    org.run(&["audit"])
        .assert_contains("chief")
        .assert_contains("claude-code");
}

#[test]
fn without_a_session_a_state_changing_command_refuses() {
    // The regression that matters most: omitting a flag used to grant root.
    let org = Org::unattended("sess-none", "solo");
    let r = org.run(ADD_PROJECT);
    assert!(!r.ok(), "must refuse, not silently act as root");
    r.assert_contains("not logged in")
        .assert_contains("wecode login")
        .assert_contains("you");

    // And nothing was written.
    org.run(&["tree"]).assert_contains("no projects yet");
}

#[test]
fn reading_needs_no_session() {
    let org = Org::unattended("sess-read", "solo");
    org.run(&["tree"]).assert_ok("tree");
    org.run(&["ready"]).assert_ok("ready");
    org.run(&["company", "show"]).assert_ok("company show");
    org.run(&["board"]).assert_ok("board");
    org.run(&["who"]).assert_ok("who");
}

#[test]
fn two_sessions_are_ambiguous_until_one_is_named() {
    let org = Org::unattended("sess-two", "software-company");
    let first = org
        .run(&["login", "you"])
        .assert_ok("login 1")
        .stdout
        .clone();
    org.run(&["login", "you", "--as", "review"])
        .assert_ok("login 2");

    let r = org.run(ADD_PROJECT);
    assert!(!r.ok(), "two seats, no way to guess which");
    r.assert_contains("several sessions");

    // Naming one resolves it.
    let id = first
        .split_whitespace()
        .find(|w| w.starts_with("s-"))
        .expect("login prints a session id");
    let mut named: Vec<&str> = ADD_PROJECT.to_vec();
    named.extend(["--session", id]);
    org.run(&named)
        .assert_ok("named session")
        .assert_contains("saved");
}

#[test]
fn an_idle_expired_session_is_not_used() {
    let org = Org::unattended("sess-expired", "solo");
    org.run(&["login", "you"]).assert_ok("login");

    // The only sleep in the suite. Expiry is a function of the wall clock, and the
    // alternatives are worse: a zero ttl is a config the org crate itself rejects
    // as implausible, and reaching past the binary into the store would stop this
    // being an end-to-end test of the thing that broke.
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, text.replace("ttl = \"8h\"", "ttl = \"1s\"")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2100));

    let r = org.run(ADD_PROJECT);
    assert!(!r.ok(), "an idle session must not authorise");
    r.assert_contains("not logged in");
}

#[test]
fn who_reports_the_connected_and_logout_clears_them() {
    let org = Org::unattended("sess-who", "software-company");
    org.run(&["who"]).assert_contains("nobody connected");

    org.run(&["login", "you"]).assert_ok("login");
    org.run(&["who"])
        .assert_ok("who")
        .assert_contains("chief")
        .assert_contains("you via claude-code");

    org.run(&["logout", "--all"]).assert_ok("logout");
    org.run(&["who"]).assert_contains("nobody connected");
}

#[test]
fn whoami_lists_only_the_commands_this_seat_may_call() {
    let org = Org::new("sess-whoami", "software-company");
    org.run(&["whoami"])
        .assert_ok("whoami")
        .assert_contains("assign")
        .assert_contains("project add")
        .assert_contains("task add");

    // An engineer seat holds neither define nor staff.
    let eng = Org::unattended("sess-whoami-eng", "software-company");
    eng.run(&["login", "you", "--as", "impl"])
        .assert_ok("login");
    let out = eng.run(&["whoami"]).assert_ok("whoami").all();
    assert!(!out.contains("assign"), "engineer cannot staff:\n{out}");
    assert!(
        !out.contains("project add") && !out.contains("task add"),
        "engineer cannot define:\n{out}"
    );
}

#[test]
fn the_ledger_names_both_the_human_and_the_agent() {
    let org = Org::new("sess-ledger", "software-company");
    org.run(ADD_PROJECT).assert_ok("add");

    // The seat is a human *and* an agent, and the ledger records both. `who`
    // renders the pair the store holds.
    org.run(&["who"])
        .assert_ok("who")
        .assert_contains("you via claude-code")
        .assert_contains("s-");
    org.run(&["audit"])
        .assert_ok("audit")
        .assert_contains("chief")
        .assert_contains("claude-code");
}

#[test]
fn as_operator_is_the_only_way_to_reach_root() {
    let org = Org::unattended("sess-operator", "solo");
    // No session, but an explicit override still works — deliberately typed.
    let mut as_root: Vec<&str> = ADD_PROJECT.to_vec();
    as_root.extend(["--as", "operator"]);
    org.run(&as_root)
        .assert_ok("explicit operator")
        .assert_contains("saved");

    org.run(&["audit"])
        .assert_ok("audit")
        .assert_contains("operator");
}

// ----------------------------------------------------------------- plan --------

#[test]
fn a_vague_project_is_refused_with_specific_questions() {
    let org = Org::new("vague", "solo");
    let r = org.run(&[
        "project",
        "add",
        "speedup",
        "make the export faster",
        "--repo",
        "app",
    ]);
    r.assert_ok("command itself succeeds")
        .assert_contains("not admitted")
        .assert_contains("faster")
        .assert_contains("not saved");

    // Nothing was written.
    org.run(&["tree"]).assert_contains("no projects yet");
}

#[test]
fn force_admits_a_defective_project_and_says_so() {
    let org = Org::new("force", "solo");
    org.run(&[
        "project",
        "add",
        "speedup",
        "make the export faster",
        "--repo",
        "app",
        "--force",
    ])
    .assert_ok("forced add")
    .assert_contains("forced")
    .assert_contains("saved");
    org.run(&["tree"]).assert_contains("speedup");
}

#[test]
fn a_project_must_name_a_repo_the_company_knows() {
    let org = Org::new("repo-unknown", "solo");
    let r = org.run(&[
        "project",
        "add",
        "x",
        "add response caching to the export endpoint",
        "--repo",
        "nonexistent",
        "--measure-cmd",
        "cargo test",
        "--tokens",
        "100",
    ]);
    r.assert_contains("not admitted").assert_contains("app");
}

#[test]
fn a_task_needs_a_project_that_exists() {
    let org = Org::new("task-orphan", "solo");
    let r = org.run(&[
        "task",
        "add",
        "t",
        "do the thing",
        "--project",
        "ghost",
        "--accept-cmd",
        "cargo test",
        "--write",
        "src/**",
        "--tokens",
        "10",
    ]);
    assert!(!r.ok(), "should be refused");
    r.assert_contains("no such project");
}

#[test]
fn a_spike_is_the_only_kind_admitted_without_a_write_scope() {
    let org = Org::new("spike", "solo");
    org.seed();

    // A feature that writes nothing is a defect...
    org.run(&[
        "task",
        "add",
        "f",
        "implement the eviction policy",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--tokens",
        "10",
    ])
    .assert_contains("not admitted");

    // ...but a spike produces no code, so it needs no write scope.
    org.run(&[
        "task",
        "add",
        "s",
        "investigate the eviction strategies",
        "--project",
        "caching",
        "--kind",
        "spike",
        "--accept-cmd",
        "cargo test",
        "--tokens",
        "10",
    ])
    .assert_ok("spike")
    .assert_contains("admitted")
    .assert_contains("saved");
}

#[test]
fn the_plan_survives_a_restart() {
    let org = Org::new("persist", "solo");
    org.seed();

    // A separate process reads what earlier processes wrote.
    org.run(&["tree"])
        .assert_ok("tree")
        .assert_contains("caching")
        .assert_contains("cache-tests")
        .assert_contains("after cache-tests");

    org.run(&["show", "cache-tests"])
        .assert_ok("show")
        .assert_contains("cover the cache layer")
        .assert_contains("caching");
}

#[test]
fn show_resolves_either_level_and_says_so_when_neither_matches() {
    let org = Org::new("show", "solo");
    org.seed();
    org.run(&["show", "caching"])
        .assert_ok("show project")
        .assert_contains("objective");
    org.run(&["show", "cache-tests"])
        .assert_ok("show task")
        .assert_contains("acceptance");
    let r = org.run(&["show", "nope"]);
    assert!(!r.ok());
    r.assert_contains("no project or task");
}

#[test]
fn the_two_relations_are_reported_separately() {
    // The modelling error this design exists to avoid: a subtask is part of its
    // parent, a dependency comes after its predecessor, and they are not the same.
    let org = Org::new("relations", "solo");
    org.seed();
    org.run(&[
        "task",
        "add",
        "keys",
        "design the cache key format",
        "--project",
        "caching",
        "--parent",
        "cache-tests",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/keys/**",
        "--tokens",
        "10",
    ])
    .assert_ok("subtask");

    org.run(&["show", "cache-tests"])
        .assert_contains("subtasks")
        .assert_contains("not blocked by it");

    org.run(&["show", "bench"])
        .assert_contains("depends on")
        .assert_contains("must come after");
}

#[test]
fn a_dependency_is_a_sibling_in_the_tree_not_a_child() {
    let org = Org::new("tree-shape", "solo");
    org.seed();
    let out = org.run(&["tree"]).assert_ok("tree").stdout.clone();
    let indent = |needle: &str| {
        let line = out
            .lines()
            .find(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("no line for {needle} in:\n{out}"));
        line.len() - line.trim_start().len()
    };
    assert_eq!(
        indent("cache-tests"),
        indent("benchmark the cache"),
        "a predecessor is not a parent:\n{out}"
    );
}

#[test]
fn ready_reports_only_what_a_dispatcher_could_pick_up() {
    let org = Org::new("ready", "software-company");
    org.seed();

    // Fresh tasks are drafts: nothing is dispatchable until it is assigned.
    org.run(&["ready"]).assert_contains("nothing ready");

    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign");
    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign dependent");

    org.run(&["ready"])
        .assert_ok("ready")
        .assert_contains("cache-tests")
        .assert_lacks("benchmark the cache");
}

#[test]
fn finishing_a_predecessor_releases_its_dependent() {
    let org = Org::new("release", "software-company");
    org.seed();
    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign");
    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign");
    org.run(&["ready"]).assert_lacks("benchmark the cache");

    org.run(&["status", "cache-tests", "done"])
        .assert_ok("status")
        .assert_contains("done");

    org.run(&["ready"])
        .assert_ok("ready")
        .assert_contains("benchmark the cache");
}

#[test]
fn status_rejects_a_name_that_is_not_a_status() {
    let org = Org::new("status-bad", "solo");
    org.seed();
    let r = org.run(&["status", "cache-tests", "finished"]);
    assert!(!r.ok());
    r.assert_contains("unknown status")
        .assert_contains("waiting");
}

#[test]
fn a_duplicate_task_id_is_refused() {
    let org = Org::new("dupe", "solo");
    org.seed();
    let r = org.run(&[
        "task",
        "add",
        "cache-tests",
        "cover the cache layer twice",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--write",
        "other/**",
        "--tokens",
        "10",
    ]);
    assert!(!r.ok(), "a duplicate id must be refused");
}

#[test]
fn sibling_scope_overlap_is_reported() {
    let org = Org::new("overlap", "solo");
    org.seed();
    let r = org.run(&[
        "task",
        "add",
        "more-tests",
        "extend the cache tests",
        "--project",
        "caching",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/**",
        "--tokens",
        "1000",
    ]);
    r.assert_contains("overlaps").assert_contains("cache-tests");
}

#[test]
fn sequenced_tasks_may_share_a_scope() {
    // Two tasks that cannot run at once are not competing for the same files, so
    // the overlap check must exempt them.
    let org = Org::new("overlap-seq", "solo");
    org.seed();
    org.run(&[
        "task",
        "add",
        "more-tests",
        "extend the cache tests",
        "--project",
        "caching",
        "--after",
        "cache-tests",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/**",
        "--tokens",
        "1000",
    ])
    .assert_ok("sequenced overlap")
    .assert_contains("admitted");
}

// --------------------------------------------------------------- assign --------

#[test]
fn assign_refuses_a_post_whose_scope_cannot_cover_the_work() {
    let org = Org::new("assign-scope", "software-company");
    org.seed();

    // cache-tests writes tests/**; the engineer writes src/crates/lib.
    let r = org.run(&["assign", "cache-tests", "--to", "impl"]);
    assert!(!r.ok(), "should be refused");
    r.assert_contains("may not write")
        .assert_contains("tests/**");

    // The tester can.
    org.run(&["assign", "cache-tests", "--to", "test"])
        .assert_ok("assign to tester")
        .assert_contains("assigned")
        .assert_contains("codex");
}

#[test]
fn assigning_a_dependent_task_says_what_it_waits_on() {
    let org = Org::new("assign-waits", "software-company");
    org.seed();
    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign")
        .assert_contains("waiting")
        .assert_contains("cache-tests");
}

#[test]
fn a_defective_task_cannot_be_dispatched() {
    let org = Org::new("assign-draft", "software-company");
    org.seed();
    org.run(&[
        "task",
        "add",
        "vague",
        "make it faster",
        "--project",
        "caching",
        "--force",
    ])
    .assert_ok("forced");
    org.run(&["assign", "vague", "--to", "test"])
        .assert_contains("not assigned")
        .assert_contains("cannot be dispatched");
}

#[test]
fn assign_names_the_available_posts_when_given_a_bad_one() {
    let org = Org::new("assign-post", "software-company");
    org.seed();
    let r = org.run(&["assign", "cache-tests", "--to", "nobody"]);
    assert!(!r.ok());
    r.assert_contains("no such post").assert_contains("chief");
}

// ---------------------------------------------------------------- guard --------

#[test]
fn an_in_scope_write_is_allowed() {
    let org = Org::new("guard-allow", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "impl",
        "write",
        "crates/export/cache.rs",
        "--task",
        "cache-tests",
    ])
    .assert_ok("guard")
    .assert_contains("allowed");
}

#[test]
fn the_tester_cannot_edit_the_implementation() {
    let org = Org::new("guard-tester", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "test",
        "write",
        "crates/export/cache.rs",
        "--task",
        "cache-tests",
    ])
    .assert_ok("guard")
    .assert_contains("denied")
    // Recoverable, so the attempt is a signal about the scope, not misconduct.
    .assert_contains("sanctioned");
}

#[test]
fn an_invariant_violation_alarms_even_for_a_permitted_post() {
    let org = Org::new("guard-alarm", "software-company");
    org.seed();
    // The engineer may write src/**, but no grant outranks a charter invariant.
    org.run(&[
        "guard",
        "impl",
        "write",
        "src/keys/prod.pem",
        "--task",
        "cache-tests",
    ])
    .assert_contains("ALARM")
    .assert_contains("never_touch");

    org.run(&[
        "guard",
        "impl",
        "run",
        "git push --force",
        "--task",
        "cache-tests",
    ])
    .assert_contains("ALARM")
    .assert_contains("never_run");
}

#[test]
fn merging_a_protected_branch_needs_approval() {
    let org = Org::new("guard-merge", "software-company");
    org.seed();
    org.run(&["guard", "review", "merge", "main", "--task", "cache-tests"])
        .assert_contains("needs approval");
}

#[test]
fn overspending_is_refused() {
    let org = Org::new("guard-spend", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "impl",
        "spend",
        "x",
        "--tokens",
        "500000",
        "--task",
        "cache-tests",
    ])
    .assert_contains("budget");
}

// ---------------------------------------------------------------- audit --------

#[test]
fn the_audit_sequence_is_monotonic_across_processes() {
    // Regression: each invocation used to restart the Broker's counter at 1.
    let org = Org::new("audit-seq", "software-company");
    org.seed();
    for path in [
        "crates/export/a.rs",
        "crates/export/b.rs",
        "crates/export/c.rs",
    ] {
        org.run(&["guard", "impl", "write", path, "--task", "cache-tests"]);
    }
    let out = org.run(&["audit"]).assert_ok("audit").stdout.clone();
    let seqs: Vec<u64> = out
        .lines()
        .filter_map(|l| l.split_whitespace().next()?.parse().ok())
        .collect();
    // Contiguous from 1, not a fixed count: seeding also records `define`
    // actions now, so pinning the length would just be brittle.
    let expected: Vec<u64> = (1..=seqs.len() as u64).collect();
    assert_eq!(seqs, expected, "one ledger, one sequence:\n{out}");
    assert!(seqs.len() > 3, "the three writes must be in there:\n{out}");
}

#[test]
fn audit_filters_select_alarms_denials_and_paths() {
    let org = Org::new("audit-filter", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "impl",
        "write",
        "crates/export/ok.rs",
        "--task",
        "cache-tests",
    ]);
    org.run(&[
        "guard",
        "test",
        "write",
        "crates/export/no.rs",
        "--task",
        "cache-tests",
    ]);
    org.run(&[
        "guard",
        "impl",
        "write",
        "src/x.pem",
        "--task",
        "cache-tests",
    ]);

    org.run(&["audit", "--alarms"])
        .assert_contains("x.pem")
        .assert_lacks("ok.rs");

    org.run(&["audit", "--denied"]).assert_contains("no.rs");

    // The cross-harness question: who touched this, whichever agent it was.
    let touched = org.run(&["audit", "--path", "crates/export/**"]);
    touched
        .assert_contains("claude-code")
        .assert_contains("codex");
    touched.assert_lacks("x.pem");
}

#[test]
fn guard_records_are_attributed_to_their_task() {
    // Regression: the attribution was hardcoded, so every record was uncorrelated.
    let org = Org::new("audit-attrib", "software-company");
    org.seed();
    org.run(&[
        "guard",
        "impl",
        "write",
        "src/x.pem",
        "--task",
        "cache-tests",
    ]);

    // Assert on the needs-you cell and the incident row, NOT on the word "alarm":
    // the footer hints mention "--alarms", so a looser assertion passes even when
    // attribution is broken. This test was vacuous until that was noticed.
    org.run(&["board", "caching"])
        .assert_ok("board caching")
        .assert_contains("1 alarm")
        .assert_contains("x.pem");

    // And it must roll up: the alarm is on the project, the portfolio shows goals.
    org.run(&["board"])
        .assert_ok("board")
        .assert_contains("1 alarm");
}

#[test]
fn an_unattributed_record_does_not_reach_the_board() {
    // The other half of attribution: a record naming nothing must not be silently
    // credited to some task.
    let org = Org::new("audit-unattrib", "software-company");
    org.seed();
    org.run(&["guard", "impl", "write", "src/x.pem"]);

    org.run(&["audit", "--alarms"]).assert_contains("x.pem");
    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_lacks("1 alarm");
}

// ---------------------------------------------------------------- board --------

#[test]
fn the_board_shows_five_columns_at_every_level() {
    let org = Org::new("board", "software-company");
    org.seed();
    for args in [vec!["board"], vec!["board", "caching"]] {
        let r = org.run(&args);
        r.assert_ok("board");
        for col in ["what", "health", "progress", "spend", "needs you"] {
            r.assert_contains(col);
        }
    }
}

#[test]
fn the_board_reports_an_unknown_id_plainly() {
    let org = Org::new("board-missing", "solo");
    org.seed();
    org.run(&["board", "nope"])
        .assert_contains("no project or task");
}

#[test]
fn up_refuses_without_a_terminal_and_points_at_board() {
    let org = Org::new("up-tty", "solo");
    let r = org.run(&["up"]);
    assert!(!r.ok(), "piped output is not a terminal");
    r.assert_contains("needs a terminal")
        .assert_contains("board");
}

// ----------------------------------------------------------------- misc --------

#[test]
fn help_lists_the_command_groups() {
    let r = bare(&[]);
    r.assert_ok("help")
        .assert_contains("SETUP")
        .assert_contains("PLAN")
        .assert_contains("COCKPIT")
        .assert_contains("WORK");
}

#[test]
fn an_unknown_command_fails_and_shows_usage() {
    let r = bare(&["frobnicate"]);
    assert!(!r.ok());
    r.assert_contains("unknown command")
        .assert_contains("SETUP");
}

#[test]
fn templates_are_listed_with_summaries() {
    bare(&["templates"])
        .assert_ok("templates")
        .assert_contains("software-company")
        .assert_contains("solo");
}

// -------------------------------------------------------------- playbook ------

/// Guidance with everything a test might lean on, stated explicitly.
const PLAYBOOK: &str = r#"
[project]
language = "rust"

[bug]
worktree = true
assign_to = "impl"
accept = ["true"]
tokens = 1000
wall_secs = 60
guidance = "Reproduce first, then a failing test, then the fix."

[docs]
worktree = false
assign_to = "impl"
accept = ["true"]
tokens = 1000
wall_secs = 60
guidance = "Single task, no worktree."
"#;

/// A workspace with a real repo and a playbook in it.
fn with_playbook(name: &str) -> (Org, PathBuf) {
    let org = Org::new(name, "solo");
    let repo = org.repo();
    org.playbook(&repo, PLAYBOOK);
    org.run(&[
        "project",
        "add",
        "caching",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "1000",
        "--wall",
        "60",
    ])
    .assert_ok("add project");
    (org, repo)
}

#[test]
fn playbook_init_writes_a_file_that_then_parses() {
    let org = Org::new("pb-init", "solo");
    let repo = org.repo();
    org.run(&[
        "project",
        "add",
        "p",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "1",
    ])
    .assert_ok("project");

    org.run(&["playbook", "init", "--language", "rust"])
        .assert_ok("playbook init")
        .assert_contains("playbook.toml");
    assert!(repo.join(".wecode/playbook.toml").is_file());

    // The starter must be valid, or adoption fails at the first step.
    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("rust")
        .assert_contains("bug");

    // And it refuses to overwrite.
    let again = org.run(&["playbook", "init"]);
    assert!(!again.ok());
    again.assert_contains("already exists");
}

#[test]
fn a_project_with_no_playbook_says_how_to_make_one() {
    let org = Org::new("pb-absent", "solo");
    org.repo();
    org.run(&[
        "project",
        "add",
        "p",
        "add response caching to the export endpoint",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "1",
    ])
    .assert_ok("project");

    org.run(&["playbook"])
        .assert_ok("no playbook is not an error")
        .assert_contains("no playbook")
        .assert_contains("playbook init");
}

#[test]
fn playbook_shows_the_guidance_for_one_kind() {
    let (org, _) = with_playbook("pb-kind");
    org.run(&["playbook", "bug"])
        .assert_ok("playbook bug")
        .assert_contains("Reproduce first")
        .assert_contains("worktree  yes");

    org.run(&["playbook", "docs"])
        .assert_ok("playbook docs")
        .assert_contains("worktree  no");

    // A kind the project has said nothing about.
    org.run(&["playbook", "spike"])
        .assert_ok("playbook spike")
        .assert_contains("no [spike] section");
}

#[test]
fn task_add_fills_the_defaults_the_playbook_supplies() {
    let (org, _) = with_playbook("pb-defaults");
    org.run(&[
        "task",
        "add",
        "fix-it",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add")
    .assert_contains("(from playbook)")
    .assert_contains("admitted");

    org.run(&["show", "fix-it"])
        .assert_contains("impl")
        .assert_contains("`true` exits 0");
}

#[test]
fn an_explicit_flag_beats_the_playbook() {
    let (org, _) = with_playbook("pb-explicit");
    org.run(&[
        "task",
        "add",
        "fix-it",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
        "--accept-cmd",
        "cargo test",
        "--to",
        "impl",
        "--tokens",
        "50",
        "--wall",
        "5",
    ])
    .assert_ok("task add")
    .assert_lacks("(from playbook)");

    org.run(&["show", "fix-it"]).assert_contains("cargo test");
}

#[test]
fn a_kind_the_playbook_omits_gets_no_defaults() {
    let (org, _) = with_playbook("pb-omitted");
    // No [chore] section, so nothing is filled and the task is defective as written.
    org.run(&[
        "task",
        "add",
        "tidy",
        "--project",
        "caching",
        "--kind",
        "chore",
        "remove the deprecated export helper",
        "--write",
        "src/**",
    ])
    .assert_lacks("(from playbook)");
}

// ------------------------------------------------------------- worktrees ------

#[test]
fn start_creates_the_worktree_the_playbook_asks_for() {
    let (org, repo) = with_playbook("wt-bug");
    org.run(&[
        "task",
        "add",
        "fix-it",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");

    let r = org.run(&["start", "fix-it"]);
    r.assert_ok("start");
    r.assert_contains("worktree")
        .assert_contains("wecode/fix-it")
        .assert_contains("running")
        // The envelope, which was inert template text before anything rendered it.
        .assert_contains("YOUR TASK: the cache returns a stale entry")
        .assert_contains("You may modify only: src/**");

    let wt = org.path("config/run");
    assert!(
        wt.exists(),
        "worktree root should exist under the isolated config"
    );
    org.run(&["worktree"])
        .assert_ok("worktree list")
        .assert_contains("fix-it");

    // git agrees, and the branch is real.
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "--list", "wecode/fix-it"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("wecode/fix-it"),
        "branch should exist"
    );
}

#[test]
fn start_creates_no_worktree_when_the_playbook_says_not_to() {
    let (org, _) = with_playbook("wt-docs");
    org.run(&[
        "task",
        "add",
        "write-docs",
        "--project",
        "caching",
        "--kind",
        "docs",
        "document the eviction policy",
        "--write",
        "docs/**",
    ])
    .assert_ok("task add");

    org.run(&["start", "write-docs"])
        .assert_ok("start")
        .assert_contains("no worktree")
        .assert_contains("running");
    org.run(&["worktree"]).assert_contains("no worktrees");
}

#[test]
fn a_subtask_shares_its_main_tasks_worktree() {
    // The rule that makes `parent` and `depends_on` do separate jobs: hierarchy picks
    // the tree, dependencies pick the order.
    let (org, _) = with_playbook("wt-shared");
    org.run(&[
        "task",
        "add",
        "fix-it",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("main task");
    org.run(&[
        "task",
        "add",
        "fix-it-test",
        "--project",
        "caching",
        "--kind",
        "bug",
        "--parent",
        "fix-it",
        "no test covers eviction of a stale entry",
        "--write",
        "src/**",
    ])
    .assert_ok("subtask shares its parent's scope legally");

    org.run(&["start", "fix-it-test"])
        .assert_ok("start subtask")
        .assert_contains("shared with fix-it")
        .assert_contains("wecode/fix-it");

    // One tree, not two.
    let listed = org.run(&["worktree"]).assert_ok("worktree").stdout.clone();
    assert_eq!(
        listed.lines().filter(|l| l.contains("fix-it")).count(),
        1,
        "exactly one worktree:\n{listed}"
    );

    // And removing it must be done via the owner.
    let r = org.run(&["worktree", "remove", "fix-it-test"]);
    assert!(!r.ok());
    r.assert_contains("shares").assert_contains("fix-it");
}

#[test]
fn removing_a_worktree_refuses_to_discard_uncommitted_work() {
    let (org, _) = with_playbook("wt-dirty");
    org.run(&[
        "task",
        "add",
        "fix-it",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");

    // Nothing has committed this work — wecode does that, after checks pass — so
    // removing the tree would lose it outright.
    //
    // The path is read from `start` rather than guessed: the run directory is keyed on
    // the workspace directory name, not the test name.
    let started = org.run(&["start", "fix-it"]);
    let wt = PathBuf::from(
        started
            .stdout
            .lines()
            .find_map(|l| l.trim().strip_prefix("worktree "))
            .expect("start prints the worktree path")
            .trim()
            .trim_end_matches(" (reset)"),
    );
    assert!(wt.is_dir(), "{wt:?} should exist");
    std::fs::write(wt.join("new.rs"), "fn x() {}\n").unwrap();

    let r = org.run(&["worktree", "remove", "fix-it"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("uncommitted").assert_contains("new.rs");

    org.run(&["worktree", "remove", "fix-it", "--force"])
        .assert_ok("forced")
        .assert_contains("discarded");
    org.run(&["worktree"]).assert_contains("no worktrees");
}

#[test]
fn start_refuses_a_task_that_is_not_ready() {
    let (org, _) = with_playbook("wt-blocked");
    for (id, title) in [
        ("first", "the cache returns a stale entry after eviction"),
        ("second", "record the cache hit rate"),
    ] {
        let mut args = vec![
            "task",
            "add",
            id,
            "--project",
            "caching",
            "--kind",
            "bug",
            title,
            "--write",
        ];
        args.push(if id == "first" {
            "src/a/**"
        } else {
            "src/b/**"
        });
        if id == "second" {
            args.extend(["--after", "first"]);
        }
        org.run(&args).assert_ok(id);
    }
    let r = org.run(&["start", "second"]);
    r.assert_contains("not ready").assert_contains("first");
}

// ----------------------------------------------------------------- brief ------

#[test]
fn brief_states_what_this_seat_may_and_may_not_do() {
    let (org, _) = with_playbook("brief-chief");
    let r = org.run(&["brief"]);
    r.assert_ok("brief");
    r.assert_contains("as `chief`")
        .assert_contains("YOU MAY")
        .assert_contains("task add")
        .assert_contains("YOU MAY NOT")
        // The chief holds define and staff precisely so it cannot execute.
        .assert_contains("write files")
        .assert_contains("NEVER")
        .assert_contains("caching");
}

#[test]
fn brief_tells_a_worker_something_different_from_the_chief() {
    // Derived from the grant, not a stored per-role prompt — so a seat with no
    // `define` must not be told to create tasks.
    let org = Org::unattended("brief-worker", "software-company");
    org.repo();
    org.run(&["login", "you", "--as", "impl"])
        .assert_ok("login");
    let out = org.run(&["brief"]).assert_ok("brief").all();
    assert!(
        !out.contains("task add"),
        "an engineer cannot define:\n{out}"
    );
    assert!(out.contains("wecode ready"), "{out}");
}

// -------------------------------------------------------- project status ------

#[test]
fn a_project_status_can_be_set_by_hand() {
    // The point of a declared status: `done` is a judgement, not a rollup, so it must
    // be settable with work outstanding.
    let (org, _) = with_playbook("proj-status");
    org.run(&[
        "task",
        "add",
        "unfinished",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");

    let r = org.run(&["status", "caching", "done"]);
    r.assert_ok("set project status")
        .assert_contains("draft → done")
        .assert_contains("1 task still open");

    org.run(&["show", "caching"])
        .assert_contains("status     done");
}

#[test]
fn an_unknown_project_status_lists_the_real_ones() {
    let (org, _) = with_playbook("proj-status-bad");
    let r = org.run(&["status", "caching", "finished"]);
    assert!(!r.ok());
    r.assert_contains("unknown project status")
        .assert_contains("dropped");
}

#[test]
fn status_still_resolves_tasks_and_says_so_when_neither_matches() {
    let (org, _) = with_playbook("proj-status-task");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    org.run(&["status", "t", "done"])
        .assert_ok("task status still works")
        .assert_contains("→ done");

    let r = org.run(&["status", "ghost", "done"]);
    assert!(!r.ok());
    r.assert_contains("no project or task");
}

// --------------------------------------------------------------- archive ------

#[test]
fn archiving_hides_a_project_until_all_is_asked_for() {
    let (org, _) = with_playbook("arch-hide");
    org.run(&["archive", "caching"])
        .assert_ok("archive")
        .assert_contains("archived caching");

    org.run(&["tree"])
        .assert_ok("tree")
        .assert_contains("every project is archived");
    org.run(&["tree", "--all"])
        .assert_ok("tree --all")
        .assert_contains("caching")
        .assert_contains("archived");

    org.run(&["unarchive", "caching"])
        .assert_ok("unarchive")
        .assert_contains("visible again");
    org.run(&["tree"]).assert_contains("caching");
}

#[test]
fn archiving_parks_the_work_rather_than_only_hiding_it() {
    // The scheduler will scan live projects only, so `ready` has to agree with it.
    let (org, _) = with_playbook("arch-park");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    org.run(&["assign", "t", "--to", "impl"])
        .assert_ok("assign");
    org.run(&["ready"]).assert_contains("t");

    org.run(&["archive", "caching"]).assert_ok("archive");
    org.run(&["ready"])
        .assert_ok("ready")
        .assert_lacks("stale entry");

    org.run(&["unarchive", "caching"]).assert_ok("unarchive");
    org.run(&["ready"]).assert_contains("stale entry");
}

#[test]
fn archiving_refuses_to_hide_work_that_is_mid_flight() {
    let (org, _) = with_playbook("arch-live");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    org.run(&["assign", "t", "--to", "impl"])
        .assert_ok("assign");
    org.run(&["start", "t"]).assert_ok("start");

    let r = org.run(&["archive", "caching"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("mid-flight").assert_contains("t");

    org.run(&["archive", "caching", "--force"])
        .assert_ok("forced")
        .assert_contains("archived");
}

#[test]
fn archiving_is_idempotent_and_says_so() {
    let (org, _) = with_playbook("arch-twice");
    org.run(&["archive", "caching"]).assert_ok("archive");
    org.run(&["archive", "caching"])
        .assert_ok("second time is not an error")
        .assert_contains("already archived");
}

#[test]
fn an_archived_project_stays_reachable_by_name() {
    // Hiding must not make a project unusable — only unlisted.
    let (org, _) = with_playbook("arch-reach");
    org.run(&["archive", "caching"]).assert_ok("archive");

    org.run(&["show", "caching"])
        .assert_ok("show still works")
        .assert_contains("objective");
    org.run(&["playbook", "bug", "--project", "caching"])
        .assert_ok("playbook still resolves")
        .assert_contains("Reproduce first");
    org.run(&["status", "caching", "done"])
        .assert_ok("status still works");
}

#[test]
fn a_worktree_in_an_archived_project_is_still_listed() {
    // Otherwise archiving orphans the checkout: invisible, and impossible to clean up.
    let (org, _) = with_playbook("arch-wt");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    org.run(&["start", "t"]).assert_ok("start");
    org.run(&["archive", "caching", "--force"])
        .assert_ok("archive");

    org.run(&["worktree"])
        .assert_ok("worktree")
        .assert_contains("t");
    org.run(&["worktree", "remove", "t"])
        .assert_ok("removable while archived");
}

#[test]
fn archive_applies_to_projects_not_tasks() {
    let (org, _) = with_playbook("arch-task");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    let r = org.run(&["archive", "t"]);
    assert!(!r.ok());
    r.assert_contains("projects, not tasks");
}

// ----------------------------------------------------------- task scope ------

#[test]
fn a_scope_can_be_amended_without_erasing_what_was_recorded() {
    // Re-planning, not laundering. The ledger is append-only, so widening a scope
    // lets a later verify pass while the earlier violation stays visible.
    let (org, repo) = with_playbook("scope-amend");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "declared/**",
    ])
    .assert_ok("task add");

    // Work that lands outside the declared scope.
    std::fs::write(repo.join("elsewhere.rs"), "fn x() {}\n").unwrap();
    org.run(&["verify", "t"])
        .assert_ok("verify runs")
        .assert_contains("outside scope")
        .assert_contains("failed");
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_contains("elsewhere.rs");

    org.run(&["task", "scope", "t", "--write", "elsewhere.rs"])
        .assert_ok("amend")
        .assert_contains("was  declared/**")
        .assert_contains("now  elsewhere.rs");

    org.run(&["verify", "t"])
        .assert_ok("verify again")
        .assert_lacks("outside scope");

    // The point: the old denial is still on the record.
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_contains("elsewhere.rs");
}

#[test]
fn amending_a_scope_into_a_collision_is_refused() {
    let (org, _) = with_playbook("scope-collide");
    for (id, glob) in [("a", "one/**"), ("b", "two/**")] {
        org.run(&[
            "task",
            "add",
            id,
            "--project",
            "caching",
            "--kind",
            "bug",
            "the cache returns a stale entry after eviction",
            "--write",
            glob,
        ])
        .assert_ok(id);
    }
    // Widening `a` onto `b`'s files is a real conflict, not a formality.
    let r = org.run(&["task", "scope", "a", "--write", "two/**"]);
    r.assert_contains("overlaps").assert_contains("not changed");

    org.run(&["task", "scope", "a", "--write", "two/**", "--force"])
        .assert_ok("forced")
        .assert_contains("now  two/**");
}

#[test]
fn amending_a_scope_needs_at_least_one_glob() {
    let (org, _) = with_playbook("scope-empty");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add");
    let r = org.run(&["task", "scope", "t"]);
    assert!(!r.ok());
    r.assert_contains("at least one");
}

// ------------------------------------------------------------------- run ------

/// A workspace whose `impl` post is a shell script rather than a coding CLI.
fn with_agent(name: &str, script: &str) -> (Org, PathBuf) {
    let (org, repo) = with_playbook(name);
    org.agent(script);
    (org, repo)
}

fn a_task(org: &Org, id: &str, glob: &str, accept: &str) {
    org.run(&[
        "task",
        "add",
        id,
        "--project",
        "caching",
        "--kind",
        "chore",
        "append a marker comment to the source",
        "--write",
        glob,
        "--write",
        ".wecode/run/**",
        "--accept-cmd",
        accept,
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("task add");
}

#[test]
fn run_spawns_the_agent_and_verifies_what_it_did() {
    let (org, _) = with_agent("run-ok", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    let r = org.run(&["run", "t"]);
    r.assert_ok("run")
        .assert_contains("post     impl")
        .assert_contains("exit 0")
        .assert_contains("✓ a.txt")
        .assert_contains("passed");
    org.run(&["show", "t"]).assert_contains("status     done");
}

#[test]
fn a_failing_agent_is_not_verified() {
    // Verification would be meaningless: the work never finished.
    let (org, _) = with_agent("run-fail", "echo nope >&2; exit 4");
    a_task(&org, "t", "a.txt", "true");

    org.run(&["run", "t"])
        .assert_ok("command itself succeeds")
        .assert_contains("exit 4")
        .assert_contains("not verified");
    org.run(&["show", "t"]).assert_contains("status     failed");
}

#[test]
fn work_outside_the_declared_scope_fails_a_run_that_exited_cleanly() {
    // The case the whole design turns on: the agent says it succeeded, and the diff
    // says it went somewhere it was not allowed.
    let (org, _) = with_agent(
        "run-scope",
        "echo done >> a.txt; echo sneaky >> elsewhere.txt",
    );
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    let r = org.run(&["run", "t"]);
    r.assert_contains("exit 0")
        .assert_contains("elsewhere.txt")
        .assert_contains("outside scope")
        .assert_contains("failed");
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_contains("elsewhere.txt");
}

#[test]
fn an_agent_that_hangs_is_killed_on_its_idle_limit() {
    let (org, _) = with_agent("run-idle", "sleep 60");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, text.replace("idle_secs = 300", "idle_secs = 1")).unwrap();
    a_task(&org, "t", "a.txt", "true");

    let r = org.run(&["run", "t"]);
    r.assert_contains("no output")
        .assert_contains("not verified");
    org.run(&["show", "t"]).assert_contains("status     failed");
}

#[test]
fn the_agent_is_launched_where_the_task_says_and_the_launch_is_recorded() {
    let (org, _) = with_agent("run-record", "pwd > where.txt; echo done >> a.txt");
    a_task(&org, "t", "*.txt", "grep -q done a.txt");
    org.run(&["run", "t"]).assert_ok("run");

    // The configured launch line reaches the ledger, prompt placeholder intact.
    org.run(&["audit", "--task", "t"])
        .assert_contains("sh -c")
        .assert_contains("exit 0");
}

#[test]
fn an_unassigned_task_cannot_be_run() {
    // There is no post to name an agent, so there is nothing to launch. The fixture
    // playbook has no [chore] section, so nothing fills the assignee either.
    let (org, _) = with_agent("run-unassigned", "true");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "chore",
        "append a marker comment to the source",
        "--write",
        "a.txt",
        "--accept-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "5",
    ])
    .assert_ok("task add");

    let r = org.run(&["run", "t"]);
    assert!(!r.ok());
    r.assert_contains("unassigned")
        .assert_contains("wecode assign");
}

#[test]
fn running_a_task_that_does_not_exist_says_so() {
    let (org, _) = with_agent("run-ghost", "true");
    let r = org.run(&["run", "ghost"]);
    assert!(!r.ok());
    r.assert_contains("no such task");
}

#[test]
fn a_charter_forbidden_launch_is_refused_before_anything_runs() {
    // Invariants outrank configuration: an agent template that would run a forbidden
    // command is itself the bug, and is caught before the process starts.
    let (org, _) = with_agent("run-charter", "true");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        text.replace("never_run = [", "never_run = [\"sh *\", "),
    )
    .unwrap();
    a_task(&org, "t", "a.txt", "true");

    let r = org.run(&["run", "t"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("charter forbids")
        .assert_contains("never_run");
}

#[test]
fn naming_a_post_on_task_add_assigns_it_rather_than_half_assigning_it() {
    // A task left `draft` with an assignee is invisible to `ready` and to the loop,
    // with nothing on screen saying why. The playbook fills assign_to on most tasks,
    // so this was the common case.
    let (org, _) = with_playbook("add-assigns");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
    ])
    .assert_ok("task add")
    .assert_contains("draft → waiting");

    org.run(&["ready"]).assert_contains("t");
}

#[test]
fn a_post_that_cannot_reach_the_work_keeps_the_task_but_not_the_assignment() {
    // Refusing outright would discard a whole declaration over a post that one flag
    // could change.
    let (org, _) = with_playbook("add-uncovered");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "somewhere-else/**",
    ])
    .assert_ok("the task is still created")
    .assert_contains("not assigned")
    .assert_contains("may not write");

    org.run(&["show", "t"]).assert_contains("status     draft");
    org.run(&["ready"]).assert_lacks("stale entry");
}

#[test]
fn declaring_the_worker_area_does_not_break_assignment() {
    // `verify` exempts .wecode/run/** because the envelope tells the agent to write
    // there. The assign-time check has to agree, or declaring it fails one and passes
    // the other.
    let (org, _) = with_playbook("worker-area");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "bug",
        "the cache returns a stale entry after eviction",
        "--write",
        "src/**",
        "--write",
        ".wecode/run/**",
    ])
    .assert_ok("task add")
    .assert_contains("draft → waiting")
    .assert_lacks("not assigned");
}
