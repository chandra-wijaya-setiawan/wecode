//! Naming a process precisely enough to prove whether it is still there.
//!
//! Recovery has to tell *the supervisor that owned this run is gone* from *it is still
//! working*, because a hand-run `wecode run t` beside a running `wecode serve` is
//! ordinary, and a restart that assumed everything unsettled was its own would kill a
//! live sibling's agent. A pid alone cannot make that distinction: pids are reused.
//!
//! So identity is three facts, all cheap file reads — no new dependency and no `unsafe`.
//! The machine, the boot id from `/proc/sys/kernel/random/boot_id`, and the process
//! start time from field 22 of `/proc/<pid>/stat`. Together they are a proof rather than
//! an estimate: a different boot id means the machine restarted and nothing recorded
//! before it survives, and the same boot id means `/proc/<pid>` either exists with the
//! recorded start time or it does not. There is no threshold and no heartbeat, which is
//! deliberate — a threshold's false death puts two agents in one worktree.
//!
//! A host without `/proc` is not lied to. It answers [`Life::Unproven`] for anything
//! still responding to `kill -0`, and whatever reads that has to decline and say so.

use std::path::Path;
use std::process::{Command, Stdio};

use wecode_store::Owner;

/// Where the boot id is, on the one operating system that publishes one.
const BOOT_ID: &str = "/proc/sys/kernel/random/boot_id";

/// What can be said about whether a recorded process is still running.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Life {
    /// It is there, and it is the same process that was written down.
    Alive,
    /// It is provably not there.
    Gone,
    /// This machine cannot answer. Nothing may be done on the strength of it.
    Unproven,
}

