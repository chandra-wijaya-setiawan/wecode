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
}

/// The argv this template will actually run, with `{{prompt}}` filled in.
///
/// Exposed so the Broker can be asked about the real command line before anything
/// starts — an argv check after the fact would be worthless.
pub(crate) fn argv(t: &AgentTemplate, prompt: &str) -> Vec<String> {
    let mut out = vec![t.command.clone()];
    out.extend(t.args.iter().map(|a| a.replace("{{prompt}}", prompt)));
    out
}

/// Runs the agent to completion, or kills it.
pub(crate) fn run(
    t: &AgentTemplate,
    prompt: &str,
    cwd: &Path,
    limits: Limits,
) -> std::io::Result<Outcome> {
    let args: Vec<String> = t
        .args
        .iter()
        .map(|a| a.replace("{{prompt}}", prompt))
        .collect();

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

    let started = Instant::now();
    let mut child = cmd.spawn()?;
    let pid = child.id();

    let buf = Arc::new(Mutex::new(String::new()));
    let truncated = Arc::new(Mutex::new(false));
    let (tick_tx, tick_rx) = channel::<()>();

    let mut readers = Vec::new();
    if let Some(o) = child.stdout.take() {
        readers.push(reader(o, &buf, &truncated, tick_tx.clone()));
    }
    if let Some(e) = child.stderr.take() {
        readers.push(reader(e, &buf, &truncated, tick_tx.clone()));
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
    })
}

/// Drains one stream into the shared buffer, pinging `tick` on every line so the
/// supervisor can tell working from hung.
fn reader<R: Read + Send + 'static>(
    stream: R,
    buf: &Arc<Mutex<String>>,
    truncated: &Arc<Mutex<bool>>,
    tick: std::sync::mpsc::Sender<()>,
) -> thread::JoinHandle<()> {
    let buf = Arc::clone(buf);
    let truncated = Arc::clone(truncated);
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            // Ping first: a line that overflows the cap is still evidence of life.
            let _ = tick.send(());
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
            argv(&t, "do the thing"),
            vec!["sh", "-c", "echo do the thing"]
        );
    }

    #[test]
    fn output_is_captured_and_the_exit_code_kept() {
        let t = agent("echo hello; echo oops >&2; exit 3", None, None);
        let o = run(&t, "", &cwd(), Limits::default()).unwrap();
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

        let o = run(&t, "", &cwd(), Limits::default()).unwrap();
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
    fn it_runs_in_the_directory_it_is_given() {
        let dir = std::env::temp_dir().join("wecode-spawn-cwd");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker"), "x").unwrap();

        let t = agent("test -f marker", None, None);
        assert!(run(&t, "", &dir, Limits::default()).unwrap().ended.ok());
    }

    #[test]
    fn a_run_that_overruns_its_wall_limit_is_killed() {
        let t = agent("sleep 30", None, None);
        let o = run(
            &t,
            "",
            &cwd(),
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
            &cwd(),
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
            &cwd(),
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
            &cwd(),
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
        let o = run(&t, "", &cwd(), Limits::default()).unwrap();
        assert!(o.truncated, "should have hit the cap");
        assert!(o.output.len() <= OUTPUT_CAP, "{}", o.output.len());
        // The point of draining past the cap: the child still gets to finish.
        assert_eq!(o.ended, Ended::Exited(0));
    }

    #[test]
    fn limits_come_from_the_agent_template() {
        let t = agent("true", Some(120), Some(30));
        let l = Limits::from(&t);
        assert_eq!(l.wall, Some(Duration::from_secs(120)));
        assert_eq!(l.idle, Some(Duration::from_secs(30)));
    }
}
