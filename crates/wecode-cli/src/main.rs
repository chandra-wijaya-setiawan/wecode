//! `wecode` — the single control driver.

mod args;
mod board;
mod commands;
mod git;
mod render;
mod scheduler;
mod spawn;
mod tui;
mod verify;
mod work;

use std::process::ExitCode;

use args::Args;
use commands::ctx::*;
use commands::exec::*;
use commands::gov::*;
use commands::org::*;
use commands::plan::*;
use commands::view::*;

const USAGE: &str = "\
wecode — run coding agents as staff

A company is a self-contained directory: company.toml by hand, wecode.db by
machine. It is not a code repository; the repos it works on are declared inside it
by path.

SESSION
  wecode orgs                          named orgs under ~/.wecode/workspaces
  wecode use <name|dir>                remember a default org (skips --org)
  wecode login <user> [--as <post>] [--agent <n>]   open a session
  wecode whoami                        this seat, and the commands it may call
  wecode who                           everything connected right now
  wecode logout [--session <id>] [--all]

SETUP
  wecode init <name|dir> [--template <t>] scaffold a company workspace
        a bare name lands in ~/.wecode/workspaces/<name>
  wecode templates                        list available templates
  wecode company show                     profile, posts, invariants

  Commands find the workspace by walking up from the working directory, or via
  --org <name|dir> / $WECODE_ORG / the default set by `wecode use`.

PLAN
  A project owns one repo and carries an objective. A task is the executable unit.

  wecode project add <id> --repo <name> \"<objective>\"
        --measure-cmd \"<cmd>\"   --measure-metric <name>:<lt|lte|gt|gte|eq>:<n>
        --tokens <n>  --wall <secs>
  wecode project list

  wecode task add <id> --project <p> \"<title>\"
        --kind <feature|bug|refactor|chore|spike|docs>   default: feature
        --parent <task>          is part of that task
        --after <task>           must come after it (repeatable)
        --accept-cmd \"<cmd>\"     executable acceptance (repeatable)
        --accept-metric <name>:<cmp>:<target>
        --write <glob>  --read <glob>   scope (repeatable)
        --tokens <n>  --wall <secs>     --to <post>
        --force                  save despite defects, recorded as waivers
  wecode task rm <id>                  erase a task that never ran
  wecode task scope <id> --write <glob> [--read <glob>]
        replace a scope after the fact; recorded violations are not erased

  wecode playbook [<kind>]             this project's guidance for that kind
        --project <p>   init            `init` writes a starter into the repo
  wecode brief                         who you are and how to work — read this first
  wecode tree [--all]                  projects and their task trees
  wecode ready                         what is schedulable right now
  wecode show <id>                     one project or task in full
  wecode check <id>                    the admission verdict
  wecode status <project|task> <status>   set a status by hand
  wecode archive <project> | unarchive <project>
        hide a project from the cockpit, or bring it back (--force if work is live)

COCKPIT
  wecode up                            live dashboard: j/k move, enter descend, q quit
  wecode board [<id>] [--all]          the same view as a one-shot snapshot

WORK
  wecode assign <task> --to <post>     check the post may do it, then make it ready
  wecode start <task> [--json]         worktree + envelope; marks it running
                                       --json emits the A2A task instead of prose
  wecode tick                          promote waiting tasks whose work is unblocked
  wecode loop [--once]                 tick, then dispatch what is ready, forever
  wecode run <task>                    spawn its agent, supervise it, then verify
  wecode verify <task>                 judge it: diff against scope, then acceptance
  wecode merge <task>                  land it on the integration branch, and report
  wecode rollback <task>               revert that merge; the report says when to
  wecode worktree [remove <task>]      list them, or remove one (--force if dirty)
  wecode approve <merge|admission|design|budget|measure> [<what>] --as <post>
        approve design --task <id>   signs a design off: needs-approval → done
  wecode guard <post> <verb> <target>  authorise an action; records the decision
        verbs: read write run merge spend        --tokens <n> for spend
        --task <id> / --project <id> attributes the record
  wecode audit [--denied] [--alarms] [--path <glob>] [--project <p>] [--task <t>]
";

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let a = Args::parse(argv);

    match run(&a) {
        Ok(out) => {
            print!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
fn run(a: &Args) -> Res {
    match (a.cmd(0), a.cmd(1)) {
        ("init", _) => init(a),
        ("templates", _) => Ok(render::templates()),
        ("company", "show") | ("org", "show") => {
            let (_, company) = open(a)?;
            Ok(render::company(&company))
        }
        ("project", "add") => project_add(a),
        ("project", "list") | ("projects", _) => {
            let (store, _) = open(a)?;
            Ok(render::tree(&store.load_plan()?, a.has("all")))
        }
        ("task", "add") => task_add(a),
        ("task", "rm") => task_rm(a),
        ("task", "scope") => task_scope(a),
        ("tree", _) => {
            let (store, _) = open(a)?;
            Ok(render::tree(&store.load_plan()?, a.has("all")))
        }
        ("ready", _) => {
            let (store, _) = open(a)?;
            Ok(render::ready(&store.load_plan()?))
        }
        ("playbook", "init") => playbook_init(a),
        ("playbook", _) => playbook_show(a),
        ("brief", _) => brief(a),
        ("start", _) => start(a),
        ("verify", _) => verify_task(a),
        ("merge", _) => merge_task(a),
        ("rollback", _) => rollback_task(a),
        ("run", _) => run_task(a),
        ("tick", _) => tick(a),
        ("loop", _) | ("serve", _) => serve(a),
        ("worktree", "remove") | ("worktree", "rm") => worktree_remove(a),
        ("worktree", _) => worktree_list(a),
        ("archive", _) => set_archived(a, true),
        ("unarchive", _) => set_archived(a, false),
        ("show", _) => show(a),
        ("check", _) => check(a),
        ("status", _) => set_status(a),
        ("board", _) => board_snapshot(a),
        ("up", _) | ("cockpit", _) => cockpit(a),
        ("assign", _) => assign(a),
        ("use", _) => use_org(a),
        ("orgs", _) => Ok(render::orgs()),
        ("login", _) => login(a),
        ("logout", _) => logout(a),
        ("who", _) => who(a),
        ("whoami", _) => whoami(a),
        ("approve", _) => approve(a),
        ("guard", _) => guard(a),
        ("audit", _) => audit(a),
        ("", _) | ("help", _) | ("--help", _) => Ok(USAGE.to_string()),
        (cmd, sub) => Err(format!("unknown command `{cmd} {sub}`\n\n{USAGE}").into()),
    }
}
