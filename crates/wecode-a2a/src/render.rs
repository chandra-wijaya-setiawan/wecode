//! Turning a [`Message`](crate::Message) into the text a coding CLI receives.
//!
//! Kept beside the model rather than in the CLI, so the protocol knowledge lives in
//! one place: whoever changes the parts changes the rendering with them.
//!
//! A CLI agent gets a string on argv. Structured parts exist for something that can
//! read them and must not leak into the prompt as JSON noise, so only text parts are
//! rendered — with the structured ones summarised as a heading, not dumped.

use crate::{Artifact, Message, Part, Task};

/// The prompt for a coding CLI: every text part, and each artifact under a heading.
#[must_use]
pub fn prompt(message: &Message, artifacts: &[Artifact]) -> String {
    let mut out = message.as_text();
    for a in artifacts {
        out.push_str("\n\n");
        out.push_str(&artifact_block(a));
    }
    out
}

fn artifact_block(a: &Artifact) -> String {
    let mut out = match &a.name {
        Some(n) => format!("--- {n}"),
        None => format!("--- {}", a.artifact_id),
    };
    if let Some(d) = &a.description {
        out.push_str(&format!(" — {d}"));
    }
    out.push('\n');
    for p in &a.parts {
        if let Part::Text { text } = p {
            out.push_str(text);
            if !text.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

/// A one-line summary of a run, for a human reading the board.
#[must_use]
pub fn summarise(task: &Task) -> String {
    let artifacts = task.artifacts.len();
    format!(
        "{} [{}] {} artifact{}",
        task.id,
        serde_json::to_string(&task.status.state)
            .unwrap_or_default()
            .trim_matches('"'),
        artifacts,
        if artifacts == 1 { "" } else { "s" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Message, Part, TaskState};

    #[test]
    fn artifacts_follow_the_instruction_under_their_own_heading() {
        let m = Message::to_agent("m", vec![Part::text("do the thing")]);
        let a = Artifact::new("a-1", "what came before", vec![Part::text("+groundwork")])
            .described("from first");
        let p = prompt(&m, &[a]);
        assert!(p.starts_with("do the thing"), "{p}");
        assert!(p.contains("--- what came before — from first"), "{p}");
        assert!(p.contains("+groundwork"), "{p}");
    }

    #[test]
    fn structured_parts_never_reach_the_prompt() {
        // A coding CLI would read a JSON blob as part of its instruction.
        let m = Message::to_agent(
            "m",
            vec![
                Part::text("instruction"),
                Part::data(serde_json::json!({"acceptance": ["cargo test"]})),
            ],
        );
        let p = prompt(&m, &[]);
        assert_eq!(p, "instruction");
        assert!(!p.contains("acceptance"), "{p}");
    }

    #[test]
    fn an_instruction_with_no_artifacts_is_just_the_instruction() {
        let m = Message::to_agent("m", vec![Part::text("only this")]);
        assert_eq!(prompt(&m, &[]), "only this");
    }

    #[test]
    fn a_summary_names_the_state_the_protocol_uses() {
        let t = Task::new("e-1", "t-1", TaskState::InputRequired);
        assert!(
            summarise(&t).contains("input-required"),
            "{}",
            summarise(&t)
        );
        assert!(summarise(&t).contains("0 artifacts"));
    }
}
