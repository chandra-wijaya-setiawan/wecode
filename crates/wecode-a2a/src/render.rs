//! Turning [`Artifact`](crate::Artifact)s into the text a coding CLI receives.
//!
//! Kept beside the model rather than in the CLI, so the protocol knowledge lives in
//! one place: whoever changes the parts changes the rendering with them.
//!
//! A CLI agent gets a string on argv. Structured parts exist for something that can
//! read them and must not leak into the prompt as JSON noise, so only text parts are
//! rendered here — a `DataPart` survives in the JSON and stays out of the prose.
//!
//! Where the evidence goes in the prompt is *not* decided here. A template with a
//! `{{context}}` slot wants it inline; without one it is appended. That is a binding
//! concern, and the caller owns it.

use crate::{Artifact, Part};

/// Every artifact under its own heading, in order.
#[must_use]
pub fn artifacts(list: &[Artifact]) -> String {
    list.iter().map(block).collect::<Vec<_>>().join("\n")
}

fn block(a: &Artifact) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Artifact;

    #[test]
    fn an_artifact_is_named_and_described_in_its_heading() {
        let a = Artifact::new("a-1", "what came before", vec![Part::text("+groundwork")])
            .described("from first");
        let out = artifacts(&[a]);
        assert!(
            out.starts_with("--- what came before — from first"),
            "{out}"
        );
        assert!(out.contains("+groundwork"), "{out}");
    }

    #[test]
    fn structured_parts_never_reach_the_prompt() {
        // A coding CLI would read a JSON blob as part of its instruction.
        let a = Artifact::new(
            "a-1",
            "spec",
            vec![
                Part::text("readable"),
                Part::data(serde_json::json!({"acceptance": ["cargo test"]})),
            ],
        );
        let out = artifacts(&[a]);
        assert!(out.contains("readable"), "{out}");
        assert!(!out.contains("acceptance"), "{out}");
    }

    #[test]
    fn no_artifacts_renders_to_nothing_rather_than_an_empty_heading() {
        assert_eq!(artifacts(&[]), "");
    }

    #[test]
    fn an_unnamed_artifact_falls_back_to_its_id() {
        let a = Artifact {
            artifact_id: "a-9".into(),
            parts: vec![Part::text("x")],
            name: None,
            description: None,
        };
        assert!(artifacts(&[a]).starts_with("--- a-9"));
    }
}
