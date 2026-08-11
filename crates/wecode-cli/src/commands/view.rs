//! The cockpit, in its two forms: a live terminal and a one-shot snapshot.

use wecode_store::AuditQuery;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::{board, tui};

/// The live cockpit: full-screen, navigable, reloads as state changes.
pub(crate) fn cockpit(a: &Args) -> Res {
    let (store, company) = open(a)?;
    if !tui::is_tty() {
        return Err("wecode up needs a terminal — try `wecode board` for a snapshot".into());
    }
    tui::run(store, company)?;
    Ok(String::new())
}

/// A snapshot of the same view, for pipes and logs.
pub(crate) fn board_snapshot(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let known_repos = repo_names(&company);
    let plan = store.load_plan()?;
    let audit = store.audit(&AuditQuery::default())?;
    match a.cmd(1) {
        "" => Ok(board::portfolio(&plan, &audit, &known_repos, a.has("all"))),
        id => Ok(board::focus(&plan, &audit, id, &known_repos)),
    }
}
