//! Reading what a run cost out of the agent's own output.
//!
//! There is no other source for a token count. wecode does not proxy the model API,
//! so the only party that knows how many tokens went over the wire is the harness
//! that sent them — which makes this the one number on the board that is reported
//! rather than observed. The ledger records that difference at write time
//! (`Source::Harness`, not `Source::Supervisor`) instead of letting a reader assume
//! it was measured.
//!
//! One adapter per protocol, selected by the `protocol` field of the agent template.
//! Two of them read a number, and neither is a harness: `claude-stream-json` is one
//! CLI's output as it happens to be, and `generic-jsonl` is a shape wecode publishes
//! for anything willing to emit it. A harness that does neither declares `plain` and
//! is metered as nothing — inventing a number from an output format nobody has read
//! would be worse than a blank column, because a blank column is obviously blank.
//! Which is also why a name outside the list is refused where `company.toml` is loaded
//! rather than here: a typo silently metering nothing is that blank column with no
//! decision behind it. See [`wecode_org::company::Protocol`].
//!
//! # The unit
//!
//! A count is only half of a number; the other half is what it counts, and a budget
//! is checked against this one. The unit here is **tokens the run added** — the
//! prompt it sent, the context it wrote to the cache, and everything the model
//! produced. Context re-read out of the cache is metered separately and is not part
//! of it, because those tokens were already counted once, on the turn that wrote
//! them.
//!
//! That is the difference between a figure that grows with the conversation and one
//! that grows with the conversation *times its length*. A forty-turn run over a
//! 120k-token context replays something near five million tokens without the agent
//! having written a line, while the work it actually did — the files it read, the
//! diff it produced — is a couple of hundred thousand. Budgets are written in the
//! second scale, because that is the scale a person estimates a task in. Judged
//! against the first, every task in this repository was over budget on its first
//! turn, the board's red meant "a run happened", and a real overrun looked exactly
//! like a cheap one.
//!
//! The replayed count is not thrown away — cache reads are billed, at a tenth of the
//! rate, and pretending otherwise would be its own lie. It is reported beside the
//! spend on the run line, where a person can see what a long conversation cost
//! without a budget having to be denominated in it.
//!
//! # One report per message
//!
//! The turn total is summed from lines, and a line is not a turn. `claude-stream-json`
//! announces one `assistant` line per content block, so a turn that thought and then
//! called a tool arrives two or three times over — same message id, same `usage`
//! object, restated. Added up line by line, one turn's tokens are counted once per
//! block it happened to be split into.
//!
//! That figure is thrown away the moment the run states its own total, which is why
//! the ledger never showed it: the `result` line supersedes the sum, and the number a
//! person reads afterwards is right. The supervisor is not reading afterwards. It
//! checks the budget against this same meter *while* the run is going, when the only
//! figure that exists is the sum — so a task was killed for a spend it had not made,
//! against a count nothing that survived the run agreed with. See [`Meter::line`] for
//! what makes a restatement recognisable.

use std::collections::BTreeSet;

use serde_json::Value;
use wecode_org::company::Protocol;

/// What one line of output is, under the protocol that was declared.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Report {
    /// The run's own account of itself, which supersedes anything summed here.
    Total,
    /// One turn, however many lines it took to announce itself.
    Turn,
    /// Neither, and most lines are neither.
    None,
}

/// One usage report, split by the two units it mixes.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
struct Usage {
    /// Tokens the run added: prompt, cache writes, and everything produced.
    fresh: u64,
    /// Context re-read from the cache. Kept apart rather than added, because these
    /// tokens were counted when they were written and this is the same context
    /// again — see the module docs on the unit.
    replayed: u64,
}

impl Usage {
    fn add(self, other: Self) -> Self {
        Self {
            fresh: self.fresh.saturating_add(other.fresh),
            replayed: self.replayed.saturating_add(other.replayed),
        }
    }
}

