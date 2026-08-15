//! A project's guidance, and the gaps found in it.
//!
//! `wecode-org` reads a playbook out of a file a person wrote by hand, and what it
//! means is decided there. This is only how it is shown — with one rule of its own,
//! which is that a gap is never silent. A finding recorded against guidance nobody
//! reads again is a finding thrown away, so it is counted on the index and printed
//! under the kind it was filed against, after the prose: the guidance is what the
//! project decided, a gap is what it has since found out and not yet written down.

use std::path::Path;

use wecode_core::{Project, TaskKind};
use wecode_org::{Gap, Playbook};

use super::{ago, kind_tag};

fn header(project: &Project, pb: &Playbook) -> String {
    let lang = if pb.project.language.is_empty() {
        String::new()
    } else {
        format!(", {}", pb.project.language)
    };
    format!("  project   {}  [{}{}]\n", project.id, project.repo, lang)
}

/// Every kind this project has guidance for.
#[must_use]
pub(crate) fn all_kinds(project: &Project, pb: &Playbook, gaps: &[Gap]) -> String {
    let mut out = header(project, pb);
    if let Some(b) = &pb.project.merge_to {
        out.push_str(&format!("  branch    from {b}\n"));
    }
    // As written in the file, `~` and all. This is a view of the playbook; where that
    // path lands on this machine is what `wecode start` reports, in the notes beside
    // the worktree it belongs to.
    for c in &pb.project.build_cache {
        out.push_str(&format!("  cache     {} = {}\n", c.var, c.path));
    }
    if pb.is_empty() {
        out.push_str("\n  no kinds have guidance yet\n");
        return out;
    }
    out.push_str(&format!(
        "\n  {:<10} {:<9} {:<9} {}\n",
        "kind", "worktree", "assign", "accept"
    ));
    for (kind, k) in pb.kinds() {
        out.push_str(&format!(
            "  {:<10} {:<9} {:<9} {}\n",
            kind.as_str(),
            if k.worktree { "yes" } else { "no" },
            k.assign_to.as_deref().unwrap_or("—"),
            if k.accept.is_empty() {
                "—".to_string()
            } else {
                k.accept.join(", ")
            }
        ));
    }
    let templated: Vec<&str> = pb
        .kinds()
        .iter()
        .filter(|(_, k)| !k.subtasks.is_empty())
        .map(|(kind, _)| kind.as_str())
        .collect();
    if !templated.is_empty() {
        out.push_str(&format!(
            "\n  --expand emits subtasks for: {}\n",
            templated.join(", ")
        ));
    }
    let gated: Vec<&str> = pb
        .kinds()
        .iter()
        .filter(|(_, k)| k.design_required)
        .map(|(kind, _)| kind.as_str())
        .collect();
    if !gated.is_empty() {
        out.push_str(&format!(
            "\n  a design must stand before: {}\n",
            gated.join(", ")
        ));
    }
    out.push_str(&gap_count(gaps));
    out.push_str("\n  wecode playbook <kind>  for the guidance itself\n");
    out
}

