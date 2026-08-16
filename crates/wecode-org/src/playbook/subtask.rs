//! `[feature.design]`, `[feature.build]` …: how one kind of work breaks down.
//!
//! A sub-table per step, named by the list in the kind above it — order lives in that
//! list because a TOML table has none. A template states what makes its step
//! *different*; everything it leaves unset falls through to the playbook for the step's
//! own kind, exactly as a hand-written task of that kind would.
//!
//! Scope is the one thing that falls through somewhere else: to the main task being
//! expanded, by [`Subtask::scope_under`]. The playbook has no scope to give — a kind
//! block says nothing about paths — so a step that named none would otherwise be
//! refused for having no scope at all, and the only repair would be to restate the main
//! task's paths in every step of the template.
//!
//! Expansion is pure. It produces values and schedules nothing: the tasks it describes
//! still face the admission gate, and may be edited or dropped before anything runs.

use std::collections::BTreeMap;

use serde::Deserialize;
use wecode_core::{Scope, TaskKind};

use super::PlaybookError;
use super::kind::KindPlaybook;

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
struct SubtaskBlock {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    after: Vec<String>,
    #[serde(default)]
    write: Vec<String>,
    #[serde(default)]
    read: Vec<String>,
    #[serde(default)]
    accept: Vec<String>,
    #[serde(default)]
    assign_to: Option<String>,
    #[serde(default)]
    tokens: Option<u64>,
    #[serde(default)]
    wall_secs: Option<u64>,
}

/// One subtask a kind declares, before it is resolved against a main task.
///
/// Everything left unset falls through to the playbook for the subtask's *own* kind,
/// exactly as a hand-written task of that kind would. So a template states what makes
/// this step different, and nothing else.
#[derive(Clone, PartialEq, Eq, Default, Debug)]
pub struct SubtaskTemplate {
    /// The suffix: the emitted task is `<main task id>-<name>`.
    pub name: String,
    /// Defaults to the kind being expanded — a template names it only when the step
    /// is a different sort of work, as a `design` step of a `feature` is.
    pub kind: Option<TaskKind>,
    /// May use the placeholders. Without one the title is derived from the main
    /// task's, which has already cleared the gate.
    pub title: Option<String>,
    /// Sibling names, resolved to task ids at expansion. Siblings only: a template
    /// cannot know the ids of tasks outside the expansion it belongs to.
    pub after: Vec<String>,
    pub write: Vec<String>,
    pub read: Vec<String>,
    pub accept: Vec<String>,
    pub assign_to: Option<String>,
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
}

/// A subtask template resolved against one main task: ids, not names, and every
/// placeholder filled.
///
/// `write` and `read` are still only what the template said. What the step actually
/// runs under is [`Subtask::scope_under`], because the rest of the answer belongs to
/// the main task rather than to the playbook.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Subtask {
    pub id: String,
    pub kind: TaskKind,
    pub title: String,
    /// Task ids, already prefixed.
    pub after: Vec<String>,
    pub write: Vec<String>,
    pub read: Vec<String>,
    pub accept: Vec<String>,
    pub assign_to: Option<String>,
    pub tokens: Option<u64>,
    pub wall_secs: Option<u64>,
}

impl Subtask {
    /// Whether this step writes where the main task said it may, rather than somewhere
    /// of its own.
    ///
    /// A spike is excluded even when it names nothing, because it is the one kind
    /// admitted without a write scope: it answers a question. Handing it the paths the
    /// main task may change would grant an exploration the right to rewrite them, which
    /// no one asked for and nothing on screen would say.
    #[must_use]
    pub fn inherits_write(&self) -> bool {
        self.write.is_empty() && self.kind.requires_write_scope()
    }

    /// The scope this step runs under: what it named, and the main task's where it
    /// named nothing.
    ///
    /// Per side, not all-or-nothing. A step that narrows the reading and leaves the
    /// writing alone is stating one difference, and should not lose the other — the
    /// same reason every other field here falls through on its own.
    ///
    /// Inheriting is all this does. Two steps that both inherit and are not ordered by
    /// `after` claim the same paths at the same time, and the admission gate refuses
    /// them for it; sequencing them here would be the template writing itself an
    /// ordering nobody declared.
    #[must_use]
    pub fn scope_under(&self, main: &Scope) -> Scope {
        Scope {
            read: if self.read.is_empty() {
                main.read.clone()
            } else {
                self.read.clone()
            },
            write: if self.inherits_write() {
                main.write.clone()
            } else {
                self.write.clone()
            },
        }
    }
}

