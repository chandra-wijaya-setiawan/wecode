//! What a worker is told, assembled from what wecode observed.
//!
//! Nothing here is passed along by the agent that produced it. Posts do not talk to
//! each other and an agent's account of its own work is inadmissible, so the handoff is
//! read out of git, the working tree and the execution record instead: what the tree
//! looks like, what came before this task, and what this task tried last time.
//!
//! The first of those is the same idea applied to the repository rather than to the
//! work. An agent that has to run `find` and `wc -l` before it can start is being asked
//! to rediscover something wecode is standing in — see [`crate::map`].
//!
//! A2A is the model rather than a serialisation of one. The instruction *is* a
//! message, everything the worker is given to read *is* an artifact, and the prompt a
//! coding CLI receives is one rendering of them — which is why a remote agent's JSON
//! and the text on argv cannot drift apart. They are two readings of one record.

use std::path::Path;

use wecode_a2a as a2a;
use wecode_core::{Plan, Project, Task, TaskKind};

use crate::{git, work};

/// Enough of a diff to work from; not so much that it crowds out the instruction.
const DIFF_CAP: usize = 4000;

/// Enough of a design to work from. Four times `DIFF_CAP`, because the two are read
/// differently: a diff is scanned for what moved, while a design *is* the decision, and
/// the part an implementer needs most — what it costs, what it makes harder, what in the
/// tree it reverses — is written last. A diff-sized cap would cut exactly that.
const DOC_CAP: usize = 16000;

/// The conventional home of a design's document, used when the task declared no
/// concrete path of its own. `playbook init` writes it, the starter guidance names it,
/// and it is the directory the merge report lands in.
fn conventional_design_path(t: &Task) -> String {
    format!("docs/wecode/{}/design.md", t.id)
}

/// Where a design's document might be, according to the task itself.
///
/// Taken from the declared write scope, because that is the one place a task states
/// where it wrote. The convention is `docs/wecode/<task>/design.md`, but a playbook that
/// templates its steps names its own — `write = ["src/design/{{task}}.md"]` is no less
/// right — and a handoff that only knew the convention would hand nothing over there.
///
/// Globs are dropped. `docs/**` names a directory, not a document, and choosing a file
/// out of it would be a second convention nobody declared; the fallback is at least one
/// the playbook starter wrote down.
fn design_paths(t: &Task) -> Vec<String> {
    let declared: Vec<String> = t
        .scope
        .write
        .iter()
        .filter(|w| w.ends_with(".md") && !w.contains(['*', '?', '[']))
        .cloned()
        .collect();
    if declared.is_empty() {
        vec![conventional_design_path(t)]
    } else {
        declared
    }
}

/// A design predecessor's document — the path it sits at, and its text.
///
/// Three places, because a design is the one kind that asks for no worktree and so
/// writes wherever the operator is standing: the predecessor's own tree if it had one,
/// then this task's, then the project's checkout. Whichever answers first is the copy
/// handed over; when it is the reader's own tree, the path printed above the text is one
/// they can open.
fn design_document(t: &Task, roots: [&Path; 3]) -> Option<(String, String)> {
    design_paths(t).into_iter().find_map(|rel| {
        roots
            .iter()
            .find_map(|root| std::fs::read_to_string(root.join(&rel)).ok())
            .map(|text| (rel, text))
    })
}

/// `s`, cut to `max` bytes and told how much was cut — the same shape `commit_summary`
/// uses, so a truncated document and a truncated diff read alike.
fn capped(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… truncated, {} bytes in full", &s[..end], s.len())
}

/// The commits a predecessor made in its own tree, with the first one's diff.
fn commit_body(t: &Task, their_tree: &Path) -> String {
    let mut body = String::new();
    match git::attempts_on(their_tree) {
        Ok(commits) => {
            let mine: Vec<&(String, String)> = commits
                .iter()
                .filter(|(_, subject)| subject.starts_with(&format!("{}: ", t.id)))
                .collect();
            if mine.is_empty() {
                body.push_str("  (no commits in this worktree)\n");
            }
            for (sha, subject) in mine.iter().take(1) {
                body.push_str(&format!("  {sha}  {subject}\n"));
                if let Ok((files, diff)) = git::commit_summary(their_tree, sha, DIFF_CAP) {
                    for f in &files {
                        body.push_str(&format!("    {f}\n"));
                    }
                    body.push_str(&indent_block(&diff));
                }
            }
        }
        Err(_) => body.push_str("  (not a worktree — no diff to show)\n"),
    }
    body
}

