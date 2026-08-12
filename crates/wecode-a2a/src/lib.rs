//! The A2A data model, as the shape a handoff takes.
//!
//! A2A separates its canonical data model from its bindings — JSON-RPC, gRPC, REST —
//! so adopting the model without the transport is what the specification sanctions
//! rather than a compromise. wecode is a platform, not an agent, and speaks to coding
//! CLIs over argv and a working directory; there is nothing for JSON-RPC to do here.
//!
//! What it buys is a *named* contract. Before this the envelope carried headings
//! invented on the spot — `CONTEXT FROM COMPLETED WORK`, `YOUR PREVIOUS ATTEMPTS` —
//! which no one else could parse and nothing pinned down.
//!
//! The mapping to wecode's own types:
//!
//! | wecode | A2A |
//! |---|---|
//! | `TaskExecution`, one run | [`Task`] — `id` the execution, `contextId` the wecode task |
//! | the envelope | [`Message`] with role `user` |
//! | a predecessor's diff | [`Artifact`] |
//! | `ExecutionStatus` | [`TaskState`] — the same eight names |
//! | a wecode `Task`, planned work | *nothing* — A2A has no planned-but-unstarted state |
//!
//! For a CLI agent that cannot speak A2A, wecode fills in the agent's side of the
//! [`Task`] from what it observed: the diff, the exit code. That is strictly more
//! trustworthy than an agent-reported one, because the agent cannot author it.

use serde::{Deserialize, Serialize};
use wecode_core::ExecutionStatus;

pub mod render;

/// A2A's task lifecycle. The JSON names are the protocol's, not ours.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    Submitted,
    Working,
    InputRequired,
    AuthRequired,
    Completed,
    Failed,
    Canceled,
    Rejected,
    /// A2A carries this; wecode never produces it. Present so a foreign task
    /// deserialises rather than failing.
    Unknown,
}

impl From<ExecutionStatus> for TaskState {
    fn from(s: ExecutionStatus) -> Self {
        // Deliberately exhaustive rather than a string round-trip: if a state is ever
        // added on either side, this stops compiling instead of silently mapping to
        // `Unknown`.
        match s {
            ExecutionStatus::Submitted => Self::Submitted,
            ExecutionStatus::Working => Self::Working,
            ExecutionStatus::InputRequired => Self::InputRequired,
            ExecutionStatus::AuthRequired => Self::AuthRequired,
            ExecutionStatus::Completed => Self::Completed,
            ExecutionStatus::Failed => Self::Failed,
            ExecutionStatus::Canceled => Self::Canceled,
            ExecutionStatus::Rejected => Self::Rejected,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The requester. wecode, when it hands work down.
    User,
    /// The responder.
    Agent,
}

/// One piece of content. The `kind` tag is A2A's discriminator.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Part {
    Text {
        text: String,
    },
    File {
        file: FileContent,
    },
    /// Structured, so an agent that can parse need not scrape prose.
    Data {
        data: serde_json::Value,
    },
}

impl Part {
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text { text: s.into() }
    }