/// What `playbook init` wrote, and what it decided while writing it.
///
/// Every decision the starter made on the project's behalf is reported here rather
/// than left in the file to be discovered: which language, where it was read from, the
/// commands that will judge every task, and the directory the worktrees will share.
/// These are the lines a person is expected to disagree with — a starter that stated
/// them only in TOML would be trusted by whoever never opened it.
///
/// `refusal` is the load-time check applied to what was just written. It is a warning
/// and not an error: the file is correct for the repository and wrong only for this
/// machine, and deleting it would be the wrong answer to that.
#[must_use]
pub(crate) fn written(
    project: &Project,
    w: &wecode_org::Written,
    refusal: Option<&str>,
) -> String {
    let mut out = format!("  wrote {}\n\n", w.path.display());

    match (&w.toolchain, w.detected_from) {
        (Some(t), Some(from)) => {
            out.push_str(&format!("  language  {} — read off {from}\n", t.name));
        }
        (Some(t), None) => out.push_str(&format!("  language  {}\n", t.name)),
        (None, _) => {
            let said = if w.language.is_empty() {
                "none given, and none could be read off the repo".to_string()
            } else {
                format!("{} — no toolchain here answers to it", w.language)
            };
            out.push_str(&format!(
                "  language  {said}\n            accept is empty and every guidance is TODO; \
                 wecode knows {}\n",
                wecode_org::toolchain::known()
            ));
        }
    }
    if let Some(t) = w.toolchain {
        for (i, cmd) in t.accept.iter().enumerate() {
            out.push_str(&format!(
                "  {:<9} {cmd}\n",
                if i == 0 { "accept" } else { "" }
            ));
        }
        for (i, (var, dir)) in w.cache.iter().enumerate() {
            out.push_str(&format!(
                "  {:<9} {var} = {dir}\n",
                if i == 0 { "cache" } else { "" }
            ));
        }
    }

    if let Some(why) = refusal {
        out.push_str(&format!(
            "\n  ! this machine cannot run what the starter names\n    {}\n    \
             every command that reads this playbook refuses it until that line names \
             something this machine has\n",
            why.trim()
        ));
    }

    out.push_str(if w.toolchain.is_some() {
        "\n  The accept lines are the toolchain's usual commands rather than this \
         project's —\n  run them once, then fill in the guidance for each kind:\n"
    } else {
        "\n  Fill in the acceptance commands and the guidance for each kind:\n"
    });
    out.push_str(&format!(
        "    wecode playbook bug --project {}\n\n  Commit it — it describes this code, \
         so it belongs with it.\n  Add {}/ to .gitignore; it is the worker-writable \
         area.\n",
        project.id,
        wecode_org::playbook::RUN_DIR
    ));
    out
}

/// Counted rather than listed: the index is not where a gap is read, it is where a
/// reader finds out there is one. Saying nothing here would leave findings sitting in
/// a file nobody opens.
#[must_use]
pub(crate) fn gap_count(gaps: &[Gap]) -> String {
    if gaps.is_empty() {
        return String::new();
    }
    format!(
        "\n  {} gap{} recorded and not folded in — wecode playbook gaps\n",
        gaps.len(),
        if gaps.len() == 1 { "" } else { "s" }
    )
}

/// One kind in full: the typed defaults, then the prose.
#[must_use]
pub(crate) fn one_kind(
    project: &Project,
    pb: &Playbook,
    kind: TaskKind,
    gaps: &[Gap],
    now: u64,
) -> String {
    let mut out = header(project, pb);
    let Some(k) = pb.for_kind(kind) else {
        out.push_str(&format!(
            "\n  no [{}] section — this project has no guidance for that kind\n",
            kind.as_str()
        ));
        // Shown even here. "There is no section" is the strongest reason for a gap
        // to have been recorded against this kind, so it is the last place to hide
        // one.
        out.push_str(&gaps_against(kind, gaps, now));
        return out;
    };
    out.push_str(&format!(
        "  kind      {}\n  worktree  {}\n",
        kind.as_str(),
        if k.worktree {
            match &pb.project.merge_to {
                Some(b) => format!("yes, branched from {b}"),
                None => "yes".to_string(),
            }
        } else {
            "no".to_string()
        }
    ));
    if k.design_required {
        out.push_str("  design    required — admitted only behind a design task\n");
    }
    if let Some(post) = &k.assign_to {
        out.push_str(&format!("  assign    {post}\n"));
    }
    for cmd in &k.accept {
        out.push_str(&format!("  accept    {cmd}\n"));
    }
    // What `--expand` would emit. Shown before the prose because it is the part the
    // reader can act on without writing anything: a decomposition already decided.
    if !k.subtasks.is_empty() {
        out.push_str(&format!(
            "  expand    {}\n",
            k.subtasks
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>()
                .join(" → ")
        ));
        let width = k.subtasks.iter().map(|s| s.name.len()).max().unwrap_or(0);
        for s in &k.subtasks {
            out.push_str(&format!(
                "              {:<width$}  {:<5}  {}",
                s.name,
                kind_tag(s.kind.unwrap_or(kind)),
                if s.write.is_empty() {
                    "—".to_string()
                } else {
                    s.write.join(", ")
                }
            ));
            if !s.after.is_empty() {
                out.push_str(&format!("  after {}", s.after.join(", ")));
            }
            out.push('\n');
        }
    }
    if !k.guidance.is_empty() {
        out.push_str("  ---\n");
        for line in k.guidance.lines() {
            out.push_str(&format!("  {line}\n"));
        }
    }
    // After the prose, because that is the order they were learned in: the guidance
    // is what the project decided, a gap is what it has since found out and not yet
    // written down.
    out.push_str(&gaps_against(kind, gaps, now));
    out
}

