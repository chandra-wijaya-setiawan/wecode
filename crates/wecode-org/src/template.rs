//! Built-in organisation templates.
//!
//! A workspace is two files that matter: `company.toml`, which you hand-edit, and
//! `wecode.db`, which only the program writes. Agents and prompt templates are
//! inlined into the config so it stays two.

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
        ("README.md", WORKSPACE_README),
        (".gitignore", WORKSPACE_GITIGNORE),
    ],
};

pub const SOLO: Template = Template {
    name: "solo",
    summary: "chief of staff and one engineer; the smallest governed setup",
    files: &[
        ("company.toml", SOLO_TOML),
        ("README.md", WORKSPACE_README),
        (".gitignore", WORKSPACE_GITIGNORE),
    ],
};

const SOFTWARE_COMPANY_TOML: &str = r#"# Everything you edit by hand lives in this file. Projects, tasks, sessions and
# the audit ledger live in wecode.db, which only the program writes.
#
# This directory is NOT a code repository — the repos it works on are declared
# below by path and live elsewhere on purpose: a worker's working directory must
# never be able to reach the file that defines its own authority.

[company]
name = "Example Software Co"
profile = "solo"          # solo | team | enterprise
vision = "replace this with why the company exists, in one sentence"
description = """
Replace this with what the company is for. A project's objective is judged
against it, so a sentence about the product and its constraints is worth more
than a slogan.
"""

# The binding constraint is your attention, not your CPU.
[attention]
max_open_items = 5
max_interrupts_per_hour = 3
digest_interval_mins = 20

# Run when a task starts waiting on a person — a signature, an answer, a decision
# about work that failed. Uncomment and make it whatever "tell me" means here. The
# task arrives in the environment: WECODE_TASK, WECODE_TASK_TITLE, WECODE_PROJECT,
# WECODE_TASK_STATUS, WECODE_WAITING_FOR (approval | input | failed | signature).
# [notify]
# command = "notify-send 'wecode' \"$WECODE_TASK needs you: $WECODE_WAITING_FOR\""
# timeout = "10s"           # killed at this; a hung notifier must not hold the loop

# And the way back: reply `approve` under that message and the next pass of `wecode
# loop` signs it. wecode holds no token — this is your command line, and what it
# prints is read as a getUpdates response. WECODE_TELEGRAM_OFFSET is how far it has
# already read. Give the user below a `telegram` id to say who may sign this way.
# [telegram]
# fetch = "curl -sS -m 20 \"https://api.telegram.org/bot$TG_TOKEN/getUpdates?offset=$WECODE_TELEGRAM_OFFSET\""
# timeout = "30s"

# Invariants outrank every grant below. A grant that would permit one of these is
# itself the bug, so violations raise an alarm rather than a denial.
#
# These are the company's, and they hold for every project at once. One repository's own
# line — paths that are nobody's task to change here — belongs in its playbook instead,
# as `[project.refuses]`: that one is checked against a task's declared scope while the
# plan is still being written, and is answered by narrowing it. A project may be stricter
# than this list and never laxer.
[invariants]
never_touch = [".github/**", "infra/**", "**/*.pem", "**/*.key", "**/.env"]
never_run = ["git push --force*", "npm publish*", "terraform apply*", "rm -rf /*"]
approval_to_merge = ["main", "master", "release/**"]
max_tokens = 1000000
# max_intelligence = 7.5  # no seat may be staffed above this level; see posts below

[session]
ttl = "8h"                # idle timeout for an interactive session

# Repositories. A project owns exactly one, by name.
[[repos]]
name = "app"
path = "~/projects/your-repo"

# ---------------------------------------------------------------- roles --------
# A role is a set of enforced capabilities, or it is nothing.

# The main agent's seat. Broad authority, and deliberately unable to do the work:
# something that can both set the criteria and satisfy them is not governed.
[roles.chief]
read = ["**"]
define = ["project", "task"]
# Landing work is the chief's job — it staffs and it merges, but writes no code.
# Where a signature is *required* is the charter's business, not this list's.
merge_to = ["**"]
approve = ["admission", "design", "budget-increase"]
introspect = "tree"
staff = true
tokens = 100000

[roles.engineer]
read = ["**"]
# The specification is the engineer's own deliverable — 15289 names the information
# item and no author for it apart from whoever builds the thing — so a seat that ships
# the code and cannot keep its contract true ships a stale one. It is not a way to
# self-approve: acceptance is named on the task by whoever defined it, and is never
# read back out of this file. `report_as_finished.md` stays out because it is generated
# from `git diff`, and an agent's account of its own work is inadmissible.
write = ["src/**", "crates/**", "lib/**", "specs/**/specification.md"]
run = ["cargo *", "npm test*", "npm run build*"]
tokens = 200000
wall_secs = 1800

