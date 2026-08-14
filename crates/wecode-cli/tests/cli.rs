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

    /// Plants the committed toy fixture as a real git repository, and points the
    /// workspace's `app` repo at it.
    ///
    /// Copied from `fixtures/toy/` rather than generated inline: a fixture that lives
    /// in the tree can be read, changed deliberately, and reproduced by hand a week
    /// later. It cannot be committed *as* a repository — nested repos — so `git init`
    /// happens here.
    fn repo(&self) -> PathBuf {
        let repo = self.dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        copy_dir(&fixture_root().join("toy"), &repo);
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            git(&repo, &args);
        }
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "the toy fixture"]);

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
        // Matched by shape rather than by literal, so adding a flag to the shipped
        // template does not silently turn every stub agent into `sh --allowedTools`.
        let args = format!("args = [\"-c\", \"{}\"]", script.replace('"', "\\\""));
        let replaced: String = text
            .replace("command = \"claude\"", "command = \"sh\"")
            .lines()
            .map(|l| {
                if l.starts_with("args = [\"-p\"") {
                    args.clone()
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_ne!(replaced, text, "agent template was not replaced");
        std::fs::write(&conf, replaced).unwrap();
    }

    /// The fixture with its playbook removed, for the tests about not having one.
    fn repo_without_playbook(&self) -> PathBuf {
        let repo = self.repo();
        std::fs::remove_file(repo.join(".wecode/playbook.toml")).unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "no playbook"]);
        repo
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

    /// Every worktree the workspace has recorded, tombstones included.
    ///
    /// Read out of the database the binary wrote, because no command prints it yet —
    /// making it visible is `worktree-view`'s job, and it depends on this. Until then
    /// opening the file is the only way to prove the writes actually happen.
    fn recorded(&self) -> Vec<wecode_store::Worktree> {
        wecode_store::Store::open(self.dir.join("wecode.db"))
            .expect("the workspace database")
            .worktrees()
            .expect("the registry")
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

/// Where the committed fixtures live, independent of the test's working directory.
fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/wecode-cli has a workspace root")
        .join("fixtures")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).expect("fixture exists").flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if src.is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
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
fn company_show_says_which_model_each_seat_is_staffed_with() {
    // The gap this closes: the most expensive variable in the system used to be
    // decided by whatever the operator last typed at `/model`, and nothing recorded
    // it. Here it is a column, beside the level the file actually declares.
    let org = Org::new("levels", "software-company");
    org.run(&["company", "show"])
        .assert_ok("company show")
        .assert_contains("model")
        // `impl` sits at 5 against a three-model catalogue, which is the middle one.
        .assert_contains("sonnet (5)")
        // And the catalogue the numbers are matched against, so the column is not
        // a model chosen by magic.
        .assert_contains("models, weakest first")
        .assert_contains("haiku")
        // The tester's harness declares none, and says so rather than showing blank.
        .assert_contains("harness default");
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

#[test]
fn a_chain_stays_admissible_past_its_second_link() {
    // Ordering is transitive, so the overlap exemption must be too. The third link
    // here shares the first's scope and can never run beside it.
    let org = Org::new("overlap-chain", "solo");
    org.seed();
    let add = |id: &str, after: &str, glob: &str| {
        org.run(&[
            "task",
            "add",
            id,
            "a link in the chain",
            "--project",
            "caching",
            "--after",
            after,
            "--accept-cmd",
            "cargo test",
            "--write",
            glob,
            "--tokens",
            "1000",
        ])
    };
    // Seeded: cache-tests (tests/**) <- bench. The fourth link below shares
    // cache-tests' scope, three edges upstream.
    add("link-two", "bench", "crates/two/**").assert_contains("admitted");
    add("link-three", "link-two", "tests/**")
        .assert_ok("third link")
        .assert_contains("admitted");
}

/// Declares a second repository, so a test can put two projects on different ones.
///
/// The path need not exist: nothing resolves it until a task starts, and the point
/// here is which name a project registers, not what is checked out under it.
fn second_repo(org: &Org, name: &str) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[[repos]]\nname = \"{name}\"\npath = \"~/projects/{name}\"\n"),
    )
    .unwrap();
}

/// A second project, so its tasks meet the seeded ones across a project boundary.
fn second_project(org: &Org, id: &str, repo: &str) {
    org.run(&[
        "project",
        "add",
        id,
        "cut the export payload in half",
        "--repo",
        repo,
        "--measure-cmd",
        "cargo test",
        "--tokens",
        "200000",
        "--wall",
        "1800",
    ])
    .assert_ok("add second project");
}

