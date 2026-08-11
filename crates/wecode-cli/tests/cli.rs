//! End-to-end tests: run the real binary against a real workspace.
//!
//! These exist because the three worst bugs so far were all integration bugs that
//! unit tests structurally could not catch — a hardcoded intent id, a per-process
//! audit sequence, and a Vision being refused admission. Each needed the whole
//! pipeline running.

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
        // Never inherit a real workspace from the developer's environment.
        cmd.env_remove("WECODE_ORG");
        decode(cmd.output().expect("binary runs"))
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }

    /// Builds the vision → goal → project → task chain used by several tests.
    fn seed(&self) {
        self.run(&["intent", "add", "vision", "fast", "lead on export speed"])
            .assert_ok("add vision");
        self.run(&[
            "intent",
            "add",
            "goal",
            "p99",
            "cut export p99 below 500ms",
            "--parent",
            "fast",
            "--measure-metric",
            "p99_ms:lt:500",
        ])
        .assert_ok("add goal");
        self.run(&[
            "intent",
            "add",
            "project",
            "caching",
            "add response caching to the export endpoint",
            "--parent",
            "p99",
            "--measure-cmd",
            "cargo test",
            "--write",
            "crates/export/**",
            "--tokens",
            "200000",
            "--wall",
            "1800",
        ])
        .assert_ok("add project");
        self.run(&[
            "intent",
            "add",
            "task",
            "cache-tests",
            "cover the cache layer with tests",
            "--parent",
            "caching",
            "--measure-cmd",
            "cargo test",
            "--write",
            "tests/**",
            "--tokens",
            "50000",
        ])
        .assert_ok("add task");
    }
}

/// Runs the binary with no workspace at all.
fn bare(args: &[&str]) -> Run {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wecode"));
    cmd.args(args);
    cmd.env_remove("WECODE_ORG");
    // A directory guaranteed to contain no company.toml, and no parent that does.
    cmd.current_dir(Path::new("/"));
    decode(cmd.output().expect("binary runs"))
}

// ---------------------------------------------------------------- setup --------

#[test]
fn init_scaffolds_a_self_contained_workspace() {
    let org = Org::new("init", "software-company");
    for f in [
        "company.toml",
        "agents/claude-code.toml",
        "agents/codex.toml",
        "templates/task-envelope.md",
        "README.md",
        ".gitignore",
    ] {
        assert!(org.path(f).is_file(), "missing {f}");
    }
    assert!(org.path("state").is_dir(), "state dir not created");
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
    let r = bare(&["intent", "tree"]);
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

// -------------------------------------------------------------- session --------

#[test]
fn a_session_survives_between_processes() {
    // The mechanism the whole agent workflow rests on: log in once, then every
    // later invocation is a separate process that finds the seat by itself.
    let org = Org::unattended("sess-persist", "solo");
    org.run(&["login", "you"]).assert_ok("login");

    org.run(&["intent", "add", "vision", "v", "lead on export speed"])
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
    let r = org.run(&["intent", "add", "vision", "v", "lead on export speed"]);
    assert!(!r.ok(), "must refuse, not silently act as root");
    r.assert_contains("not logged in")
        .assert_contains("wecode login")
        .assert_contains("you");

    // And nothing was written.
    org.run(&["intent", "tree"])
        .assert_contains("no intents yet");
}

#[test]
fn reading_needs_no_session() {
    let org = Org::unattended("sess-read", "solo");
    org.run(&["intent", "tree"]).assert_ok("tree");
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

    let r = org.run(&["intent", "add", "vision", "v", "lead on export speed"]);
    assert!(!r.ok(), "two seats, no way to guess which");
    r.assert_contains("several sessions");

    // Naming one resolves it.
    let id = first
        .split_whitespace()
        .find(|w| w.starts_with("s-"))
        .expect("login prints a session id");
    org.run(&[
        "intent",
        "add",
        "vision",
        "v",
        "lead on export speed",
        "--session",
        id,
    ])
    .assert_ok("named session")
    .assert_contains("saved");
}

#[test]
fn an_idle_expired_session_is_not_used() {
    let org = Org::unattended("sess-expired", "solo");
    org.run(&["login", "you"]).assert_ok("login");

    // Rewrite the session as opened long ago, and shorten the ttl. No sleeping.
    let path = org.path("state/sessions.log");
    let log = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, log.replace(&format!("at={}", now()), "at=1000")).unwrap();
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(&conf, text.replace("ttl = \"8h\"", "ttl = \"60s\"")).unwrap();

    let r = org.run(&["intent", "add", "vision", "v", "lead on export speed"]);
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
        .assert_contains("intent add");

    // An engineer seat holds neither define nor staff.
    let eng = Org::unattended("sess-whoami-eng", "software-company");
    eng.run(&["login", "you", "--as", "impl"])
        .assert_ok("login");
    let out = eng.run(&["whoami"]).assert_ok("whoami").all();
    assert!(!out.contains("assign"), "engineer cannot staff:\n{out}");
    assert!(
        !out.contains("intent add"),
        "engineer cannot define:\n{out}"
    );
}