/// Reads a kind's sub-tables into templates, in the order `subtasks` declares.
///
/// Two more things are settled here rather than left to fail later, because both are
/// typos and a typo found at planning time costs nothing: a declared subtask with no
/// block, and an `after` that names no *earlier* sibling. The third — a block the list
/// does not declare — is refused one level up, where the field names are.
pub(super) fn templates_of(
    key: &str,
    declared: &[String],
    steps: &BTreeMap<String, toml::Value>,
) -> Result<Vec<SubtaskTemplate>, PlaybookError> {
    let at = format!("[{key}]");
    let mut out = Vec::with_capacity(declared.len());
    for name in declared {
        let value = steps
            .get(name)
            .ok_or_else(|| PlaybookError::SubtaskUndeclared {
                at: at.clone(),
                name: name.clone(),
            })?;
        let s: SubtaskBlock = value.clone().try_into()?;

        // Earlier, not merely a sibling: the emitted tasks are created in this order,
        // so a step ordered after a later one names a task that does not exist yet.
        for a in &s.after {
            if !out.iter().any(|e: &SubtaskTemplate| &e.name == a) {
                return Err(PlaybookError::SubtaskAfterUnknown {
                    at: format!("[{key}.{name}]"),
                    after: a.clone(),
                    earlier: out
                        .iter()
                        .map(|e: &SubtaskTemplate| e.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                });
            }
        }
        let kind = match &s.kind {
            None => None,
            Some(k) => Some(TaskKind::parse(k).ok_or_else(|| {
                PlaybookError::BadValue {
                    at: format!("[{key}.{name}] kind"),
                    value: k.clone(),
                    known: TaskKind::all()
                        .iter()
                        .map(|k| k.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                }
            })?),
        };
        out.push(SubtaskTemplate {
            name: name.clone(),
            kind,
            title: s.title,
            after: s.after,
            write: s.write,
            read: s.read,
            accept: s.accept,
            assign_to: s.assign_to,
            tokens: s.tokens,
            wall_secs: s.wall_secs,
        });
    }
    Ok(out)
}

/// The placeholders a template may use: the main task's id and its title.
///
/// Deliberately two. A template that could reach further into the plan would be a
/// small language, and this is a scaffold that runs once.
fn fill(text: &str, task: &str, title: &str) -> String {
    text.replace("{{task}}", task).replace("{{title}}", title)
}

impl KindPlaybook {
    /// What `--expand` would emit for a main task, in declared order.
    ///
    /// Pure. It produces values and schedules nothing — the tasks it describes still
    /// face the admission gate, and may be edited or dropped before anything runs.
    /// `parent_kind` is the kind being expanded, used for a step that names none.
    #[must_use]
    pub fn expand(&self, parent_kind: TaskKind, task: &str, title: &str) -> Vec<Subtask> {
        self.subtasks
            .iter()
            .map(|s| Subtask {
                id: format!("{task}-{}", s.name),
                kind: s.kind.unwrap_or(parent_kind),
                title: s
                    .title
                    .as_ref()
                    .map_or_else(|| format!("{}: {title}", s.name), |t| fill(t, task, title)),
                after: s.after.iter().map(|a| format!("{task}-{a}")).collect(),
                write: s.write.iter().map(|g| fill(g, task, title)).collect(),
                read: s.read.iter().map(|g| fill(g, task, title)).collect(),
                accept: s.accept.iter().map(|c| fill(c, task, title)).collect(),
                assign_to: s.assign_to.clone(),
                tokens: s.tokens,
                wall_secs: s.wall_secs,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playbook::{Playbook, SAMPLE, starter, with_the_template_live};

    const TEMPLATED: &str = r#"
[feature]
worktree  = true
assign_to = "impl"
accept    = ["cargo test --workspace"]
tokens    = 120000
wall_secs = 5400
subtasks  = ["design", "build", "docs"]

[feature.design]
kind   = "design"
title  = "decide how {{task}} should work"
write  = ["docs/wecode/{{task}}/design.md"]
accept = ["test -f docs/wecode/{{task}}/design.md"]

[feature.build]
after  = ["design"]
write  = ["src/**"]

[feature.docs]
after  = ["build"]
kind   = "docs"
write  = ["README.md"]
"#;

    #[test]
    fn a_template_expands_in_declared_order_with_the_placeholders_filled() {
        let p = Playbook::parse(TEMPLATED).unwrap();
        let k = p.for_kind(TaskKind::Feature).unwrap();
        let out = k.expand(TaskKind::Feature, "retry", "retry a failed task once");

        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["retry-design", "retry-build", "retry-docs"]);

        let design = &out[0];
        assert_eq!(design.kind, TaskKind::Design);
        assert_eq!(design.title, "decide how retry should work");
        assert_eq!(
            design.write,
            vec!["docs/wecode/retry/design.md".to_string()]
        );
        assert_eq!(
            design.accept,
            vec!["test -f docs/wecode/retry/design.md".to_string()]
        );
        // A sibling name becomes a task id — a template cannot know ids itself.
        assert_eq!(out[1].after, vec!["retry-design".to_string()]);
        assert_eq!(out[2].after, vec!["retry-build".to_string()]);
    }

    #[test]
    fn a_step_that_names_no_kind_is_the_kind_being_expanded() {
        let p = Playbook::parse(TEMPLATED).unwrap();
        let out = p.for_kind(TaskKind::Feature).unwrap().expand(
            TaskKind::Feature,
            "retry",
            "retry a failed task once",
        );
        assert_eq!(out[1].kind, TaskKind::Feature);
        assert_eq!(out[2].kind, TaskKind::Docs);
    }

    #[test]
    fn a_step_without_a_title_derives_one_from_the_main_task() {
        // The main task's title has already cleared the gate, so a prefix of it is
        // the cheapest title that will too. Inventing prose here would not.
        let p = Playbook::parse(TEMPLATED).unwrap();
        let out = p.for_kind(TaskKind::Feature).unwrap().expand(
            TaskKind::Feature,
            "retry",
            "retry a failed task once",
        );
        assert_eq!(out[1].title, "build: retry a failed task once");
    }

    #[test]
    fn a_template_states_only_what_differs() {
        // Everything unset is left unset here, so `task add` can fill it from the
        // playbook for the step's own kind — the same path a hand-written task takes.
        let p = Playbook::parse(TEMPLATED).unwrap();
        let out = p.for_kind(TaskKind::Feature).unwrap().expand(
            TaskKind::Feature,
            "retry",
            "retry a failed task once",
        );
        assert!(out[1].accept.is_empty());
        assert!(out[1].assign_to.is_none());
        assert_eq!(out[1].tokens, None);
    }

    /// A template that leaves scope to the main task: `build` names none at all, and
    /// `check` narrows only the reading.
    const SILENT: &str = r#"
[feature]
subtasks = ["design", "build", "check"]

[feature.design]
kind  = "design"
write = ["docs/wecode/{{task}}/design.md"]

[feature.build]
after = ["design"]

[feature.check]
after = ["build"]
read  = ["docs/**"]
"#;

    /// A step of the one kind that may be admitted with no write scope at all.
    const A_SPIKE: &str = r#"
[feature]
subtasks = ["look"]

[feature.look]
kind = "spike"
"#;

    /// What a main task of this shape declares: both sides set, so inheriting one
    /// side and not the other is visible.
    fn main_scope() -> Scope {
        Scope {
            read: vec!["crates/**".to_string()],
            write: vec!["crates/wecode-cli/**".to_string()],
        }
    }

    /// A playbook's feature steps, resolved against a main task called `retry`.
    fn steps_of(toml: &str) -> Vec<Subtask> {
        Playbook::parse(toml)
            .unwrap()
            .for_kind(TaskKind::Feature)
            .unwrap()
            .expand(TaskKind::Feature, "retry", "a title")
    }

    #[test]
    fn a_step_that_names_no_scope_writes_where_the_main_task_may() {
        // The playbook has no scope to give — a kind block says nothing about paths —
        // so without this the step is refused for having none, and the only repair is
        // to restate the main task's paths in every step of the template.
        let build = &steps_of(SILENT)[1];
        assert!(build.inherits_write());
        assert_eq!(build.scope_under(&main_scope()), main_scope());
    }

    #[test]
    fn a_step_that_names_its_own_scope_keeps_it() {
        let design = &steps_of(SILENT)[0];
        assert!(!design.inherits_write());
        assert_eq!(
            design.scope_under(&main_scope()).write,
            vec!["docs/wecode/retry/design.md".to_string()]
        );
    }

    #[test]
    fn each_side_of_the_scope_falls_through_on_its_own() {
        // `check` states one difference — what it reads — and should not lose the
        // other by having stated anything at all.
        let check = steps_of(SILENT)[2].scope_under(&main_scope());
        assert_eq!(check.read, vec!["docs/**".to_string()]);
        assert_eq!(check.write, main_scope().write);
    }

    #[test]
    fn a_spike_step_is_not_handed_the_paths_the_main_task_may_change() {
        // The one kind admitted without a write scope. Inheriting here would turn a
        // question into a licence to rewrite the answer.
        let look = &steps_of(A_SPIKE)[0];
        assert!(!look.inherits_write());
        assert!(look.scope_under(&main_scope()).write.is_empty());
        // Reading is not a licence to change anything, so it still falls through.
        assert_eq!(look.scope_under(&main_scope()).read, main_scope().read);
    }

    #[test]
    fn a_main_task_with_no_scope_passes_none_on() {
        // Nothing is invented: the step is left as bare as it was, and the admission
        // gate asks about it in the ordinary way.
        assert!(steps_of(SILENT)[1].scope_under(&Scope::default()).is_empty());
    }

    #[test]
    fn a_kind_with_no_subtasks_expands_to_nothing() {
        let p = Playbook::parse(SAMPLE).unwrap();
        let k = p.for_kind(TaskKind::Bug).unwrap();
        assert!(k.subtasks.is_empty());
        assert!(k.expand(TaskKind::Bug, "fix-it", "a title").is_empty());
    }

    #[test]
    fn a_declared_subtask_with_no_block_is_refused() {
        let err = Playbook::parse("[feature]\nsubtasks = [\"design\"]\n").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("design"), "{msg}");
        assert!(msg.contains("feature.design"), "{msg}");
    }

    #[test]
    fn a_block_the_list_does_not_declare_is_refused() {
        // Order lives in `subtasks`, so a block missing from it would silently never
        // be emitted — the same class of bug as a misspelled field.
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\"]\n\n[feature.build]\n\n[feature.tests]\nwrite = [\"tests/**\"]\n",
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("tests"), "{msg}");
    }

    #[test]
    fn an_after_that_names_no_sibling_is_refused() {
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\"]\n\n[feature.build]\nafter = [\"desgin\"]\n",
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("desgin"), "{msg}");
        assert!(msg.contains("feature.build"), "{msg}");
    }

    #[test]
    fn an_after_that_points_forward_is_refused() {
        // The tasks are created in the declared order, so ordering a step after a
        // later one names a task that does not exist yet — `NoSuchTask`, halfway
        // through creating an expansion, rather than a question about the playbook.
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\", \"design\"]\n\n[feature.build]\nafter = [\"design\"]\n\n[feature.design]\n",
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("earlier"), "{msg}");
    }

    #[test]
    fn a_step_kind_that_is_not_a_kind_is_refused() {
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\"]\n\n[feature.build]\nkind = \"buld\"\n",
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("buld"), "{msg}");
        assert!(msg.contains("refactor"), "should list the kinds: {msg}");
    }

    #[test]
    fn a_misspelled_field_inside_a_step_is_refused() {
        let err = Playbook::parse(
            "[feature]\nsubtasks = [\"build\"]\n\n[feature.build]\nwrites = [\"src/**\"]\n",
        )
        .unwrap_err();
        assert!(err.to_string().contains("writes"), "{err}");
    }

    #[test]
    fn the_build_step_is_scoped_to_what_this_toolchain_builds_from() {
        // Including the files a build rewrites. `src/**` was the old answer for every
        // language, and a task that touched the lock file was reported as reaching
        // outside its scope — after its budget was spent.
        let p = Playbook::parse(&with_the_template_live(&starter("rust", "app"))).unwrap();
        let build =
            &p.for_kind(TaskKind::Feature)
                .unwrap()
                .expand(TaskKind::Feature, "retry", "a title")[1];
        assert!(build.write.contains(&"crates/**".to_string()), "{build:?}");
        assert!(build.write.contains(&"Cargo.lock".to_string()), "{build:?}");
    }
}
