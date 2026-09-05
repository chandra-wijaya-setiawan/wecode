//! `wecode` — the single control driver.

mod args;
mod board;
mod cache;
mod claim;
mod codemap;
mod commands;
mod doctor;
mod git;
mod handoff;
mod install;
mod identity;
mod ledger;
mod map;
mod notify;
mod reclaim;
mod record;
mod render;
mod scheduler;
mod spawn;
mod teardown;
mod telegram;
mod tui;
mod usage;
mod verify;
mod work;

use std::process::ExitCode;

use args::Args;
use commands::cost::*;
use commands::ctx::*;
use commands::exec::*;
use commands::gov::*;
use commands::org::*;
use commands::plan::*;
use commands::trees::*;
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
  wecode doctor                           check this machine can do the work
        resolves git, the worktree root, every [[repos]] path and [agents.*]
        command, then fires [notify] command and reads [telegram] fetch back;
        signs nothing, consumes no reply, non-zero if what is set does not work

  Commands find the workspace by walking up from the working directory, or via
  --org <name|dir> / $WECODE_ORG / the default set by `wecode use`.

PLAN
  A project owns one repo and carries an objective. A task is the executable unit.

  Anywhere below takes a <project> or <task> by its id or by its short number: every
  view prints one in the left column, and `wecode merge 4` is `wecode merge
  cache-warm-on-deploy`. Write `#4` where a task is actually called `4`.

  wecode project add <id> --repo <name> \"<objective>\"
        --measure-cmd \"<cmd>\"   --measure-metric <name>:<lt|lte|gt|gte|eq>:<n>
        --tokens <n>  --wall <secs>
  wecode project list

  wecode task add <id> --project <p> \"<title>\"
        --kind <epic|story|feature|bug|refactor|chore|spike|design|docs>   default: feature
        --by <agent|person>      who does the work; default: agent. `manual` and
                                 `human` say person. Not yet recordable — the
                                 store has no column for it, so this is refused
        --parent <task>          is part of that task
        --after <task>           must come after it (repeatable)
        --accept-cmd \"<cmd>\"     executable acceptance (repeatable)
        --accept-metric <name>:<cmp>:<target>
        --write <glob>  --read <glob>   scope (repeatable)
        --tokens <n>  --wall <secs>     --to <post>
        --expand                 also emit the subtasks the playbook declares
        --force                  save despite defects, recorded as waivers
  wecode task rm <id>                  erase a task that never ran
  wecode task scope <id> --write <glob> [--read <glob>]
        replace a scope after the fact; recorded violations are not erased
  wecode task budget <id> [--tokens <n>] [--wall <secs>]
        raise a budget a run proved short, on the task that ran; each figure
        is amended on its own, and the next run is the one held to it

  wecode playbook [<kind>]             this project's guidance for that kind
        --project <p>
  wecode playbook init [--language <l>]   writes a starter into the repo; the language
                                        decides its accept commands, its shared build
                                        cache and the globs a build dirties, and is
                                        read off the repo's manifest when omitted
  wecode playbook gap \"<what the guidance does not say>\"
        --kind <k> --task <id>          record a gap you found while planning;
                                        shown to whoever reads that kind next
  wecode playbook gaps                 what has been found and not folded in yet
  wecode brief                         who you are and how to work — read this first
  wecode tree [--all]                  projects and their task trees
  wecode map [<project>] [--seed <glob>…]   what sits next to what, by name
        parses the tracked source with tree-sitter and ranks the files nearest the
        seeds — the same ranking a task's envelope carries, seeded from its write
        scope. Names are matched between files, never resolved: read it to declare
        a scope, not as an answer about what calls what
  wecode ready                         what is schedulable right now
  wecode show <id>                     one project or task in full
  wecode check <id>                    the admission verdict
  wecode status <project|task> <status>   set a status by hand
        `hold` parks it on the board — the tick skips it until you move it
        back (a task to `waiting`, a project to `active`)
  wecode archive <project> | unarchive <project>
        hide a project from the cockpit, or bring it back (--force if work is live)
  wecode sweep [<project>] [--dry-run] [--force]
        file away every finished task at once — each `done` or `dropped` group whose
        rows are all settled, subtasks with them. Names what it held back, and why;
        --dry-run reports the same sweep without writing or signing anything

COCKPIT
  wecode tui [<id>]                    one application, three screens that call
                                       each other (`wecode up` is the same command)
        HOME     needs-you · moving · next · landed, over the whole portfolio
        PROJECT  one project's task tree      TASK  one task in full
        enter opens what the cursor is on, esc goes back, q quits
        j/k move · space fold · z/Z fold all · a archived · r reload · ? keys
        <id> is the screen it opens on, not a mode: esc still reaches HOME
  wecode board [<id>] [--all]          the same state printed once — for pipes,
                                       logs, and anywhere there is no terminal