#[test]
fn the_ledger_names_both_the_human_and_the_agent() {
    let org = Org::new("sess-crew", "software-company");
    org.run(&["intent", "add", "vision", "v", "lead on export speed"])
        .assert_ok("add");

    let log = std::fs::read_to_string(org.path("state/audit.log")).unwrap();
    assert!(log.contains("human=you"), "{log}");
    assert!(
        log.contains("agent=claude-code") || log.contains("occupant=claude-code"),
        "{log}"
    );
    assert!(
        log.contains("session=s-"),
        "the real session id, not cli-<post>:\n{log}"
    );
}

#[test]
fn as_operator_is_the_only_way_to_reach_root() {
    let org = Org::unattended("sess-operator", "solo");
    // No session, but an explicit override still works — deliberately typed.
    org.run(&[
        "intent",
        "add",
        "vision",
        "v",
        "lead on export speed",
        "--as",
        "operator",
    ])
    .assert_ok("explicit operator")
    .assert_contains("saved");

    let log = std::fs::read_to_string(org.path("state/audit.log")).unwrap();
    assert!(
        log.contains("post=operator"),
        "recorded as operator:\n{log}"
    );
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

// --------------------------------------------------------------- intent --------

#[test]
fn a_vague_project_is_refused_with_specific_questions() {
    let org = Org::new("vague", "solo");
    let r = org.run(&[
        "intent",
        "add",
        "project",
        "speedup",
        "make the export faster",
    ]);
    r.assert_ok("command itself succeeds")
        .assert_contains("not assignable")
        .assert_contains("faster")
        .assert_contains("not saved");

    // Nothing was written.
    org.run(&["intent", "tree"])
        .assert_contains("no intents yet");
}

#[test]
fn force_admits_a_defective_intent_and_says_so() {
    let org = Org::new("force", "solo");
    org.run(&[
        "intent",
        "add",
        "project",
        "speedup",
        "make the export faster",
        "--force",
    ])
    .assert_ok("forced add")
    .assert_contains("forced")
    .assert_contains("saved");
    org.run(&["intent", "tree"]).assert_contains("speedup");
}

#[test]
fn a_bare_vision_is_admitted() {
    // Regression: a Vision has no legal parent, so being unlinked is correct.
    let org = Org::new("vision", "solo");
    org.run(&["intent", "add", "vision", "fast", "lead on export speed"])
        .assert_ok("add vision")
        .assert_contains("admitted")
        .assert_contains("saved");
    org.run(&["intent", "tree"]).assert_lacks("UNLINKED");
}

#[test]
fn the_grammar_rejects_a_task_under_a_goal() {
    let org = Org::new("grammar", "solo");
    org.run(&["intent", "add", "vision", "v", "be excellent"])
        .assert_ok("vision");
    org.run(&[
        "intent",
        "add",
        "goal",
        "g",
        "reach 99.9% uptime",
        "--parent",
        "v",
        "--measure-metric",
        "uptime:gte:99.9",
    ])
    .assert_ok("goal");

    let r = org.run(&[
        "intent",
        "add",
        "task",
        "t",
        "do the thing",
        "--parent",
        "g",
        "--measure-cmd",
        "cargo test",
        "--write",
        "src/**",
        "--tokens",
        "10",
    ]);
    assert!(!r.ok(), "should be refused");
    r.assert_contains("may not be parented");
}

#[test]
fn the_tree_and_lineage_survive_a_restart() {
    let org = Org::new("persist", "solo");
    org.seed();

    // A separate process reads what earlier processes wrote.
    org.run(&["intent", "tree"])
        .assert_ok("tree")
        .assert_contains("VIS")
        .assert_contains("cache-tests");

    org.run(&["intent", "show", "cache-tests"])
        .assert_ok("show")
        .assert_contains("lead on export speed")
        .assert_contains("cover the cache layer");
}

#[test]
fn sibling_scope_overlap_is_reported() {
    let org = Org::new("overlap", "solo");
    org.seed();
    let r = org.run(&[
        "intent",
        "add",
        "task",
        "more-tests",
        "extend the cache tests",
        "--parent",
        "caching",
        "--measure-cmd",
        "cargo test",
        "--write",
        "tests/**",
        "--tokens",
        "1000",
    ]);
    r.assert_contains("overlaps").assert_contains("cache-tests");
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
fn a_goal_is_not_assignable() {
    let org = Org::new("assign-goal", "software-company");
    org.seed();
    let r = org.run(&["assign", "p99", "--to", "impl"]);
    assert!(!r.ok());
    r.assert_contains("not assignable");
}

#[test]
fn assign_names_the_available_posts_when_given_a_bad_one() {
    let org = Org::new("assign-post", "software-company");
    org.seed();
    let r = org.run(&["assign", "caching", "--to", "nobody"]);
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
        "--intent",
        "caching",
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
        "--intent",
        "caching",
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
        "--intent",
        "caching",
    ])
    .assert_contains("ALARM")
    .assert_contains("never_touch");

    org.run(&[
        "guard",
        "impl",
        "run",
        "git push --force",
        "--intent",
        "caching",
    ])
    .assert_contains("ALARM")
    .assert_contains("never_run");
}