/// Accumulates the spend an agent reports as its output goes past.
///
/// Fed line by line rather than handed the finished output, because the output is
/// capped and the run total arrives on the very last line — exactly the line a cap
/// drops. Metering as it streams means the expensive runs are the ones that still
/// account for themselves.
#[derive(Debug)]
pub(crate) struct Meter {
    protocol: Protocol,
    /// The run's own total, once a line has stated one.
    total: Option<Usage>,
    /// Per-turn usage added up, for output that never states a total.
    turns: Option<Usage>,
    /// The message ids already in `turns`, so a turn restated across several lines is
    /// added once — see the module docs on one report per message.
    ///
    /// Ids, not a count of lines: the same turn can be announced three times with
    /// other turns' lines interleaved between them, which nothing positional could
    /// tell from three turns in a row.
    counted: BTreeSet<String>,
}

impl Meter {
    pub(crate) fn for_protocol(protocol: &str) -> Self {
        Self {
            // A name outside the vocabulary is refused where the file declaring it is
            // loaded, so what reaches here from a company is always one of the three.
            // A template built in code can still name anything, and meters nothing
            // rather than guessing — which is what `plain` already means.
            protocol: Protocol::parse(protocol).unwrap_or(Protocol::Plain),
            total: None,
            turns: None,
            counted: BTreeSet::new(),
        }
    }

    /// What this protocol makes of a line announcing itself as `ty`.
    ///
    /// The whole difference between the two readers. `claude-stream-json` knows the
    /// type names its harness writes and counts nothing else, so a line of some other
    /// kind that happens to carry a usage object cannot be mistaken for a turn. The
    /// generic contract has no names to rely on — that is what makes it general — so
    /// any line offering usage is a turn, and `result` keeps the one meaning wecode
    /// asks a harness to reserve.
    fn report(&self, ty: Option<&str>) -> Report {
        match (self.protocol, ty) {
            (Protocol::Plain, _) => Report::None,
            (_, Some("result")) => Report::Total,
            (Protocol::ClaudeStreamJson, Some("assistant")) | (Protocol::GenericJsonl, _) => {
                Report::Turn
            }
            _ => Report::None,
        }
    }

    /// Offers one line of the agent's output to the meter.
    pub(crate) fn line(&mut self, line: &str) {
        if self.protocol == Protocol::Plain {
            return;
        }
        // Most lines are not usage, and some are not JSON at all — a coding CLI
        // writes warnings to the same stream. Anything unparseable is simply not a
        // report, which is not an error.
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return;
        };
        match self.report(v.get("type").and_then(Value::as_str)) {
            // The run's own account of itself, which supersedes anything summed
            // here: a compacted or resumed conversation is charged for turns this
            // process never saw a line for.
            Report::Total => {
                if let Some(u) = usage_on(&v) {
                    self.total = Some(u);
                }
            }
            // One turn, however many lines it took to announce itself. A message
            // already counted is that same turn restated — a second content block,
            // not a second call — and adding it again charges a turn once per block
            // it was split into. Only a line that was actually counted claims its id,
            // so a first announcement carrying no usage does not silence the one that
            // does.
            Report::Turn => {
                let id = id_on(&v);
                if id.is_some_and(|id| self.counted.contains(id)) {
                    return;
                }
                if let Some(u) = usage_on(&v) {
                    self.turns = Some(self.turns.unwrap_or_default().add(u));
                    // An unidentified message is counted and not remembered: there is
                    // nothing to recognise it by later, and dropping every anonymous
                    // turn after the first would lose a real conversation's spend.
                    if let Some(id) = id {
                        self.counted.insert(id.to_string());
                    }
                }
            }
            Report::None => {}
        }
    }

    /// The run's own account of itself when it gave one, and the turns that were
    /// seen otherwise.
    fn reported(&self) -> Option<Usage> {
        self.total.or(self.turns)
    }

    /// What the agent said it spent, in the unit budgets are written in, or `None`
    /// if it said nothing.
    ///
    /// `None` and `Some(0)` are different facts and are kept apart: one is an agent
    /// whose output wecode cannot read, the other is an agent that ran and burned
    /// nothing.
    pub(crate) fn tokens(&self) -> Option<u64> {
        self.reported().map(|u| u.fresh)
    }

    /// Context the run re-read from the cache, which is spend of a different scale
    /// and is reported rather than budgeted. `None` on the same terms as
    /// [`Meter::tokens`].
    pub(crate) fn replayed(&self) -> Option<u64> {
        self.reported().map(|u| u.replayed)
    }
}