WORK
  wecode assign <task> --to <post>     check the post may do it, then make it ready
  wecode start <task> [--json]         worktree + envelope; marks it running
                                       --json emits the A2A task instead of prose
  wecode tick                          promote waiting tasks whose work is unblocked
  wecode loop [--once]                 tick, then dispatch what is ready, forever
        also closes a run whose supervisor has stopped reporting for 5 minutes,
        confirmed a minute later: the task goes to failed for a person to retry;
        nothing is killed, no worktree is removed, nothing is re-dispatched
  wecode run <task>                    spawn its agent, supervise it, then verify
  wecode cost <task> \"<what was done>\"  attribute work wecode never dispatched
        --tokens <n>  --wall <secs>  --replayed <n>    at least one of the first two
        for a task worked in your own session, or a step done by hand in a console:
        filed as an attempt of its own, in your name, stated rather than measured.
        Every view marks it as stated; no metered row is touched
  wecode verify <task>                 judge it: diff against scope, then acceptance
  wecode merge <task>                  land it on the integration branch, and report
        the worktree comes down once nothing still works in it; the branch stays
        the report is committed to docs/wecode/<task>/report.md, on the target
        a repo with `installs` set also gets its executable built from the merge
        commit and moved to that path — reported, and unable to fail the merge
  wecode rollback <task>               revert that merge; the report says when to
  wecode install [--repo <name>]       build the integration branch and install what
        it produces, at the `installs` path in company.toml. The same step a merge
        runs: for the first install, and for retrying one a merge declined
  wecode worktree                      list them, grouped by repository
  wecode worktree remove <task|path>   take one down (--force if dirty)
        a path reaches the trees no task can: an orphan's, and the merge scratch
  wecode approve <merge|admission|design|budget|measure> [<what>] --as <post>
        approve design --task <id>      signs a design off: needs-approval → done
        approve admission --task <id>   signs a task for dispatch, where its playbook
                                        says dispatch = \"approved\"
  wecode telegram [--dry-run]          sign what the replies in Telegram approved
        needs [telegram] fetch and a telegram id on the user who replies; `loop`
        reads the channel every pass on its own
        a reply names a task by id or by `#4` — the `#` is required in a chat, where
        a bare number is as likely to be prose
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
        ("templates", _) => Ok(render::org::templates()),
        ("doctor", _) => doctor::run(a),
        ("company", "show") | ("org", "show") => {
            let (_, company) = open(a)?;
            Ok(render::org::company(&company))
        }
        ("project", "add") => project_add(a),
        ("project", "list") | ("projects", _) => {
            let (store, _) = open(a)?;
            Ok(render::plan::tree(&store.load_plan()?, a.has("all")))
        }
        ("task", "add") => task_add(a),
        ("task", "rm") => task_rm(a),
        ("task", "scope") => task_scope(a),
        ("task", "budget") => task_budget(a),
        ("map", _) => codemap::command(a),
        ("tree", _) => {
            let (store, _) = open(a)?;
            Ok(render::plan::tree(&store.load_plan()?, a.has("all")))
        }
        ("ready", _) => {
            let (store, _) = open(a)?;
            Ok(render::plan::ready(&store.load_plan()?))
        }
        ("playbook", "init") => playbook_init(a),
        ("playbook", "gap") => playbook_gap(a),
        ("playbook", "gaps") => playbook_gaps(a),
        ("playbook", _) => playbook_show(a),
        ("brief", _) => brief(a),
        ("start", _) => start(a),
        ("verify", _) => verify_task(a),
        ("merge", _) => merge_task(a),
        ("rollback", _) => rollback_task(a),
        ("install", _) => install_now(a),
        ("run", _) => run_task(a),
        ("cost", _) => cost(a),
        // Absent from USAGE above, and that is a scope defect rather than a decision:
        // `docs/reference/commands.md` is `wecode help` verbatim and a test holds it
        // to that, and this task may not write outside `crates/**`. Adding the entry
        // here would have failed the suite every other task in this repo runs as its
        // acceptance. `wecode doctor` names the command in its report meanwhile.
        ("reclaim", _) => reclaim::command(a),
        ("tick", _) => tick(a),
        ("loop", _) | ("serve", _) => serve(a),
        ("worktree", "remove") | ("worktree", "rm") => worktree_remove(a),
        ("worktree", _) => worktree_list(a),
        ("archive", _) => set_archived(a, true),
        ("unarchive", _) => set_archived(a, false),
        ("sweep", _) => sweep(a),
        ("show", _) => show(a),
        ("check", _) => check(a),
        ("status", _) => set_status(a),
        ("board", _) => board_snapshot(a),
        // `up` and `cockpit` are what it was called before there was one application
        // to name: a rename that breaks muscle memory is a tax with no revenue.
        ("tui", _) | ("up", _) | ("cockpit", _) => cockpit(a),
        ("assign", _) => assign(a),
        ("use", _) => use_org(a),
        ("orgs", _) => Ok(render::org::orgs()),
        ("login", _) => login(a),
        ("logout", _) => logout(a),
        ("who", _) => who(a),
        ("whoami", _) => whoami(a),
        ("approve", _) => approve(a),
        ("telegram", _) => inbox(a),
        ("guard", _) => guard(a),
        ("audit", _) => audit(a),
        ("", _) | ("help", _) | ("--help", _) => Ok(USAGE.to_string()),
        (cmd, sub) => Err(format!("unknown command `{cmd} {sub}`\n\n{USAGE}").into()),
    }
}