#[test]
fn merging_a_protected_branch_needs_approval() {
    let org = Org::new("guard-merge", "software-company");
    org.seed();
    org.run(&["guard", "review", "merge", "main", "--intent", "caching"])
        .assert_contains("needs approval");
}

#[test]
fn overspending_is_refused() {
    let org = Org::new("guard-spend", "software-company");
    org.seed();
    org.run(&[
        "guard", "impl", "spend", "x", "--tokens", "500000", "--intent", "caching",
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
        org.run(&["guard", "impl", "write", path, "--intent", "caching"]);
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
        "--intent",
        "caching",
    ]);
    org.run(&[
        "guard",
        "test",
        "write",
        "crates/export/no.rs",
        "--intent",
        "caching",
    ]);
    org.run(&["guard", "impl", "write", "src/x.pem", "--intent", "caching"]);

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
fn guard_records_are_attributed_to_their_intent() {
    // Regression: the intent was hardcoded, so every record was uncorrelated.
    let org = Org::new("audit-attrib", "software-company");
    org.seed();
    org.run(&["guard", "impl", "write", "src/x.pem", "--intent", "caching"]);

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
    // The other half of attribution: a record with no --intent must not be
    // silently credited to some intent.
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
fn the_board_reports_an_unknown_intent_plainly() {
    let org = Org::new("board-missing", "solo");
    org.seed();
    org.run(&["board", "nope"])
        .assert_contains("no such intent");
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
        .assert_contains("INTENT")
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
