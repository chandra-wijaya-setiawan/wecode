//! `[project.components]`: the parts this repository is built out of, by name.
//!
//! A component is a name for a set of paths — `store`, `gate`, `cli` — and the one
//! thing in this file that gives a glob a meaning. Everything wecode governs is
//! addressed by path glob (see `docs/design/sdlc.md`), and a glob says where a task
//! may write without saying what it *is*: `crates/wecode-store/**` is the store to
//! whoever laid the tree out and four segments of punctuation to everybody else.
//!
//! So a scope may name one instead: `write = ["@store"]` is the store's paths, read
//! out of the table below. The name is resolved while the playbook is read, and what
//! comes out is the paths — which is what keeps this a naming convenience rather than
//! a new kind of authority. Nothing downstream has to learn the word: assignment, the
//! envelope, verification and the admission gate all see the globs they always saw.
//!
//! Resolution is one level deep on purpose. A component names paths and never another
//! component, so a scope in a playbook can be read by following exactly one table.

use std::collections::BTreeMap;

use super::PlaybookError;

/// One named part of the architecture, and the paths it owns.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Component {
    /// Written without the sigil: `store`, referred to as `@store`.
    pub name: String,
    /// At least one — a component that claims nothing is refused at load.
    pub paths: Vec<String>,
}

impl Component {
    /// What a scope entry begins with when it names a component rather than a glob.
    ///
    /// A path may not begin with one, so nothing legal is ambiguous — and a scope entry
    /// is either a glob or a name, never a glob that happens to hold a name.
    pub const SIGIL: char = '@';

    /// The component a scope entry names, or `None` where it is an ordinary glob.
    ///
    /// On the type rather than beside it because the sigil is one rule and belongs in
    /// one place: whatever reads a scope entry and wants to know which of the two it
    /// has asks here.
    #[must_use]
    pub fn named(entry: &str) -> Option<&str> {
        entry.strip_prefix(Self::SIGIL)
    }
}

/// Every component the project declares, in name order.
///
/// The two things refused are the two that would be read as something else. A name
/// written with the sigil is the reference form typed into the declaration, and would
/// then be unreachable under either spelling. A component with no paths is worse than
/// unreachable: a step whose `write` resolved to nothing does not fail, it silently
/// [inherits the main task's scope][super::Subtask::scope_under] — the widest answer,
/// arrived at by the narrowest-looking line in the file.
pub(super) fn components_of(
    table: &BTreeMap<String, Vec<String>>,
) -> Result<Vec<Component>, PlaybookError> {
    let mut out = Vec::with_capacity(table.len());
    for (name, paths) in table {
        let bad = |why: &str| {
            Err(PlaybookError::BadComponent {
                name: name.clone(),
                why: why.to_string(),
            })
        };
        if name.trim().is_empty() || name.starts_with(Component::SIGIL) {
            return bad("a component is named without the `@` — that is how a scope refers to it");
        }
        if paths.is_empty() {
            return bad(
                "names no paths: a scope naming it would resolve to nothing, and a subtask \
                 with no write scope inherits its main task's instead",
            );
        }
        if let Some(p) = paths.iter().find(|p| Component::named(p).is_some()) {
            return bad(&format!(
                "{p:?} names another component — a component owns paths, so a scope is one \
                 table away from the files it means"
            ));
        }
        out.push(Component {
            name: name.clone(),
            paths: paths.clone(),
        });
    }
    Ok(out)
}