/// What one predecessor produced, in the form its kind produced it.
///
/// A design is handed over as its **document**, every other kind as its diff. The two
/// are not the same question. A diff of a design says what changed since the last draft;
/// the decision itself is the whole file, and it is what the next task builds against.
/// Worse, a design asks for no worktree and so is never committed by wecode: the kind
/// the gate exists to protect was the one whose handoff read `(no commits in this
/// worktree)` and stopped there, so the implementer was told a signed design produced
/// nothing at all.
fn predecessor_body(t: &Task, their_tree: &Path, cwd: &Path, repo: &Path) -> String {
    if t.kind != TaskKind::Design {
        return commit_body(t, their_tree);
    }
    match design_document(t, [their_tree, cwd, repo]) {
        Some((path, text)) => format!("  {path}\n{}", indent_block(&capped(&text, DOC_CAP))),
        // Where it was looked for, rather than only that nothing was found. A reader
        // told just `(no commits)` concludes the design produced nothing; what actually
        // happened is that its document is somewhere this process cannot see, and the
        // path is what makes it findable.
        None => format!(
            "  (no design document at {} — read it before starting)\n{}",
            design_paths(t).join(", "),
            commit_body(t, their_tree)
        ),
    }
}

/// What predecessors produced, as A2A artifacts.
///
/// Artifacts rather than prose because that is what they are — the output of a run
/// that already happened. Modelling them as such is what lets the same handoff reach a
/// remote agent as JSON without being rewritten for it.
fn predecessor_artifacts(task: &Task, plan: &Plan, cwd: &Path, repo: &Path) -> Vec<a2a::Artifact> {
    task.depends_on
        .iter()
        .filter_map(|d| plan.task(d))
        // Unfinished work is not context, it is a blocker — and the task would not be
        // running if it had any.
        .filter(|t| t.status.is_done())
        .map(|t| {
            // A predecessor may have worked in its own worktree — worktrees are per
            // main task, and two sibling tasks are two trees. They sit beside each
            // other under the run root, so the sibling path is where its commits are.
            //
            // Reading them is not the same as *having* them: this task's branch was
            // cut from the base, so the predecessor's changes are visible here but not
            // present. See `branch-from-predecessor`.
            let their_tree = work::owner(plan, &t.id)
                .map(|o| cwd.with_file_name(o.id.as_str()))
                .filter(|d| d.is_dir())
                .unwrap_or_else(|| cwd.to_path_buf());
            let body = predecessor_body(t, &their_tree, cwd, repo);
            a2a::Artifact::new(t.id.as_str(), t.id.as_str(), vec![a2a::Part::text(body)])
                .described(t.title.clone())
        })
        .collect()
}

/// The shape of the tree this task will work in, as an artifact.
///
/// An artifact like the rest, so the JSON record carries it too. It is not the output of
/// a run — nothing produced it, it is simply what is there — but it is one of the things
/// the worker is given to read, and the record of an instruction that leaves out half of
/// what the instruction said is not a record of it.
///
/// `None` when there is nothing to map, which is a tree that is not a git checkout or is
/// empty. A heading over "could not read the repository" would be an apology; the agent
/// can look for itself, which is what it would have done anyway.
fn repo_map_artifact(task: &Task, cwd: &Path) -> Option<a2a::Artifact> {
    let body = crate::map::of(cwd, &task.scope.write)?;
    Some(
        a2a::Artifact::new("repo-map", "repo map", vec![a2a::Part::text(body)])
            .described("the tree as git tracked it when this attempt was prepared"),
    )
}