# Writes tests only, so it cannot make a failing test pass by weakening the code.
# `spec/**` here is rspec's test directory: one letter from the engineer's `specs/**`
# above and a different owner, so check which you meant with `wecode guard`.
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
# A post is a seat; `agent` is what types for it. Re-staff without touching the
# org chart.
#
# `intelligence` is how clever the occupant should be, 1–10, matched against the
# `models` list on its agent below — not a model name, so this chart does not rot
# when one is renamed. Omit it and the harness runs whatever it runs by default.

[[posts]]
name = "chief"
role = "chief"
agent = "claude-code"
intelligence = 7.5        # decides what the work is; the expensive judgement

[[posts]]
name = "impl"
role = "engineer"
agent = "claude-code"
intelligence = 5

[[posts]]
name = "test"
role = "tester"
agent = "codex"
# No level: `codex` below lists no models, so there is nothing to pick from and
# setting one here would be refused at load rather than quietly ignored.

[[posts]]
name = "review"
role = "reviewer"
agent = "claude-code"
intelligence = 7.5

# ---------------------------------------------------------------- users --------
# A person holding a seat. Authority lives on the role, so naming a user adds
# accountability, not power. A post with no user is an agent-only seat.

[[users]]
name = "you"              # rename to yourself
post = "chief"
# telegram = "48210934"   # the account you reply from; what you may sign is the post's

# --------------------------------------------------------------- agents --------

[agents.claude-code]
command = "claude"
protocol = "claude-stream-json"
args = ["-p", "{{prompt}}", "--output-format", "stream-json", "--verbose", "--allowedTools", "{{tools}}"]
env_allowlist = ["ANTHROPIC_API_KEY", "PATH", "HOME", "LANG"]
wall_secs = 1800
idle_secs = 300
# Weakest first. The 1–10 scale is spread over this list — three entries answer
# up to 3.3, 6.6 and 10 — so adding one keeps every seat's number meaning roughly
# what it meant. Launched as `--model <name>`; set `model_flag` if this harness
# spells it differently. Omit the list and no model is named at all.
models = ["haiku", "sonnet", "opus"]

[agents.codex]
command = "codex"
protocol = "generic-jsonl"
args = ["exec", "--json", "{{prompt}}"]
env_allowlist = ["OPENAI_API_KEY", "PATH", "HOME", "LANG"]
wall_secs = 1800
idle_secs = 300

# ------------------------------------------------------------ templates --------

[templates]
task_envelope = """
<task id="{{task_id}}" project="{{project_id}}">
OBJECTIVE: {{objective}}

YOUR TASK: {{title}}

ACCEPTANCE
{{acceptance}}

SCOPE
You may modify only: {{write_scope}}
Writes outside this list are rejected.

GUIDANCE
This project keeps its own guidance in the repository you are standing in, at
.wecode/playbook.toml. Read the section for this kind of work before you start:
it is what the project already decided about how work like this is done here,
and nothing else in this envelope repeats it. Do not edit it — it is guidance
you were handed, and it is outside the scope above on purpose.

CONTEXT FROM COMPLETED WORK
{{context}}

WHEN FINISHED
Write .wecode/run/result.json in your working directory:
{"status":"succeeded"|"failed"|"blocked",
 "summary":"<2-4 sentences>",
 "changed_files":["..."],
 "blocked_on":"<question, if blocked>"}

Do not commit. Do not merge. Both are done for you after checks pass.
</task>
"""
"#;

const SOLO_TOML: &str = r#"[company]
name = "My Project"
profile = "solo"
vision = "replace this with why this exists, in one sentence"
description = "Replace with what this is for."

[attention]
max_open_items = 5
max_interrupts_per_hour = 3
digest_interval_mins = 20

# Run when a task starts waiting on you. The task arrives in the environment —
# WECODE_TASK, WECODE_WAITING_FOR (approval | input | failed | signature), and more.
# [notify]
# command = "notify-send 'wecode' \"$WECODE_TASK needs you: $WECODE_WAITING_FOR\""

# And the way back: reply `approve` under that message and `wecode loop` signs it.
# This is your command line — wecode holds no token — and what it prints is read as a
# getUpdates response. Say who may sign that way with `telegram` on a user below.
# [telegram]
# fetch = "curl -sS -m 20 \"https://api.telegram.org/bot$TG_TOKEN/getUpdates?offset=$WECODE_TELEGRAM_OFFSET\""

# Company-wide, and enforced per write. What one repository will not have touched goes in
# its own playbook as `[project.refuses]`, where it is checked against a task's declared
# scope while the plan is still being written.
[invariants]
never_touch = [".github/**", "**/*.pem", "**/.env"]
never_run = ["git push --force*", "npm publish*"]
approval_to_merge = ["main", "master"]
max_tokens = 500000
# max_intelligence = 7.5  # no seat may be staffed above this level