/// The gaps a reader of one kind's guidance should see: the ones filed against that
/// kind, plus the ones filed against no kind at all, which are about how this project
/// is planned and therefore apply to all of them.
fn gaps_against(kind: TaskKind, gaps: &[Gap], now: u64) -> String {
    let mine: Vec<&Gap> = gaps.iter().filter(|g| g.applies_to(kind)).collect();
    if mine.is_empty() {
        return String::new();
    }
    format!(
        "\n  gaps found in this guidance and not folded in yet:\n\n{}",
        gap_entries(&mine, now)
    )
}

/// Every gap on a project, for `wecode playbook gaps`.
#[must_use]
pub(crate) fn gaps(
    project: &Project,
    gaps: &[Gap],
    now: u64,
    playbook: &Path,
    file: &Path,
) -> String {
    if gaps.is_empty() {
        return format!(
            "  no gaps recorded against {}'s playbook\n  \
             wecode playbook gap \"<what the guidance does not say>\" --kind <kind>\n",
            project.id
        );
    }
    let list: Vec<&Gap> = gaps.iter().collect();
    format!(
        "  {} gap{} against {}'s playbook, oldest first\n\n{}{}",
        gaps.len(),
        if gaps.len() == 1 { "" } else { "s" },
        project.id,
        gap_entries(&list, now),
        folding("each", playbook, file)
    )
}

/// How one stops being a gap. Printed wherever they are, because the file will not
/// empty itself and nothing else in wecode will empty it either.
fn folding(subject: &str, playbook: &Path, file: &Path) -> String {
    format!(
        "  Fold {subject} into {}\n  then delete it from {}\n",
        playbook.display(),
        file.display()
    )
}

/// One block per gap: where it belongs, who found it and when, then the note itself.
fn gap_entries(gaps: &[&Gap], now: u64) -> String {
    let mut out = String::new();
    for g in gaps {
        let mut head = format!(
            "    {}",
            // A gap filed against no kind is about the project's planning as a
            // whole, and saying "—" here would read as missing data.
            g.kind.map_or("every kind", TaskKind::as_str)
        );
        head.push_str(&format!("  ·  {} ago", ago(now.saturating_sub(g.at))));
        if !g.by.is_empty() {
            head.push_str(&format!("  ·  {}", g.by));
        }
        if let Some(task) = &g.task {
            head.push_str(&format!("  ·  found on {task}"));
        }
        out.push_str(&format!("{head}\n"));
        for line in g.note.lines() {
            out.push_str(&format!("      {line}\n"));
        }
        out.push('\n');
    }
    out
}

