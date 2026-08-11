//! Built-in organisation templates.
//!
//! A template is just the initial file set. Everything it writes is plain text the
//! operator is expected to edit.

/// A file a template contributes: relative path and contents.
pub type File = (&'static str, &'static str);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Template {
    pub name: &'static str,
    pub summary: &'static str,
    pub files: &'static [File],
}

#[must_use]
pub fn all() -> &'static [Template] {
    &[SOFTWARE_COMPANY, SOLO]
}

#[must_use]
pub fn find(name: &str) -> Option<Template> {
    all().iter().copied().find(|t| t.name == name)
}

pub const SOFTWARE_COMPANY: Template = Template {
    name: "software-company",
    summary: "chief of staff, engineer, tester, reviewer; scopes that do not overlap",
    files: &[
        ("company.toml", SOFTWARE_COMPANY_TOML),
        ("agents/claude-code.toml", AGENT_CLAUDE),
        ("agents/codex.toml", AGENT_CODEX),
        ("templates/task-envelope.md", TASK_ENVELOPE),
        ("README.md", WORKSPACE_README),
        (".gitignore", WORKSPACE_GITIGNORE),
    ],
};

pub const SOLO: Template = Template {
    name: "solo",
    summary: "chief of staff and one engineer; the smallest governed setup",
    files: &[
        ("company.toml", SOLO_TOML),
        ("agents/claude-code.toml", AGENT_CLAUDE),
        ("templates/task-envelope.md", TASK_ENVELOPE),
        ("README.md", WORKSPACE_README),
        (".gitignore", WORKSPACE_GITIGNORE),
    ],
};

const SOFTWARE_COMPANY_TOML: &str = r#"# This company is self-contained: profile, roles, posts, agent templates and
# state all live in this directory. It is NOT a code repository — the repos it
# works on are declared below by path.

[company]
name = "Example Software Co"
description = """
Replace this with what the company is for. The chief of staff reads it when
deciding where new intent belongs, so a sentence about the product and its
constraints is worth more than a slogan.
"""
profile = "solo"          # solo | team | enterprise

# The binding constraint is your attention, not your CPU. Concurrency derives
# from these numbers.
[attention]
max_open_items = 5
max_interrupts_per_hour = 3
digest_interval_mins = 20

# Invariants outrank every grant below. A grant that would permit one of these is
# itself the bug, so violations raise an alarm rather than a denial.
[invariants]
never_touch = [".github/**", "infra/**", "**/*.pem", "**/*.key", "**/.env"]
never_run = ["git push --force*", "npm publish*", "terraform apply*", "rm -rf /*"]
approval_to_merge = ["main", "master", "release/**"]
max_tokens = 1000000

# Repositories this company works on. Kept outside the workspace on purpose: a
# post's working directory must never be able to reach this file.
[[repos]]
name = "app"
path = "~/projects/your-repo"

# ---------------------------------------------------------------- roles --------
# A role is a set of enforced capabilities, or it is nothing.

# The main agent. Broad authority, and deliberately unable to do the work:
# an agent that can both set the criteria and satisfy them is not governed.
[roles.chief]
read = ["**"]
define = ["goal", "project", "task"]
approve = ["admission", "budget-increase"]
introspect = "tree"
staff = true
tokens = 100000

[roles.engineer]
read = ["**"]
write = ["src/**", "crates/**", "lib/**"]
run = ["cargo *", "npm test*", "npm run build*"]
tokens = 200000
wall_secs = 1800

# Writes tests only, so it cannot make a failing test pass by weakening the code.
[roles.tester]
read = ["**"]
write = ["tests/**", "spec/**"]
run = ["cargo test*", "npm test*"]
tokens = 50000
wall_secs = 600

# Writes nothing at all, and holds the only merge approval.
[roles.reviewer]
read = ["**"]
run = ["git diff*", "git log*", "cargo clippy*"]
approve = ["merge"]
introspect = "own"
tokens = 30000
wall_secs = 300

# ---------------------------------------------------------------- posts --------
# A post is a seat; `agent` is whoever currently occupies it. Re-staff without
# touching the org chart.

[[posts]]
name = "chief"
role = "chief"
agent = "claude-code"

[[posts]]
name = "impl"
role = "engineer"
agent = "claude-code"

[[posts]]
name = "test"
role = "tester"
agent = "codex"

[[posts]]
name = "review"
role = "reviewer"
agent = "claude-code"
"#;

const SOLO_TOML: &str = r#"[company]
name = "My Project"
description = "Replace with what this is for."
profile = "solo"

[attention]
max_open_items = 5
max_interrupts_per_hour = 3
digest_interval_mins = 20

[invariants]
never_touch = [".github/**", "**/*.pem", "**/.env"]
never_run = ["git push --force*", "npm publish*"]
approval_to_merge = ["main", "master"]
max_tokens = 500000

[[repos]]
name = "app"
path = "~/projects/your-repo"

[roles.chief]
read = ["**"]
define = ["goal", "project", "task"]
approve = ["admission"]
introspect = "tree"
staff = true
tokens = 50000

[roles.engineer]
read = ["**"]
write = ["src/**", "crates/**"]
run = ["cargo *"]
tokens = 200000
wall_secs = 1800

[[posts]]
name = "chief"
role = "chief"
agent = "claude-code"

[[posts]]
name = "impl"
role = "engineer"
agent = "claude-code"
"#;

