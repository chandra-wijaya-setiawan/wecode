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
    total: Option<u64>,
    /// Per-turn usage added up, for output that never states a total.
    turns: Option<u64>,
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
                if let Some(n) = v.get("usage").and_then(tokens_in) {
                    self.total = Some(n);
                }
            }
            Some("assistant") => {
                if let Some(n) = v.pointer("/message/usage").and_then(tokens_in) {
                    self.turns = Some(self.turns.unwrap_or(0).saturating_add(n));
                }
            }
            _ => {}
        }
    }

    /// What the agent said it spent, or `None` if it said nothing.
    ///
    /// `None` and `Some(0)` are different facts and are kept apart: one is an agent
    /// whose output wecode cannot read, the other is an agent that ran and burned
    /// nothing.
    pub(crate) fn tokens(&self) -> Option<u64> {
        self.total.or(self.turns)
    }
}

/// The tokens one `usage` object accounts for.
///
/// Every `*_tokens` field counts, cache reads and cache writes included: they are
/// tokens the run consumed, and a budget that ignored them would be a budget for
/// something other than what the run cost. A stated `total_tokens` is taken on its
/// own — it is the sum of the fields beside it, so adding both counts everything
/// twice.
fn tokens_in(usage: &Value) -> Option<u64> {
    let obj = usage.as_object()?;
    if let Some(total) = obj.get("total_tokens").and_then(Value::as_u64) {
        return Some(total);
    }
    let mut sum = 0u64;
    let mut found = false;
    for (key, value) in obj {
        if key.ends_with("_tokens")
            && let Some(n) = value.as_u64()
        {
            sum = sum.saturating_add(n);
            found = true;
        }
    }
    found.then_some(sum)
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
    fn cache_tokens_are_part_of_what_a_run_cost() {
        // Not free, and not somebody else's spend: leaving them out would report a
        // long conversation as a cheap one.
        assert_eq!(
            claude(&[
                r#"{"type":"result","usage":{"input_tokens":10,"output_tokens":5,
                    "cache_creation_input_tokens":800,"cache_read_input_tokens":4000}}"#,
            ]),
            Some(4815)
        );
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
