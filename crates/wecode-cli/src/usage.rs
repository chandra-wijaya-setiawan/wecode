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
//! An unrecognised protocol meters nothing and says so: inventing a number from an
//! output format nobody has read would be worse than a blank column, because a blank
//! column is obviously blank.
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

use serde_json::Value;

/// The output formats a token count can be read out of.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Protocol {
    /// `claude --output-format stream-json`: one JSON object per line, where an
    /// `assistant` line carries that turn's usage and a final `result` line carries
    /// the whole run's.
    ClaudeStreamJson,
    /// Everything else, including the empty string. Its output may well contain a
    /// count; nothing here claims to know where.
    Unmetered,
}

impl Protocol {
    fn parse(s: &str) -> Self {
        match s {
            "claude-stream-json" => Self::ClaudeStreamJson,
            _ => Self::Unmetered,
        }
    }
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
}

impl Meter {
    pub(crate) fn for_protocol(protocol: &str) -> Self {
        Self {
            protocol: Protocol::parse(protocol),
            total: None,
            turns: None,
        }
    }

    /// Offers one line of the agent's output to the meter.
    pub(crate) fn line(&mut self, line: &str) {
        if self.protocol == Protocol::Unmetered {
            return;
        }
        // Most lines are not usage, and some are not JSON at all — a coding CLI
        // writes warnings to the same stream. Anything unparseable is simply not a
        // report, which is not an error.
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return;
        };
        match v.get("type").and_then(Value::as_str) {
            // The run's own account of itself, which supersedes anything summed
            // here: a compacted or resumed conversation is charged for turns this
            // process never saw a line for.
            Some("result") => {
                if let Some(u) = v.get("usage").and_then(usage_in) {
                    self.total = Some(u);
                }
            }
            Some("assistant") => {
                if let Some(u) = v.pointer("/message/usage").and_then(usage_in) {
                    self.turns = Some(self.turns.unwrap_or_default().add(u));
                }
            }
            _ => {}
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

/// The one key naming context that was re-read rather than sent.
///
/// Named, not pattern-matched, and only this one: it is the field
/// `claude-stream-json` emits, which is the only protocol anything here claims to
/// read. Guessing that some other harness spells it the same way is how a made-up
/// number reaches a budget — the same reason an unknown protocol meters nothing.
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
    fn an_unknown_protocol_meters_nothing_even_when_the_output_looks_familiar() {
        // Guessing at an unread format is how a made-up number reaches a budget.
        let line = r#"{"type":"result","usage":{"input_tokens":1200,"output_tokens":340}}"#;
        assert_eq!(meter("generic-jsonl", &[line]), None);
        assert_eq!(meter("", &[line]), None);
    }
}