/// What `playbook gap` says once a finding is on the record.
#[must_use]
pub(crate) fn gap_recorded(g: &Gap, fresh: bool, playbook: &Path, file: &Path) -> String {
    let mut out = if fresh {
        format!("  recorded a gap in {}'s playbook\n\n", g.project)
    } else {
        // Not an error, and not silence either: something that records in a loop
        // needs to know the finding is held without being told it failed.
        format!(
            "  already recorded against {}'s playbook — nothing was added\n\n",
            g.project
        )
    };
    for line in g.note.lines() {
        out.push_str(&format!("    {line}\n"));
    }
    out.push_str(&format!(
        "\n  {}{}\n",
        match g.kind {
            Some(k) => format!("against [{}]", k.as_str()),
            None => "against the project, so every kind shows it".to_string(),
        },
        g.task
            .as_ref()
            .map_or_else(String::new, |t| format!(", found on {t}"))
    ));
    out.push_str(
        "\n  It is a note, not a change: nothing acts on it, and it stays here until\n\
         \x20 a person has done something about it.\n\n",
    );
    out.push_str(&folding("it", playbook, file));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_build_cache_is_listed_as_the_playbook_wrote_it() {
        // Unexpanded, because this is a view of the file. Where `~` lands on this
        // machine is what `wecode start` reports, beside the worktree it belongs to.
        let pb = Playbook::parse(
            "[project.build_cache]\nCARGO_TARGET_DIR = \"~/.cache/w/target\"\n\n[bug]\n",
        )
        .unwrap();
        let out = all_kinds(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &pb,
            &[],
        );
        assert!(
            out.contains("cache     CARGO_TARGET_DIR = ~/.cache/w/target"),
            "{out}"
        );
    }

    /// What `playbook init` returns for one language, without touching a repository.
    fn starter(language: &str) -> wecode_org::Written {
        let dir = std::env::temp_dir().join(format!("wecode-render-init-{language}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        wecode_org::playbook::init(&dir, language).unwrap()
    }

    #[test]
    fn what_a_starter_decided_is_reported_rather_than_left_in_the_file() {
        // The accept commands and the shared cache are the two lines a person is
        // expected to disagree with. Stated only in TOML they would be trusted by
        // whoever never opened it.
        let out = written(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &starter("rust"),
            None,
        );
        assert!(out.contains("language  rust"), "{out}");
        assert!(out.contains("accept    cargo test --workspace"), "{out}");
        assert!(out.contains("cargo clippy --all-targets"), "{out}");
        assert!(
            out.contains("cache     CARGO_TARGET_DIR = ~/.cache/"),
            "{out}"
        );
        assert!(
            out.contains("wecode playbook bug --project export"),
            "{out}"
        );
    }

    #[test]
    fn a_language_nothing_answers_to_says_what_it_could_have_written() {
        let out = written(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &starter("cobol"),
            None,
        );
        assert!(out.contains("no toolchain here answers to it"), "{out}");
        assert!(out.contains("rust"), "the known ones are named: {out}");
        assert!(!out.contains("accept  "), "nothing to report: {out}");
        assert!(
            out.contains("Fill in the acceptance commands"),
            "and the reader is told whose job that now is: {out}"
        );
    }

    #[test]
    fn a_command_this_machine_lacks_is_a_warning_and_not_a_failure() {
        // The file is right for the repository and wrong only here — deleting it
        // would be the wrong answer, so the refusal is reported beside what was
        // written and the exit stays zero.
        let out = written(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &starter("python"),
            Some("[bug] accept: `uv` is not on this machine — `uv run pytest -q` would ..."),
        );
        assert!(out.contains("wrote "), "{out}");
        assert!(out.contains("! this machine cannot run"), "{out}");
        assert!(out.contains("`uv` is not on this machine"), "{out}");
    }

    #[test]
    fn a_project_that_shares_nothing_says_nothing_about_a_cache() {
        let pb = Playbook::parse("[bug]\nguidance = \"reproduce first\"\n").unwrap();
        let out = all_kinds(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &pb,
            &[],
        );
        assert!(!out.contains("cache"), "{out}");
    }

    // ------------------------------------------------------------- gaps ------

    fn a_gap(kind: Option<TaskKind>, note: &str) -> Gap {
        Gap {
            project: "export".into(),
            kind,
            task: None,
            by: "chief".into(),
            at: 1_000,
            note: note.into(),
        }
    }

    #[test]
    fn a_kind_shows_its_own_gaps_and_the_ones_filed_against_no_kind() {
        let pb = Playbook::parse("[bug]\nguidance = \"reproduce first\"\n").unwrap();
        let found = [
            a_gap(Some(TaskKind::Bug), "declare the test file"),
            a_gap(None, "no integration branch is set"),
            a_gap(Some(TaskKind::Docs), "say where the reference is generated"),
        ];
        let out = one_kind(
            &Project::new("export", "cut export p99 below 500ms", "api"),
            &pb,
            TaskKind::Bug,
            &found,
            2_000,
        );
        assert!(out.contains("reproduce first"), "the guidance stays: {out}");
        assert!(out.contains("declare the test file"), "{out}");
        assert!(
            out.contains("no integration branch"),
            "applies to all: {out}"
        );
        assert!(!out.contains("where the reference is generated"), "{out}");
        // After the prose, in the order the two were learned in.
        assert!(
            out.find("reproduce first") < out.find("declare the test file"),
            "{out}"
        );
    }

    #[test]
    fn guidance_with_nothing_recorded_against_it_says_nothing_about_gaps() {
        // The silent case is the common one, and a heading with nothing under it
        // would be noise on every read.
        let pb = Playbook::parse("[bug]\nguidance = \"reproduce first\"\n").unwrap();
        let project = Project::new("export", "cut export p99 below 500ms", "api");
        let out = one_kind(&project, &pb, TaskKind::Bug, &[], 2_000);
        assert!(!out.contains("gap"), "{out}");
        assert!(!all_kinds(&project, &pb, &[]).contains("gap"), "{out}");
    }
}