/// The usage a line carries, wherever on it that is.
///
/// Both spellings are already in the one stream `claude-stream-json` reads — a turn
/// nests it under the message it belongs to, the run's total sits at the top — so
/// asking for either is what the two readers have in common rather than a concession
/// to the second. A harness meeting the published contract writes whichever suits it.
fn usage_on(v: &Value) -> Option<Usage> {
    v.pointer("/usage")
        .or_else(|| v.pointer("/message/usage"))
        .and_then(usage_in)
}

/// What names the turn a line belongs to, so a turn restated across several lines is
/// counted once. `None` is a line with nothing to recognise it by — see [`Meter::line`]
/// for why that is counted anyway.
fn id_on(v: &Value) -> Option<&str> {
    v.pointer("/message/id")
        .or_else(|| v.pointer("/id"))
        .and_then(Value::as_str)
}

/// The one key naming context that was re-read rather than sent.
///
/// Named, not pattern-matched, and only this one: it is the field
/// `claude-stream-json` emits, and the spelling the published contract asks a harness
/// for. Recognising some other name for the same thing is how a made-up number reaches
/// a budget — the same reason a protocol nobody declared meters nothing.
const REPLAY_KEY: &str = "cache_read_input_tokens";

/// What one `usage` object accounts for, split into the two units.
///
/// Every other `*_tokens` field is fresh spend, cache *writes* included: those are
/// tokens that went over the wire for the first time, and a count that dropped them
/// would report a run as cheaper than it was.
///
/// A stated `total_tokens` is taken on its own rather than added to the fields
/// beside it, since it is their sum — and the replay comes back out of it, so the
/// number means the same thing whichever way it arrived.
fn usage_in(usage: &Value) -> Option<Usage> {
    let obj = usage.as_object()?;
    let read = obj.get(REPLAY_KEY).and_then(Value::as_u64);
    let replayed = read.unwrap_or(0);

    if let Some(total) = obj.get("total_tokens").and_then(Value::as_u64) {
        return Some(Usage {
            fresh: total.saturating_sub(replayed),
            replayed,
        });
    }
    // A usage object naming only cache reads has reported something — a turn that
    // added nothing — so the replay alone is enough to make this a report.
    let mut fresh = 0u64;
    let mut found = read.is_some();
    for (key, value) in obj {
        if key != REPLAY_KEY
            && key.ends_with("_tokens")
            && let Some(n) = value.as_u64()
        {
            fresh = fresh.saturating_add(n);
            found = true;
        }
    }
    found.then_some(Usage { fresh, replayed })
}

/// Every run of a task, so a retry does not erase what happened last time.
///
/// The heading counts the attested rows as well as the attempts, and that is the whole
/// of the warning: the figures below do not all come from the same place, and a reader
/// adding them up is entitled to know before doing the arithmetic rather than after.
#[must_use]
pub(crate) fn executions(runs: &[wecode_store::Execution]) -> String {
    if runs.is_empty() {
        return String::new();
    }
    let stated = runs.iter().filter(|r| r.attested_by.is_some()).count();
    let mut out = match stated {
        0 => format!("\nruns ({})\n", runs.len()),
        n => format!("\nruns ({}, {n} stated rather than metered)\n", runs.len()),
    };
    for r in runs {
        out.push_str(&format!(
            "  #{}  {:<10} {:<18} {:<20} {}\n",
            r.attempt,
            r.status.as_str(),
            match r.wall_secs {
                Some(w) => format!("{w}s"),
                // No end time means it never closed — wecode died mid-run, and the
                // pid is the only handle left on whatever it started.
                None => match r.pid {
                    Some(p) => format!("unfinished, pid {p}"),
                    None => "unfinished".to_string(),
                },
            },
            cost(r),
            account(r)
        ));
    }
    out
}