/// This machine's name, as the journal records it.
///
/// Recorded now although nothing reads it across hosts yet, so a row written today
/// survives distributed workers arriving later — and, until they do, so that a database
/// carried to another machine cannot be read as an invitation to kill its pids.
pub(crate) fn host() -> String {
    read("/proc/sys/kernel/hostname")
        .or_else(|| std::env::var("HOSTNAME").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// This boot, or an empty string where there is nothing to read.
///
/// Empty is the honest answer rather than a generated one: an invented id would compare
/// unequal to itself across two runs and report every owner as dead.
pub(crate) fn boot() -> String {
    read(BOOT_ID).map_or_else(String::new, |s| s.trim().to_string())
}

/// When a process started, in the kernel's own clock ticks since boot.
///
/// Field 22 of `/proc/<pid>/stat`, counted after the **last** `)`: the second field is
/// the executable's name, it is not escaped, and a program called `weird (name)` would
/// otherwise shift every field after it.
pub(crate) fn started(pid: i64) -> Option<i64> {
    // The tokens after the name begin at field 3, so field 22 is the twentieth of them.
    field(pid, 19)?.parse().ok()
}

/// Whether the process has already exited and is only waiting to be collected.
///
/// A zombie is not running, and treating it as alive would be a real failure rather
/// than a pedantic one: a supervisor whose own parent is slow to reap it would hold its
/// task hostage for as long as the parent took, and that is the whole condition this
/// module exists to end. Field 3 of `/proc/<pid>/stat`, the first after the name.
fn reaped(pid: i64) -> bool {
    field(pid, 0).is_some_and(|state| state == "Z")
}

/// The `n`th whitespace-separated field after the executable's name.
///
/// Counted after the **last** `)`: the second field of `/proc/<pid>/stat` is that name,
/// it is not escaped, and a program called `weird (name)` would otherwise shift every
/// field after it.
fn field(pid: i64, n: usize) -> Option<String> {
    let stat = read(&format!("/proc/{pid}/stat"))?;
    let rest = stat.rsplit_once(')')?.1;
    rest.split_whitespace().nth(n).map(ToString::to_string)
}

/// This wecode process, as it would be written down.
pub(crate) fn me() -> Owner {
    let pid = i64::from(std::process::id());
    Owner {
        host: host(),
        boot: boot(),
        pid,
        start: started(pid).unwrap_or_default(),
    }
}

/// A process this one just created, named the same way.
///
/// `start` is 0 where it could not be read — a child that died inside the window
/// between `spawn` returning and this read. The pid is still worth recording: it is the
/// group id too, so it addresses the whole tree the agent went on to spawn.
pub(crate) fn child(pid: u32) -> Owner {
    let pid = i64::from(pid);
    Owner {
        host: host(),
        boot: boot(),
        pid,
        start: started(pid).unwrap_or_default(),
    }
}

/// Whether the process a row names is still running.
///
/// In the order that lets each answer settle the question without the next read:
/// another machine cannot be asked at all, a changed boot id ends it, and only then is
/// there a pid worth looking up.
pub(crate) fn life(o: &Owner) -> Life {
    if o.host != host() {
        return Life::Unproven;
    }
    let now = boot();
    if !now.is_empty() && !o.boot.is_empty() && now != o.boot {
        // The machine restarted. Nothing recorded before it is running, whatever
        // happens to be sitting on that pid today.
        return Life::Gone;
    }
    if !Path::new("/proc").is_dir() {
        // No proof available either way, so `kill -0` is all there is: a pid nothing
        // answers to is genuinely gone, and one that answers may be anybody's.
        return if responds(o.pid) {
            Life::Unproven
        } else {
            Life::Gone
        };
    }
    if reaped(o.pid) {
        return Life::Gone;
    }
    match started(o.pid) {
        // The recorded start time is the proof. A row written where it could not be
        // read carries 0, and then the pid alone is not enough to act on.
        Some(start) if start == o.start && o.start != 0 => Life::Alive,
        Some(_) if o.start == 0 => Life::Unproven,
        _ => Life::Gone,
    }
}

/// Whether `pid` exists and this user may signal it.
fn responds(pid: i64) -> bool {
    signal(pid, "-0")
}

/// The processes carrying this run's token in their environment.
///
/// The window between the kernel creating the agent and wecode writing its pid down is
/// small but real, and this is what covers it: the token is laid into the child's
/// environment, `env_clear` means we own that environment completely, and an orphan
/// whose pid was never recorded is still findable by it.
///
/// Silent about what it cannot read. `/proc/<pid>/environ` is readable only by the
/// owning user, so another user's processes are simply not found — which is correct,
/// since they are not ours to stop either.
pub(crate) fn holding(token: &str) -> Vec<i64> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return found;
    };
    let wanted = format!("WECODE_RUN={token}");
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<i64>().ok()) else {
            continue;
        };
        let Ok(env) = std::fs::read(entry.path().join("environ")) else {
            continue;
        };
        if env
            .split(|b| *b == 0)
            .any(|v| String::from_utf8_lossy(v) == wanted)
        {
            found.push(pid);
        }
    }
    found.sort_unstable();
    found
}

/// Stops a process and everything it spawned, and says whether it was there to stop.
///
/// The group first, by the negative pid: `process_group(0)` at spawn made the agent its
/// own group leader, so one number addresses the whole tree it went on to create. Then
/// the leader by its own pid, which is the one name it cannot shed — a harness that
/// daemonised itself is in no group the first signal can reach.
///
/// Asked politely, then insisted on, which is [`crate::spawn`]'s own order. Nothing here
/// waits on the process: this is not its parent, so there is no exit status to collect
/// and nothing to reap.
///
/// Through `kill(1)` rather than libc, for the reason `spawn` shells out the same way:
/// the workspace forbids `unsafe`, and a negative pid is not something `Child::kill` can
/// express.
pub(crate) fn stop(pid: i64) -> bool {
    // Asked before anything is sent, and asked of the pid rather than of the group:
    // `kill` answers for a *signal it could deliver*, and a group id that names nothing
    // is a usage question rather than a missing process — so the exit status of the
    // TERM below is not the answer to "was anything there". This is.
    let found = responds(pid);
    signal(-pid, "-TERM");
    signal(pid, "-TERM");
    std::thread::sleep(std::time::Duration::from_millis(200));
    signal(-pid, "-KILL");
    signal(pid, "-KILL");
    found
}