    pub fn data(v: serde_json::Value) -> Self {
        Self::Data { data: v }
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub message_id: String,
    pub role: Role,
    pub parts: Vec<Part>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

impl Message {
    /// A directive going down: wecode is the requester.
    pub fn to_agent(message_id: impl Into<String>, parts: Vec<Part>) -> Self {
        Self {
            message_id: message_id.into(),
            role: Role::User,
            parts,
            context_id: None,
            task_id: None,
        }
    }

    #[must_use]
    pub fn about(mut self, context: impl Into<String>, task: impl Into<String>) -> Self {
        self.context_id = Some(context.into());
        self.task_id = Some(task.into());
        self
    }

    /// The text of every `TextPart`, in order. What a CLI agent actually receives.
    #[must_use]
    pub fn as_text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|p| match p {
                Part::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

/// Something a run produced. wecode builds these from git, never from the agent.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub artifact_id: String,
    pub parts: Vec<Part>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Artifact {
    pub fn new(id: impl Into<String>, name: impl Into<String>, parts: Vec<Part>) -> Self {
        Self {
            artifact_id: id.into(),
            parts,
            name: Some(name.into()),
            description: None,
        }
    }

    #[must_use]
    pub fn described(mut self, d: impl Into<String>) -> Self {
        self.description = Some(d.into());
        self
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<Message>,
    /// Seconds since the epoch. A2A wants ISO 8601 on the wire; nothing here is on a
    /// wire yet, and inventing a date library for a field no one reads would be worse.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
}

/// One run of one task. A2A's `Task`, which is wecode's *execution*, not its task.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    /// The wecode task, so every attempt at it shares a context.
    pub context_id: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub history: Vec<Message>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub artifacts: Vec<Artifact>,
}

impl Task {
    pub fn new(id: impl Into<String>, context: impl Into<String>, state: TaskState) -> Self {
        Self {
            id: id.into(),
            context_id: context.into(),
            status: TaskStatus {
                state,
                message: None,
                timestamp: None,
            },
            history: Vec::new(),
            artifacts: Vec::new(),
        }
    }

    #[must_use]
    pub fn with(mut self, m: Message) -> Self {
        self.history.push(m);
        self
    }

    #[must_use]
    pub fn producing(mut self, a: Artifact) -> Self {
        self.artifacts.push(a);
        self
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_names_are_the_protocols_own() {
        // Not ours to choose. If these drift, a bridge stops being a mapping.
        let cases = [
            (TaskState::Submitted, "submitted"),
            (TaskState::Working, "working"),
            (TaskState::InputRequired, "input-required"),
            (TaskState::AuthRequired, "auth-required"),
            (TaskState::Completed, "completed"),
            (TaskState::Failed, "failed"),
            (TaskState::Canceled, "canceled"),
            (TaskState::Rejected, "rejected"),
        ];
        for (state, name) in cases {
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{name}\"")
            );
        }
    }

    #[test]
    fn every_execution_status_maps_to_a_state_with_the_same_name() {
        // The mapping is identity, which is the point: wecode adopted A2A's vocabulary
        // rather than translating into it.
        for s in ExecutionStatus::all() {
            let mapped = TaskState::from(*s);
            let json = serde_json::to_string(&mapped).unwrap();
            assert_eq!(json, format!("\"{}\"", s.as_str()), "{s:?}");
        }
    }

    #[test]
    fn a_part_serialises_with_the_kind_discriminator() {
        let t = serde_json::to_value(Part::text("hello")).unwrap();
        assert_eq!(t["kind"], "text");
        assert_eq!(t["text"], "hello");

        let d = serde_json::to_value(Part::data(serde_json::json!({"a": 1}))).unwrap();
        assert_eq!(d["kind"], "data");
        assert_eq!(d["data"]["a"], 1);
    }

    #[test]
    fn a_message_uses_camel_case_on_the_wire() {
        let m = Message::to_agent("m-1", vec![Part::text("do the thing")]).about("t-1", "e-1");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["messageId"], "m-1");
        assert_eq!(v["contextId"], "t-1");
        assert_eq!(v["taskId"], "e-1");
        assert_eq!(v["role"], "user");
    }

    #[test]
    fn absent_fields_are_omitted_rather_than_null() {
        let m = Message::to_agent("m-1", vec![]);
        let s = serde_json::to_string(&m).unwrap();
        assert!(!s.contains("contextId"), "{s}");
        assert!(!s.contains("null"), "{s}");
    }

    #[test]
    fn a_task_round_trips_through_json() {
        let t = Task::new("e-1", "fix-it", TaskState::Rejected)
            .with(Message::to_agent("m-1", vec![Part::text("instruction")]))
            .producing(Artifact::new("a-1", "diff", vec![Part::text("--- a/x")]));
        let back: Task = serde_json::from_str(&t.to_json()).unwrap();
        assert_eq!(back, t);
    }

    #[test]
    fn only_text_parts_reach_a_cli_agent() {
        // A coding CLI takes a string. Structured parts are for something that can
        // read them, and must not leak into the prompt as JSON noise.
        let m = Message::to_agent(
            "m",
            vec![
                Part::text("first"),
                Part::data(serde_json::json!({"hidden": true})),
                Part::text("second"),
            ],
        );
        assert_eq!(m.as_text(), "first\n\nsecond");
    }

    #[test]
    fn a_foreign_state_we_do_not_produce_still_deserialises() {
        let s: TaskState = serde_json::from_str("\"unknown\"").unwrap();
        assert_eq!(s, TaskState::Unknown);
    }
}
