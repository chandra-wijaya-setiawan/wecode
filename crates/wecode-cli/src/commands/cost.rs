//! `cost` — attributing work wecode never dispatched to the task it was for.
//!
//! Every other cost in this system arrives through the supervisor: a run is opened at
//! spawn, timed here, and its tokens read off the agent's own output. Work that never
//! went through that door — a task handed out by `wecode start` and finished in
//! somebody's own session, a console step only a person can do — costs the same real
//! money and leaves no row, so the task reads as free and the project's total is short
//! by however much of the work a human did.
//!
//! What this command does about it is the smallest possible thing: it writes one more
//! attempt, says who stated the figures, and touches nothing that was measured. It does
//! not judge the work — a cost record makes no claim about the result, so no status
//! moves and no acceptance runs. See [`wecode_store::execution::Attested`], which is the
//! shape of what gets stored, and the reasoning about why it is its own row.
//!
//! Two writes, because the cost is read in two places. The attempt is what `wecode show`
//! and the cockpit's task screen list; the ledger record is what the board's spend cell
//! and `wecode audit` add up. Attribution that reached only one of them would leave the
//! board still calling the task free, which is the whole complaint.

use wecode_core::TaskId;
use wecode_gov::{Action, Broker, Decision, Session, Source};
use wecode_store::execution::{Attested, Spend};
use wecode_store::Store;

use crate::args::Args;
use crate::commands::ctx::*;
use crate::commands::plan::amount;

/// Files what work nobody metered cost, against the task it was for.
///
/// The attestor is whoever typed it, never a `--by` flag. A name a switch can carry is
/// not an attribution: the point of the column is that somebody is answerable for the
/// figures, and the session already knows who that is. Where a person occupies the seat
/// it is their name; where none does it is the post's, which is the honest answer — the
/// seat stated it and nobody has said who was in it.
///
/// Gated on `staff` rather than `define`. Nothing here changes what the task is; it
/// records something about the doing of it, which is the authority that says who acts on
/// a task and where it stands. `Spend` would be the wrong gate twice over: it is checked
/// against a token cap, so a large honest figure would be *refused* — and refused after
/// the money was gone, with the refusal filed in the ledger as an overspend that never
/// happened.
pub(crate) fn cost(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let plan = store.load_plan()?;
    let task = the_task(&plan, require(a.cmd(1), "task id")?)?.clone();
    let id = task.id.clone();
    // Required, not optional. A metered row gets its detail from an exit code; this one
    // has no such source, so a bare figure would land in the run table as an unexplained
    // charge with nothing to reconcile it against six weeks later.
    //
    // Read before the figures, so somebody who typed the command with nothing after it is
    // told what the command wants rather than which flag it is missing.
    let detail = require(
        a.cmd(2),
        "what the work was — wecode cost <task> \"<what was done>\"",
    )?
    .to_string();

    let (tokens, wall, replayed) = (
        amount(a, "tokens")?,
        amount(a, "wall")?,
        amount(a, "replayed")?,
    );
    // Both absent is the one input that cannot be honoured. The row would say a person
    // worked on this and it cost nothing measurable, which no reader can tell from the
    // silence it is meant to replace. A lone `--replayed` is the same refusal: context
    // read back out of a cache is not a spend, which is the whole reason it has a column
    // of its own rather than a place in the sum.
    if tokens.is_none() && wall.is_none() {
        return Err("a cost with no figures is not a cost — \
                    give --tokens <n>, --wall <secs>, or both"
            .into());
    }

    let who = actor(a, &store, &company)?;
    let on = (Some(task.project.to_string()), Some(id.to_string()));
    require_allowed(
        &store,
        &company,
        &who,
        on.clone(),
        &Action::Staff,
        "recording a cost",
    )?;

    let by = who.human.clone().unwrap_or_else(|| who.post.clone());
    let row = store.record_execution(
        &id,
        &who.session,
        &Attested {
            by: by.clone(),
            wall_secs: wall,
            spend: Spend { tokens, replayed },
            detail: detail.clone(),
        },
    )?;
    ledger(&store, &company, &who, on, tokens, wall)?;

    let runs = store.executions(&id)?;
    let attempt = runs.iter().find(|r| r.id == row).map_or(0, |r| r.attempt);
    let mut out = format!(
        "  {id}  attempt {attempt} — stated, not measured\n    \
         by      {by}\n    \
         spent   {}\n    \
         what    {detail}\n",
        figures(tokens, wall, replayed)
    );
    out.push_str(&total(&store, &id, task.budget.tokens)?);
    Ok(out)
}

