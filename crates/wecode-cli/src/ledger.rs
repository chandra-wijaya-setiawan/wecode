//! Reading facts about a task back out of the audit ledger.
//!
//! Signatures live here rather than on the task row, and that is the whole design: a
//! signature a command-line switch could stand in for is not a signature. `wecode
//! approve` writes one, attributed to the post that gave it and to the human in that
//! seat when there is one, and every gate that needs one comes back here to ask.
//!
//! The ledger is append-only and `seq` is assigned by the database, so these queries
//! compare positions rather than timestamps — which is what lets a signature be judged
//! *stale* rather than merely present.
//!
//! Not everything in that ledger is about a task, and this module reads only the part
//! that is. The ADR index shares the same table — a `decide` row per decision the
//! repository has taken and a `supersede` row per replacement (ADR-0005) — and those rows
//! carry no task id, because a decision outlives every task that cites it. So [`lines`]
//! never returns one, and no gate here can be tripped or satisfied by an ADR landing.
//! Read the index through [`wecode_store::Store::adrs`], which folds the whole of it;
//! filtering this module's rows for it would find nothing and say so quietly.

use wecode_core::TaskId;
use wecode_gov::ActionKind;
use wecode_store::{AuditQuery, Store};

type Fallible<T> = Result<T, Box<dyn std::error::Error>>;

/// Where in the ledger the newest signature of this kind on this task sits.
///
/// `None` when there is none. Only an allowed record counts: a refused approval is an
/// attempt to sign, which is worth recording and is not a signature.
pub(crate) fn signed_at(store: &Store, task: &TaskId, kind: ActionKind) -> Fallible<Option<i64>> {
    Ok(lines(store, task)?
        .iter()
        // `target` is the Debug form of the kind, which is what the store writes.
        // Derived from the kind here rather than typed as a literal, so a renamed
        // variant cannot leave a gate quietly matching nothing.
        .filter(|l| {
            l.action == "approve" && l.target == format!("{kind:?}") && l.outcome == "allow"
        })
        .map(|l| l.seq)
        .max())
}

/// Whether a signature of this kind is on the record at all.
pub(crate) fn is_signed(store: &Store, task: &TaskId, kind: ActionKind) -> Fallible<bool> {
    Ok(signed_at(store, task, kind)?.is_some())
}

/// Where in the ledger this task was last defined or redefined.
///
/// `Define{Task}` is recorded by `task add` and by `task scope`, so this is the
/// position of the most recent change to *what the task is*. A signature earlier than
/// it was given to a different task under the same id.
///
/// Not every field is covered: only scope amendment has its own command today, and a
/// budget or acceptance change means removing the task and adding it again, which
/// records a `define` of its own. What this cannot see is a row written straight into
/// the database, and nothing in wecode defends against that.
pub(crate) fn defined_at(store: &Store, task: &TaskId) -> Fallible<Option<i64>> {
    Ok(lines(store, task)?
        .iter()
        .filter(|l| l.action == "define" && l.target == "task" && l.outcome == "allow")
        .map(|l| l.seq)
        .max())
}

fn lines(store: &Store, task: &TaskId) -> Fallible<Vec<wecode_store::AuditLine>> {
    Ok(store.audit(&AuditQuery {
        task: Some(task.to_string()),
        ..Default::default()
    })?)
}