/// A task on `tests/**` — the paths the seeded `cache-tests` already claims.
fn claims_the_seeded_scope(org: &Org, id: &str, project: &str, after: Option<&str>) -> Run {
    let mut args = vec![
        "task",
        "add",
        id,
        "extend the export tests",
        "--project",
        project,
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/**",
        "--tokens",
        "1000",
    ];
    if let Some(dep) = after {
        args.extend_from_slice(&["--after", dep]);
    }
    org.run(&args)
}

#[test]
fn a_second_project_on_the_same_repo_may_not_claim_the_same_files() {
    // The gap using wecode on itself kept finding. A repository carries as many
    // projects as anyone starts, and the overlap check only ever looked inside one
    // of them — so both admitted a task on the same paths, and nothing said no until
    // two worktrees came back having changed the same lines.
    let org = Org::new("overlap-cross", "solo");
    org.seed();
    second_project(&org, "exports", "app");

    let r = claims_the_seeded_scope(&org, "export-tests", "exports", None);
    r.assert_contains("overlaps")
        .assert_contains("cache-tests")
        // The reader is looking at `exports` and will not find `cache-tests` on it.
        .assert_contains("caching")
        .assert_contains("not saved");
}

#[test]
fn projects_on_different_repos_do_not_collide() {
    // The control. Identical globs against different checkouts are different files,
    // and without this the check would refuse most of a company's board at once.
    let org = Org::new("overlap-cross-repos", "solo");
    org.seed();
    second_repo(&org, "other");
    second_project(&org, "exports", "other");

    claims_the_seeded_scope(&org, "export-tests", "exports", None)
        .assert_ok("different repo")
        .assert_contains("admitted")
        .assert_lacks("overlaps");
}

#[test]
fn a_dependency_across_projects_settles_a_shared_scope() {
    // The repair the message offers has to work across the boundary it reports, or
    // the only way past the gate is --force. A dependency may name any task in the
    // plan, and ordering removes the conflict the same way it does for siblings.
    let org = Org::new("overlap-cross-seq", "solo");
    org.seed();
    second_project(&org, "exports", "app");

    claims_the_seeded_scope(&org, "export-tests", "exports", Some("cache-tests"))
        .assert_ok("sequenced across projects")
        .assert_contains("admitted");
}

#[test]
fn archiving_a_project_stops_its_tasks_claiming_files() {
    // Archiving parks a project: the scheduler never dispatches from it, so its
    // tasks cannot be running while anything else is. Reporting one would say "could
    // run at the same time" about work that cannot start at all — and unarchiving is
    // all it takes to get the conflict back.
    let org = Org::new("overlap-cross-parked", "solo");
    org.seed();
    second_project(&org, "exports", "app");
    org.run(&["archive", "caching"]).assert_ok("archive");

    claims_the_seeded_scope(&org, "export-tests", "exports", None)
        .assert_ok("parked is not competition")
        .assert_contains("admitted");

    org.run(&["unarchive", "caching"]).assert_ok("unarchive");
    org.run(&["check", "export-tests"])
        .assert_contains("overlaps")
        .assert_contains("cache-tests");
}

#[test]
fn widening_a_scope_onto_another_projects_files_is_refused() {
    // `task scope` re-runs the same check, so the hole would reopen through the back
    // door if only `task add` had been widened.
    let org = Org::new("overlap-cross-scope", "solo");
    org.seed();
    second_project(&org, "exports", "app");
    org.run(&[
        "task",
        "add",
        "export-writer",
        "rewrite the export writer",
        "--project",
        "exports",
        "--accept-cmd",
        "cargo test",
        "--write",
        "crates/export/**",
        "--tokens",
        "1000",
    ])
    .assert_ok("add on its own paths")
    .assert_contains("admitted");

    org.run(&["task", "scope", "export-writer", "--write", "tests/**"])
        .assert_contains("overlaps")
        .assert_contains("caching")
        .assert_contains("not changed");
}

// -------------------------------------------------------------- design ---------

#[test]
fn a_design_that_passes_waits_for_a_signature_rather_than_finishing() {
    // Every other kind is done when its acceptance passes. A design is a proposal,
    // and whether it is the right one is exactly what no command can check.
    let (org, _) = with_agent("design-sign", "mkdir -p docs && echo proposal > docs/d.md");
    org.run(&[
        "task",
        "add",
        "d",
        "propose how threading is reconstructed",
        "--project",
        "caching",
        "--kind",
        "design",
        "--accept-cmd",
        "test -f docs/d.md",
        "--write",
        "docs/**",
        "--tokens",
        "1000",
        "--to",
        "impl",
    ])
    .assert_ok("add design");

    org.run(&["run", "d"])
        .assert_ok("run")
        .assert_contains("passed");
    org.run(&["show", "d"]).assert_contains("needs-approval");

    // Nothing downstream may treat it as settled until someone signs.
    org.run(&["approve", "design", "--task", "d"])
        .assert_ok("approve design")
        .assert_contains("needs-approval → done");
    org.run(&["show", "d"]).assert_contains("done");
}

#[test]
fn a_design_step_waits_for_its_signature_even_though_it_is_a_subtask() {
    // The exception to a step finishing when it passes, and it is there for the other
    // reason: a step has nothing of its own to land, but a design has nothing landing
    // would settle. The document exists — all a command can check — and whether it is
    // the right design is exactly the part no command can. The steps built on it must
    // not start on the strength of a file being present.
    let (org, _) = with_agent("design-step", "mkdir -p docs && echo proposal > docs/d.md");
    org.run(&[
        "task",
        "add",
        "threading",
        "reconstruct threading in the export writer",
        "--project",
        "caching",
        "--kind",
        "chore",
        "--accept-cmd",
        "true",
        "--write",
        "src/**",
        "--tokens",
        "1000",
        "--to",
        "impl",
    ])
    .assert_ok("main task");
    org.run(&[
        "task",
        "add",
        "threading-design",
        "propose how threading is reconstructed",
        "--project",
        "caching",
        "--kind",
        "design",
        "--parent",
        "threading",
        "--accept-cmd",
        "test -f docs/d.md",
        "--write",
        "docs/**",
        "--tokens",
        "1000",
        "--to",
        "impl",
    ])
    .assert_ok("design step");

    org.run(&["run", "threading-design"])
        .assert_ok("run")
        .assert_contains("passed")
        .assert_contains("passing is not approval");
    org.run(&["show", "threading-design"])
        .assert_contains("status     needs-approval");
    org.run(&["approve", "design", "--task", "threading-design"])
        .assert_ok("sign")
        .assert_contains("needs-approval → done");
}

#[test]
fn only_a_design_is_signed_off_that_way() {
    let (org, _) = with_agent("design-wrong-kind", "true");
    a_task(&org, "t", "src/**", "true");
    let r = org.run(&["approve", "design", "--task", "t"]);
    assert!(!r.ok(), "a feature must not be signed off as a design");
    r.assert_contains("only a design is signed");
}

// ------------------------------------------------------------- task rm ---------

#[test]
fn a_task_that_never_ran_can_be_removed_outright() {
    // Distinct from dropping it. Dropping records a judgement; removing says the task
    // should not have existed, and leaving those on the board makes it a graveyard.
    let org = Org::new("task-rm", "solo");
    org.seed();
    org.run(&["task", "rm", "bench"])
        .assert_ok("rm")
        .assert_contains("removed bench");
    org.run(&["tree"]).assert_lacks("bench");

    // The ledger is not rewritten — that is the one thing an audit log must not do.
    org.run(&["audit", "--task", "bench"])
        .assert_ok("audit")
        .assert_contains("define");
}

#[test]
fn removing_a_task_something_waits_on_is_refused() {
    // Seeded: `bench` waits on `cache-tests`.
    let org = Org::new("task-rm-dep", "solo");
    org.seed();

    let r = org.run(&["task", "rm", "cache-tests"]);
    assert!(!r.ok(), "removing a prerequisite must be refused");
    r.assert_contains("waited on by bench");
    // Refused, not half-done.
    org.run(&["tree"]).assert_contains("cache-tests");
}

#[test]
fn a_task_that_ran_is_history_and_cannot_be_removed() {
    let (org, _) = with_agent("task-rm-ran", "true");
    a_task(&org, "t", "src/**", "true");
    org.run(&["run", "t"]).assert_ok("run");

    let r = org.run(&["task", "rm", "t"]);
    assert!(!r.ok(), "a task with an execution must not be removable");
    r.assert_contains("it ran, so it is history");
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
fn dropping_a_prerequisite_flags_the_chain_it_strands() {
    // bench waits on cache-tests. Drop the prerequisite and bench can never
    // advance on its own — no tick promotes it, no agent is dispatched to it.
    // Every surface has to say so, or the chain sits green until someone digs.
    let org = Org::new("stuck-chain", "software-company");
    org.seed();
    org.run(&["assign", "bench", "--to", "test"])
        .assert_ok("assign");

    // Flagged at the moment of the act, when reconsidering is still cheap.
    org.run(&["status", "cache-tests", "dropped"])
        .assert_ok("drop")
        .assert_contains("now stuck behind it: bench");

    org.run(&["board"])
        .assert_ok("board")
        .assert_contains("stuck on cache-tests (dropped)")
        .assert_contains("1 stuck");
    org.run(&["ready"])
        .assert_ok("ready")
        .assert_contains("stuck on failed or dropped work");
    org.run(&["show", "bench"])
        .assert_ok("show")
        .assert_contains("will not finish on its own");

    // Reopening the prerequisite is exactly how the operator resolves it, so the
    // flag must come down by itself.
    org.run(&["status", "cache-tests", "waiting"])
        .assert_ok("reopen");
    org.run(&["ready"]).assert_ok("ready").assert_lacks("stuck");
    org.run(&["board"]).assert_ok("board").assert_lacks("stuck");
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
fn the_board_shows_four_columns_at_every_level() {
    let org = Org::new("board", "software-company");
    org.seed();
    for args in [vec!["board"], vec!["board", "caching"]] {
        let r = org.run(&args);
        r.assert_ok("board");
        for col in ["what", "status", "spend", "needs you"] {
            r.assert_contains(col);
        }
        // The columns that said nothing: health repeated the needs-you cell, and
        // a leaf's progress bar restated its status.
        r.assert_lacks("health").assert_lacks("progress");
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

// --------------------------------------------------------- short numbers ------

/// `seed()` creates `caching`, then `cache-tests`, then `bench` — one sequence across
/// both levels, so the numbers are 1, 2, 3 in that order. Named here rather than
/// recomputed in each test below.
const CACHING: &str = "1";
const CACHE_TESTS: &str = "2";
const BENCH: &str = "3";

#[test]
fn the_plan_views_print_a_number_beside_everything() {
    let org = Org::new("numbers-shown", "software-company");
    org.seed();

    let tree = org.run(&["tree"]);
    tree.assert_ok("tree");
    // A project and both tasks, each with its handle, and the line that says the
    // column can be typed.
    for n in ["#1", "#2", "#3"] {
        tree.assert_contains(n);
    }
    tree.assert_contains("wecode show 4");

    org.run(&["board"]).assert_ok("board").assert_contains("#2");
    org.run(&["show", "cache-tests"])
        .assert_ok("show")
        .assert_contains("#2");
}

#[test]
fn a_number_works_wherever_an_id_does() {
    let org = Org::new("numbers-resolve", "software-company");
    org.seed();

    // Reading: both levels, and the two commands that take either.
    org.run(&["show", CACHING])
        .assert_ok("show a project by number")
        .assert_contains("caching");
    org.run(&["show", CACHE_TESTS])
        .assert_ok("show a task by number")
        .assert_contains("cover the cache layer with tests");
    org.run(&["check", BENCH])
        .assert_ok("check by number")
        .assert_contains("bench");
    org.run(&["board", CACHE_TESTS])
        .assert_ok("board by number")
        .assert_contains("L2 · cache-tests");

    // Writing. `assign` is the one that goes past the Broker and onto the ledger.
    org.run(&["assign", CACHE_TESTS, "--to", "test"])
        .assert_ok("assign by number")
        .assert_contains("assigned cache-tests");
    org.run(&["status", BENCH, "dropped"])
        .assert_ok("status by number")
        .assert_contains("bench");
    org.run(&["archive", CACHING])
        .assert_ok("archive by number")
        .assert_contains("archived caching");
}

#[test]
fn the_ledger_records_the_id_a_number_named_and_not_the_number() {
    // The number is a way of typing, never a way of storing. A record filed under `2`
    // is a record no later query correlates with anything.
    let org = Org::new("numbers-ledger", "software-company");
    org.seed();
    org.run(&["assign", CACHE_TESTS, "--to", "test"])
        .assert_ok("assign");

    // The query is keyed on `task_id`, so a filter by number returning the record is
    // proof the number became an id before it was written down. Compared against the
    // filter by id, because either being empty would pass a bare `contains`.
    let by_id = org.run(&["audit", "--task", "cache-tests"]);
    by_id.assert_ok("audit by id").assert_contains("staff");
    let by_number = org.run(&["audit", "--task", CACHE_TESTS]);
    by_number.assert_ok("audit by number");
    assert_eq!(
        by_id.stdout, by_number.stdout,
        "a number and the id it names have to select the same records"
    );
}

#[test]
fn a_number_is_stable_across_a_removal() {
    // The property the whole feature rests on: a number in a message sent six hours
    // ago still names what it named. A recycled number would sign the wrong task.
    let org = Org::new("numbers-stable", "software-company");
    org.seed();
    org.run(&["task", "rm", "bench"]).assert_ok("rm");
    org.run(&[
        "task",
        "add",
        "later",
        "warm the cache on deploy",
        "--project",
        "caching",
        // Sequenced after cache-tests, whose `tests/**` covers this, or admission
        // refuses the overlap and nothing is saved to number.
        "--after",
        "cache-tests",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/later/**",
        "--tokens",
        "10000",
    ])
    .assert_ok("add after the removal")
    .assert_contains("saved");

    let tree = org.run(&["tree"]);
    tree.assert_ok("tree").assert_contains("#4");
    // `bench` was #3 and `later` must not have inherited it.
    org.run(&["show", BENCH])
        .assert_contains("no project or task");
    org.run(&["show", "4"])
        .assert_ok("the new task has the next number")
        .assert_contains("later");
}

#[test]
fn a_task_named_for_a_number_keeps_its_own_name() {
    // The collision rule. A bare digit string is a name first, so a workspace that has
    // a task called `2` keeps it — and `#2` is how the number is still reached.
    let org = Org::new("numbers-collide", "software-company");
    org.seed();
    org.run(&[
        "task",
        "add",
        "2",
        "sweep the stale cache entries",
        "--project",
        "caching",
        "--after",
        "cache-tests",
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/sweep/**",
        "--tokens",
        "10000",
    ])
    .assert_ok("a task may be called 2")
    .assert_contains("saved");

    org.run(&["show", "2"])
        .assert_ok("show")
        .assert_contains("sweep the stale cache entries");
    org.run(&["show", "#2"])
        .assert_ok("show")
        .assert_contains("cover the cache layer with tests");
}

#[test]
fn a_number_naming_nothing_says_where_to_find_one() {
    let org = Org::new("numbers-missing", "software-company");
    org.seed();
    let r = org.run(&["merge", "99"]);
    assert!(!r.ok(), "99 names nothing");
    r.assert_contains("no such task: 99")
        .assert_contains("wecode tree");
}

#[test]
fn task_add_takes_numbers_for_the_work_it_points_at() {
    // `--project`, `--parent` and `--after` name existing work, so they resolve. The
    // task's own id does not: `task add 7` creates a task called `7`.
    let org = Org::new("numbers-planning", "software-company");
    org.seed();
    org.run(&[
        "task",
        "add",
        "evict",
        "evict entries past their ttl",
        "--project",
        CACHING,
        "--after",
        CACHE_TESTS,
        "--parent",
        BENCH,
        "--accept-cmd",
        "cargo test",
        "--write",
        "tests/evict/**",
        "--tokens",
        "10000",
    ])
    .assert_ok("plan by number");

    let shown = org.run(&["show", "evict"]);
    shown
        .assert_ok("show")
        .assert_contains("caching")
        .assert_contains("cache-tests")
        .assert_contains("bench");
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
fn the_command_reference_is_the_help_verbatim() {
    // docs/reference/commands.md opens by claiming it cannot drift from `wecode help`.
    // Nothing enforced that until this test, and adding one flag to the usage was
    // enough to make the claim false.
    let doc = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("crates/wecode-cli has a workspace root")
            .join("docs/reference/commands.md"),
    )
    .expect("the command reference exists");

    let fenced: String = doc
        .lines()
        .skip_while(|l| *l != "```")
        .skip(1)
        .take_while(|l| *l != "```")
        .map(|l| format!("{l}\n"))
        .collect();
    assert!(!fenced.is_empty(), "no fenced block in commands.md");
    assert_eq!(
        fenced,
        bare(&["help"]).stdout,
        "docs/reference/commands.md is stale — paste `wecode help` into its code block"
    );
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

[chore]
worktree = true
assign_to = "impl"
accept = ["true"]
tokens = 1000
wall_secs = 60
guidance = "Uses a worktree, like most work here."

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
    with_playbook_body(name, PLAYBOOK)
}

/// The same, with guidance the test states itself — for the settings the shared
/// constant deliberately does not carry.
fn with_playbook_body(name: &str, body: &str) -> (Org, PathBuf) {
    let org = Org::new(name, "solo");
    let repo = org.repo();
    org.playbook(&repo, body);
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
    let repo = org.repo_without_playbook();
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
        .assert_contains("playbook.toml")
        // Every decision the starter made on the project's behalf is reported, not
        // left in the file for whoever thinks to open it.
        .assert_contains("cargo test --workspace")
        .assert_contains("CARGO_TARGET_DIR = ~/.cache/wecode/repo/target");
    assert!(repo.join(".wecode/playbook.toml").is_file());

    // The starter must be valid, or adoption fails at the first step — and the
    // commands it wrote are the ones the project now runs.
    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("rust")
        .assert_contains("bug")
        .assert_contains("cargo test --workspace");

    // And it refuses to overwrite.
    let again = org.run(&["playbook", "init"]);
    assert!(!again.ok());
    again.assert_contains("already exists");
}

#[test]
fn playbook_init_reads_the_toolchain_off_the_repository() {
    // The flag that gets left off. A project scaffolded without `--language` used to
    // get `accept = []` and a TODO for every kind, and the first task paid for it.
    let org = Org::new("pb-init-detect", "solo");
    let repo = org.repo_without_playbook();
    std::fs::write(repo.join("Cargo.toml"), "[package]\nname = \"toy\"\n").unwrap();
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

    org.run(&["playbook", "init"])
        .assert_ok("playbook init")
        .assert_contains("read off Cargo.toml")
        .assert_contains("cargo clippy --all-targets -- -D warnings");

    let text = std::fs::read_to_string(repo.join(".wecode/playbook.toml")).unwrap();
    assert!(text.contains("language = \"rust\""), "{text}");
    assert!(text.contains("[project.build_cache]"), "{text}");
    // And the trap that cost a task: the file a build rewrites, said where a planner
    // reads it rather than left to be discovered by a scope violation.
    assert!(text.contains("Cargo.lock"), "{text}");
}

#[test]
fn playbook_init_says_when_this_machine_cannot_run_what_it_wrote() {
    // A starter names a real test command, so it can name one this machine does not
    // have — the mistake wemail made with `python -m pytest`. The file is still
    // written: it is right for the repository and wrong only here.
    let org = Org::new("pb-init-absent", "solo");
    org.repo_without_playbook();
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

    let out = org.run(&["playbook", "init", "--language", "python"]);
    out.assert_ok("playbook init");
    if which("uv").is_none() {
        out.assert_contains("not on this machine")
            .assert_contains("uv");
    }
}

/// Whether `sh` could start this program here. The same question the playbook's
/// load-time check asks, asked by a test that must pass on either kind of machine.
fn which(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|p| p.is_file())
    })
}

#[test]
fn a_project_with_no_playbook_says_how_to_make_one() {
    let org = Org::new("pb-absent", "solo");
    org.repo_without_playbook();
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
    // `refactor` has no section, so nothing is filled and the task is bare.
    org.run(&[
        "task",
        "add",
        "tidy",
        "--project",
        "caching",
        "--kind",
        "refactor",
        "remove the deprecated export helper",
        "--write",
        "src/**",
    ])
    .assert_lacks("(from playbook)");
}

#[test]
fn a_playbook_naming_a_program_the_machine_lacks_is_refused() {
    // Verification would find this as exit 127, after the budget is spent. The
    // playbook is refused at load instead, so the mistake costs an edit, not a task.
    let org = Org::new("pb-no-such-program", "solo");
    let repo = org.repo();
    org.playbook(
        &repo,
        "[bug]\nworktree = true\nassign_to = \"impl\"\n\
         accept = [\"definitely-not-a-real-binary-xyz --check\"]\n\
         tokens = 1000\nwall_secs = 60\n",
    );
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

    // Reading it refuses and names the program and the kind...
    let read = org.run(&["playbook", "bug"]);
    assert!(!read.ok(), "a broken playbook must not render");
    read.assert_contains("definitely-not-a-real-binary-xyz")
        .assert_contains("[bug]")
        .assert_contains("not on this machine");

    // ...and so does creating work against it — even with explicit acceptance,
    // because the file is wrong for this machine and the fix is one edit to it.
    let add = org.run(&[
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
        "true",
        "--to",
        "impl",
        "--tokens",
        "50",
        "--wall",
        "5",
    ]);
    assert!(!add.ok(), "task add must refuse a broken playbook");
    add.assert_contains("definitely-not-a-real-binary-xyz");
}

// ----------------------------------------------------------------- gaps ------

/// A task to attribute a finding to, of the kind the guidance is short on.
fn a_bug_task(org: &Org) {
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
}

const FOUND: &str = "put the test file in the write scope, or the scope check refuses the diff";

#[test]
fn a_gap_found_while_planning_reaches_whoever_reads_that_guidance_next() {
    // The whole point of the feature in one test: the finding goes in through the
    // orchestrator, and comes out where the next planner already looks.
    let (org, _) = with_playbook("pb-gap");
    a_bug_task(&org);

    org.run(&["playbook", "gap", FOUND, "--task", "fix-it"])
        .assert_ok("playbook gap")
        .assert_contains("recorded a gap")
        // The kind is taken from the task, so `--task` alone is the whole invocation.
        .assert_contains("[bug]")
        .assert_contains("note, not a change");

    org.run(&["playbook", "bug"])
        .assert_ok("playbook bug")
        .assert_contains(FOUND)
        .assert_contains("found on fix-it")
        // Still the guidance's page, not a replacement for it.
        .assert_contains("Reproduce first");

    // Filed against `bug`, so it is not noise on every other kind's page.
    org.run(&["playbook", "docs"])
        .assert_ok("playbook docs")
        .assert_lacks(FOUND);

    // The index counts them, so a reader who starts at the top knows to look.
    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("1 gap recorded");

    org.run(&["playbook", "gaps"])
        .assert_ok("playbook gaps")
        .assert_contains(FOUND)
        .assert_contains("playbook.toml");
}

#[test]
fn the_same_finding_recorded_twice_is_held_once() {
    // Something records these in a loop. A duplicate must cost a sentence rather
    // than an error or a second copy of the same paragraph.
    let (org, _) = with_playbook("pb-gap-twice");
    a_bug_task(&org);
    org.run(&["playbook", "gap", FOUND, "--task", "fix-it"])
        .assert_ok("first");
    org.run(&["playbook", "gap", FOUND, "--task", "fix-it"])
        .assert_ok("second")
        .assert_contains("already recorded");

    org.run(&["playbook", "gaps"])
        .assert_ok("gaps")
        .assert_contains("1 gap against");
}

#[test]
fn a_finding_about_no_kind_in_particular_is_shown_against_all_of_them() {
    let (org, _) = with_playbook("pb-gap-project");
    org.run(&[
        "playbook",
        "gap",
        "nothing here says which branch work merges into",
    ])
    .assert_ok("playbook gap")
    .assert_contains("every kind");

    for kind in ["bug", "docs"] {
        org.run(&["playbook", kind])
            .assert_ok("playbook kind")
            .assert_contains("which branch work merges into");
    }

    // Including a kind the playbook says nothing about, which is the strongest
    // reason for a gap to have been recorded in the first place.
    org.run(&["playbook", "spike"])
        .assert_ok("playbook spike")
        .assert_contains("no [spike] section")
        .assert_contains("which branch work merges into");
}

#[test]
fn a_gap_is_recorded_in_the_workspace_and_never_in_the_repository() {
    // The repository is what verification diffs, and a kind whose playbook asks for
    // no worktree is judged in the main checkout — a file dropped there would be
    // reported as somebody else's scope violation.
    let (org, repo) = with_playbook("pb-gap-where");
    org.run(&["playbook", "gap", "the docs guidance says nothing at all"])
        .assert_ok("playbook gap");

    assert!(org.path("gaps.toml").is_file(), "recorded in the workspace");
    assert!(!repo.join(".wecode/gaps.toml").exists());
    assert!(
        git_out(&repo, &["status", "--porcelain"]).is_empty(),
        "the repository is untouched"
    );
}

#[test]
fn only_a_seat_that_may_define_work_may_annotate_the_guidance() {
    // The gate is `define project`, not a write scope: the chief writes no code and
    // must be able to record one, the engineer writes the code and must not — it
    // would be annotating the guidance it was handed.
    let (org, _) = with_playbook("pb-gap-seat");
    let refused = org.run(&[
        "playbook",
        "gap",
        "the bug guidance should say where tests live",
        "--as",
        "impl",
    ]);
    assert!(!refused.ok(), "an engineer may not record one");
    refused
        .assert_contains("recording a playbook gap refused")
        .assert_contains("define");
    assert!(!org.path("gaps.toml").exists(), "nothing was written");

    // And the refusal is on the ledger, like every other decision.
    org.run(&["audit"]).assert_contains("define");
}

#[test]
fn a_planner_is_told_it_may_record_one_before_it_needs_to() {
    // A place to put a finding that nobody knows about is a place nothing is put.
    // Both surfaces are derived from the same capability that gates the command, so
    // neither can promise what the Broker would refuse.
    let (org, _) = with_playbook("pb-gap-brief");
    org.run(&["brief"])
        .assert_ok("brief")
        .assert_contains("playbook gap");
    org.run(&["whoami"])
        .assert_ok("whoami")
        .assert_contains("playbook gap");
}

#[test]
fn a_gap_needs_a_note_and_a_task_that_exists() {
    let (org, _) = with_playbook("pb-gap-refusals");

    let empty = org.run(&["playbook", "gap"]);
    assert!(!empty.ok());
    empty.assert_contains("say what the guidance does not");

    let ghost = org.run(&["playbook", "gap", FOUND, "--task", "ghost"]);
    assert!(!ghost.ok(), "a finding attributed to nothing is a lie");
    ghost.assert_contains("no such task: ghost");

    let kind = org.run(&["playbook", "gap", FOUND, "--kind", "buld"]);
    assert!(!kind.ok());
    kind.assert_contains("unknown kind `buld`");

    // A task and a project that disagree would file the note against guidance the
    // task was never planned from.
    a_bug_task(&org);
    let elsewhere = org.run(&[
        "playbook",
        "gap",
        FOUND,
        "--task",
        "fix-it",
        "--project",
        "nowhere",
    ]);
    assert!(!elsewhere.ok());
    elsewhere.assert_contains("fix-it is in project caching");
}

// --------------------------------------------------------------- expand ------

/// A playbook that templates a feature. The scopes stay under `src/` so the solo
/// template's engineer can reach them — an expansion nobody can be assigned would
/// prove the wrong thing.
const TEMPLATED: &str = r#"
[project]
language = "rust"

[feature]
worktree  = true
assign_to = "impl"
accept    = ["true"]
tokens    = 1000
wall_secs = 60
subtasks  = ["design", "build"]
guidance  = "A feature here is a design, then the code."

[feature.design]
kind   = "design"
title  = "decide how {{task}} should work"
write  = ["src/design/{{task}}.md"]
accept = ["test -f src/design/{{task}}.md"]

[feature.build]
after  = ["design"]
write  = ["src/{{task}}/**"]

[design]
worktree  = false
assign_to = "impl"
tokens    = 500
wall_secs = 30

[chore]
worktree  = true
assign_to = "impl"
accept    = ["true"]
tokens    = 1000
wall_secs = 60
guidance  = "One task. Nothing to break down."
"#;

/// The same workspace `with_playbook` builds, over a playbook that templates.
fn with_template(name: &str) -> (Org, PathBuf) {
    let org = Org::new(name, "solo");
    let repo = org.repo();
    org.playbook(&repo, TEMPLATED);
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

const EXPANDABLE: &[&str] = &[
    "task",
    "add",
    "retry",
    "--project",
    "caching",
    "retry a failed task once",
    "--write",
    "src/**",
];

#[test]
fn expand_emits_the_subtasks_the_playbook_declares() {
    let (org, _) = with_template("exp-emits");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("task add --expand")
        .assert_contains("expanded retry into 2 subtasks")
        .assert_contains("retry-design")
        .assert_contains("retry-build")
        .assert_contains("after retry-design");

    // Each is an ordinary task, with the placeholders resolved.
    org.run(&["show", "retry-design"])
        .assert_ok("show the design subtask")
        .assert_contains("decide how retry should work")
        .assert_contains("src/design/retry.md")
        // The step named its own kind; the budget came from [design].
        .assert_contains("design");

    org.run(&["show", "retry-build"])
        .assert_ok("show the build subtask")
        .assert_contains("src/retry/**")
        // `after` names a sibling in the playbook and a task id in the plan.
        .assert_contains("retry-design");

    // Part of the main task, and both assigned — a template that produced drafts
    // nobody could pick up would be a worse version of typing them out.
    org.run(&["tree"])
        .assert_ok("tree")
        .assert_contains("retry-design")
        .assert_contains("retry-build");
}

#[test]
fn the_playbook_shows_what_expand_would_emit() {
    // An orchestrator reads this before decomposing, so a decomposition the project
    // has already decided must be visible without opening the file.
    let (org, _) = with_template("exp-shown");
    org.run(&["playbook", "feature"])
        .assert_ok("playbook feature")
        .assert_contains("expand    design → build")
        .assert_contains("src/design/{{task}}.md")
        .assert_contains("after design");

    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("--expand emits subtasks for: feature");

    // A kind that templates nothing says nothing about it.
    org.run(&["playbook", "chore"])
        .assert_ok("playbook chore")
        .assert_lacks("expand");
}

#[test]
fn an_expansion_is_ordered_so_only_the_first_step_is_startable() {
    let (org, _) = with_template("exp-order");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv).assert_ok("task add --expand");
    org.run(&["tick"]).assert_ok("tick");

    org.run(&["ready"])
        .assert_ok("ready")
        .assert_contains("retry-design")
        .assert_lacks("retry-build");
}

#[test]
fn expand_is_refused_when_the_playbook_declares_no_subtasks() {
    // Nothing is created: a main task saved beside an expansion that silently did
    // nothing is the failure mode this refusal exists for.
    let (org, _) = with_template("exp-none");
    let refused = org.run(&[
        "task",
        "add",
        "tidy-up",
        "--project",
        "caching",
        "--kind",
        "chore",
        "delete the unused export helper",
        "--write",
        "src/**",
        "--expand",
    ]);
    assert!(!refused.ok(), "should refuse: {}", refused.all());
    refused
        .assert_contains("no subtasks for `chore`")
        .assert_contains("wecode playbook chore");

    let shown = org.run(&["show", "tidy-up"]);
    assert!(!shown.ok(), "nothing should have been created");
}

#[test]
fn a_step_whose_kind_the_playbook_omits_refuses_the_whole_expansion() {
    // All or nothing. A half-built expansion leaves the later steps depending on
    // tasks that were never created, which is worse than creating none.
    let (org, repo) = with_template("exp-partial");
    org.playbook(&repo, &TEMPLATED.replace("[design]\n", "[refactor]\n"));

    let out = org.run(&{
        let mut argv = EXPANDABLE.to_vec();
        argv.push("--expand");
        argv
    });
    out.assert_ok("the main task still admits")
        .assert_contains("saved task retry")
        .assert_contains("not expanded")
        .assert_contains("[design] has no section");

    for id in ["retry-design", "retry-build"] {
        assert!(!org.run(&["show", id]).ok(), "{id} should not exist");
    }
}

#[test]
fn expanding_onto_ids_that_exist_creates_none_of_it() {
    // The ids are derived, so one can already be held by a task nobody meant to
    // collide with. Refused as a whole and named, rather than raised on the first
    // collision with the rest of the expansion left unstated.
    let (org, _) = with_template("exp-taken");
    org.run(&[
        "task",
        "add",
        "retry-design",
        "--project",
        "caching",
        "sketch the retry state machine",
        "--write",
        "crates/notes/**",
    ])
    .assert_ok("a task that happens to hold the id");

    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("a collision is a verdict, not a crash")
        .assert_contains("saved task retry")
        .assert_contains("not expanded")
        .assert_contains("retry-design already exists")
        .assert_contains("wecode task rm");
}

#[test]
fn a_defective_main_task_expands_into_nothing() {
    let (org, _) = with_template("exp-defective");
    org.run(&[
        "task",
        "add",
        "retry",
        "--project",
        "caching",
        // Two outcomes in one title: the gate refuses it.
        "retry a failed task and report why",
        "--write",
        "src/**",
        "--expand",
    ])
    .assert_ok("refusal is not an error")
    .assert_contains("not saved")
    .assert_contains("nothing was expanded either");

    assert!(!org.run(&["show", "retry-design"]).ok());
}

#[test]
fn without_expand_a_templated_playbook_behaves_exactly_as_before() {
    // The un-expanded path is the one every existing task takes, so it must not
    // change because a template appeared in the file.
    let (org, _) = with_template("exp-optout");
    org.run(EXPANDABLE)
        .assert_ok("task add")
        .assert_lacks("expanded");
    assert!(!org.run(&["show", "retry-design"]).ok());
}

// ------------------------------------------------------------ design gate ------

/// `TEMPLATED` with the gate turned on: a feature here is refused unless a design
/// stands before it. The template is what makes satisfying the gate one flag.
fn with_gate(name: &str) -> (Org, PathBuf) {
    let (org, repo) = with_template(name);
    org.playbook(
        &repo,
        &TEMPLATED.replace("[feature]\n", "[feature]\ndesign_required = true\n"),
    );
    (org, repo)
}

#[test]
fn a_feature_with_no_design_behind_it_is_refused() {
    let (org, _) = with_gate("gate-refuses");
    org.run(EXPANDABLE)
        .assert_ok("refusal is a verdict, not an error")
        .assert_contains("requires a design")
        .assert_contains("not saved");
    assert!(!org.run(&["show", "retry"]).ok(), "nothing was created");

    // The gate is visible where an orchestrator plans, not only where it fails.
    org.run(&["playbook", "feature"])
        .assert_ok("playbook feature")
        .assert_contains("design    required");
    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("a design must stand before: feature");
}

#[test]
fn a_feature_built_on_a_design_is_admitted_and_waits_for_its_signature() {
    let (org, _) = with_gate("gate-after");
    org.run(&[
        "task",
        "add",
        "retry-plan",
        "--project",
        "caching",
        "--kind",
        "design",
        "decide how a failed task is retried",
        "--write",
        "src/design/retry.md",
        "--accept-cmd",
        "true",
    ])
    .assert_ok("the design itself is not gated")
    .assert_contains("admitted");

    let mut argv = EXPANDABLE.to_vec();
    argv.extend(["--after", "retry-plan"]);
    org.run(&argv)
        .assert_ok("task add --after design")
        .assert_contains("admitted")
        .assert_contains("saved task retry")
        // The gate asks only that the design exist to wait on; the ordering — and a
        // design's need for a signature — is what keeps the feature from running.
        .assert_contains("retry-plan is not done");
}

#[test]
fn expand_satisfies_the_gate_with_the_design_step_it_creates() {
    let (org, _) = with_gate("gate-expand");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--expand");
    org.run(&argv)
        .assert_ok("task add --expand")
        .assert_contains("saved task retry")
        .assert_contains("expanded retry into 2 subtasks");

    // And the main task keeps satisfying the gate afterwards: the design is its
    // subtask now, in the plan where every later check finds it.
    org.run(&["check", "retry"])
        .assert_ok("check")
        .assert_contains("admitted");
    org.run(&["check", "retry-build"])
        .assert_ok("check the build step")
        .assert_contains("admitted");
}

#[test]
fn force_admits_an_undesigned_feature_and_records_the_waiver() {
    let (org, _) = with_gate("gate-forced");
    let mut argv = EXPANDABLE.to_vec();
    argv.push("--force");
    org.run(&argv)
        .assert_ok("task add --force")
        .assert_contains("forced — defects recorded as waivers")
        .assert_contains("saved task retry");
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

/// A project and one bug task in it, ready to start.
fn with_bug(name: &str) -> (Org, PathBuf) {
    let (org, repo) = with_playbook(name);
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
    (org, repo)
}

/// The worktree path `start` printed, which is where the work really went.
fn started_at(r: &Run) -> String {
    r.stdout
        .lines()
        .find_map(|l| l.trim().strip_prefix("worktree "))
        .expect("start prints the worktree path")
        .trim()
        .trim_end_matches(" (reset)")
        .to_string()
}

#[test]
fn start_writes_down_the_worktree_it_made() {
    // `start` creates a tree and opens no execution row, so before this the only
    // record of it was the directory itself.
    let (org, _) = with_bug("wt-recorded");
    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));

    let all = org.recorded();
    assert_eq!(all.len(), 1, "{all:?}");
    let wt = &all[0];
    assert_eq!(wt.path, path);
    assert_eq!(wt.task, "fix-it");
    assert_eq!(wt.branch, "wecode/fix-it");
    assert_eq!(wt.repo, "app", "the repo it was cut from, not the project");
    assert!(wt.removed.is_none(), "it is standing");
}

#[test]
fn a_worktree_wecode_did_not_make_is_not_claimed_as_its_own() {
    // The fault that started this: another tool keeping worktrees in the same
    // repository was printed as one of ours that had lost its task.
    let (org, repo) = with_bug("wt-stranger");
    org.run(&["start", "fix-it"]).assert_ok("start");

    let theirs = org.path("not-ours");
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["worktree", "add", "-b", "theirs", theirs.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "a stranger's worktree should be addable"
    );

    let ours: Vec<String> = org.recorded().into_iter().map(|w| w.path).collect();
    assert_eq!(ours.len(), 1, "only wecode's own is recorded: {ours:?}");
    assert!(!ours[0].contains("not-ours"));

    // And the listing says which is which, rather than calling both an orphan.
    org.run(&["worktree"])
        .assert_ok("worktree")
        .assert_contains("— not ours")
        .assert_contains("1 in use")
        .assert_contains("1 not ours")
        .assert_lacks("orphan");
}

#[test]
fn a_tree_is_listed_once_however_many_projects_share_its_repo() {
    // The fault: `git worktree list` answers per repository, so asking once per project
    // printed every tree once per project sharing it. Four trees came out as 27 rows.
    let (org, _) = with_bug("wt-shared-repo");
    org.run(&[
        "project",
        "add",
        "exports",
        "cut the export endpoint's p99 latency in half",
        "--repo",
        "app",
        "--measure-cmd",
        "true",
        "--tokens",
        "1000",
        "--wall",
        "60",
    ])
    .assert_ok("a second project on the same repo");

    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));
    let listed = org.run(&["worktree"]).assert_ok("worktree").stdout.clone();

    assert_eq!(
        listed.lines().filter(|l| l.contains(&path)).count(),
        1,
        "one tree, one row:\n{listed}"
    );
    // Grouped by repo, and the tally is what makes a repeat visible at a glance.
    assert!(
        listed.contains("1 tree in 1 repo"),
        "the tally counts trees, not project-tree pairs:\n{listed}"
    );
    // The project shown is the one whose task works here — not whichever shares the repo.
    assert!(
        listed.contains("caching") && !listed.contains("exports"),
        "attributed to the owning task's project:\n{listed}"
    );
}

#[test]
fn a_tree_whose_task_is_gone_is_ours_rather_than_a_stranger() {
    // `start` opens no execution row, so a started task can still be removed outright —
    // and the directory does not go with it. Before the registry this came back as an
    // orphan by accident; now it is one on the record, and names who it was for.
    let (org, _) = with_bug("wt-orphan");
    org.run(&["start", "fix-it"]).assert_ok("start");
    org.run(&["task", "rm", "fix-it"])
        .assert_ok("remove a task that only started");

    org.run(&["worktree"])
        .assert_ok("worktree")
        .assert_contains("— orphan (fix-it)")
        .assert_contains("1 ours to clean up");
}

#[test]
fn starting_the_same_task_again_records_the_tree_once() {
    // The retry path resets the directory rather than creating it. A row per attempt
    // would make the registry a run log, which `task_executions` already is.
    let (org, _) = with_bug("wt-again");
    org.run(&["start", "fix-it"]).assert_ok("first start");
    let first = org.recorded();
    org.run(&["start", "fix-it"])
        .assert_ok("second start")
        .assert_contains("(reset)");

    assert_eq!(org.recorded(), first, "nothing added, nothing restated");
}

#[test]
fn a_subtask_records_no_worktree_of_its_own() {
    // It shares its parent's tree, so it owns nothing to record.
    let (org, _) = with_bug("wt-sub-record");
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
    .assert_ok("subtask");

    org.run(&["start", "fix-it-test"])
        .assert_ok("start subtask");
    let all = org.recorded();
    assert_eq!(all.len(), 1, "one tree, one row: {all:?}");
    assert_eq!(all[0].task, "fix-it", "recorded against its owner");
}

#[test]
fn removing_a_worktree_records_that_it_is_gone_without_forgetting_it_existed() {
    let (org, _) = with_bug("wt-tombstone");
    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));
    org.run(&["worktree", "remove", "fix-it"])
        .assert_ok("remove");

    let all = org.recorded();
    assert_eq!(all.len(), 1, "the row stays: {all:?}");
    assert_eq!(all[0].path, path);
    assert!(
        all[0].removed.is_some(),
        "we made one here and tore it down — not: there was never one"
    );
}

#[test]
fn a_worktree_deleted_by_hand_stops_being_reported_as_standing() {
    // A row claiming a directory that is provably absent is worse than no row.
    let (org, _) = with_bug("wt-handdel");
    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));
    std::fs::remove_dir_all(&path).unwrap();

    org.run(&["worktree", "remove", "fix-it"])
        .assert_ok("remove a tree that is already gone")
        .assert_contains("recorded as gone");
    assert!(org.recorded()[0].removed.is_some());
}

#[test]
fn a_worktree_whose_task_is_gone_can_be_removed_by_its_path() {
    // The gap `worktree-view` left: an orphan is named by the listing and unreachable by
    // a command that takes a task id, because *having no task* is what makes it an
    // orphan. Seeing a tree you cannot remove is worse than not seeing it.
    let (org, _) = with_bug("wt-rm-path");
    let path = started_at(org.run(&["start", "fix-it"]).assert_ok("start"));
    org.run(&["task", "rm", "fix-it"]).assert_ok("remove task");
    org.run(&["worktree"]).assert_contains("— orphan (fix-it)");

    org.run(&["worktree", "remove", &path])
        .assert_ok("remove by path")
        .assert_contains("removed")
        // The branch comes from the registry, since a path does not imply one.
        .assert_contains("branch wecode/fix-it kept");
    org.run(&["worktree"]).assert_contains("no worktrees");
    assert!(
        org.recorded()[0].removed.is_some(),
        "the row is closed, not deleted"
    );
}

#[test]
fn a_path_no_repository_claims_is_not_removed_by_wecode() {
    // `git worktree remove` is a command against a repository. A directory none of the
    // plan's repos lists as a worktree has no repository to run it against, and guessing
    // one would run a removal against the wrong repo.
    let (org, _) = with_bug("wt-rm-stray");
    let stray = org.path("just-a-directory");
    std::fs::create_dir_all(&stray).unwrap();

    let r = org.run(&["worktree", "remove", stray.to_str().unwrap()]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("no repository this workspace knows");
    assert!(stray.is_dir(), "and it is still there");
}

#[test]
fn a_mistyped_path_is_not_slugified_into_a_task_id() {
    // A task id is a kebab-case slug, so a `/` cannot occur in one. Before the two were
    // told apart by shape, `/tmp/nope` became the task `tmp-nope` and the refusal named
    // the wrong problem.
    let (org, _) = with_bug("wt-rm-typo");
    let r = org.run(&["worktree", "remove", "/tmp/no-such-tree"]);
    r.assert_ok("an absent path is a report, not an error")
        .assert_contains("no worktree at /tmp/no-such-tree")
        .assert_lacks("no such task");
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

    // Passing is not landed. The work is on a branch nobody has merged, so it waits
    // for the signature rather than claiming to be done.
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");
}

// ------------------------------------------------------------ build cache ------

/// A cache directory outside every worktree and outside the workspace, which is what
/// the setting is for: `Org` wipes its own directory on each run, and a cache that went
/// with it would be shared with nothing.
fn cache_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wecode-e2e-cache-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("target")
}

/// The shared playbook with a build cache declared on top of it.
fn with_cache(target: &Path) -> String {
    format!(
        "{PLAYBOOK}\n[project.build_cache]\nCARGO_TARGET_DIR = \"{}\"\n",
        target.display()
    )
}

#[test]
fn one_build_cache_reaches_both_the_agent_and_the_commands_that_judge_it() {
    // The whole path in one test, because half of it is worse than none: an agent
    // building into the shared directory while acceptance rebuilds from scratch in the
    // worktree pays the cost this exists to remove, and looks like it did not.
    let target = cache_dir("both");
    let (org, _) = with_playbook_body("cache-both", &with_cache(&target));
    org.agent("echo \"$CARGO_TARGET_DIR\" > seen.txt");

    let seen = format!("grep -qx {} seen.txt", target.display());
    let judged = format!("test \"$CARGO_TARGET_DIR\" = {}", target.display());
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
        "seen.txt",
        "--accept-cmd",
        &seen,
        "--accept-cmd",
        &judged,
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("task add");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("exit 0")
        .assert_contains("passed");
    // Made by wecode rather than by whatever ran first: a toolchain handed a path it
    // cannot create either fails obscurely or quietly builds into the worktree.
    assert!(target.is_dir(), "{} was not created", target.display());
}

#[test]
fn the_shared_cache_is_shown_in_the_guidance_and_reported_where_work_is_prepared() {
    let target = cache_dir("shown");
    let (org, _) = with_playbook_body("cache-shown", &with_cache(&target));

    // In the playbook view as written, since that is a view of the file.
    org.run(&["playbook"])
        .assert_ok("playbook")
        .assert_contains("cache")
        .assert_contains("CARGO_TARGET_DIR");

    // And resolved where the operator is told which directory to work in — a hand-run
    // task that built somewhere else would be the one build not sharing the cache.
    a_task(&org, "t", "a.txt", "true");
    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_contains(&format!("cache    CARGO_TARGET_DIR={}", target.display()));
}

#[test]
fn a_cache_that_would_land_inside_a_worktree_is_refused_by_name() {
    // `target/shared` resolves against whichever worktree is running, so it would be a
    // per-task directory with a name promising the opposite. Refused where the playbook
    // is read, which is before any budget is spent.
    let (org, _) = with_playbook_body(
        "cache-relative",
        &format!("{PLAYBOOK}\n[project.build_cache]\nCARGO_TARGET_DIR = \"target/shared\"\n"),
    );
    let r = org.run(&["playbook"]);
    assert!(!r.ok(), "a playbook that cannot be honoured must not load");
    r.assert_contains("CARGO_TARGET_DIR")
        .assert_contains("relative");
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
fn a_failed_check_is_recorded_as_a_failure_not_a_denial() {
    // The scope violation above is a denial: authority was breached. A red check is
    // not — the supervisor ran it itself, and the work failed it. Filing the second
    // as "command not permitted" filled the governance channel with test runs, and
    // the board said "denied" about a task that was merely wrong.
    let (org, _) = with_agent("run-fail-check", "echo wrong >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q right a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("failed");

    // The check and its exit are on the record, as something we ran and observed...
    org.run(&["audit", "--task", "t"])
        .assert_contains("grep -q right a.txt")
        .assert_contains("exit 1, wanted 0");
    // ...and not as a denial: nothing was refused.
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_lacks("grep -q right");
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

/// An agent that does its work and then reports what it cost, the way a coding CLI
/// speaking `claude-stream-json` does.
fn reporting_agent(work: &str, input: u64, output: u64) -> String {
    format!(
        "{work}; echo '{{\"type\":\"result\",\"usage\":\
         {{\"input_tokens\":{input},\"output_tokens\":{output}}}}}'"
    )
}

#[test]
fn what_the_agent_reported_spending_reaches_the_row_it_was_spent_on() {
    // The spend column was a zero on every board until something wrote to it. The
    // whole path: the agent's own output, the ledger, the task row, the attempt.
    let (org, _) = with_agent("run-spend", &reporting_agent("echo done >> a.txt", 60, 30));
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("spent    90 tokens");

    // On the board, against the budget the task declared — 100 tokens.
    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_contains("90/100");

    // In the ledger, attributed to the task and marked as the agent's own account of
    // itself rather than as something wecode measured.
    org.run(&["audit", "--task", "t"])
        .assert_ok("audit")
        .assert_contains("spend")
        .assert_contains("90t/")
        .assert_contains("harness");

    // And against the attempt, so a task with several tries can say which was
    // expensive.
    org.run(&["show", "t"]).assert_contains("90t");
}

#[test]
fn an_agent_that_reports_nothing_leaves_the_column_empty_rather_than_zero() {
    // The stub speaks no protocol wecode can read, so there is no number. Printing
    // one would be a claim nobody made, and the budget would be checked against it.
    let (org, _) = with_agent("run-unmetered", "echo done >> a.txt");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        text.replace(
            "protocol = \"claude-stream-json\"",
            "protocol = \"invented\"",
        ),
    )
    .unwrap();
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("unmetered");

    // The wall clock is still ours to record, and it is still recorded — as
    // something wecode observed, unlike a token count.
    org.run(&["audit", "--task", "t"])
        .assert_contains("spend")
        .assert_contains("supervisor")
        .assert_lacks("harness");
}

#[test]
fn an_overspending_agent_turns_its_row_red_after_the_fact() {
    // Enforcement of a token budget is post-hoc by necessity: the tokens are gone
    // before wecode hears about them. What the board can do is stop calling the run
    // healthy, which it could not do while nothing counted. Health is the colour
    // of the needs-you cell, so red is the ANSI code around the words.
    let (org, _) = with_agent(
        "run-overspend",
        &reporting_agent("echo done >> a.txt", 4000, 1000),
    );
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    org.run(&["run", "t"]).assert_ok("run");

    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_contains("\u{1b}[31mover budget");
}

#[test]
fn a_conversation_is_not_billed_for_the_context_it_re_read() {
    // The budget is a number a person wrote — 100 tokens for this task — and the
    // agent added 90. It also replayed half a million tokens of its own context,
    // which is what a long conversation does every turn and what no budget is
    // written in. Counted into the spend, this run is 5,000x over and the board is
    // red for every task that ever ran; kept in its own unit, the row is honest and
    // the replay is still on the screen.
    let (org, _) = with_agent(
        "run-cached",
        "echo done >> a.txt; echo '{\"type\":\"result\",\"usage\":\
         {\"input_tokens\":60,\"output_tokens\":30,\
         \"cache_read_input_tokens\":500000}}'",
    );
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("spent    90 tokens")
        .assert_contains("500000 re-read from cache");

    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_contains("90/100")
        .assert_lacks("over budget");
}

#[test]
fn a_turn_announced_once_per_block_does_not_spend_the_budget_four_times() {
    // A coding CLI announces one `assistant` line per content block, so a turn that
    // thought and then called a tool says the same thing — same message, same usage —
    // three or four times over. Added up line by line, this 60-token run reads as 240
    // against a 100-token budget, and the supervisor kills it while it is still
    // working. Nothing that survives the run agrees: the total the harness states at
    // the end, and every figure read off it afterwards, says 60.
    let turn = "echo '{\"type\":\"assistant\",\"message\":{\"id\":\"msg_1\",\"usage\":\
                {\"input_tokens\":40,\"output_tokens\":20}}}'; sleep 0.15";
    let (org, _) = with_agent(
        "run-blocks",
        &format!(
            "echo done >> a.txt; {turn}; {turn}; {turn}; {turn}; \
             echo '{{\"type\":\"result\",\"usage\":\
             {{\"input_tokens\":40,\"output_tokens\":20}}}}'"
        ),
    );
    a_task(&org, "t", "a.txt", "grep -q done a.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_lacks("token budget")
        .assert_contains("spent    60 tokens");

    org.run(&["board", "caching"])
        .assert_ok("board")
        .assert_contains("60/100")
        .assert_lacks("over budget");
}

#[test]
fn a_run_killed_on_its_limit_still_reports_what_it_burned() {
    // The case a spend recorded only on success would hide, and the expensive one:
    // an agent that ran away with the budget and had to be killed.
    let (org, _) = with_agent(
        "run-killed",
        "echo '{\"type\":\"assistant\",\"message\":{\"usage\":\
         {\"input_tokens\":40,\"output_tokens\":10}}}'; sleep 60",
    );
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, text.replace("idle_secs = 300", "idle_secs = 1")).unwrap();
    a_task(&org, "t", "a.txt", "true");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("no output")
        .assert_contains("spent    50 tokens");
    org.run(&["board", "caching"]).assert_contains("50/100");
}

#[test]
fn an_unassigned_task_cannot_be_run() {
    // There is no post to name an agent, so there is nothing to launch. The fixture
    // playbook has no [refactor] section, so nothing fills the assignee either.
    let (org, _) = with_agent("run-unassigned", "true");
    org.run(&[
        "task",
        "add",
        "t",
        "--project",
        "caching",
        "--kind",
        "refactor",
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

#[test]
fn the_fixture_is_planted_as_a_real_repository() {
    // The fixture cannot be committed as a repo — nested repos — so this checks the
    // planting worked rather than assuming it.
    let org = Org::new("fixture", "solo");
    let repo = org.repo();
    assert!(repo.join("src/app.txt").is_file(), "content copied");
    assert!(
        repo.join(".wecode/playbook.toml").is_file(),
        "playbook copied"
    );
    assert!(repo.join(".git").is_dir(), "git init ran");

    // Committed, so a task's diff shows only what the task did.
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        "the fixture must start clean"
    );
}

// ---------------------------------------------------------------- commit ------

#[test]
fn a_passing_attempt_is_committed_on_its_branch() {
    let (org, repo) = with_agent("commit-pass", "echo done >> src/app.txt");
    a_task(&org, "t", "src/**", "grep -q done src/app.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed")
        .assert_contains("committed");

    // The main branch is untouched — output is a branch to review.
    let main = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", "main:src/app.txt"])
        .output()
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&main.stdout).contains("done"),
        "main must not move until a merge"
    );
}

#[test]
fn a_failed_attempt_is_committed_too_so_a_retry_can_learn_from_it() {
    // The reason this matters: a retry resets the worktree. Uncommitted, the failed
    // diff — the only evidence of what went wrong — would be destroyed.
    let (org, _) = with_agent("commit-fail", "echo wrong >> src/app.txt");
    a_task(&org, "t", "src/**", "grep -q correct src/app.txt");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("failed")
        .assert_contains("committed");
}

#[test]
fn two_attempts_leave_two_commits() {
    let (org, _) = with_agent("commit-twice", "echo mark >> src/app.txt");
    a_task(&org, "t", "src/**", "grep -q nope src/app.txt");

    org.run(&["run", "t"]).assert_contains("attempt 1");
    org.run(&["status", "t", "waiting"]).assert_ok("reopen");
    org.run(&["run", "t"]).assert_contains("attempt 2");

    // Both runs are on the record, and the first is not overwritten.
    org.run(&["show", "t"])
        .assert_contains("#1")
        .assert_contains("#2");
}

#[test]
fn an_agent_that_changed_nothing_is_reported_rather_than_committed() {
    let (org, _) = with_agent("commit-none", "true");
    a_task(&org, "t", "src/**", "test -f src/app.txt");
    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("nothing to commit");
}

#[test]
fn work_without_a_worktree_is_never_committed() {
    // Committing into the operator's own checkout is not wecode's decision to take.
    let (org, repo) = with_agent("commit-nowt", "echo x >> README.md");
    org.playbook(
        &repo,
        "[docs]\nworktree = false\nassign_to = \"impl\"\naccept = [\"true\"]\n\
         tokens = 10\nwall_secs = 5\nguidance = \"x\"\n",
    );
    org.run(&[
        "task",
        "add",
        "d",
        "--project",
        "caching",
        "--kind",
        "docs",
        "note the eviction policy in the readme",
        "--write",
        "README.md",
    ])
    .assert_ok("task add");

    org.run(&["run", "d"])
        .assert_ok("run")
        .assert_lacks("committed");
}

// --------------------------------------------------------------- handoff ------

#[test]
fn a_retry_is_told_what_it_tried_and_why_it_was_refused() {
    // The whole point of a retry envelope: without the previous diff and the failing
    // check, the second attempt is the first attempt again.
    let (org, _) = with_agent("handoff-retry", "echo wrong >> src/app.txt");
    a_task(&org, "t", "src/**", "grep -q right src/app.txt");

    org.run(&["run", "t"]).assert_contains("failed");
    org.run(&["status", "t", "waiting"]).assert_ok("reopen");

    let r = org.run(&["start", "t"]);
    r.assert_ok("start")
        .assert_contains("YOUR PREVIOUS ATTEMPTS")
        .assert_contains("attempt 1")
        // Why it was rejected, not how the process exited.
        .assert_contains("grep -q right src/app.txt")
        .assert_contains("exit 1, wanted 0")
        // And the diff it produced.
        .assert_contains("+wrong");
}

#[test]
fn a_first_attempt_has_no_previous_attempts_section() {
    // An empty heading would read as though something were missing.
    let (org, _) = with_agent("handoff-first", "true");
    a_task(&org, "t", "src/**", "true");
    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_lacks("YOUR PREVIOUS ATTEMPTS");
}

#[test]
fn a_successor_is_shown_what_its_predecessor_produced() {
    // The handoff travels along depends_on, and is read out of git rather than taken
    // from the agent that produced it.
    let (org, _) = with_agent("handoff-chain", "echo groundwork >> src/app.txt");
    a_task(&org, "first", "src/**", "grep -q groundwork src/app.txt");
    org.run(&[
        "task",
        "add",
        "second",
        "--project",
        "caching",
        "--kind",
        "chore",
        "build on what the first task laid down",
        "--after",
        "first",
        "--write",
        "src/**",
        "--accept-cmd",
        "true",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("second");

    org.run(&["run", "first"]).assert_contains("passed");
    org.run(&["status", "first", "done"]).assert_ok("close it");

    let r = org.run(&["start", "second"]);
    r.assert_ok("start")
        .assert_contains("first — append a marker comment to the source")
        .assert_contains("+groundwork");
}

/// A design and the task built on it, with the design signed and closed.
///
/// The design asks for no worktree — no playbook here gives it one — so its document is
/// written into the repository itself and never committed by wecode, which is exactly
/// the arrangement the handoff has to cope with.
fn a_signed_design(org: &Org, doc: &str) {
    org.run(&[
        "task",
        "add",
        "d",
        "decide the cache key format",
        "--project",
        "caching",
        "--kind",
        "design",
        "--write",
        doc,
        "--accept-cmd",
        &format!("test -f {doc}"),
        "--tokens",
        "1000",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("add design");
    org.run(&["run", "d"]).assert_contains("passed");
    org.run(&["approve", "design", "--task", "d"])
        .assert_ok("sign the design");

    org.run(&[
        "task",
        "add",
        "build",
        "--project",
        "caching",
        "--kind",
        "chore",
        "build what the design decided",
        "--after",
        "d",
        "--write",
        "src/**",
        "--accept-cmd",
        "true",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("add build");
}

#[test]
fn a_design_predecessor_is_handed_over_as_its_document() {
    // The one kind whose output is not code. Its deliverable is a file, wecode never
    // commits it — a design asks for no worktree — and the successor's branch is cut
    // from a base that may not have it either. Read out of the repository instead, or
    // the kind the design gate exists to protect is the one kind whose handoff is empty.
    let (org, _) = with_agent(
        "handoff-design",
        "mkdir -p docs/wecode/d && printf 'The key is the url and the vary header.\\n' \
         > docs/wecode/d/design.md",
    );
    a_signed_design(&org, "docs/wecode/d/design.md");

    org.run(&["start", "build"])
        .assert_ok("start")
        .assert_contains("docs/wecode/d/design.md")
        .assert_contains("The key is the url and the vary header.")
        // The decision itself, not a diff of it.
        .assert_lacks("+The key is the url");
}

#[test]
fn a_design_document_is_found_wherever_the_task_declared_it() {
    // The convention is `docs/wecode/<task>/design.md`, but a playbook that templates
    // its steps names its own path. The write scope is where the task says which.
    let (org, _) = with_agent(
        "handoff-design-path",
        "mkdir -p src/design && printf 'Hash the url, not the body.\\n' > src/design/keys.md",
    );
    a_signed_design(&org, "src/design/keys.md");

    org.run(&["start", "build"])
        .assert_ok("start")
        .assert_contains("src/design/keys.md")
        .assert_contains("Hash the url, not the body.");
}

#[test]
fn a_design_whose_document_cannot_be_found_says_where_it_looked() {
    // "(no commits)" would read as a signed design that produced nothing, which is a
    // far more alarming fact than one this process could not locate.
    let (org, _) = with_agent(
        "handoff-design-gone",
        "mkdir -p docs/wecode/d && printf 'decided\\n' > docs/wecode/d/design.md",
    );
    a_signed_design(&org, "docs/wecode/d/design.md");
    std::fs::remove_file(org.dir.join("repo/docs/wecode/d/design.md")).unwrap();

    org.run(&["start", "build"])
        .assert_ok("start")
        .assert_contains("no design document at docs/wecode/d/design.md");
}

#[test]
fn the_instruction_is_also_available_as_a2a_json() {
    // Why adopting the protocol is worth anything: a caller that can parse gets the
    // acceptance and the scope as data, rather than scraping them back out of prose.
    let (org, _) = with_agent("a2a-json", "true");
    a_task(&org, "t", "src/**", "grep -q right src/app.txt");

    let r = org.run(&["start", "t", "--json"]);
    r.assert_ok("start --json");
    let v: serde_json::Value =
        serde_json::from_str(&r.stdout).expect("start --json must emit valid JSON");

    // A2A's Task is one wecode *execution*, and nothing has been spawned yet.
    assert_eq!(v["id"], "t-attempt-1");
    assert_eq!(v["contextId"], "t");
    assert_eq!(v["status"]["state"], "submitted");
    assert_eq!(v["history"][0]["role"], "user");

    let parts = v["history"][0]["parts"].as_array().expect("parts");
    let data = &parts
        .iter()
        .find(|p| p["kind"] == "data")
        .expect("a data part")["data"];
    assert!(
        data["acceptance"][0]
            .as_str()
            .unwrap()
            .contains("grep -q right src/app.txt"),
        "{data}"
    );
    // The declared scope, plus the worker area every task may write to.
    let scope = data["writeScope"].as_array().expect("writeScope");
    assert!(scope.iter().any(|g| g == "src/**"), "{data}");
    assert!(scope.iter().any(|g| g == ".wecode/run/**"), "{data}");
    assert_eq!(data["attempt"], 1);

    // ...and that structured half never reaches the text a coding CLI is handed,
    // where it would read as noise inside the instruction.
    let text = parts
        .iter()
        .find(|p| p["kind"] == "text")
        .expect("a text part")["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!text.contains("writeScope"), "{text}");
    assert!(
        text.contains("You may modify only: .wecode/run/**, src/**"),
        "{text}"
    );
}

#[test]
fn a_task_with_no_predecessors_says_so_plainly() {
    let (org, _) = with_agent("handoff-none", "true");
    a_task(&org, "t", "src/**", "true");
    org.run(&["start", "t"])
        .assert_ok("start")
        .assert_contains("nothing came before this task");
}

#[test]
fn a_dependent_task_starts_from_its_predecessors_work() {
    // Being *told* what came before is not the same as *having* it. Cut from the base,
    // a chain touching the same file conflicts the moment it merges.
    let (org, _) = with_agent("chain-base", "echo groundwork >> src/app.txt");
    a_task(&org, "first", "src/**", "grep -q groundwork src/app.txt");
    org.run(&[
        "task",
        "add",
        "second",
        "--project",
        "caching",
        "--kind",
        "chore",
        "build on what the first task laid down",
        "--after",
        "first",
        "--write",
        "src/**",
        "--accept-cmd",
        "grep -q groundwork src/app.txt",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("second");

    org.run(&["run", "first"]).assert_contains("passed");
    org.run(&["status", "first", "done"]).assert_ok("close it");

    // `second`'s acceptance greps for what `first` wrote. It can only pass if the
    // worktree actually contains it.
    org.run(&["run", "second"])
        .assert_ok("run")
        .assert_contains("passed");
}

#[test]
fn an_independent_task_still_starts_from_the_base() {
    // Only a dependency moves the branch point; two unrelated tasks must not inherit
    // each other's changes.
    let (org, _) = with_agent("chain-indep", "echo mine >> src/app.txt");
    // Disjoint scopes: `src/**` would swallow the other and the gate would refuse it.
    a_task(&org, "one", "src/app.txt", "grep -q mine src/app.txt");
    a_task(&org, "two", "src/other.txt", "test -f src/app.txt");

    org.run(&["run", "one"]).assert_contains("passed");
    org.run(&["status", "one", "done"]).assert_ok("close");

    org.run(&["run", "two"]).assert_ok("run");

    // Asserted on history, not on file content: the stand-in agent writes the same
    // line for every task, so content proves nothing. What matters is whether one's
    // *commit* is an ancestor of two's branch.
    let wt = org
        .path("config/run")
        .join("wecode-e2e-chain-indep")
        .join("two");
    let out = Command::new("git")
        .arg("-C")
        .arg(&wt)
        .args(["log", "--oneline"])
        .output()
        .unwrap();
    let log = String::from_utf8_lossy(&out.stdout);
    assert!(
        !log.contains("one: attempt"),
        "an unrelated task inherited a predecessor's commit:\n{log}"
    );
}

// ------------------------------------------------------ dispatch signature ----

/// A workspace whose project will not dispatch a task until someone signs for it.
fn signs_first(name: &str, script: &str) -> Org {
    let (org, repo) = with_agent(name, script);
    org.playbook(
        &repo,
        &PLAYBOOK.replace(
            "language = \"rust\"",
            "language = \"rust\"\ndispatch = \"approved\"",
        ),
    );
    org
}

/// A task inside the engineer's own write scope, so naming the post actually hands it
/// over: `a_task`'s narrower globs leave it a draft, and the scheduler never offers a
/// draft to anything.
fn a_task_in_src(org: &Org, id: &str, glob: &str, accept: &str) {
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
fn a_task_nobody_signed_for_is_not_dispatched() {
    let org = signs_first("dispatch-unsigned", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");

    // Both, because they are one door. A gate `start` walks around is not a gate — and
    // `start` is how a person takes the work themselves, which is still dispatch.
    for cmd in [["start", "t"], ["run", "t"]] {
        let r = org.run(&cmd);
        assert!(!r.ok(), "{cmd:?} should refuse");
        r.assert_contains("has not been signed for")
            .assert_contains("wecode approve admission --task t");
    }
    // Refused before anything was prepared: no worktree cut, and the task did not move.
    assert!(
        org.recorded().is_empty(),
        "a tree was cut for work nobody signed for"
    );
    org.run(&["show", "t"])
        .assert_contains("status     waiting");

    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign")
        .assert_contains("may be dispatched");
    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
}

#[test]
fn changing_a_task_after_it_was_signed_retracts_the_signature() {
    // The hole a present/absent check would leave: sign something small, then widen it.
    // The ledger is ordered, so "signed before the last change" is a fact about it.
    let org = signs_first("dispatch-restated", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign");

    org.run(&[
        "task", "scope", "t", "--write", "src/**", "--write", "tests/**",
    ])
    .assert_ok("widen the scope");
    let r = org.run(&["run", "t"]);
    assert!(!r.ok(), "the signature was for the narrower task");
    r.assert_contains("was changed after it was signed")
        .assert_contains("wecode approve admission --task t");

    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign what it is now");
    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
}

#[test]
fn the_post_doing_the_work_cannot_sign_for_it() {
    let org = signs_first("dispatch-self", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");

    let r = org.run(&["approve", "admission", "--task", "t", "--as", "impl"]);
    assert!(!r.ok(), "an engineer holds no approvals");
    r.assert_contains("approving refused for `impl`");
    // The attempt is on the record and is not a signature: the gate reads allowed
    // decisions, not the fact that someone tried.
    org.run(&["audit", "--denied", "--task", "t"])
        .assert_contains("approve");
    org.run(&["run", "t"])
        .assert_contains("has not been signed for");
}

#[test]
fn a_signature_cannot_be_attributed_to_a_task_that_does_not_exist() {
    // A typo would otherwise record as authority, and the gate would go on refusing
    // the real task while the operator held what looked like a signature for it.
    let (org, _) = with_playbook("dispatch-ghost");
    let r = org.run(&["approve", "admission", "--task", "ghost"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("no such task: ghost");
    org.run(&["audit", "--task", "ghost"])
        .assert_lacks("approve");
}

#[test]
fn signing_a_task_whose_project_asks_for_no_signature_says_so() {
    // Recorded either way — a holder may sign whatever they like — but silence would
    // let it be read as a gate that is now satisfied.
    let (org, _) = with_playbook("dispatch-ungated");
    a_task_in_src(&org, "t", "src/**", "true");
    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign")
        .assert_contains("nothing was waiting on it");
    org.run(&["start", "t"]).assert_ok("dispatches as before");
}

#[test]
fn the_loop_pauses_on_an_unsigned_task_rather_than_failing_it() {
    let org = signs_first("dispatch-loop", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");

    let r = org.run(&["loop", "--once"]);
    r.assert_ok("one pass")
        // Promoted, then held: the task is startable and waiting on a person, which are
        // two different facts and both true.
        .assert_contains("waiting → ready")
        .assert_contains("⏸ t needs your signature")
        .assert_lacks("▶ t");
    org.run(&["show", "t"]).assert_contains("status     ready");

    org.run(&["approve", "admission", "--task", "t"])
        .assert_ok("sign");
    org.run(&["loop", "--once"])
        .assert_ok("second pass")
        .assert_contains("▶ t")
        .assert_contains("passed");
}

#[test]
fn an_unsigned_task_does_not_hold_the_slot_behind_it() {
    // The queue is taken in id order, so `aaa` is offered first. If the gate were
    // applied after the concurrency cap, one unsigned task at the head would stall
    // everything behind it for as long as nobody signed.
    let org = signs_first(
        "dispatch-slot",
        "mkdir -p src/bbb && echo done >> src/bbb/x.txt",
    );
    a_task_in_src(&org, "aaa", "src/aaa/**", "true");
    a_task_in_src(&org, "bbb", "src/bbb/**", "grep -q done src/bbb/x.txt");
    org.run(&["approve", "admission", "--task", "bbb"])
        .assert_ok("sign the second one only");

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("⏸ aaa needs your signature")
        .assert_contains("▶ bbb");
}

// ----------------------------------------------------------------- merge ------

/// A workspace whose repo has a `dev` branch and the given merge policy.
fn mergeable(name: &str, policy: &str) -> (Org, PathBuf) {
    let (org, repo) = with_agent(name, "echo landed >> src/app.txt");
    org.playbook(
        &repo,
        &format!(
            "[project]\nlanguage = \"text\"\nmerge_to = \"dev\"\nmerge = \"{policy}\"\n\n\
             [chore]\nworktree = true\nassign_to = \"impl\"\naccept = [\"true\"]\n\
             tokens = 100\nwall_secs = 30\nguidance = \"x\"\n"
        ),
    );
    git(&repo, &["branch", "dev"]);
    // The chief already carries `merge_to` from the template: landing work is its job.
    (org, repo)
}

fn landed_task(org: &Org, id: &str) {
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
        "src/**",
        "--accept-cmd",
        "grep -q landed src/app.txt",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("task add");
    org.run(&["run", id]).assert_contains("passed");
}

#[test]
fn an_auto_project_merges_without_being_asked_and_reports_what_it_did() {
    let (org, repo) = mergeable("merge-auto", "auto");
    landed_task(&org, "t");

    let r = org.run(&["merge", "t"]);
    r.assert_ok("merge")
        .assert_contains("MERGED  t → dev")
        .assert_contains("how        automatic")
        // The way back leads, because auto-merge is only defensible if it is undoable.
        .assert_contains("undo       wecode rollback t")
        .assert_contains("src/app.txt");
    org.run(&["show", "t"]).assert_contains("status     done");

    let on_dev = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", "dev:src/app.txt"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&on_dev.stdout).contains("landed"));
}

#[test]
fn an_approved_project_waits_for_a_signature() {
    let (org, _) = mergeable("merge-approved", "approved");
    landed_task(&org, "t");

    let r = org.run(&["merge", "t"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("needs a signature")
        .assert_contains("wecode approve merge --task t");

    // A recorded signature, not a flag: the ledger is what the charter reads.
    org.run(&["approve", "merge", "--task", "t"])
        .assert_ok("sign");
    org.run(&["merge", "t"])
        .assert_ok("signed")
        .assert_contains("how        signed off");
}

#[test]
fn the_charter_outranks_an_auto_project() {
    // A project may be stricter than the company, never laxer. `merge = "auto"` on a
    // branch the charter protects changes nothing.
    let (org, _) = mergeable("merge-charter", "auto");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        text.replace("approval_to_merge = [", "approval_to_merge = [\"dev\", "),
    )
    .unwrap();

    landed_task(&org, "t");
    let r = org.run(&["merge", "t"]);
    assert!(!r.ok(), "the charter protects dev");
    r.assert_contains("charter protects that branch");

    // And a signature still lands it — the charter demands one, it does not forbid.
    org.run(&["approve", "merge", "--task", "t"])
        .assert_ok("sign");
    org.run(&["merge", "t"])
        .assert_ok("signed")
        .assert_contains("MERGED");
}

#[test]
fn only_verified_work_merges() {
    let (org, _) = mergeable("merge-unverified", "auto");
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
        "src/**",
        "--accept-cmd",
        "true",
        "--tokens",
        "10",
        "--wall",
        "5",
        "--to",
        "impl",
    ])
    .assert_ok("task add");
    let r = org.run(&["merge", "t"]);
    assert!(!r.ok());
    r.assert_contains("only verified work merges");
}

#[test]
fn a_merge_can_be_rolled_back_and_says_how_to_restore_it() {
    let (org, repo) = mergeable("merge-rollback", "auto");
    landed_task(&org, "t");
    org.run(&["merge", "t"]).assert_ok("merge");

    org.run(&["rollback", "t"])
        .assert_ok("rollback")
        .assert_contains("ROLLED BACK")
        // The trap, named before it is sprung.
        .assert_contains("will not")
        .assert_contains("git revert");
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");

    let on_dev = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", "dev:src/app.txt"])
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&on_dev.stdout).contains("landed"));
}

/// Trimmed stdout of a read-only git command, for asserting on what actually landed.
fn git_out(repo: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn the_merge_report_is_committed_where_the_task_record_lives() {
    // The gap: `merge` built the one document that says what a task did — files, line
    // counts, acceptance, provenance, what became of the tree — and printed it to a
    // terminal that scrolls. A week on, the only surviving trace of a landed task was a
    // merge commit.
    let (org, repo) = mergeable("merge-record", "auto");
    landed_task(&org, "t");

    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("record     docs/wecode/t/report.md @");

    // Beside the design the gate looks for, so one task's record is one directory.
    let file = git_out(&repo, &["show", "dev:docs/wecode/t/report.md"]);
    assert!(file.starts_with("# t → dev"), "{file}");
    assert!(file.contains("Generated, never authored"), "{file}");
    // The file *is* the report, not a second telling of it: re-rendering would give one
    // merge two accounts that could disagree.
    assert!(file.contains("MERGED  t → dev"), "{file}");
    assert!(file.contains("src/app.txt"), "{file}");
    assert!(file.contains("undo       wecode rollback t"), "{file}");
    assert!(file.contains("worktree   removed"), "{file}");
    // The one line it cannot carry is the one saying where it went. Nothing records its
    // own landing.
    assert!(!file.contains("record     docs"), "{file}");

    // A commit of its own, on top of the merge, because the report names the merge sha
    // and no commit can contain its own name. Not a merge commit either — `rollback`
    // finds the merge by grepping `--merges`, and a second match would break it.
    let log = git_out(&repo, &["log", "dev", "--format=%s", "-n", "2"]);
    let mut lines = log.lines();
    assert_eq!(lines.next(), Some("t: merge record"), "{log}");
    assert!(
        lines.next().expect("the merge").contains("t: append"),
        "{log}"
    );
    // `rollback` finds the merge by grepping `--merges`, so a record that was itself a
    // merge commit would be a second match sitting in front of the real one.
    let parents = git_out(&repo, &["rev-list", "--parents", "-n", "1", "dev"]);
    assert_eq!(
        parents.split_whitespace().count(),
        2,
        "one parent: {parents}"
    );
}

#[test]
fn rolling_back_a_merge_leaves_its_record_standing() {
    // A revert is a new commit rather than a rewrite, and the record is honest for the
    // same reason: the merge did happen. Deleting the report would leave the branch
    // carrying a merge and a revert that nothing accounts for.
    let (org, repo) = mergeable("merge-record-rollback", "auto");
    landed_task(&org, "t");
    org.run(&["merge", "t"]).assert_ok("merge");

    org.run(&["rollback", "t"])
        .assert_ok("rollback")
        .assert_contains("Its record stays too, at docs/wecode/t/report.md");

    let file = git_out(&repo, &["show", "dev:docs/wecode/t/report.md"]);
    assert!(file.contains("MERGED  t → dev"), "{file}");
    // And the work itself is gone, which is what a rollback is.
    let dev = git_out(&repo, &["ls-tree", "-r", "--name-only", "dev"]);
    assert!(dev.contains("docs/wecode/t/report.md"), "{dev}");
}

/// Whether the repo has a branch by that name.
fn has_branch(repo: &Path, branch: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .output()
        .expect("git runs")
        .status
        .success()
}

/// The one worktree the workspace has standing, by path.
fn standing(org: &Org) -> PathBuf {
    let live: Vec<PathBuf> = org
        .recorded()
        .into_iter()
        .filter(|w| w.removed.is_none())
        .map(|w| PathBuf::from(w.path))
        .collect();
    assert_eq!(
        live.len(),
        1,
        "expected exactly one standing tree: {live:?}"
    );
    live.into_iter().next().unwrap()
}

#[test]
fn landing_the_work_takes_its_worktree_down_and_keeps_the_branch() {
    // The gap: a tree was created and never removed. Once the merge lands, every commit
    // in it is reachable from the integration branch, so the directory is a copy rather
    // than the only copy — and four of them were still standing on the workspace that
    // found this.
    let (org, repo) = mergeable("merge-teardown", "auto");
    landed_task(&org, "t");
    let wt = standing(&org);
    assert!(wt.is_dir(), "the run left a tree at {wt:?}");

    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("worktree   removed");

    assert!(!wt.exists(), "{wt:?} should be gone");
    assert!(
        org.recorded()[0].removed.is_some(),
        "and the registry should say so rather than going on claiming it"
    );
    // The branch stays. Its commits are already on `dev`, so it is redundant — but
    // keeping it is what makes `wecode start` able to cut the tree again.
    assert!(has_branch(&repo, "wecode/t"), "the branch was deleted");
    org.run(&["worktree"]).assert_contains("no worktrees");
}

#[test]
fn a_tree_a_subtask_still_works_in_survives_the_merge() {
    // The branch belongs to the *main* task, so merging lands the whole tree's work
    // while its subtasks still have somewhere to be. Removing it here would take the
    // directory out from under them.
    let (org, _) = mergeable("merge-teardown-busy", "auto");
    landed_task(&org, "t");
    let wt = standing(&org);
    org.run(&[
        "task",
        "add",
        "t-doc",
        "--project",
        "caching",
        "--kind",
        "chore",
        "--parent",
        "t",
        "write down what the marker means",
        "--write",
        "docs/**",
        "--accept-cmd",
        "true",
        "--tokens",
        "100",
        "--wall",
        "30",
        "--to",
        "impl",
    ])
    .assert_ok("subtask");

    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("worktree   kept")
        .assert_contains("t-doc still working");
    assert!(wt.is_dir(), "{wt:?} should still be there");

    // And once the subtask closes, the next thing that lands takes the tree with it.
    org.run(&["status", "t-doc", "dropped"]).assert_ok("close");
    org.run(&["worktree", "remove", "t"])
        .assert_ok("remove")
        .assert_contains("removed");
    assert!(!wt.exists());
}

// ------------------------------------------------------------ the steps ---------

/// One main task and two ordered steps beneath it — the shape `--expand` emits.
///
/// Every one of them writes `src/**`, which the admission gate allows here for two
/// separate reasons: a subtask is nested in its parent, and the second step is
/// declared after the first, so the two can never run at once.
fn with_steps(org: &Org, main: &str) {
    let add = |id: &str, extra: &[&str]| {
        let mut argv = vec![
            "task",
            "add",
            id,
            "--project",
            "caching",
            "--kind",
            "chore",
            "append a marker comment to the source",
            "--write",
            "src/**",
            "--accept-cmd",
            "grep -q landed src/app.txt",
            "--tokens",
            "100",
            "--wall",
            "30",
            "--to",
            "impl",
        ];
        argv.extend_from_slice(extra);
        org.run(&argv)
    };
    add(main, &[]).assert_ok("main task");
    add(&format!("{main}-one"), &["--parent", main]).assert_ok("first step");
    add(
        &format!("{main}-two"),
        &["--parent", main, "--after", &format!("{main}-one")],
    )
    .assert_ok("second step");
}

#[test]
fn a_step_that_passes_finishes_instead_of_parking_at_approval() {
    // The gap this closes. A subtask that passed went to `needs-approval` and waited
    // for a landing decision that could not be taken about it: its commits are on the
    // main task's branch, so merging it would have put every step of the expansion on
    // the integration branch, including the ones that had not run. Nothing could
    // correctly grant that approval — and while it stood there the sibling declared
    // after it stayed `waiting`, because readiness follows `done`, and the loop stops
    // dispatching entirely while anything needs a human. One passing step held up the
    // rest of its own plan.
    let (org, _) = mergeable("step-lands", "auto");
    with_steps(&org, "t");

    org.run(&["run", "t-one"])
        .assert_ok("first step")
        .assert_contains("passed")
        // And it says where the work went, because the status word cannot: `done`
        // here does not mean landed, it means there is nothing left of this task to
        // land separately.
        .assert_contains("its commits are on t's branch");
    org.run(&["show", "t-one"])
        .assert_contains("status     done");

    // Which is the whole point: the next step is startable now, with no signature in
    // between.
    org.run(&["tick"]).assert_ok("tick");
    org.run(&["show", "t-two"])
        .assert_contains("status     ready");
}

#[test]
fn a_step_cannot_be_merged_on_its_own_and_the_main_task_lands_them_all() {
    // The other half. `merge` on a step used to land the whole shared branch and mark
    // one task done; now it is refused and says which task does land it.
    let (org, repo) = mergeable("step-merge", "auto");
    with_steps(&org, "t");
    org.run(&["run", "t-one"]).assert_ok("first step");

    let r = org.run(&["merge", "t-one"]);
    assert!(!r.ok(), "a step lands nothing on its own");
    r.assert_contains("t-one is part of t")
        .assert_contains("wecode merge t");

    // The main task owns the tree and the branch, so it is what lands. Its own run
    // commits on top of the step's, and the merge takes both.
    org.run(&["run", "t"]).assert_ok("main task");
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");
    org.run(&["merge", "t"])
        .assert_ok("the main task lands")
        .assert_contains("MERGED  t → dev")
        // t-two never ran, so the directory is still somebody's.
        .assert_contains("t-two still working");

    let on_dev = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", "dev:src/app.txt"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&on_dev.stdout)
            .matches("landed")
            .count(),
        2,
        "the step's commit and the main task's both landed"
    );
}

#[test]
fn uncommitted_work_keeps_the_tree_standing_through_a_merge() {
    // Teardown nobody asked for does not get to decide that uncommitted work was
    // worthless. The merge took what was committed; anything else stays where it is.
    let (org, _) = mergeable("merge-teardown-dirty", "auto");
    landed_task(&org, "t");
    let wt = standing(&org);
    std::fs::write(wt.join("scratch.txt"), "half an idea\n").unwrap();

    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("worktree   kept")
        .assert_contains("uncommitted");
    assert!(wt.join("scratch.txt").exists(), "the work is still there");

    // The operator still decides, and has to say so.
    let r = org.run(&["worktree", "remove", "t"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("scratch.txt");
    org.run(&["worktree", "remove", "t", "--force"])
        .assert_ok("forced")
        .assert_contains("discarded");
}

#[test]
fn a_rolled_back_merge_can_have_its_tree_cut_again() {
    // What makes teardown safe: the branch is kept, so reopening the work is one
    // command and it comes back at the tip the merge landed.
    let (org, _) = mergeable("merge-teardown-redo", "auto");
    landed_task(&org, "t");
    let wt = standing(&org);
    org.run(&["merge", "t"]).assert_ok("merge");
    assert!(!wt.exists());

    org.run(&["rollback", "t"]).assert_ok("rollback");
    org.run(&["start", "t"]).assert_ok("start again");
    assert!(wt.is_dir(), "the tree is back at {wt:?}");
    assert!(
        wt.join("src/app.txt").exists(),
        "and it holds the work, not an empty checkout"
    );
}

#[test]
fn merging_twice_is_refused_rather_than_silently_doing_nothing() {
    let (org, _) = mergeable("merge-twice", "auto");
    landed_task(&org, "t");
    org.run(&["merge", "t"]).assert_ok("merge");
    org.run(&["status", "t", "needs-approval"])
        .assert_ok("reopen");

    let r = org.run(&["merge", "t"]);
    assert!(!r.ok(), "a no-op merge must not read as success");
    r.assert_contains("already merged");
}

// ---------------------------------------------------------------- notify ------

/// Points the workspace's notify hook at a file, and returns where it will write.
///
/// A file rather than a real notifier: what is being proved is that a command runs
/// with the task in its environment, and `notify-send` would prove the same thing
/// only on a machine with a desktop on it.
fn notified(org: &Org, body: &str) -> PathBuf {
    notified_with(org, body, "")
}

/// The same, with `extra` lines added to the `[notify]` block.
fn notified_with(org: &Org, body: &str, extra: &str) -> PathBuf {
    let log = org.path("notified.txt");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!(
            "{text}\n[notify]\ncommand = \"{body} >> {}\"\ntimeout = \"30s\"\n{extra}",
            log.display()
        ),
    )
    .unwrap();
    log
}

/// Points the workspace's notify hook at `command` itself.
///
/// For the cases where what the hook *says* is the thing under test rather than what
/// it is told, so the command is not wrapped in a redirect to a log.
fn hooked(org: &Org, command: &str) {
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[notify]\ncommand = \"{command}\"\ntimeout = \"20s\"\n"),
    )
    .unwrap();
}

/// Every line the hook has written, in order.
fn announcements(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn a_task_that_stops_for_a_person_runs_the_hook() {
    // The gap using wecode on itself kept finding. Everything up to the moment a task
    // needs a signature happens unattended; the notification that it does was the
    // operator remembering to look at a terminal.
    let org = Org::new("notify-stops", "solo");
    org.seed();
    let log = notified(
        &org,
        "echo $WECODE_TASK $WECODE_WAITING_FOR $WECODE_TASK_STATUS $WECODE_PROJECT",
    );

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    assert_eq!(
        announcements(&log),
        vec!["cache-tests approval needs-approval caching"]
    );
}

#[test]
fn the_hook_is_handed_the_number_to_reply_with() {
    // The notification and the answer, closed. A message naming only `cache-tests`
    // leaves the operator spelling a slug back on a phone keyboard; one that carries
    // the number leaves them typing `approve #2`.
    let org = Org::new("notify-number", "solo");
    org.seed();
    let log = notified(&org, "echo $WECODE_TASK '#'$WECODE_TASK_NUMBER");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person");
    // The digits alone in the variable, so the hook decides how to write it.
    assert_eq!(announcements(&log), vec!["cache-tests #2"]);
}

#[test]
fn work_that_does_not_stop_announces_nothing() {
    // The control, and the whole reason this is edge-triggered: a hook that fired on
    // every status change would be one the operator silences within a day.
    let org = Org::new("notify-quiet", "solo");
    org.seed();
    let log = notified(&org, "echo $WECODE_TASK");

    for status in ["running", "verifying", "done"] {
        org.run(&["status", "cache-tests", status])
            .assert_ok(status);
    }
    assert!(announcements(&log).is_empty(), "{:?}", announcements(&log));
}

#[test]
fn one_wait_is_announced_once_however_it_is_renamed() {
    // `failed` → `needs-input` is a person who is already holding this task being
    // told about it again. The wait began once, and that is what is announced.
    let org = Org::new("notify-once", "solo");
    org.seed();
    let log = notified(&org, "echo $WECODE_WAITING_FOR");

    for status in ["failed", "needs-input", "needs-approval"] {
        org.run(&["status", "cache-tests", status])
            .assert_ok(status);
    }
    assert_eq!(announcements(&log), vec!["failed"]);

    // Released, then stuck again: a second wait, and a second announcement.
    org.run(&["status", "cache-tests", "ready"]).assert_ok("go");
    org.run(&["status", "cache-tests", "failed"])
        .assert_ok("stuck again");
    assert_eq!(announcements(&log), vec!["failed", "failed"]);
}

#[test]
fn a_run_that_ends_in_front_of_a_person_announces_it() {
    // The path that matters most: nobody is watching when this happens, which is the
    // entire premise of `wecode loop`.
    let (org, _) = with_agent("notify-run", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    let log = notified(&org, "echo $WECODE_TASK $WECODE_WAITING_FOR");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    assert_eq!(announcements(&log), vec!["t approval"]);
}

#[test]
fn the_message_carries_what_the_run_produced() {
    // The other half of answering from a phone. `t approval` says you are wanted; it
    // does not say what for, and deciding whether to sign meant opening a terminal to
    // look at the diff — which is the trip the hook exists to save. So the paths go
    // out with it, read out of git rather than taken from the agent's word for it.
    let (org, _) = with_agent("notify-made", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    let log = notified(
        &org,
        "echo $WECODE_CHANGED_COUNT $WECODE_CHANGED_FILES $WECODE_WORKTREE",
    );

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    let said = announcements(&log);
    assert_eq!(said.len(), 1, "one wait, one announcement: {said:?}");
    let mut parts = said[0].split_whitespace();
    assert_eq!(parts.next(), Some("1"), "one path changed: {said:?}");
    assert_eq!(parts.next(), Some("a.txt"), "and it is named: {said:?}");
    // The tree itself, so a hook wanting the diff rather than the names can ask git
    // for it. It is the work's own worktree, not the workspace or the repository.
    let tree = PathBuf::from(parts.next().expect("the tree: {said:?}"));
    assert!(tree.join("a.txt").is_file(), "not the worktree: {said:?}");
    assert_eq!(parts.next(), None, "nothing else on the line: {said:?}");
}

#[test]
fn the_message_carries_the_change_and_not_only_the_shape_of_it() {
    // What the names alone cannot answer. `1 a.txt` says the same thing whether the
    // attempt rewrote the file or corrected a letter in it, so an operator who can now
    // sign from a phone could sign without ever being shown what they were signing —
    // and the way to see it was `git -C $WECODE_WORKTREE diff`, which is a terminal,
    // which is the trip the whole hook exists to save.
    let (org, _) = with_agent("notify-diff", "echo done >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    let log = notified(&org, "echo \\\"$WECODE_DIFF\\\"");

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    let said = announcements(&log).join("\n");
    assert!(said.contains("a.txt"), "the file is not named: {said}");
    assert!(said.contains("+done"), "the change itself is missing: {said}");
}

#[test]
fn the_names_are_capped_where_the_operator_says_and_the_count_never_is() {
    // Why the count is its own variable. The bound is on what an environment should
    // carry to a channel with one line in it; a message that answered "how much
    // changed" with the bound would be the notification agreeing with itself instead
    // of with the diff.
    let (org, _) = with_agent("notify-capped", "echo done >> a.txt; echo done >> b.txt");
    a_task(&org, "t", "*.txt", "grep -q done b.txt");
    let log = notified_with(
        &org,
        "echo $WECODE_CHANGED_COUNT $WECODE_CHANGED_FILES",
        "max_files = 1\n",
    );

    org.run(&["run", "t"])
        .assert_ok("run")
        .assert_contains("passed");
    assert_eq!(announcements(&log), vec!["2 a.txt"]);
}

#[test]
fn a_wait_for_permission_to_start_has_nothing_to_show_yet() {
    // `signature` is the one wait that comes before any work, and empty is what says
    // so. Reporting `0` here would have the notification describing an empty diff
    // that nothing produced.
    let org = signs_first("notify-unmade", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    let log = notified(
        &org,
        "echo $WECODE_WAITING_FOR [$WECODE_CHANGED_COUNT] [$WECODE_WORKTREE]",
    );

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("⏸ t needs your signature");
    assert_eq!(announcements(&log), vec!["signature [] []"]);
}

#[test]
fn a_run_that_fails_its_acceptance_announces_that_instead() {
    let (org, _) = with_agent("notify-run-fail", "echo nothing >> a.txt");
    a_task(&org, "t", "a.txt", "grep -q done a.txt");
    let log = notified(&org, "echo $WECODE_TASK $WECODE_WAITING_FOR");

    org.run(&["run", "t"]).assert_ok("run");
    assert_eq!(announcements(&log), vec!["t failed"]);
}

#[test]
fn the_loop_announces_a_task_it_is_holding_for_a_signature() {
    // The one wait with no status change behind it: the task is `ready` and stays
    // ready. Without this the dispatch gate is a queue that stops silently.
    let org = signs_first("notify-signature", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    let log = notified(
        &org,
        "echo $WECODE_TASK $WECODE_WAITING_FOR $WECODE_TASK_STATUS",
    );

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("⏸ t needs your signature");
    assert_eq!(announcements(&log), vec!["t signature ready"]);
}

#[test]
fn a_hook_that_fails_is_reported_without_touching_the_verdict() {
    // A notification is not part of judging the work. The task stopped for a person
    // whether or not anything managed to tell them, and a command that failed because
    // its notifier did would send the operator hunting in the wrong place.
    let org = Org::new("notify-broken", "solo");
    org.seed();
    hooked(&org, "exit 7");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("the status change still succeeds")
        .assert_contains("⚠ notify")
        .assert_contains("exited 7");
    org.run(&["show", "cache-tests"])
        .assert_contains("status     needs-approval");
}

#[test]
fn a_hook_that_exits_well_and_refuses_the_message_is_not_reported_as_a_delivery() {
    // The failure this half of the module exists for. A chat API refuses a wrong id in
    // its *reply*: the `curl` carrying the refusal exits `0` having done exactly what it
    // was asked, and its body went to stdout, which wecode used to throw away. So a
    // message that never arrived reached the terminal as the same silence a delivered
    // one does — and the operator waits on a phone for a notification that was refused
    // an hour ago, which is the whole thing this module is for.
    let org = Org::new("notify-refused", "solo");
    org.seed();
    hooked(&org, "echo Bad Request: chat not found");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("the status change still succeeds")
        .assert_contains("⚠ notify")
        .assert_contains("Bad Request: chat not found");
    // Still not a verdict about the work: the task stopped for a person whether or not
    // anything managed to tell them.
    org.run(&["show", "cache-tests"])
        .assert_contains("status     needs-approval");
}

#[test]
fn a_hook_that_delivers_quietly_is_left_alone() {
    // The control, and the reason the rule can be this weak. A notifier that got its
    // `200` has nothing to say, and a report on every announcement would be a warning
    // the operator learns to read past — which is how the refusal above gets missed.
    let org = Org::new("notify-quiet-hook", "solo");
    org.seed();
    hooked(&org, "true");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("stop it for a person")
        .assert_lacks("⚠ notify");
}

#[test]
fn a_hook_that_fails_is_reported_with_the_reason_it_gave_for_failing() {
    // `exited 6` names the failure and not the cause. The cause was in the sentence the
    // hook wrote on the way out, and answering "why did nothing tell me" from a status
    // number alone means going and running the notifier by hand.
    let org = Org::new("notify-why", "solo");
    org.seed();
    hooked(&org, "echo could not resolve api.example.invalid >&2; exit 6");

    org.run(&["status", "cache-tests", "needs-approval"])
        .assert_ok("the status change still succeeds")
        .assert_contains("exited 6")
        // Caught on stderr as readily as on stdout: `curl` complains on one and prints
        // the refusal it is complaining about on the other.
        .assert_contains("could not resolve api.example.invalid");
}

#[test]
fn a_hook_that_floods_is_quoted_by_one_line_and_does_not_stall_the_run() {
    // Two bounds at once. A notifier's chatter must not become the record of the work —
    // that is why it was thrown away in the first place — so however much it wrote, one
    // line of it goes beside the wait. And it must be able to write more than a pipe
    // holds without the run stopping to wait on it.
    let org = Org::new("notify-loud", "solo");
    org.seed();
    hooked(&org, "seq 1 40000");

    let r = org.run(&["status", "cache-tests", "needs-approval"]);
    r.assert_ok("the status change still succeeds")
        .assert_contains("said: 1")
        .assert_lacks("39999");
    assert!(
        r.all().lines().count() < 20,
        "the hook buried the run:\n{}",
        r.all()
    );
}

#[test]
fn a_workspace_with_no_hook_runs_nothing() {
    // The default. Every workspace that has never heard of the setting is one of
    // these, and none of them may start a process because a task stopped.
    let org = Org::new("notify-absent", "solo");
    org.seed();
    org.run(&["status", "cache-tests", "failed"])
        .assert_ok("stop it")
        .assert_lacks("notify");
}

#[test]
fn a_notify_command_the_charter_forbids_is_refused_rather_than_run() {
    // An invariant outranks every grant, and company.toml does not get to be the
    // exception because the line happens to be in a different block of it.
    let org = Org::new("notify-forbidden", "solo");
    org.seed();
    // Written relative, because the hook runs in the workspace: an absolute path in
    // the command line would put a `/` in it, and `*` stays inside one segment.
    let log = org.path("notified.txt");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let charter = text.replace(
        "never_run = [\"git push --force*\", \"npm publish*\"]",
        "never_run = [\"git push --force*\", \"curl *\"]",
    );
    assert_ne!(charter, text, "the template's never_run was not replaced");
    std::fs::write(
        &conf,
        format!("{charter}\n[notify]\ncommand = \"curl -so notified.txt example.invalid\"\n"),
    )
    .unwrap();

    org.run(&["status", "cache-tests", "failed"])
        .assert_ok("the task still stops")
        .assert_contains("never_run");
    assert!(!log.exists(), "the hook must not have run");
}

#[test]
fn the_profile_says_whether_anything_will_tell_you() {
    // Both ways round, because "why did nothing tell me" is answered by the absence
    // as much as by the command, and a line only printed when a hook exists answers
    // it with the same silence being complained about.
    let org = Org::new("notify-shown", "solo");
    org.run(&["company", "show"])
        .assert_ok("show")
        .assert_contains("notify:    nothing");

    notified(&org, "echo $WECODE_TASK");
    org.run(&["company", "show"])
        .assert_ok("show")
        .assert_contains("when a task starts waiting, killed after 30s");
}

#[test]
fn a_notify_block_with_nothing_to_run_is_refused_at_load() {
    // The failure a gate must not have: a setting that reads as configured and
    // behaves as absent. Refused where every other bad value in this file is.
    let org = Org::new("notify-blank", "solo");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, format!("{text}\n[notify]\ncommand = \"\"\n")).unwrap();

    let r = org.run(&["company", "show"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("[notify] command");
}

// -------------------------------------------------------------- telegram ------

/// Points the workspace's reply channel at a file, and says which account the user in
/// the chief's seat replies from. Returns the file to write updates into.
///
/// `cat` rather than `curl`: what is being proved is that what the channel says gets
/// signed, and a real bot token would prove the same thing only on a machine that has
/// one. The fetch being a command line is exactly what makes the substitution possible.
fn chatting(org: &Org, account: &str) -> PathBuf {
    let replies = org.path("replies.json");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let claimed = text.replace(
        "[[users]]\nname = \"you\"\npost = \"chief\"",
        &format!("[[users]]\nname = \"you\"\npost = \"chief\"\ntelegram = \"{account}\""),
    );
    assert_ne!(claimed, text, "the template's user block was not replaced");
    std::fs::write(
        &conf,
        format!(
            "{claimed}\n[telegram]\nfetch = \"cat {}\"\n",
            replies.display()
        ),
    )
    .unwrap();
    replies
}

/// One update, shaped the way the Bot API hands it over. `from` is unquoted, because
/// Telegram sends account ids as numbers and `company.toml` writes them as strings.
fn reply(id: i64, from: &str, text: &str, answering: &str) -> String {
    let message = format!(
        "{{\"message_id\":{id},{}{}{}{}}}",
        format_args!("\"from\":{{\"id\":{from},\"is_bot\":false,\"username\":\"you\"}},"),
        format_args!("\"chat\":{{\"id\":{from},\"type\":\"private\"}},\"date\":1770000000,"),
        format_args!("\"text\":\"{text}\","),
        format_args!("\"reply_to_message\":{{\"message_id\":1,\"text\":\"{answering}\"}}"),
    );
    format!("{{\"update_id\":{id},\"message\":{message}}}")
}

/// One tapped button, shaped the way the Bot API hands it over. A `callback_query` rather
/// than a message: it carries the `data` the operator put on the button, and the
/// notification the keyboard hangs under in place of a message replied to.
fn tapped(id: i64, from: &str, data: &str, under: &str) -> String {
    let query = format!(
        "{{\"id\":\"cb{id}\",{}{}{}}}",
        format_args!("\"from\":{{\"id\":{from},\"is_bot\":false,\"username\":\"you\"}},"),
        format_args!("\"chat_instance\":\"-176\",\"data\":\"{data}\","),
        format_args!("\"message\":{{\"message_id\":1,\"text\":\"{under}\"}}"),
    );
    format!("{{\"update_id\":{id},\"callback_query\":{query}}}")
}

/// Gives the workspace something to say what came of a tap with, added to the
/// `[telegram]` block [`chatting`] wrote. Returns the file that command appends to.
///
/// `echo` rather than `curl`, for [`chatting`]'s reason: what is being proved is that the
/// callback and the outcome reach the operator's line, and a real `answerCallbackQuery`
/// would prove that only on a machine with a bot token on it.
fn acknowledging(org: &Org) -> PathBuf {
    let said = org.path("answered.txt");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    assert!(text.contains("[telegram]"), "chatting() comes first");
    std::fs::write(
        &conf,
        format!(
            "{text}answer = \"echo \\\"$WECODE_TELEGRAM_CALLBACK $WECODE_TELEGRAM_ANSWER\\\" >> {}\"\n",
            said.display()
        ),
    )
    .unwrap();
    said
}

/// What the channel is holding right now.
fn holding(replies: &Path, updates: &[String]) {
    std::fs::write(
        replies,
        format!("{{\"ok\":true,\"result\":[{}]}}", updates.join(",")),
    )
    .unwrap();
}

#[test]
fn a_reply_signs_the_merge_it_answers() {
    // The gap this closes. Everything up to the signature happens unattended, the
    // notification reaches a phone, and until now the signature still needed a
    // terminal — so work that passed at 02:14 landed in the morning anyway.
    let (org, _) = mergeable("tg-merge", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(
            700_123,
            "48210934",
            "approve",
            "t needs you: approval",
        )],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("approved merge");

    // How it arrived is on the record, and the post's coding agent is not: nobody typed
    // this at a keyboard, and a row saying `claude-code` would say so.
    org.run(&["audit", "--task", "t"])
        .assert_ok("audit")
        .assert_contains("chief       telegram");

    // The gate that reads the signature has no idea a phone was involved, which is the
    // whole design: one ledger record, given by the post, however it arrived.
    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("MERGED  t → dev");
}

#[test]
fn a_tap_signs_the_merge_the_notification_is_about() {
    // The last of the typing gone. The operator is holding a phone at 02:14, the
    // notification has an *Approve* button on it, and one thumb lands the work — no
    // keyboard, and nothing to remember about which task it was.
    let (org, _) = mergeable("tg-tap", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(
            700_125,
            "48210934",
            "approve",
            "t needs you: approval",
        )],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("approved merge");

    // Told back to the phone that sent it, which is the half a tap needs and a typed
    // reply does not: the callback to answer, and what came of it.
    let back = std::fs::read_to_string(&said).expect("the tap was acknowledged");
    assert!(back.contains("cb700125"), "{back}");
    assert!(back.contains("approved merge"), "{back}");

    // And it is the same signature by the same seat as a typed reply — one ledger
    // record, given by the post, however it arrived.
    org.run(&["audit", "--task", "t"])
        .assert_ok("audit")
        .assert_contains("chief       telegram");
    org.run(&["merge", "t"])
        .assert_ok("merge")
        .assert_contains("MERGED  t → dev");
}

#[test]
fn a_tap_from_an_account_nobody_claims_is_told_it_signed_nothing() {
    // A button is more findable than a sentence: anyone in the chat can press it. The
    // identity check is the same one a typed reply gets — and the refusal goes back to
    // the phone, because a stranger left looking at a spinner learns less than the
    // operator whose own id is missing from `company.toml` does.
    let (org, _) = mergeable("tg-tap-stranger", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(1, "99999999", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("no user in company.toml");

    let back = std::fs::read_to_string(&said).expect("the tap was acknowledged");
    assert!(back.contains("cb1"), "{back}");
    assert!(back.contains("no user in company.toml"), "{back}");
    assert!(
        !org.run(&["merge", "t"]).ok(),
        "an unclaimed account must not be able to land work by button either"
    );
}

#[test]
fn a_button_that_decides_nothing_is_told_so_rather_than_left_looking_broken() {
    // `data` is a string the operator put on their own keyboard, so a tap that says
    // nothing recognisable is a keyboard to fix — and the person who can fix it is the
    // one holding the phone. Chat is passed over silently; a button never is.
    let (org, _) = mergeable("tg-tap-odd", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(
            3,
            "48210934",
            "sure why not",
            "t needs you: approval",
        )],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("that button decides nothing");

    let back = std::fs::read_to_string(&said).expect("the tap was acknowledged");
    assert!(back.contains("cb3"), "{back}");
    assert!(!org.run(&["merge", "t"]).ok(), "nothing was signed");
}

#[test]
fn a_typed_reply_is_left_to_be_its_own_receipt() {
    // The asymmetry is the whole reason `answer` exists. A typed `approve` is already in
    // the chat, in front of the person who typed it; saying it back would be wecode
    // repeating them. A tap leaves nothing behind, so it is told what it did.
    let (org, _) = mergeable("tg-typed-quiet", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[reply(2, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("approved merge");
    assert!(!said.exists(), "a typed reply was answered back at");
}

#[test]
fn a_dry_run_says_nothing_into_the_chat_either() {
    // "Moves nothing" has to include the chat. A dry run that acknowledged a tap would
    // tell the operator their button had been dealt with, and leave it to be dealt with
    // again on the next pass.
    let (org, _) = mergeable("tg-tap-dry", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let said = acknowledging(&org);
    holding(
        &replies,
        &[tapped(11, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram", "--dry-run"])
        .assert_ok("dry run")
        .assert_contains("would sign merge for t");
    assert!(!said.exists(), "a dry run spoke into the chat");

    // And the tap is still there to be acted on, and acknowledged, for real.
    org.run(&["telegram"])
        .assert_ok("for real")
        .assert_contains("approved merge");
    assert!(
        std::fs::read_to_string(&said).unwrap().contains("cb11"),
        "the tap was acknowledged on the pass that acted on it"
    );
}

#[test]
fn a_tap_that_could_not_be_acknowledged_keeps_its_signature() {
    // `answerCallbackQuery` refuses a query more than a minute old, so this is the
    // ordinary failure and not an exotic one. It must be a warning: the signature is
    // already given, and un-signing it because the receipt bounced would lose the
    // approval the operator actually gave.
    let (org, _) = mergeable("tg-tap-mute", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}answer = \"echo query is too old >&2; exit 6\"\n"),
    )
    .unwrap();
    holding(
        &replies,
        &[tapped(4, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("a receipt that bounced is a report, not a crash")
        .assert_contains("approved merge")
        // Said under the outcome, so it is clear which of the two failed.
        .assert_contains("could not say so in the chat")
        .assert_contains("query is too old");
    org.run(&["merge", "t"]).assert_ok("merge");
}

#[test]
fn an_answer_with_no_fetch_to_read_the_taps_is_refused_at_load() {
    // Nothing would ever run it — taps arrive through the fetch — so it reads as
    // configured and behaves as absent, which is the shape `[telegram]` already refuses.
    let org = Org::new("tg-answer-alone", "solo");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, format!("{text}\n[telegram]\nanswer = \"true\"\n")).unwrap();

    let r = org.run(&["company", "show"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("nothing would read");
}

#[test]
fn a_reply_from_an_account_nobody_claims_signs_nothing() {
    // The only identity check there is. There is no fallback seat for a stranger who
    // finds the bot, and a message from one must be worth exactly nothing.
    let (org, _) = mergeable("tg-stranger", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(1, "99999999", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("no user in company.toml");

    let r = org.run(&["merge", "t"]);
    assert!(
        !r.ok(),
        "an unclaimed account must not be able to land work"
    );
    r.assert_contains("needs a signature");
}

#[test]
fn a_reply_from_a_seat_that_may_not_approve_is_refused_and_recorded() {
    // Naming an account says who somebody is. What they may sign is the post's
    // business, decided by the Broker at the moment of signing — the same refusal the
    // same person would get typing it at a terminal.
    let (org, _) = mergeable("tg-ungranted", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    // The engineer's seat: it writes code and signs nothing.
    std::fs::write(
        &conf,
        format!("{text}\n[[users]]\nname = \"dev\"\npost = \"impl\"\ntelegram = \"777\"\n"),
    )
    .unwrap();
    holding(
        &replies,
        &[reply(1, "777", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("a refused reply is a report, not a crash")
        .assert_contains("refused for `impl`");
    // Recorded, like every other refusal: an attempt to sign is worth knowing about.
    org.run(&["audit", "--denied"])
        .assert_ok("audit")
        .assert_contains("approve");

    assert!(!org.run(&["merge", "t"]).ok(), "nothing was signed");
}

#[test]
fn a_message_is_acted_on_once_however_often_the_channel_is_read() {
    // The channel hands the same message back until it is told not to, and `wecode
    // loop` reads it every five seconds. Without a cursor, one "approve" would be a
    // signature per pass, forever.
    let (org, _) = mergeable("tg-once", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(42, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("first read")
        .assert_contains("approved merge");
    org.run(&["telegram"])
        .assert_ok("second read")
        .assert_contains("nothing to sign")
        .assert_lacks("approved merge");
}

#[test]
fn a_reply_that_says_no_signs_nothing_and_leaves_the_task_in_front_of_a_person() {
    // Withholding the signature is what "no" already means, and it is the only thing a
    // one-word reply is precise enough to say. The task stays where it is.
    let (org, _) = mergeable("tg-no", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(3, "48210934", "no", "t needs you: approval")],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("t stays needs-approval")
        .assert_lacks("approved");
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");
    assert!(!org.run(&["merge", "t"]).ok(), "nothing was signed");
}

#[test]
fn chat_that_is_not_a_decision_is_left_alone() {
    // A channel people talk in is a channel wecode has to be quiet in. Guessing at
    // "what is this one doing?" is how a signature gets given by accident.
    let (org, _) = mergeable("tg-chat", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(
            5,
            "48210934",
            "what is t doing?",
            "t needs you: approval",
        )],
    );

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("nothing to sign")
        .assert_lacks("approved");
}

#[test]
fn a_reply_answering_nothing_recognisable_says_so_and_is_still_got_past() {
    // Two properties at once, because they are the same property: a message that
    // cannot be acted on is reported *and* consumed. One reported and left behind
    // would be the same complaint on every pass, forever.
    let (org, _) = mergeable("tg-nothing", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(&replies, &[reply(8, "48210934", "approve", "all clear")]);

    org.run(&["telegram"])
        .assert_ok("read the channel")
        .assert_contains("names no task");
    org.run(&["telegram"])
        .assert_ok("second read")
        .assert_contains("nothing to sign");
}

#[test]
fn a_dry_run_says_what_would_be_signed_and_moves_neither_a_signature_nor_the_cursor() {
    let (org, _) = mergeable("tg-dry", "approved");
    landed_task(&org, "t");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(11, "48210934", "approve", "t needs you: approval")],
    );

    org.run(&["telegram", "--dry-run"])
        .assert_ok("dry run")
        .assert_contains("would sign merge for t");
    assert!(!org.run(&["merge", "t"]).ok(), "a dry run signed something");

    // And the message is still there to be acted on for real, which is the half of
    // "moves nothing" that is easy to get wrong.
    org.run(&["telegram"])
        .assert_ok("for real")
        .assert_contains("approved merge");
    org.run(&["merge", "t"]).assert_ok("merge");
}

#[test]
fn the_loop_signs_the_dispatch_gate_from_a_reply_and_then_dispatches() {
    // The whole loop closed, in one pass: a task the gate is holding, a reply to the
    // notification about it, and the work starting — with nobody at a terminal.
    let org = signs_first("tg-loop", "echo done >> src/app.txt");
    a_task_in_src(&org, "t", "src/**", "grep -q done src/app.txt");
    let replies = chatting(&org, "48210934");
    holding(
        &replies,
        &[reply(9, "48210934", "approve", "t needs your signature")],
    );

    org.run(&["loop", "--once"])
        .assert_ok("one pass")
        .assert_contains("approved admission")
        // Read before the queue is, so a signature releases work on the pass that
        // finds it rather than the one after.
        .assert_contains("▶ t")
        .assert_lacks("⏸ t needs your signature");
    org.run(&["show", "t"])
        .assert_contains("status     needs-approval");
}

#[test]
fn a_loop_whose_channel_is_unreachable_keeps_working() {
    // A channel that cannot be reached is a reason to keep going unattended, not a
    // reason to stop: the work is what the loop is for.
    let org = Org::new("tg-unreachable", "solo");
    org.seed();
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[telegram]\nfetch = \"echo no route to host >&2; exit 6\"\n"),
    )
    .unwrap();

    org.run(&["loop", "--once"])
        .assert_ok("the pass still runs")
        .assert_contains("⚠ telegram")
        .assert_contains("no route to host");
}

#[test]
fn a_fetch_the_charter_forbids_is_refused_rather_than_run() {
    // The line that polls a chat channel is no more above the charter than the line
    // that launches an agent, and it is written in the same file the charter is.
    let org = Org::new("tg-forbidden", "solo");
    org.seed();
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    let charter = text.replace(
        "never_run = [\"git push --force*\", \"npm publish*\"]",
        "never_run = [\"git push --force*\", \"curl *\"]",
    );
    assert_ne!(charter, text, "the template's never_run was not replaced");
    std::fs::write(
        &conf,
        format!("{charter}\n[telegram]\nfetch = \"curl -so replies.json example.invalid\"\n"),
    )
    .unwrap();

    let r = org.run(&["telegram"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("never_run");
    assert!(
        !org.path("replies.json").exists(),
        "the fetch must not have run"
    );
}

#[test]
fn a_workspace_with_no_channel_says_so_rather_than_reading_nothing() {
    let org = Org::new("tg-absent", "solo");
    let r = org.run(&["telegram"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("[telegram] fetch");
}

#[test]
fn the_profile_says_whether_a_reply_can_sign_anything() {
    // "I replied and nothing happened" has two answers — nothing reads the channel, or
    // nothing knows the account that replied — and both are in one place.
    let org = Org::new("tg-shown", "solo");
    org.run(&["company", "show"])
        .assert_ok("show")
        .assert_contains("replies:   nothing");

    chatting(&org, "48210934");
    org.run(&["company", "show"])
        .assert_ok("show")
        .assert_contains("signed by: you");
}

#[test]
fn a_telegram_block_with_nothing_to_run_is_refused_at_load() {
    // The failure a gate must not have, in the shape `[notify]` already refuses: a
    // block that says replies will be read and a value that means none ever are.
    let org = Org::new("tg-blank", "solo");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, format!("{text}\n[telegram]\nfetch = \"\"\n")).unwrap();

    let r = org.run(&["company", "show"]);
    assert!(!r.ok(), "should refuse");
    r.assert_contains("[telegram] fetch");
}
