//! Running a coding agent under supervision.
//!
//! Everything preventable is decided before the process starts — the environment it
//! gets, the directory it runs in, the command line itself. Once it is running the
//! only controls left are time and a signal, so those are what this module provides.
//!
//! Three details are load-bearing:
//!
//! - **The environment is built, not inherited.** A coding CLI inherits every secret
//!   in the shell otherwise. Absent a container this is the only network control
//!   there is.
//! - **A new process group.** Coding CLIs spawn children; signalling only the parent
//!   leaves them orphaned and still running.
//! - **Idle, not just wall.** An agent that has stopped producing output has usually
//!   stopped working, and the wall limit is far too generous to catch it.
//! - **Metered as it streams.** The output buffer is capped, and the line stating what
//!   the run cost is the last one — so spend is counted on the way past rather than
//!   read back out of a buffer that may have dropped it.
//!
//! No `unsafe`, which the workspace forbids: `process_group` is safe, and signalling
//! shells out to `kill` the way the rest of the tree shells out to `git`.

use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use wecode_org::AgentTemplate;

use crate::usage::Meter;

/// How much of an agent's output to keep. Past this it is drained and discarded —
/// the pipe must keep moving or the child blocks on a full buffer.
const OUTPUT_CAP: usize = 256 * 1024;

/// How often to check whether the child has finished or overrun.
const POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Ended {
    Exited(i32),
    /// Killed for exceeding its total time.
    Wall,
    /// Killed after producing no output for too long.
    Idle,
    /// Exited on a signal rather than normally.
    Signalled,
}

impl Ended {
    pub(crate) fn ok(self) -> bool {
        self == Self::Exited(0)
    }

    pub(crate) fn describe(self) -> String {
        match self {
            Self::Exited(0) => "exit 0".to_string(),
            Self::Exited(c) => format!("exit {c}"),
            Self::Wall => "killed — wall limit".to_string(),
            Self::Idle => "killed — no output".to_string(),
            Self::Signalled => "killed by a signal".to_string(),
        }
    }
}

#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Limits {
    pub(crate) wall: Option<Duration>,
    pub(crate) idle: Option<Duration>,
}

impl Limits {
    pub(crate) fn from(t: &AgentTemplate) -> Self {
        Self {
            wall: t.wall_secs.map(Duration::from_secs),
            idle: t.idle_secs.map(Duration::from_secs),
        }
    }
}

pub(crate) struct Outcome {
    pub(crate) ended: Ended,
    pub(crate) output: String,
    pub(crate) took: Duration,
    /// True when output was discarded past the cap.
    pub(crate) truncated: bool,
    /// Tokens the agent's own output reported, and `None` when it reported none.
    ///
    /// A report, not a measurement — see [`crate::usage`] for why nothing else could
    /// know this, and why the two cases are kept apart rather than both being zero.
    pub(crate) spent: Option<u64>,
}

/// The argv this template will actually run, with `{{prompt}}` filled in.
///
/// Exposed so the Broker can be asked about the real command line before anything
/// starts — an argv check after the fact would be worthless.
/// The post's grant, in the form a coding CLI accepts as its own allow-list.
///
/// The two vocabularies line up almost exactly: a `run` grant is already a glob
/// matched against a command line, which is what `Bash(...)` takes. So the authority
/// wecode records and the authority the harness enforces come from one declaration
/// instead of two that can disagree.
///
/// This is enforcement moving from post-hoc to intercepted. wecode still checks the
/// diff afterwards — a harness is not a sandbox, and one that ignored the flag would
/// still be caught — but a command outside the grant is now refused before it runs
/// rather than noticed after.
///
/// File tools are all-or-nothing here: the harness cannot express "write only
/// `src/**`", so a role with any write scope gets the editing tools and the diff check
/// remains what holds it to the declared paths. A role with none gets neither.
#[must_use]
pub(crate) fn allowed_tools(grant: &wecode_gov::Grant) -> String {
    let mut out: Vec<String> = grant.run.iter().map(|g| format!("Bash({g})")).collect();
    if !grant.read.is_empty() {
        out.extend(["Read", "Glob", "Grep"].map(str::to_string));
    }
    if !grant.write.is_empty() {
        out.extend(["Edit", "Write"].map(str::to_string));
    }
    // Comma-separated: a run glob contains spaces, and space separation would split
    // `cargo *` into two tools, one of which is `*`.
    out.join(",")
}