/// The text of a map artifact — the one part it has.
///
/// Read back out of the artifact rather than kept beside it, so the prompt and the JSON
/// cannot come from two different strings.
fn map_body(a: &a2a::Artifact) -> String {
    a.parts
        .iter()
        .find_map(|p| match p {
            a2a::Part::Text { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

/// What this task tried last time — the artifacts of its own earlier executions.
///
/// Empty on a first attempt, which is the common case and should read as such rather
/// than as a heading with nothing under it.
///
/// An attempt nobody dispatched belongs here too, and its artifact is empty on purpose:
/// there is no commit under `<task>: attempt N` because there was no process to make
/// one. What the next worker needs is the description, and [`crate::usage::account`]
/// puts the attestor in it — *a person worked on this and here is what they say they
/// did* is a different fact from *a run produced this diff*, and an agent reading a
/// blank body under an unqualified `completed` would take it for the second.
fn attempt_artifacts(
    task: &Task,
    runs: &[wecode_store::Execution],
    cwd: &std::path::Path,
) -> Vec<a2a::Artifact> {
    let commits = git::attempts_on(cwd).unwrap_or_default();
    runs.iter()
        .filter(|r| r.status.is_finished())
        .rev()
        .take(2)
        .map(|r| {
            let mut body = String::new();
            let wanted = format!("{}: attempt {}", task.id, r.attempt);
            if let Some((sha, _)) = commits.iter().find(|(_, s)| s == &wanted)
                && let Ok((files, diff)) = git::commit_summary(cwd, sha, DIFF_CAP)
            {
                for f in &files {
                    body.push_str(&format!("  {f}\n"));
                }
                body.push_str(&indent_block(&diff));
            }
            a2a::Artifact::new(
                format!("{}-attempt-{}", task.id, r.attempt),
                format!("attempt {}", r.attempt),
                vec![a2a::Part::text(body)],
            )
            .described(format!("{} ({})", r.status.as_str(), crate::usage::account(r)))
        })
        .collect()
}

fn indent_block(s: &str) -> String {
    s.lines()
        .map(|l| format!("    {l}\n"))
        .collect::<Vec<_>>()
        .concat()
}

/// One attempt at one task, as the protocol models it.
///
/// Everything the worker is told is **assembled here from what wecode observed**,
/// never passed along by the agent that produced it. Posts do not talk to each other,
/// and an agent's account of its own work is inadmissible — so the handoff is read out
/// of git, the working tree and the execution record instead. Three payloads, answering
/// different questions:
///
/// - **what the tree is**, from the index, because an agent that begins by listing a
///   repository is spending a budget on an answer wecode is standing in
///
/// - **what came before you**, following `depends_on`, because that relation already
///   means "must come after" and is therefore exactly the edge a handoff travels —
///   as a diff, or as the document itself when what came before was a design
/// - **what you tried last time**, from this task's own earlier commits, because a
///   retry that cannot see its previous failure just repeats it
///
/// A2A's `Task` is wecode's *execution*: the state is `submitted` because nothing has
/// been spawned yet. The instruction is a message, and everything the worker is given
/// to read is an artifact — so the CLI prompt below and a remote agent's JSON are two
/// renderings of one record rather than two formats to keep in step.
///
/// `cwd` is where this task will work; `repo` is the project's own checkout, which is
/// the same directory when the playbook asks for no worktree and a different one when it
/// does. Both are needed because a design predecessor wrote in the second while this
/// task reads from the first.
#[must_use]
pub(crate) fn a2a_task(
    template: &str,
    task: &Task,
    project: &Project,
    plan: &Plan,
    cwd: &Path,
    repo: &Path,
    runs: &[wecode_store::Execution],
) -> a2a::Task {
    let acceptance: Vec<String> = task.acceptance.iter().map(|m| m.describe()).collect();
    let acceptance_text = if acceptance.is_empty() {
        "(none declared)".to_string()
    } else {
        acceptance
            .iter()
            .map(|m| format!("- {m}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let write_scope = if task.scope.write.is_empty() {
        "nothing — this task changes no files".to_string()
    } else {
        task.scope.write.join(", ")
    };

    let context = predecessor_artifacts(task, plan, cwd, repo);
    let attempts = attempt_artifacts(task, runs, cwd);
    let shape = repo_map_artifact(task, cwd);
    let attempt = runs.iter().map(|r| r.attempt).max().unwrap_or(0) + 1;

    let context_text = if context.is_empty() {
        "(nothing came before this task)\n".to_string()
    } else {
        a2a::render::artifacts(&context)
    };

    // Appended when the template has no `{{context}}`. A project whose envelope omits
    // the placeholder would otherwise lose the handoff without saying so, and what a
    // predecessor produced is not optional detail.
    let orphaned_context = if template.contains("{{context}}") || context.is_empty() {
        String::new()
    } else {
        format!("\n\nCONTEXT FROM COMPLETED WORK\n{context_text}")
    };

    let map_text = shape.as_ref().map(map_body).unwrap_or_default();

    // The same arrangement as the context above, and for the same reason: a template
    // that names the slot decides where the map goes, and one that does not still gets
    // it. Unlike the context it is appended *before* the previous attempts — what the
    // tree is now comes before what an earlier run did to it.
    let orphaned_map = if template.contains("{{repo_map}}") || map_text.is_empty() {
        String::new()
    } else {
        format!("\n\nREPO MAP\n{map_text}")
    };

    let filled = template
        .replace("{{task_id}}", task.id.as_str())
        .replace("{{project_id}}", project.id.as_str())
        .replace("{{objective}}", &project.objective)
        .replace("{{title}}", &task.title)
        .replace("{{acceptance}}", &acceptance_text)
        .replace("{{write_scope}}", &write_scope)
        .replace("{{context}}", &context_text)
        .replace("{{repo_map}}", &map_text);

    let prior = if attempts.is_empty() {
        String::new()
    } else {
        format!(
            "\nYOUR PREVIOUS ATTEMPTS\n{}Do not repeat what failed. Read the diff above before changing anything.\n",
            a2a::render::artifacts(&attempts)
        )
    };

    let text = if filled.trim().is_empty() {
        format!(
            "  no task_envelope in company.toml — nothing to hand to the worker\n  work in {}\n",
            cwd.display()
        )
    } else {
        format!(
            "{}{}{}{}\nWorking directory: {}\n",
            filled.trim(),
            orphaned_context,
            orphaned_map,
            prior,
            cwd.display()
        )
    };

    // The structured half of the instruction. A coding CLI never sees it — only text
    // parts render — but anything that can parse gets the acceptance and the scope
    // without scraping them back out of the prose.
    let spec = serde_json::json!({
        "taskId": task.id.as_str(),
        "projectId": project.id.as_str(),
        "kind": task.kind.as_str(),
        "attempt": attempt,
        "acceptance": acceptance,
        "writeScope": task.scope.write,
        "workingDirectory": cwd.display().to_string(),
    });

    let execution = format!("{}-attempt-{attempt}", task.id);
    let message = a2a::Message::to_agent(
        format!("{execution}-instruction"),
        vec![a2a::Part::text(text), a2a::Part::data(spec)],
    )
    .about(task.id.as_str(), execution.clone());

    let mut out = a2a::Task::new(execution, task.id.as_str(), a2a::TaskState::Submitted);
    out.history.push(message);
    // The map first: it is the tree as it stands, and everything after it is something
    // that already happened to that tree.
    out.artifacts = shape.into_iter().chain(context).chain(attempts).collect();
    out
}

/// The prompt a coding CLI receives: the text of the instruction, nothing else.
///
/// The structured parts stay in the record. Handing a CLI agent a JSON blob on argv
/// would put it in the instruction, where it reads as noise.
#[must_use]
pub(crate) fn envelope(t: &a2a::Task) -> String {
    t.history
        .first()
        .map(a2a::Message::as_text)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wecode_core::Scope;

    fn a_design(scope: &[&str]) -> Task {
        Task::new("keys", "export", "decide the cache key format")
            .of_kind(TaskKind::Design)
            .scoped(Scope::write(scope))
    }

    #[test]
    fn a_designs_document_is_looked_for_where_the_task_says_it_wrote() {
        // A playbook that templates its steps names its own path, so the convention is
        // a fallback rather than the answer.
        assert_eq!(
            design_paths(&a_design(&["src/design/keys.md"])),
            vec!["src/design/keys.md".to_string()]
        );
    }

    #[test]
    fn a_glob_scope_falls_back_to_the_conventional_path() {
        // `docs/**` names a directory. Picking a file out of it would invent a second
        // convention; the starter already wrote one down.
        for scope in [vec!["docs/**"], vec!["docs/wecode/*/design.md"], vec![]] {
            assert_eq!(
                design_paths(&a_design(&scope)),
                vec!["docs/wecode/keys/design.md".to_string()],
                "{scope:?}"
            );
        }
    }

    #[test]
    fn a_scope_that_names_code_is_not_mistaken_for_the_document() {
        let t = a_design(&["src/keys.rs", "notes/keys.md"]);
        assert_eq!(design_paths(&t), vec!["notes/keys.md".to_string()]);
    }

    #[test]
    fn a_document_too_long_to_hand_over_whole_says_what_it_cut() {
        let doc = "x".repeat(50);
        assert_eq!(capped(&doc, 50), doc);
        let cut = capped(&doc, 20);
        assert!(cut.starts_with(&"x".repeat(20)), "{cut}");
        assert!(cut.contains("truncated, 50 bytes in full"), "{cut}");
    }

    #[test]
    fn cutting_a_document_never_splits_a_character() {
        // Designs are prose, and prose has em dashes in it. Slicing mid-character
        // would panic on the one handoff big enough to need cutting.
        let doc = "—".repeat(10);
        let cut = capped(&doc, 10);
        assert!(cut.starts_with("———"), "{cut}");
        assert!(cut.contains("truncated, 30 bytes in full"), "{cut}");
    }

    #[test]
    fn a_missing_design_document_names_the_path_it_is_missing_from() {
        // Not "(no commits)": a signed design that produced nothing is a different and
        // much more alarming fact than one this process could not find.
        let nowhere = Path::new("/nonexistent-for-this-test");
        let body = predecessor_body(&a_design(&["docs/keys.md"]), nowhere, nowhere, nowhere);
        assert!(
            body.contains("no design document at docs/keys.md"),
            "{body}"
        );
    }
}