[session]
ttl = "8h"

[[repos]]
name = "app"
path = "~/projects/your-repo"

[roles.chief]
read = ["**"]
define = ["project", "task"]
# Landing work is the chief's job — it staffs and it merges, but writes no code.
# Where a signature is *required* is the charter's business, not this list's.
merge_to = ["**"]
# No reviewer post here, and the solo profile omits separation of duties: there is
# one person and they cannot countersign themselves. A team profile moves `merge`
# to a reviewer who writes no code.
approve = ["admission", "design", "merge"]
introspect = "tree"
staff = true
tokens = 50000

[roles.engineer]
read = ["**"]
# The specification comes with the code: one seat builds the thing and keeps its
# contract true. Not a self-approval — acceptance is named on the task, never read back
# out of this file — and the generated `report_as_finished.md` is deliberately not here.
write = ["src/**", "crates/**", "specs/**/specification.md"]
run = ["cargo *"]
tokens = 200000
wall_secs = 1800

# `intelligence` is how clever the occupant should be, 1–10, matched against the
# `models` list on the agent below. Not a model name, so this does not rot when one
# is renamed; omit it and the harness runs its own default.

[[posts]]
name = "chief"
role = "chief"
agent = "claude-code"
intelligence = 7.5        # decides what the work is; the expensive judgement

[[posts]]
name = "impl"
role = "engineer"
agent = "claude-code"
intelligence = 5

[[users]]
name = "you"
post = "chief"
# telegram = "48210934"   # the account you reply from; what you may sign is the post's

[agents.claude-code]
command = "claude"
protocol = "claude-stream-json"
args = ["-p", "{{prompt}}", "--output-format", "stream-json", "--verbose", "--allowedTools", "{{tools}}"]
env_allowlist = ["ANTHROPIC_API_KEY", "PATH", "HOME", "LANG"]
wall_secs = 1800
idle_secs = 300
# Weakest first: the 1–10 scale is spread over this list, so a seat's number keeps
# meaning roughly what it meant when one is added. Launched as `--model <name>`.
models = ["haiku", "sonnet", "opus"]

[templates]
task_envelope = """
<task id="{{task_id}}" project="{{project_id}}">
OBJECTIVE: {{objective}}

YOUR TASK: {{title}}

ACCEPTANCE
{{acceptance}}

SCOPE
You may modify only: {{write_scope}}
Writes outside this list are rejected.

GUIDANCE
Read .wecode/playbook.toml in the repository you are standing in before you
start — the section for this kind of work is what this project already decided
about how it is done here. Do not edit it; it is outside the scope above.

CONTEXT FROM COMPLETED WORK
{{context}}

WHEN FINISHED
Write .wecode/run/result.json:
{"status":"succeeded"|"failed"|"blocked","summary":"...","changed_files":["..."]}

Do not commit. Do not merge.
</task>
"""
"#;

const WORKSPACE_README: &str = r#"# wecode company workspace

Two files:

    company.toml   everything you edit by hand — roles, posts, users, repos,
                   agents, prompt templates
    wecode.db      everything the program writes — projects, tasks, sessions,
                   the audit ledger

This directory is **not** a code repository. The repos it works on are declared in
`company.toml` under `[[repos]]` and live elsewhere on purpose: a worker's working
directory must never be able to reach the file that defines its own authority.

## Usage

    wecode --org <name> company show
    wecode --org <name> tree

A bare name resolves under `~/.wecode/workspaces`. Or `cd` here and omit `--org`:
wecode walks up from the working directory looking for `company.toml`, the way git
and cargo do. `wecode use <name>` sets a default.

## Editing

`company.toml` validates on load, and unknown keys are **errors** rather than being
ignored — a silently dropped `writ = [...]` would mean a role with no write scope
and no warning. After editing, run `wecode company show`.
"#;

