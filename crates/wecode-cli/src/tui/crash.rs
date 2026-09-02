//! What a panic leaves behind: a terminal put back the way it was found, and the
//! cause written to disk where a person can read it.
//!
//! Without this, a panic in raw mode prints its message into the alternate screen
//! and takes it down with the process — the operator gets a wrecked terminal and no
//! words. The hook runs before the stack unwinds, which is the one moment that
//! holds both facts at once: the terminal is raw, and why the program is dying.

use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};

/// The shape `std::panic::set_hook` takes and `take_hook` hands back.
type Hook = Box<dyn Fn(&PanicHookInfo<'_>) + Sync + Send>;

/// The hook [`super::run`] installs before raw mode goes on.
///
/// It puts the terminal back, writes the cause beside the workspace database,
/// says where on stderr — readable, now the screen is restored — and then hands
/// the panic on to the hook that was there before, so the usual message and
/// backtrace land on a working terminal instead of inside the alternate screen.
pub(super) fn hook(db: &Path, prior: Hook) -> Hook {
    let dir = dir_beside(db);
    Box::new(move |info| {
        ratatui::restore();
        match note(&dir, &info.to_string()) {
            Ok(p) => eprintln!("wecode tui crashed — its cause is in {}", p.display()),
            Err(e) => eprintln!("wecode tui crashed — and writing the cause failed: {e}"),
        }
        prior(info);
    })
}

/// Where the note goes: the workspace directory, the one place on disk the
/// operator already knows about — it is where the database they opened lives.
/// A store with no directory (in memory, in tests) falls back to the temp dir.
fn dir_beside(db: &Path) -> PathBuf {
    match db.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => std::env::temp_dir(),
    }
}

/// Writes the cause and a backtrace to `tui-crash.txt` in `dir`, replacing any
/// earlier note: the crash somebody is looking into is the latest one. The
/// backtrace is captured whether or not `RUST_BACKTRACE` is set — nobody re-runs
/// a crash they cannot reproduce to ask for it a second time.
fn note(dir: &Path, cause: &str) -> std::io::Result<PathBuf> {
    let path = dir.join("tui-crash.txt");
    std::fs::write(
        &path,
        format!(
            "wecode tui panicked at unix {}\n\n{cause}\n\nbacktrace:\n{}",
            super::now_secs(),
            std::backtrace::Backtrace::force_capture()
        ),
    )?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_note_names_the_cause_and_carries_a_backtrace() {
        let dir = std::env::temp_dir().join(format!("wecode-crash-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = note(&dir, "panicked at 'boom', crates/wecode-cli/src/tui.rs:1:1").unwrap();
        assert!(path.ends_with("tui-crash.txt"), "{}", path.display());
        let words = std::fs::read_to_string(&path).unwrap();
        assert!(words.contains("boom"), "{words}");
        assert!(words.contains("tui.rs:1:1"), "where, not only what:\n{words}");
        assert!(words.contains("backtrace:"), "{words}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_note_lands_beside_the_database_and_a_pathless_store_falls_back() {
        assert_eq!(dir_beside(Path::new("/ws/wecode.db")), Path::new("/ws"));
        // `Store::in_memory` reports `:memory:`, whose parent is the empty path —
        // and a note written to `""` would land wherever the process happened to
        // be started from.
        assert_eq!(dir_beside(Path::new(":memory:")), std::env::temp_dir());
        assert_eq!(dir_beside(Path::new("")), std::env::temp_dir());
    }
}