const AGENT_CLAUDE: &str = r#"# Agent template: how to invoke this coding CLI and read its output.
# Consumed by the execution layer.

name = "claude-code"
command = "claude"
protocol = "claude-stream-json"
args = ["-p", "{{prompt}}", "--output-format", "stream-json", "--verbose"]
cwd = "{{workspace}}"
env_allowlist = ["ANTHROPIC_API_KEY", "PATH", "HOME", "LANG"]

[capabilities]
edits_files = true
runs_commands = true
interactive_stdin = false
tags = ["general", "rust", "typescript"]

[limits]
wall_secs = 1800
idle_secs = 300
max_output_bytes = 8000000

[health]
probe = ["claude", "--version"]
"#;

const AGENT_CODEX: &str = r#"name = "codex"
command = "codex"
protocol = "generic-jsonl"
args = ["exec", "--json", "{{prompt}}"]
cwd = "{{workspace}}"
env_allowlist = ["OPENAI_API_KEY", "PATH", "HOME", "LANG"]

[capabilities]
edits_files = true
runs_commands = true
interactive_stdin = false
tags = ["general", "tests"]

[limits]
wall_secs = 1800
idle_secs = 300
max_output_bytes = 8000000

[health]
probe = ["codex", "--version"]
"#;

const TASK_ENVELOPE: &str = r#"<task id="{{task_id}}" intent="{{intent_id}}">
GOAL: {{goal}}

YOUR TASK: {{intent}}

ACCEPTANCE
{{#acceptance}}
- {{.}}
{{/acceptance}}

SCOPE
You may modify only: {{write_scope}}
Do not modify anything else. Writes outside this list are rejected.

CONTEXT FROM COMPLETED WORK
{{context}}

WHEN FINISHED
Write .wecode/result.json in your working directory:
{"status":"succeeded"|"failed"|"blocked",
 "summary":"<2-4 sentences>",
 "changed_files":["..."],
 "blocked_on":"<question, if blocked>"}

Do not commit. Do not merge. Both are done for you after checks pass.
</task>
"#;

const WORKSPACE_README: &str = r#"# wecode company workspace

Self-contained. Everything about this organisation lives here:

    company.toml            profile, attention budget, invariants, roles, posts
    agents/                 how to invoke each coding CLI
    templates/              prompt templates
    state/                  intents.log, audit.log — append-only, authoritative

This directory is **not** a code repository. The repos this company works on are
declared in `company.toml` under `[[repos]]`, and live elsewhere on purpose: a
post's working directory must never be able to reach this file.

## Usage

    wecode --org <this-dir> company show
    wecode --org <this-dir> intent tree

Or `cd` here and omit `--org`: wecode walks up from the working directory looking
for `company.toml`, the way git and cargo do.

## Editing

Every file here is plain text meant to be edited. After changing `company.toml`,
run `wecode company show` — it validates on load and will tell you what is wrong.
"#;

const WORKSPACE_GITIGNORE: &str = "# State is machine-local and append-only.\nstate/\n";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::Company;

    #[test]
    fn every_template_parses_as_a_valid_company() {
        for t in all() {
            let toml = t
                .files
                .iter()
                .find(|(p, _)| *p == "company.toml")
                .map(|(_, c)| *c)
                .unwrap_or_else(|| panic!("{} has no company.toml", t.name));
            let c =
                Company::parse(toml).unwrap_or_else(|e| panic!("{} does not parse: {e}", t.name));
            assert!(!c.name.is_empty());
            assert!(c.chief().is_some(), "{} has no chief post", t.name);
        }
    }

    #[test]
    fn every_template_declares_its_agents() {
        for t in all() {
            let company_toml = t
                .files
                .iter()
                .find(|(p, _)| *p == "company.toml")
                .unwrap()
                .1;
            let c = Company::parse(company_toml).unwrap();
            for post in &c.posts {
                let expected = format!("agents/{}.toml", post.agent);
                assert!(
                    t.files.iter().any(|(p, _)| *p == expected),
                    "{}: post `{}` names agent `{}` but {expected} is missing",
                    t.name,
                    post.name,
                    post.agent
                );
            }
        }
    }

    #[test]
    fn no_template_lets_a_post_write_outside_a_repo_shape() {
        for t in all() {
            let company_toml = t
                .files
                .iter()
                .find(|(p, _)| *p == "company.toml")
                .unwrap()
                .1;
            let c = Company::parse(company_toml).unwrap();
            for (name, g) in &c.roles {
                assert!(
                    !g.write.iter().any(|w| w == "**" || w == "*"),
                    "{}: role `{name}` writes everything",
                    t.name
                );
            }
        }
    }

    #[test]
    fn template_scopes_do_not_overlap_between_engineer_and_tester() {
        let company_toml = SOFTWARE_COMPANY
            .files
            .iter()
            .find(|(p, _)| *p == "company.toml")
            .unwrap()
            .1;
        let c = Company::parse(company_toml).unwrap();
        let eng = &c.roles["engineer"];
        let tester = &c.roles["tester"];
        for w in &tester.write {
            assert!(
                !eng.allows_write(&w.replace("**", "x")),
                "engineer and tester both write {w}"
            );
        }
    }

    #[test]
    fn state_is_gitignored_in_the_workspace() {
        for t in all() {
            let ignore = t.files.iter().find(|(p, _)| *p == ".gitignore");
            assert!(ignore.is_some(), "{} has no .gitignore", t.name);
            assert!(ignore.unwrap().1.contains("state/"));
        }
    }
}