/// What the attempt was, and — where wecode did not run it — who says so.
///
/// The name goes in front of the detail rather than after it. The figures are what a
/// reader came for and they sit in the cell to the left, so the one thing that changes
/// how they should be read has to arrive first; a long account of the work would push it
/// past the width of anybody's terminal.
///
/// Silent on every metered row, which is the majority and needs no annotation: a run
/// wecode opened, timed and read is what this table has always meant.
#[must_use]
pub(crate) fn account(r: &wecode_store::Execution) -> String {
    let Some(by) = &r.attested_by else {
        return r.detail.clone();
    };
    if r.detail.is_empty() {
        format!("stated by {by}")
    } else {
        format!("stated by {by} — {}", r.detail)
    }
}

/// What one attempt cost, in the two units it was reported in.
///
/// Per attempt rather than only in total: a task that cost too much usually cost it on
/// one try, and the total cannot say which. The replay rides in the same cell because
/// it answers the same question about a different bill — three attempts that each added
/// ninety tokens are not three alike runs if one of them re-read two million — and it is
/// marked `+` rather than added, since the two are different scales and only the first
/// is what a budget is checked against.
///
/// Silent when a run re-read nothing, and silent for every attempt recorded before the
/// column existed. Those are different facts and the column keeps them apart; neither
/// is worth a cell on a line an operator is scanning for the expensive try.
fn cost(r: &wecode_store::Execution) -> String {
    let spent = match r.spent_tokens {
        Some(n) => format!("{n}t"),
        None => "—".to_string(),
    };
    match r.replayed_tokens {
        Some(n) if n > 0 => format!("{spent} +{n} re-read"),
        _ => spent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meter(protocol: &str, lines: &[&str]) -> Option<u64> {
        let mut m = Meter::for_protocol(protocol);
        for l in lines {
            m.line(l);
        }
        m.tokens()
    }

    fn claude(lines: &[&str]) -> Option<u64> {
        meter("claude-stream-json", lines)
    }

    fn claude_replayed(lines: &[&str]) -> Option<u64> {
        let mut m = Meter::for_protocol("claude-stream-json");
        for l in lines {
            m.line(l);
        }
        m.replayed()
    }

    fn generic(lines: &[&str]) -> Option<u64> {
        meter("generic-jsonl", lines)
    }

    #[test]
    fn the_final_result_line_is_the_runs_spend() {
        assert_eq!(
            claude(&[
                r#"{"type":"system","subtype":"init","session_id":"s"}"#,
                r#"{"type":"result","subtype":"success","usage":{"input_tokens":1200,"output_tokens":340}}"#,
            ]),
            Some(1540)
        );
    }

    #[test]
    fn writing_the_cache_is_spend_and_re_reading_it_is_not() {
        // The write went over the wire once and counts. The read is that same
        // context arriving back, and adding it would charge for those tokens twice
        // — once per turn that saw them.
        let line = r#"{"type":"result","usage":{"input_tokens":10,"output_tokens":5,
            "cache_creation_input_tokens":800,"cache_read_input_tokens":4000}}"#;
        assert_eq!(claude(&[line]), Some(815));
        assert_eq!(claude_replayed(&[line]), Some(4000), "still reported");
    }

    #[test]
    fn a_long_conversation_stays_in_the_scale_its_budget_was_written_in() {
        // The gap this unit exists to close. Forty turns over a growing context
        // replay millions of tokens while the run adds a couple of hundred
        // thousand; a 120k budget judged against the first is over before the
        // agent has written a line, and every task's row is red for no reason.
        let turns: Vec<String> = (0..40)
            .map(|i| {
                format!(
                    r#"{{"type":"assistant","message":{{"usage":{{"input_tokens":100,
                        "output_tokens":1000,"cache_creation_input_tokens":2000,
                        "cache_read_input_tokens":{}}}}}}}"#,
                    i * 3000
                )
            })
            .collect();
        let lines: Vec<&str> = turns.iter().map(String::as_str).collect();
        assert_eq!(claude(&lines), Some(124_000));
        assert_eq!(claude_replayed(&lines), Some(2_340_000));
    }

    #[test]
    fn a_turn_that_only_re_read_the_context_is_a_report_of_nothing_spent() {
        let line = r#"{"type":"result","usage":{"cache_read_input_tokens":9000}}"#;
        assert_eq!(claude(&[line]), Some(0));
        assert_eq!(claude_replayed(&[line]), Some(9000));
    }

    #[test]
    fn a_stated_total_is_not_added_to_the_parts_it_is_made_of() {
        assert_eq!(
            claude(&[
                r#"{"type":"result","usage":{"prompt_tokens":100,"completion_tokens":50,
                    "total_tokens":150}}"#,
            ]),
            Some(150)
        );
    }

    #[test]
    fn a_stated_total_is_in_the_same_unit_as_a_summed_one() {
        // A total states everything the run touched, replay included. Taking it as
        // it stands would make the unit depend on which line the harness wrote.
        assert_eq!(
            claude(&[
                r#"{"type":"result","usage":{"input_tokens":100,"output_tokens":50,
                    "cache_read_input_tokens":4000,"total_tokens":4150}}"#,
            ]),
            Some(150)
        );
    }

    #[test]
    fn turns_are_summed_when_no_total_ever_arrives() {
        // The truncated-output case: the cap dropped the result line, so what was
        // seen is all there is. Reporting it beats reporting nothing.
        assert_eq!(
            claude(&[
                r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20}}}"#,
                r#"{"type":"assistant","message":{"usage":{"input_tokens":30,"output_tokens":40}}}"#,
            ]),
            Some(100)
        );
    }

    #[test]
    fn a_turn_announced_once_per_content_block_is_counted_once() {
        // What `claude-stream-json` actually emits when a turn thinks and then calls a
        // tool: the same message, same id, same usage, restated per block. Summed line
        // by line it is a turn charged three times — and while the run is going, that
        // inflated sum is the only figure the budget has to check against.
        let dup = r#"{"type":"assistant","message":{"id":"msg_1","usage":{"input_tokens":30,
            "output_tokens":30}}}"#;
        assert_eq!(claude(&[dup, dup, dup]), Some(60));
    }

    #[test]
    fn two_turns_are_two_turns_however_alike_they_look() {
        // The other half of it: identical usage under different ids is a conversation
        // doing the same amount of work twice, and dropping the second would report a
        // run as half what it cost.
        assert_eq!(
            claude(&[
                r#"{"type":"assistant","message":{"id":"msg_1","usage":{"input_tokens":30,"output_tokens":30}}}"#,
                r#"{"type":"assistant","message":{"id":"msg_2","usage":{"input_tokens":30,"output_tokens":30}}}"#,
            ]),
            Some(120)
        );
    }

    #[test]
    fn a_restated_turn_does_not_replay_its_cache_reads_either() {
        // Both halves of the report come off the same line, so both were multiplied by
        // however many blocks the turn arrived in.
        let dup = r#"{"type":"assistant","message":{"id":"msg_1","usage":{"input_tokens":10,
            "output_tokens":5,"cache_read_input_tokens":4000}}}"#;
        assert_eq!(claude(&[dup, dup]), Some(15));
        assert_eq!(claude_replayed(&[dup, dup]), Some(4000));
    }

    #[test]
    fn a_harness_that_names_no_message_is_taken_at_its_word_every_line() {
        // Nothing to recognise a restatement by, so every line is a turn. The wrong
        // guess here is the expensive one: dropping unidentified turns after the first
        // reports a whole conversation as one call.
        let line =
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20}}}"#;
        assert_eq!(claude(&[line, line, line]), Some(90));
    }

    #[test]
    fn a_first_line_with_no_usage_does_not_silence_the_one_that_has_it() {
        // An id is claimed by the line that was counted, not by the first line to
        // mention it — otherwise a message announced empty and then reported would be
        // metered as free.
        assert_eq!(
            claude(&[
                r#"{"type":"assistant","message":{"id":"msg_1","content":"thinking"}}"#,
                r#"{"type":"assistant","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":20}}}"#,
            ]),
            Some(30)
        );
    }

    #[test]
    fn the_run_total_wins_over_the_turns_that_were_seen() {
        // A resumed or compacted conversation is charged for turns this process
        // never saw a line for, so the summed figure is a floor, not the answer.
        assert_eq!(
            claude(&[
                r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20}}}"#,
                r#"{"type":"result","usage":{"input_tokens":900,"output_tokens":100}}"#,
            ]),
            Some(1000)
        );
    }

    #[test]
    fn noise_on_the_stream_is_not_a_report() {
        assert_eq!(
            claude(&[
                "warning: something on stderr",
                "",
                "{not json at all",
                r#"{"type":"assistant","message":{"content":"no usage here"}}"#,
                r#"{"type":"result"}"#,
            ]),
            None,
            "nothing readable means nothing reported"
        );
    }

    #[test]
    fn an_agent_that_reported_nothing_is_not_an_agent_that_spent_nothing() {
        // The distinction the board needs: `None` is unmetered, `Some(0)` is free.
        assert_eq!(
            claude(&[r#"{"type":"result","usage":{"input_tokens":0,"output_tokens":0}}"#]),
            Some(0)
        );
        assert_eq!(claude(&[]), None);
    }

    #[test]
    fn a_harness_that_declares_nothing_is_metered_as_nothing() {
        // `plain` is a decision and not a gap: the harness reports a spend wecode
        // cannot read, so the column stays blank rather than being filled from an
        // output format nobody here has read. The empty string says the same, which is
        // what every company written before the vocabulary existed says.
        let line = r#"{"type":"result","usage":{"input_tokens":1200,"output_tokens":340}}"#;
        assert_eq!(meter("plain", &[line]), None);
        assert_eq!(meter("", &[line]), None);
        // A name outside the vocabulary never reaches here from a file — it is refused
        // at load — and is metered as nothing rather than guessed at if it does.
        assert_eq!(meter("opencode-json", &[line]), None);
    }

    #[test]
    fn a_harness_meeting_the_published_contract_is_metered_without_being_known() {
        // The point of there being a contract: no adapter, no name in a match arm,
        // nothing about this harness anywhere in the crate. It writes a usage object
        // per line and states its total on a `result` line, and the run has a spend.
        assert_eq!(
            generic(&[
                r#"{"event":"step","usage":{"input_tokens":10,"output_tokens":20}}"#,
                r#"{"event":"step","usage":{"input_tokens":30,"output_tokens":40}}"#,
            ]),
            Some(100),
            "turns are summed"
        );
        assert_eq!(
            generic(&[
                r#"{"event":"step","usage":{"input_tokens":10,"output_tokens":20}}"#,
                r#"{"type":"result","usage":{"total_tokens":900}}"#,
            ]),
            Some(900),
            "and a stated total supersedes them"
        );
    }

    #[test]
    fn the_generic_contract_keeps_the_rules_the_unit_depends_on() {
        // Everything the claude reader was taught the hard way holds here too: cache
        // reads are their own scale, and a turn restated is one turn.
        let line = r#"{"id":"t1","usage":{"input_tokens":10,"output_tokens":5,
            "cache_read_input_tokens":4000}}"#;
        assert_eq!(generic(&[line, line]), Some(15));
        let mut m = Meter::for_protocol("generic-jsonl");
        m.line(line);
        assert_eq!(m.replayed(), Some(4000));
    }

    #[test]
    fn the_two_readers_differ_only_in_what_they_are_willing_to_count() {
        // A line of some other kind carrying a usage object. `claude-stream-json`
        // knows the type names its harness writes and counts nothing else; the generic
        // reader has no names to rely on, which is the trade it makes to be general.
        let line = r#"{"type":"user","message":{"usage":{"input_tokens":700}}}"#;
        assert_eq!(claude(&[line]), None);
        assert_eq!(generic(&[line]), Some(700));
    }

    /// One closed attempt, so a test can vary what it reported and nothing else.
    fn attempt(n: i64, spent: Option<u64>, replayed: Option<u64>) -> wecode_store::Execution {
        wecode_store::Execution {
            id: n,
            task: "cache".into(),
            session: "s-1".into(),
            attempt: n,
            status: wecode_core::ExecutionStatus::Completed,
            attested_by: None,
            worktree: None,
            pid: None,
            started: 0,
            ended: Some(12),
            wall_secs: Some(12),
            spent_tokens: spent,
            replayed_tokens: replayed,
            detail: "exit 0".into(),
        }
    }

    #[test]
    fn the_attempt_that_held_the_long_conversation_is_visible_beside_the_one_that_paid() {
        // Two tries that added the same ninety tokens are not two alike runs when one
        // of them re-read two million, and the spend column alone cannot say which was
        // which. The reader wanting the expensive attempt is asking about a bill, and
        // half of that bill is cache reads.
        let out = executions(&[
            attempt(1, Some(90), Some(0)),
            attempt(2, Some(90), Some(2_340_000)),
        ]);
        assert!(out.contains("90t +2340000 re-read"), "{out}");
        // The cheap turn says nothing rather than `+0`: a cell an operator scans for
        // the outlier should not be full of zeroes.
        assert!(!out.contains("+0 re-read"), "{out}");
    }

    #[test]
    fn an_attempt_from_before_the_count_says_nothing_rather_than_nothing_re_read() {
        // NULL is an attempt nobody asked, and a run on a cold cache reports 0. Both
        // are silent here — but they are silent in the same way a missing spend is,
        // and the column behind them keeps them apart for anything that queries it.
        let out = executions(&[attempt(1, Some(90), None), attempt(2, None, None)]);
        assert!(out.contains("90t "), "{out}");
        assert!(!out.contains("re-read"), "{out}");
        assert!(out.contains('—'), "an unmetered attempt still reads as such: {out}");
    }

    #[test]
    fn a_cost_somebody_stated_never_reads_as_one_wecode_metered() {
        // The whole point of the column, at the only place most people will meet it. A
        // task worked in somebody's own session and a task run under supervision now
        // both have rows here, and the figures on them mean different things: one was
        // counted off an output stream, the other is a person's recollection. Told apart
        // twice — in the heading, before the arithmetic, and again on the row itself.
        let mut said = attempt(2, Some(90_000), None);
        said.attested_by = Some("cws".into());
        said.detail = "worked it in my own session".into();
        let out = executions(&[attempt(1, Some(1540), Some(4000)), said]);

        assert!(out.contains("runs (2, 1 stated rather than metered)"), "{out}");
        assert!(out.contains("stated by cws — worked it in my own session"), "{out}");
        // And the metered row is left exactly as it was: an annotation that leaked onto
        // it would say wecode did not run something it ran.
        assert!(out.contains("exit 0\n"), "{out}");
    }

    #[test]
    fn a_run_wecode_watched_is_annotated_with_nothing_at_all() {
        // The majority case, asserted so the marker cannot drift into it. A table where
        // every row explains its provenance is a table where none of them do.
        let out = executions(&[attempt(1, Some(90), None)]);
        assert!(out.contains("runs (1)"), "{out}");
        assert!(!out.contains("stated"), "{out}");
    }

    #[test]
    fn a_stated_cost_with_nothing_said_about_it_still_names_who_said_it() {
        // The name is the load-bearing half. A row that dropped it because the detail
        // was empty would be a bare figure reading as a measured one.
        let mut bare = attempt(1, Some(90_000), None);
        bare.attested_by = Some("cws".into());
        bare.detail = String::new();
        assert_eq!(account(&bare), "stated by cws");
    }
}