/// A scope with every component reference replaced by the paths it stands for.
///
/// A name the project does not declare is refused where it is written, naming the ones
/// it does: this is a typo, and a typo found while the file is being read costs one
/// edit. Left to resolve as a literal glob it would match no file, and a scope matching
/// nothing is a task that cannot write — reported at verification, once the budget is
/// spent.
///
/// Repeats collapse. A step naming `@store` beside a path the store already owns has
/// stated one thing twice, and the admission gate would otherwise report the overlap
/// against the task's own scope.
pub(super) fn resolve(
    at: &str,
    entries: &[String],
    comps: &[Component],
) -> Result<Vec<String>, PlaybookError> {
    let mut out: Vec<String> = Vec::with_capacity(entries.len());
    let mut push = |p: &String| {
        if !out.contains(p) {
            out.push(p.clone());
        }
    };
    for entry in entries {
        match Component::named(entry) {
            None => push(entry),
            Some(name) => {
                let c = comps.iter().find(|c| c.name == name).ok_or_else(|| {
                    PlaybookError::ComponentUnknown {
                        at: at.to_string(),
                        named: name.to_string(),
                        known: comps
                            .iter()
                            .map(|c| format!("@{}", c.name))
                            .collect::<Vec<_>>()
                            .join(", "),
                    }
                })?;
                c.paths.iter().for_each(&mut push);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playbook::Playbook;
    use wecode_core::TaskKind;

    /// A project that has said what its parts are, and a step scoped by one of them.
    const NAMED: &str = r#"
[project.components]
store = ["crates/store/**", "migrations/**"]
gate  = ["crates/core/src/admission.rs"]

[feature]
subtasks = ["design", "build"]

[feature.design]
write = ["docs/{{task}}.md"]

[feature.build]
after = ["design"]
write = ["@store", "@gate"]
read  = ["@gate"]
"#;

    fn step<'a>(p: &'a Playbook, name: &str) -> &'a super::super::SubtaskTemplate {
        p.for_kind(TaskKind::Feature)
            .unwrap()
            .subtasks
            .iter()
            .find(|s| s.name == name)
            .unwrap()
    }

    #[test]
    fn a_scope_that_names_a_component_holds_that_components_paths() {
        let p = Playbook::parse(NAMED).unwrap();
        let build = step(&p, "build");
        // In the order the scope named them, each component's own paths in file order:
        // a scope reads back as the line somebody wrote, expanded in place.
        assert_eq!(
            build.write,
            vec![
                "crates/store/**".to_string(),
                "migrations/**".to_string(),
                "crates/core/src/admission.rs".to_string(),
            ]
        );
        // Both sides, because both are scopes.
        assert_eq!(build.read, vec!["crates/core/src/admission.rs".to_string()]);
        // And the table itself is carried, in name order, for whoever wants the word.
        let comps = &p.project.components;
        assert_eq!(comps.len(), 2);
        assert_eq!(comps[0].name, "gate");
    }

    #[test]
    fn a_glob_is_still_a_glob() {
        // The control, and the compatibility promise: every playbook written before
        // components existed resolves to exactly the paths it states.
        let p = Playbook::parse(NAMED).unwrap();
        // Placeholders are filled at expansion, so resolution must leave them alone.
        assert_eq!(
            step(&p, "design").write,
            vec!["docs/{{task}}.md".to_string()]
        );
    }

    #[test]
    fn a_component_no_one_declared_is_refused_where_it_was_written() {
        let msg = Playbook::parse(
            "[project.components]\nstore = [\"crates/store/**\"]\n\n\
             [feature]\nsubtasks = [\"build\"]\n\n[feature.build]\nwrite = [\"@stroe\"]\n",
        )
        .unwrap_err()
        .to_string();
        assert!(msg.contains("stroe"), "{msg}");
        assert!(
            msg.contains("[feature.build] write"),
            "the line to fix: {msg}"
        );
        assert!(
            msg.contains("@store"),
            "should list what it does declare: {msg}"
        );
    }

    #[test]
    fn a_project_with_no_table_at_all_says_so_rather_than_naming_nothing() {
        // The message a project gets when it uses the syntax before it has the table,
        // which is the likelier mistake than a misspelling.
        let msg =
            Playbook::parse("[bug]\nsubtasks = [\"fix\"]\n\n[bug.fix]\nwrite = [\"@store\"]\n")
                .unwrap_err()
                .to_string();
        assert!(msg.contains("declares no components"), "{msg}");
    }

    #[test]
    fn a_component_that_claims_nothing_is_refused() {
        // Not a harmless empty line: the step that named it would inherit the main
        // task's whole write scope, which is the opposite of what it says.
        let msg = Playbook::parse("[project.components]\nstore = []\n")
            .unwrap_err()
            .to_string();
        assert!(msg.contains("store"), "{msg}");
        assert!(msg.contains("names no paths"), "{msg}");
    }

    #[test]
    fn a_component_declared_with_the_sigil_is_refused() {
        let msg = Playbook::parse("[project.components]\n\"@store\" = [\"crates/store/**\"]\n")
            .unwrap_err()
            .to_string();
        assert!(msg.contains("without the `@`"), "{msg}");
    }

    #[test]
    fn a_component_naming_another_component_is_refused() {
        let msg = Playbook::parse(
            "[project.components]\nstore = [\"crates/store/**\"]\nall = [\"@store\"]\n",
        )
        .unwrap_err()
        .to_string();
        assert!(msg.contains("names another component"), "{msg}");
    }

    #[test]
    fn a_scope_that_names_a_component_and_one_of_its_paths_states_it_once() {
        let p = Playbook::parse(
            "[project.components]\nstore = [\"crates/store/**\"]\n\n\
             [bug]\nsubtasks = [\"fix\"]\n\n\
             [bug.fix]\nwrite = [\"crates/store/**\", \"@store\"]\n",
        )
        .unwrap();
        assert_eq!(
            p.for_kind(TaskKind::Bug).unwrap().subtasks[0].write,
            vec!["crates/store/**".to_string()]
        );
    }

    #[test]
    fn the_sigil_is_read_in_one_place() {
        assert_eq!(Component::named("@store"), Some("store"));
        assert_eq!(Component::named("crates/store/**"), None);
        // A bare sigil names the empty component, which no table can declare — so it
        // arrives as the unknown-component question rather than as a silent glob.
        assert_eq!(Component::named("@"), Some(""));
    }
}