fn signal(pid: i64, sig: &str) -> bool {
    Command::new("kill")
        .args([sig, &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// A name for one dispatch, unique among the processes alive on this machine.
///
/// The pid and the clock together: two wecode processes cannot share a pid at one
/// moment, and one process cannot spawn twice in the same nanosecond.
pub(crate) fn token(task: &wecode_core::TaskId) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{task}-{}-{nanos}", std::process::id())
}

fn read(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on_linux() -> bool {
        Path::new("/proc/self/stat").is_file()
    }

    #[test]
    fn this_process_is_alive_by_its_own_account() {
        if !on_linux() {
            return;
        }
        assert_eq!(life(&me()), Life::Alive);
    }

    #[test]
    fn a_pid_with_the_wrong_start_time_is_a_different_process() {
        // The whole reason the start time is recorded: pids are reused, and a row
        // naming one that has been handed on must not authorise killing whoever holds
        // it now.
        if !on_linux() {
            return;
        }
        let mut stale = me();
        stale.start += 1;
        assert_eq!(life(&stale), Life::Gone);
    }

    #[test]
    fn a_machine_that_restarted_took_everything_recorded_with_it() {
        if boot().is_empty() {
            return;
        }
        let mut before = me();
        before.boot = "00000000-0000-0000-0000-000000000000".into();
        assert_eq!(life(&before), Life::Gone);
    }

    #[test]
    fn another_machines_process_is_not_this_machines_to_judge() {
        let mut elsewhere = me();
        elsewhere.host = format!("not-{}", elsewhere.host);
        assert_eq!(life(&elsewhere), Life::Unproven);
    }

    #[test]
    fn a_row_with_no_start_time_names_a_pid_and_proves_nothing() {
        // The portability fallback, reached on a host with no `/proc` to read field 22
        // out of. A live pid could be anybody's, so nothing may be done about it.
        if !on_linux() {
            return;
        }
        let mut vague = me();
        vague.start = 0;
        assert_eq!(life(&vague), Life::Unproven);
    }

    #[test]
    fn the_name_of_a_process_is_read_past_its_own_parentheses() {
        // `comm` is unescaped in /proc/<pid>/stat, so counting fields from the left
        // shifts by one for every `)` in the executable's name.
        if !on_linux() {
            return;
        }
        let mine = started(i64::from(std::process::id()));
        assert!(mine.is_some_and(|t| t > 0), "{mine:?}");
    }

    #[test]
    fn a_pid_nothing_answers_to_is_gone() {
        if !on_linux() {
            return;
        }
        // Above every pid the kernel will hand out, so nothing holds it.
        let ghost = Owner {
            host: host(),
            boot: boot(),
            pid: 0x7FFF_FFFF,
            start: 12345,
        };
        assert_eq!(life(&ghost), Life::Gone);
    }

    #[test]
    fn stopping_a_live_process_says_it_was_there_to_stop() {
        // The report an operator reads turns on this answer: `stopped the orphaned
        // agent` and `agent already gone` are the same signals sent either way, and the
        // difference between them is entirely what this returns.
        if !on_linux() {
            return;
        }
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sh runs");
        let pid = i64::from(child.id());
        assert!(stop(pid), "a running process reported as already gone");
        let _ = child.wait();
        // And a pid nothing holds is not claimed as a kill.
        assert!(!stop(0x7FFF_FFFF));
    }

    #[test]
    fn a_token_is_not_handed_out_twice() {
        let id = wecode_core::TaskId::new("cache-tests");
        assert_ne!(token(&id), token(&id));
    }

    #[test]
    fn a_token_nothing_carries_finds_nothing() {
        assert!(holding("wecode-run-that-never-existed").is_empty());
    }
}