/// The same spend on the ledger, where the board and `wecode audit` read totals from.
///
/// Observed rather than authorised, exactly as a run's own spend is: the money is
/// already gone and a Broker asked to permit it afterwards would be theatre. The
/// authority that mattered was checked one call up, on the act of writing this down.
///
/// [`Source::Harness`] is named for the commonest speaker rather than the only one. Of
/// the two sources that are not the Broker's own decision, `Supervisor` means *wecode
/// measured this* and `Harness` means *the figure arrived from outside wecode's
/// instruments* — and an attestation is the second of those. Which outsider it was is on
/// the record already: the row carries the post, the seat and the human in it.
///
/// Zero stands in for a figure nobody gave, and only here. The ledger's spend target is
/// two numbers and has no way to say *unstated*, while the attempt row does — so the
/// column that can keep the distinction keeps it, and the total that cannot is short by
/// what was never claimed rather than long by what was invented.
fn ledger(
    store: &Store,
    company: &wecode_org::Company,
    who: &Actor,
    on: (Option<String>, Option<String>),
    tokens: Option<u64>,
    wall: Option<u64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut broker = Broker::new(company.charter.clone());
    let seat = Session::new(
        who.session.clone(),
        who.post.clone(),
        who.agent.clone(),
        who.effective.clone(),
    )
    .on(on.0, on.1)
    .with_human(who.human.clone());
    broker.observe(
        &seat,
        Action::Spend {
            tokens: tokens.unwrap_or(0),
            wall_secs: wall.unwrap_or(0),
        },
        Decision::Allow,
        Source::Harness,
    );
    store.append_records(broker.ledger())?;
    Ok(())
}

/// `90000 tokens, 7200s`, with `—` where nothing was stated.
///
/// Not zero, for the reason the store keeps the columns nullable: *I know what it cost
/// and not how long it took* is a real answer and `0s` is a different one. The replay
/// only appears when somebody claimed one — it is the figure an attestor is least likely
/// to know, and a `—` for it on every row would be noise standing in for a rarity.
fn figures(tokens: Option<u64>, wall: Option<u64>, replayed: Option<u64>) -> String {
    let stated = |v: Option<u64>, unit: &str| {
        v.map_or_else(|| "—".to_string(), |n| format!("{n}{unit}"))
    };
    let mut out = format!("{} tokens, {}", stated(tokens, ""), stated(wall, "s"));
    if let Some(n) = replayed {
        out.push_str(&format!(", +{n} re-read"));
    }
    out
}

/// What the task has cost now, and how much of that nobody measured.
///
/// Printed because the figure just filed is rarely the one being asked about. Somebody
/// recording two hours of their own work wants to know whether the task has gone past
/// what it was budgeted, and how much of the answer rests on people's word — which is
/// the whole reason the two kinds of row are kept apart rather than summed in silence.
fn total(
    store: &Store,
    id: &TaskId,
    budget: Option<u64>,
) -> Result<String, Box<dyn std::error::Error>> {
    let runs = store.executions(id)?;
    let spent: u64 = runs.iter().filter_map(|r| r.spent_tokens).sum();
    let stated = runs.iter().filter(|r| r.attested_by.is_some()).count();
    let mut out = format!(
        "\n  {id} has spent {spent} tokens over {} attempt{}, {stated} of them stated\n",
        runs.len(),
        if runs.len() == 1 { "" } else { "s" }
    );
    // Phrased as what the board will show rather than as a verdict of its own, because
    // the two readings of a budget do not agree and this is not the place to settle it:
    // the run table holds each attempt to the figure, the board holds the task's whole
    // rollup to it. Said at all because this is the moment the number changed and the
    // person who changed it is still reading — finding it out from a red row tomorrow is
    // the version of this that helps nobody.
    if let Some(b) = budget
        && spent > b
    {
        out.push_str(&format!(
            "  the board will read {id} as over its {b} — \
             `wecode task budget {id} --tokens <n>` raises it\n"
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unstated_figure_reads_as_absent_rather_than_zero() {
        assert_eq!(figures(Some(90_000), None, None), "90000 tokens, —");
        assert_eq!(figures(None, Some(7200), None), "— tokens, 7200s");
        assert_eq!(
            figures(Some(90_000), Some(7200), Some(4000)),
            "90000 tokens, 7200s, +4000 re-read"
        );
    }
}