const WORKSPACE_GITIGNORE: &str =
    "# The database is machine-local.\nwecode.db\nwecode.db-wal\nwecode.db-shm\n";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::Company;

    fn company_of(t: &Template) -> Company {
        let toml = t
            .files
            .iter()
            .find(|(p, _)| *p == "company.toml")
            .map(|(_, c)| *c)
            .unwrap_or_else(|| panic!("{} has no company.toml", t.name));
        Company::parse(toml).unwrap_or_else(|e| panic!("{} does not parse: {e}", t.name))
    }

    #[test]
    fn every_template_parses_and_has_a_chief_and_a_vision() {
        for t in all() {
            let c = company_of(t);
            assert!(!c.name.is_empty());
            assert!(c.chief().is_some(), "{} has no chief post", t.name);
            assert!(!c.vision.is_empty(), "{} has no vision", t.name);
        }
    }

    #[test]
    fn every_post_names_a_declared_agent() {
        for t in all() {
            let c = company_of(t);
            for p in &c.posts {
                assert!(
                    c.agents.contains_key(&p.agent),
                    "{}: post `{}` names agent `{}`",
                    t.name,
                    p.name,
                    p.agent
                );
            }
        }
    }

    #[test]
    fn every_user_sits_in_a_real_post() {
        for t in all() {
            let c = company_of(t);
            assert!(!c.users.is_empty(), "{} declares no users", t.name);
            for u in &c.users {
                assert!(
                    c.post(&u.post).is_some(),
                    "{}: {} -> {}",
                    t.name,
                    u.name,
                    u.post
                );
            }
        }
    }

    #[test]
    fn every_starter_staffs_its_seats_by_level_rather_than_by_model_name() {
        // The starter is where an operator learns the vocabulary. A chart that named
        // `opus` here would teach them to pin a name and rot at the next release.
        for t in all() {
            let c = company_of(t);
            let chief = c.chief().unwrap_or_else(|| panic!("{}", t.name));
            assert!(
                c.model_for(chief).is_some(),
                "{}: the chief is left to whatever the terminal last set",
                t.name
            );
            for p in &c.posts {
                // A level and a name are never both written down: the name is derived.
                assert!(
                    !c.agents[&p.agent].models.iter().any(|m| m == &p.agent),
                    "{}: post `{}` looks pinned to a model name",
                    t.name,
                    p.name
                );
            }
        }
    }

    #[test]
    fn a_seat_on_an_unranked_harness_declares_no_level() {
        // Which is also the load-time check working: a starter that set one would be
        // refused by `company_of` above, so this is here to say it is deliberate.
        let c = company_of(&SOFTWARE_COMPANY);
        let test = c.post("test").expect("the tester seat exists");
        assert!(c.agents[&test.agent].models.is_empty());
        assert_eq!(test.intelligence, None);
        assert_eq!(c.model_for(test), None, "codex runs its own default");
    }

    #[test]
    fn no_role_writes_everything() {
        for t in all() {
            let c = company_of(t);
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
    fn engineer_and_tester_scopes_do_not_overlap() {
        let c = company_of(&SOFTWARE_COMPANY);
        let eng = &c.roles["engineer"];
        for w in &c.roles["tester"].write {
            assert!(
                !eng.allows_write(&w.replace("**", "x")),
                "engineer and tester both write {w}"
            );
        }
    }

    #[test]
    fn every_template_declares_a_repo_and_a_plausible_ttl() {
        for t in all() {
            let c = company_of(t);
            assert!(!c.repos.is_empty(), "{} declares no repos", t.name);
            assert!(
                c.session_ttl.as_secs() > 0 && c.session_ttl.as_secs() <= 86_400,
                "{} has an implausible ttl",
                t.name
            );
        }
    }

    #[test]
    fn the_database_is_gitignored_including_its_wal_files() {
        for t in all() {
            let ignore = t
                .files
                .iter()
                .find(|(p, _)| *p == ".gitignore")
                .unwrap_or_else(|| panic!("{} has no .gitignore", t.name))
                .1;
            assert!(ignore.contains("wecode.db"));
            assert!(ignore.contains("wecode.db-wal"), "WAL files too");
        }
    }

    #[test]
    fn a_workspace_is_at_most_three_files() {
        // Two that matter, plus a readme. Agents and templates are inlined, which
        // is the point of the config being one file.
        for t in all() {
            assert!(t.files.len() <= 3, "{} has {} files", t.name, t.files.len());
        }
    }

    #[test]
    fn the_task_envelope_is_inlined_and_states_the_scope() {
        for t in all() {
            let c = company_of(t);
            assert!(!c.templates.task_envelope.is_empty(), "{}", t.name);
            assert!(
                c.templates.task_envelope.contains("write_scope"),
                "{} envelope must state the scope",
                t.name
            );
        }
    }

    #[test]
    fn the_envelope_points_a_worker_at_the_guidance_its_playbook_wrote() {
        // The playbook is committed in the tree the worker lands in, and nothing else
        // in the envelope says what it says — so a worker that is never told the file
        // exists works to guidance it has not read. Asserted against the constant
        // rather than the string, so moving the file cannot leave every shipped
        // envelope pointing at where it used to be.
        for t in all() {
            let c = company_of(t);
            assert!(
                c.templates
                    .task_envelope
                    .contains(crate::playbook::PLAYBOOK_PATH),
                "{} envelope must name {}",
                t.name,
                crate::playbook::PLAYBOOK_PATH
            );
        }
    }

    #[test]
    fn templates_are_findable_and_unknown_names_are_not() {
        assert!(find("software-company").is_some());
        assert!(find("solo").is_some());
        assert!(find("startup").is_none());
    }
}
