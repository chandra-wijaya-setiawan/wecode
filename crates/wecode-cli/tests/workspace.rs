//! Standing a workspace up, and getting a session on it.
//!
//! Also the reading commands that belong to no one area in particular: the board,
//! the short numbers every view prints, the help, and the brief a seat is handed.

mod support;

use std::path::Path;
use std::process::Command;

use support::playbook::with_playbook;
use support::{ADD_PROJECT, Org, bare, decode};

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