pub(crate) fn argv(t: &AgentTemplate, prompt: &str, tools: &str) -> Vec<String> {
    let mut out = vec![t.command.clone()];
    out.extend(
        t.args
            .iter()
            .map(|a| a.replace("{{prompt}}", prompt).replace("{{tools}}", tools)),
    );
    out
}

/// Runs the agent to completion, or kills it.
///
/// `env` is what the project shares between its worktrees — see [`crate::cache`]. It is
/// set from values wecode already holds rather than read out of the ambient
/// environment, so it adds directories without adding a way for the shell's secrets to
/// arrive by another door.
pub(crate) fn run(
    t: &AgentTemplate,
    prompt: &str,
    tools: &str,
    cwd: &Path,
    env: &[(String, std::path::PathBuf)],
    limits: Limits,
) -> std::io::Result<Outcome> {
    let args: Vec<String> = argv(t, prompt, tools).into_iter().skip(1).collect();

    let mut cmd = Command::new(&t.command);
    cmd.args(&args)
        .current_dir(cwd)
        // Built, not inherited: the allowlist is the whole environment.
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 0 means "a new group led by the child", so one signal reaches its children.
        .process_group(0);
    for key in &t.env_allowlist {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    // After the allowlist, and that ordering is the decision: the project said where
    // this repository's build output goes, and an inherited `CARGO_TARGET_DIR` naming
    // the operator's own checkout would otherwise win — putting the agent's build in
    // the one directory a worktree run must not touch.
    for (key, dir) in env {
        cmd.env(key, dir);
    }

    let started = Instant::now();
    let mut child = cmd.spawn()?;
    let pid = child.id();

    let buf = Arc::new(Mutex::new(String::new()));
    let truncated = Arc::new(Mutex::new(false));
    // Shared by both streams: a harness free to write its usage report to either one
    // should be counted the same way whichever it picks.
    let meter = Arc::new(Mutex::new(Meter::for_protocol(&t.protocol)));
    let (tick_tx, tick_rx) = channel::<()>();

    let mut readers = Vec::new();
    if let Some(o) = child.stdout.take() {
        readers.push(reader(o, &buf, &truncated, &meter, tick_tx.clone()));
    }
    if let Some(e) = child.stderr.take() {
        readers.push(reader(e, &buf, &truncated, &meter, tick_tx.clone()));
    }
    drop(tick_tx);

    let ended = supervise(&mut child, pid, started, limits, &tick_rx);

    // However it ended, nothing the agent spawned outlives it. A backgrounded child
    // holds the pipe open, and the reader joins below would then block on a process
    // the supervisor has already reported as finished — for as long as it cared to
    // run. Reaping the group is what makes the join bounded.
    reap_group(pid);
    for r in readers {
        let _ = r.join();
    }

    Ok(Outcome {
        ended,
        output: buf.lock().map(|b| b.clone()).unwrap_or_default(),
        took: started.elapsed(),
        truncated: *truncated.lock().unwrap_or_else(|e| e.into_inner()),
        // The readers have joined, so nothing else holds this lock. A poisoned one
        // means a reader panicked mid-line, and the count it had reached is still
        // the best evidence there is.
        spent: meter.lock().unwrap_or_else(|e| e.into_inner()).tokens(),
    })
}

/// Drains one stream into the shared buffer, pinging `tick` on every line so the
/// supervisor can tell working from hung.
fn reader<R: Read + Send + 'static>(
    stream: R,
    buf: &Arc<Mutex<String>>,
    truncated: &Arc<Mutex<bool>>,
    meter: &Arc<Mutex<Meter>>,
    tick: std::sync::mpsc::Sender<()>,
) -> thread::JoinHandle<()> {
    let buf = Arc::clone(buf);
    let truncated = Arc::clone(truncated);
    let meter = Arc::clone(meter);
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            // Ping first: a line that overflows the cap is still evidence of life.
            let _ = tick.send(());
            // Metered before the cap is consulted, and deliberately: the line that
            // states what the run cost is the last one, which is precisely the line
            // a full buffer discards.
            if let Ok(mut m) = meter.lock() {
                m.line(&line);
            }
            if let Ok(mut b) = buf.lock() {
                if b.len() + line.len() < OUTPUT_CAP {
                    b.push_str(&line);
                    b.push('\n');
                } else if let Ok(mut t) = truncated.lock() {
                    *t = true;
                }
            }
        }
    })
}

/// Polls until the child finishes or overruns.
fn supervise(
    child: &mut Child,
    pid: u32,
    started: Instant,
    limits: Limits,
    tick: &Receiver<()>,
) -> Ended {
    let mut last_output = Instant::now();
    loop {
        // Drain every ping; any of them means output arrived. `Disconnected` ends
        // the drain too — both readers are gone, so no more will come.
        while let Ok(()) = tick.try_recv() {
            last_output = Instant::now();
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                return match status.code() {
                    Some(c) => Ended::Exited(c),
                    // No code means a signal — distinct from any exit value, since a
                    // killed agent has not decided anything.
                    None => Ended::Signalled,
                };
            }
            Ok(None) => {}
            Err(_) => return Ended::Signalled,
        }

        if limits.wall.is_some_and(|w| started.elapsed() > w) {
            kill_group(pid, child);
            return Ended::Wall;
        }
        if limits.idle.is_some_and(|i| last_output.elapsed() > i) {
            kill_group(pid, child);
            return Ended::Idle;
        }
        thread::sleep(POLL);
    }
}

/// Signals a whole process group.
///
/// Through `kill(1)` rather than libc, because the workspace forbids `unsafe` and a
/// negative pid — the group — is not something `Child::kill` can express. Failure is
/// ignored: an empty group is the normal case and not an error worth reporting.
fn signal_group(pid: u32, sig: &str) {
    let _ = Command::new("kill")
        .args([sig, &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Asks the group to stop, then insists.
fn kill_group(pid: u32, child: &mut Child) {
    signal_group(pid, "-TERM");
    for _ in 0..20 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    signal_group(pid, "-KILL");
    let _ = child.wait();
}

/// Clears out anything left in the group once the agent itself has gone.
fn reap_group(pid: u32) {
    signal_group(pid, "-TERM");
    thread::sleep(Duration::from_millis(50));
    signal_group(pid, "-KILL");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_grant_becomes_the_harness_allow_list() {
        // The point of deriving it: one declaration, so what wecode records and what
        // the harness enforces cannot disagree.
        let mut g = wecode_gov::Grant::writer(&["src/**"]);
        g.run = vec!["cargo *".into(), "npm test*".into()];
        let tools = allowed_tools(&g);
        assert!(tools.contains("Bash(cargo *)"), "{tools}");
        assert!(tools.contains("Bash(npm test*)"), "{tools}");
        assert!(tools.contains("Edit"), "{tools}");
        // Comma, not space: `cargo *` would otherwise split into two tools.
        assert!(!tools.contains("Bash(cargo *) Bash"), "{tools}");
    }

    #[test]
    fn a_role_that_writes_nothing_is_given_no_editing_tools() {
        // The reviewer reads and reports. Handing it Edit would make the grant a
        // description rather than a limit.
        let g = wecode_gov::Grant::default().with_read(&["**"]);
        let tools = allowed_tools(&g);
        assert!(tools.contains("Read"), "{tools}");
        assert!(!tools.contains("Edit"), "{tools}");
        assert!(!tools.contains("Write"), "{tools}");
    }

    #[test]
    fn the_placeholder_is_substituted_into_the_launch_line() {
        let t = agent("--allowedTools {{tools}}", None, None);
        // `agent` builds `sh -c <script>`, so the placeholder is inside arg 2.
        assert_eq!(
            argv(&t, "p", "Bash(cargo *),Edit")[2],
            "--allowedTools Bash(cargo *),Edit"
        );
    }

    /// A stand-in agent. `sh` is the one interpreter guaranteed present, and using a
    /// real process is the whole point — a fake would test none of this.
    fn agent(script: &str, wall: Option<u64>, idle: Option<u64>) -> AgentTemplate {
        AgentTemplate {
            command: "sh".to_string(),
            protocol: String::new(),
            args: vec!["-c".to_string(), script.to_string()],
            env_allowlist: vec![],
            wall_secs: wall,
            idle_secs: idle,
        }
    }

    fn cwd() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn a_prompt_is_substituted_into_the_argv() {
        let t = agent("echo {{prompt}}", None, None);
        assert_eq!(
            argv(&t, "do the thing", ""),
            vec!["sh", "-c", "echo do the thing"]
        );
    }

    #[test]
    fn output_is_captured_and_the_exit_code_kept() {
        let t = agent("echo hello; echo oops >&2; exit 3", None, None);
        let o = run(&t, "", "", &cwd(), &[], Limits::default()).unwrap();
        assert_eq!(o.ended, Ended::Exited(3));
        assert!(!o.ended.ok());
        assert!(o.output.contains("hello"), "{}", o.output);
        assert!(o.output.contains("oops"), "stderr too: {}", o.output);
    }

    #[test]
    fn the_environment_is_built_from_the_allowlist_not_inherited() {
        // The control that keeps a coding CLI from reading every secret in the shell.
        // Uses variables that already exist rather than setting any: `set_var` is
        // unsafe in this edition, and the workspace forbids unsafe.
        let home = std::env::var("HOME").expect("HOME is set in this environment");
        assert!(!home.is_empty());

        let mut t = agent("echo path=[$PATH] home=[$HOME]", None, None);
        t.env_allowlist = vec!["PATH".to_string()];

        let o = run(&t, "", "", &cwd(), &[], Limits::default()).unwrap();
        assert!(
            o.output.contains("path=[/"),
            "PATH should pass: {}",
            o.output
        );
        assert!(
            o.output.contains("home=[]"),
            "HOME is not on the allowlist and must not reach the agent: {}",
            o.output
        );
    }

    #[test]
    fn the_shared_build_cache_reaches_the_agent_without_being_on_the_allowlist() {
        // The allowlist is about what may be *inherited*; this value is not inherited
        // from anywhere, it is what the project's playbook said. Requiring it to be
        // listed twice would mean a company.toml edit for every project that wanted a
        // cache, which is the wrong file to be editing.
        let t = agent("echo target=[$CARGO_TARGET_DIR]", None, None);
        let env = [(
            "CARGO_TARGET_DIR".to_string(),
            std::path::PathBuf::from("/tmp/shared-target"),
        )];
        let o = run(&t, "", "", &cwd(), &env, Limits::default()).unwrap();
        assert!(
            o.output.contains("target=[/tmp/shared-target]"),
            "{}",
            o.output
        );
    }

    #[test]
    fn the_project_s_cache_outranks_an_inherited_value_of_the_same_name() {
        // Otherwise an allowlisted variable pointing at the operator's own checkout
        // wins, and a worktree run builds into the directory it must not touch. `HOME`
        // stands in for a cache variable here only because it is the one this process
        // is guaranteed to have inherited.
        let mut t = agent("echo home=[$HOME]", None, None);
        t.env_allowlist = vec!["HOME".to_string()];
        let env = [(
            "HOME".to_string(),
            std::path::PathBuf::from("/tmp/declared-wins"),
        )];
        let o = run(&t, "", "", &cwd(), &env, Limits::default()).unwrap();
        assert!(
            o.output.contains("home=[/tmp/declared-wins]"),
            "{}",
            o.output
        );
    }

    #[test]
    fn it_runs_in_the_directory_it_is_given() {
        let dir = std::env::temp_dir().join("wecode-spawn-cwd");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker"), "x").unwrap();

        let t = agent("test -f marker", None, None);
        assert!(
            run(&t, "", "", &dir, &[], Limits::default())
                .unwrap()
                .ended
                .ok()
        );
    }

    #[test]
    fn a_run_that_overruns_its_wall_limit_is_killed() {
        let t = agent("sleep 30", None, None);
        let o = run(
            &t,
            "",
            "",
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_millis(300)),
                idle: None,
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Wall);
        assert!(
            o.took < Duration::from_secs(10),
            "killed promptly: {:?}",
            o.took
        );
    }

    #[test]
    fn a_silent_run_is_killed_on_the_idle_limit() {
        // Distinct from wall: this one would finish well inside its total budget, it
        // has simply stopped doing anything.
        let t = agent("sleep 30", None, None);
        let o = run(
            &t,
            "",
            "",
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_secs(60)),
                idle: Some(Duration::from_millis(300)),
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Idle);
    }

    #[test]
    fn output_keeps_the_idle_timer_alive() {
        // The reason idle is measured from output rather than from start: a slow but
        // working agent must not be killed.
        let t = agent(
            "for i in 1 2 3 4 5 6; do echo tick; sleep 0.1; done",
            None,
            None,
        );
        let o = run(
            &t,
            "",
            "",
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_secs(30)),
                idle: Some(Duration::from_millis(400)),
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Exited(0), "steady output should survive");
    }

    #[test]
    fn children_die_with_their_parent() {
        // The reason for a process group. The shell exits immediately; its child holds
        // the pipe open, so without group signalling this hangs until the sleep ends.
        let t = agent("sleep 30 & exit 0", None, None);
        let o = run(
            &t,
            "",
            "",
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_secs(5)),
                idle: Some(Duration::from_millis(500)),
            },
        )
        .unwrap();
        assert!(
            o.took < Duration::from_secs(4),
            "an orphaned child kept it alive for {:?}",
            o.took
        );
    }

    #[test]
    fn a_flood_of_output_is_capped_rather_than_buffered_without_limit() {
        let t = agent(
            "i=0; while [ $i -lt 40000 ]; do echo aaaaaaaaaaaaaaaaaaaa; i=$((i+1)); done",
            None,
            None,
        );
        let o = run(&t, "", "", &cwd(), &[], Limits::default()).unwrap();
        assert!(o.truncated, "should have hit the cap");
        assert!(o.output.len() <= OUTPUT_CAP, "{}", o.output.len());
        // The point of draining past the cap: the child still gets to finish.
        assert_eq!(o.ended, Ended::Exited(0));
    }

    /// The same stand-in, speaking a protocol whose usage lines wecode can read.
    fn metered_agent(script: &str) -> AgentTemplate {
        let mut t = agent(script, None, None);
        t.protocol = "claude-stream-json".to_string();
        t
    }

    #[test]
    fn what_the_agent_reported_spending_comes_back_with_its_exit() {
        let t = metered_agent(
            r#"echo '{"type":"result","usage":{"input_tokens":1200,"output_tokens":340}}'"#,
        );
        let o = run(&t, "", "", &cwd(), &[], Limits::default()).unwrap();
        assert_eq!(o.spent, Some(1540));
    }

    #[test]
    fn an_agent_whose_protocol_says_nothing_is_unmetered_rather_than_free() {
        // Same output, template protocol left empty. Zero would be a claim; `None`
        // is the truth, and the board renders them differently.
        let t = agent(
            r#"echo '{"type":"result","usage":{"input_tokens":1200,"output_tokens":340}}'"#,
            None,
            None,
        );
        assert_eq!(
            run(&t, "", "", &cwd(), &[], Limits::default())
                .unwrap()
                .spent,
            None
        );
    }

    #[test]
    fn a_run_that_overflows_the_output_cap_still_accounts_for_itself() {
        // The reason metering happens in the reader: the total arrives on the last
        // line, and the last line of a flood is the one the cap throws away.
        let t = metered_agent(
            "i=0; while [ $i -lt 40000 ]; do echo aaaaaaaaaaaaaaaaaaaa; i=$((i+1)); done; \
             echo '{\"type\":\"result\",\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}'",
        );
        let o = run(&t, "", "", &cwd(), &[], Limits::default()).unwrap();
        assert!(o.truncated, "the cap should have been hit");
        assert!(
            !o.output.contains("input_tokens"),
            "the reporting line was dropped from the buffer, as intended"
        );
        assert_eq!(o.spent, Some(10), "and counted anyway");
    }

    #[test]
    fn a_killed_run_keeps_the_spend_it_had_already_reported() {
        // Overrunning does not refund anything. The tokens were burned before the
        // wall limit was reached, and the board has to show them.
        let t = metered_agent(
            "echo '{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":50,\
             \"output_tokens\":25}}}'; sleep 30",
        );
        let o = run(
            &t,
            "",
            "",
            &cwd(),
            &[],
            Limits {
                wall: Some(Duration::from_millis(300)),
                idle: None,
            },
        )
        .unwrap();
        assert_eq!(o.ended, Ended::Wall);
        assert_eq!(o.spent, Some(75));
    }

    #[test]
    fn limits_come_from_the_agent_template() {
        let t = agent("true", Some(120), Some(30));
        let l = Limits::from(&t);
        assert_eq!(l.wall, Some(Duration::from_secs(120)));
        assert_eq!(l.idle, Some(Duration::from_secs(30)));
    }
}
