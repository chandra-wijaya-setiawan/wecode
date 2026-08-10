//! `wecode` — the single control driver.

mod args;
mod render;

use std::process::ExitCode;

use args::Args;
use wecode_core::{Admission, Budget, Cmp, Intent, IntentId, Link, Measure, Scope, Sphere, Status};
use wecode_gov::{Action, Broker, Session, glob};
use wecode_org::{Company, Post, Workspace, workspace};
use wecode_store::{Store, horizon_from_str, intent_kind_from_str, standalone_reason_from_str};

const USAGE: &str = "\
wecode — run coding agents as staff

A company is a self-contained directory: profile, roles, posts, agent templates
and state. It is not a code repository; the repos it works on are declared inside
it by path.

SETUP
  wecode init <dir> [--template <name>]   scaffold a company workspace
  wecode templates                        list available templates
  wecode company show                     profile, posts, invariants

  Commands find the workspace by walking up from the working directory, or via
  --org <dir> / $WECODE_ORG.

INTENT
  wecode intent add <kind> <id> \"<statement>\"   kind: vision|goal|project|task
        --parent <id> | --standalone <maintenance|urgent|exploration|personal>
        --link <requires|alternative|contributes>
        --measure-cmd \"<cmd>\"        executable acceptance (repeatable)
        --measure-metric <name>:<lt|lte|gt|gte|eq>:<target>
        --write <glob>  --read <glob>   scope (repeatable)
        --tokens <n>  --wall <secs>
        --horizon <now|week|month|quarter|year|indefinite>
        --personal  --force
  wecode intent tree | show <id> | check <id>
  wecode intent link <id> --parent <p>

WORK
  wecode assign <intent> --to <post>   check the post may do it, then activate
  wecode guard <post> <verb> <target>  authorise an action; records the decision
        verbs: read write run merge spend        --tokens <n> for spend
  wecode audit [--denied] [--alarms] [--path <glob>]
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

type Res = Result<String, Box<dyn std::error::Error>>;

fn run(a: &Args) -> Res {
    match (a.cmd(0), a.cmd(1)) {
        ("init", _) => init(a),
        ("templates", _) => Ok(render::templates()),
        ("company", "show") | ("org", "show") => {
            let (_, company) = open(a)?;
            Ok(render::company(&company))
        }
        ("intent", "add") => intent_add(a),
        ("intent", "tree") => {
            let (store, _) = open(a)?;
            Ok(render::tree(&store.load_tree()?))
        }
        ("intent", "show") => {
            let (store, _) = open(a)?;
            let id = require(a.cmd(2), "intent id")?;
            Ok(render::lineage(&store.load_tree()?, &IntentId::new(id)))
        }
        ("intent", "check") => intent_check(a),
        ("intent", "link") => intent_link(a),
        ("assign", _) => assign(a),
        ("guard", _) => guard(a),
        ("audit", _) => audit(a),
        ("", _) | ("help", _) | ("--help", _) => Ok(USAGE.to_string()),
        (cmd, sub) => Err(format!("unknown command `{cmd} {sub}`\n\n{USAGE}").into()),
    }
}

/// Resolves the workspace, then its state store and validated profile.
fn open(a: &Args) -> Result<(Store, Company), Box<dyn std::error::Error>> {
    let ws = workspace::resolve(a.get("org"))?;
    let company = ws.load()?;
    let store = Store::open(ws.state_dir())?;
    Ok((store, company))
}

fn require<'a>(value: &'a str, what: &str) -> Result<&'a str, String> {
    if value.is_empty() {
        Err(format!("missing {what}"))
    } else {
        Ok(value)
    }
}

fn init(a: &Args) -> Res {
    let dir = require(a.cmd(1), "target directory")?;
    let template = a.get("template").unwrap_or("software-company");
    let root = wecode_org::expand_home(dir);

    let written = workspace::init(&root, template)?;
    let company = Workspace::at(&root).load()?;

    let mut out = format!("created {} from template `{template}`\n\n", root.display());
    for p in &written {
        out.push_str(&format!("  {}\n", p.display()));
    }
    out.push_str(&format!(
        "\n{} — {} posts, {} roles\n\nnext:\n  cd {}\n  wecode company show\n  edit company.toml, then point [[repos]] at your code\n",
        company.name,
        company.posts.len(),
        company.roles.len(),
        root.display()
    ));
    Ok(out)
}

/// Builds an intent from flags. Nothing here decides admissibility.
fn build_intent(a: &Args) -> Result<Intent, Box<dyn std::error::Error>> {
    let kind = intent_kind_from_str(require(a.cmd(2), "kind")?)?;
    let id = require(a.cmd(3), "id")?;
    let statement = require(a.cmd(4), "statement")?;

    let mut intent = Intent::new(IntentId::new(id), kind, statement);

    if let Some(parent) = a.get("parent") {
        let link = match a.get("link").unwrap_or("requires") {
            "alternative" => Link::Alternative,
            "contributes" => Link::Contributes {
                rationale: a.get("rationale").unwrap_or("").to_string(),
                polarity: wecode_core::Polarity::Positive,
            },
            _ => Link::Requires,
        };
        intent = intent.under(IntentId::new(parent), link);
    } else if let Some(reason) = a.get("standalone") {
        intent = intent.standalone(standalone_reason_from_str(reason)?);
    }

    for cmd in a.all("measure-cmd") {
        intent = intent.measured(Measure::Command {
            cmd: cmd.to_string(),
            expect_status: 0,
        });
    }
    for spec in a.all("measure-metric") {
        intent = intent.measured(parse_metric(spec)?);
    }

    let read: Vec<&str> = a.all("read");
    let write: Vec<&str> = a.all("write");
    if !read.is_empty() || !write.is_empty() {
        intent = intent.scoped(Scope {
            read: read.iter().map(|s| (*s).to_string()).collect(),
            write: write.iter().map(|s| (*s).to_string()).collect(),
        });
    }
    if a.has("tokens") || a.has("wall") {
        intent = intent.budgeted(Budget {
            tokens: a.num("tokens"),
            wall_secs: a.num("wall"),
        });
    }
    if let Some(h) = a.get("horizon") {
        intent = intent.horizon(horizon_from_str(h)?);
    }
    if a.has("personal") {
        intent = intent.sphere(Sphere::Personal);
    }
    Ok(intent)
}

fn parse_metric(spec: &str) -> Result<Measure, String> {
    let parts: Vec<&str> = spec.split(':').collect();
    if parts.len() != 3 {
        return Err(format!(
            "--measure-metric wants <name>:<cmp>:<target>, got `{spec}`"
        ));
    }
    let cmp = match parts[1] {
        "lt" => Cmp::Lt,
        "lte" => Cmp::Lte,
        "gt" => Cmp::Gt,
        "gte" => Cmp::Gte,
        "eq" => Cmp::Eq,
        other => return Err(format!("unknown comparison `{other}`")),
    };
    let target: f64 = parts[2]
        .parse()
        .map_err(|_| format!("target `{}` is not a number", parts[2]))?;
    Ok(Measure::Metric {
        name: parts[0].to_string(),
        target,
        cmp,
    })
}

fn intent_add(a: &Args) -> Res {
    let (store, _) = open(a)?;
    let intent = build_intent(a)?;
    let tree = store.load_tree()?;

    let verdict = Admission::decide(&intent, &tree, "operator", Vec::new());
    let mut out = render::admission(&intent, &verdict);

    if verdict.is_admitted() || a.has("force") {
        // Probe a scratch tree first: the log is append-only, so a grammar
        // violation must be caught before anything is written.
        let mut probe = tree;
        probe.insert(intent.clone())?;
        store.append_intent(&intent)?;

        if a.has("force") && !verdict.is_admitted() {
            out.push_str("\n  forced — defects recorded as waivers\n");
        }
        out.push_str(&format!("\n  saved {}\n", intent.id));
    } else {
        out.push_str("\n  not saved — answer the above, or pass --force\n");
    }
    Ok(out)
}

fn intent_check(a: &Args) -> Res {
    let (store, _) = open(a)?;
    let id = IntentId::new(require(a.cmd(2), "intent id")?);
    let tree = store.load_tree()?;
    let intent = tree
        .get(&id)
        .ok_or_else(|| format!("no such intent: {id}"))?;
    let verdict = Admission::check(intent, &tree);
    Ok(render::admission(intent, &verdict))
}

fn intent_link(a: &Args) -> Res {
    let (store, _) = open(a)?;
    let id = IntentId::new(require(a.cmd(2), "intent id")?);
    let parent = IntentId::new(require(a.get("parent").unwrap_or(""), "--parent")?);

    let mut tree = store.load_tree()?;
    tree.reparent(&id, Some(parent.clone()))?;

    let mut updated = tree
        .get(&id)
        .ok_or_else(|| format!("no such intent: {id}"))?
        .clone();
    updated.link = Link::Requires;
    store.append_intent(&updated)?;

    Ok(format!("  linked {id} under {parent}\n"))
}

/// Assigns an admitted intent to a post — the chief's job.
///
/// The load-bearing check is the last one: a post whose grant does not cover the
/// intent's write scope cannot legally do the work, so assigning it guarantees a
/// scope rejection later. Catching that here is deterministic and cheap.
fn assign(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let id = IntentId::new(require(a.cmd(1), "intent id")?);
    let post_name = require(a.get("to").unwrap_or(""), "--to <post>")?;
    let post = find_post(&company, post_name)?;

    let tree = store.load_tree()?;
    let intent = tree
        .get(&id)
        .ok_or_else(|| format!("no such intent: {id}"))?;

    if !intent.kind.is_assignable() {
        return Err(format!(
            "a {} is not assignable — it is reached by satisfying its children",
            intent.kind.as_str()
        )
        .into());
    }
    let verdict = Admission::check(intent, &tree);
    if !verdict.defects().is_empty() {
        let mut out = render::admission(intent, &verdict);
        out.push_str("\n  not assigned — a draft cannot be dispatched\n");
        return Ok(out);
    }

    let grant = company
        .grant_of(&post)
        .ok_or_else(|| format!("post `{post_name}` has no role grant"))?;
    let uncovered: Vec<&str> = intent
        .scope
        .write
        .iter()
        .filter(|w| !grant.write.iter().any(|g| glob::covers(g, w)))
        .map(String::as_str)
        .collect();

    if !uncovered.is_empty() {
        return Err(format!(
            "post `{post_name}` (role {}) may not write {} — it writes only: {}\n\
             \x20 assign a post whose scope covers the work, or widen the role",
            post.role,
            uncovered.join(", "),
            if grant.write.is_empty() {
                "nothing".to_string()
            } else {
                grant.write.join(", ")
            }
        )
        .into());
    }

    let mut activated = intent.clone();
    activated.status = Status::Active;
    store.append_intent(&activated)?;
    record(&store, &company, &post, &Action::Staff)?;

    Ok(format!(
        "  assigned {id} to {post_name} ({}, occupied by {})\n  status: active\n",
        post.role, post.agent
    ))
}

fn find_post(company: &Company, name: &str) -> Result<Post, String> {
    company.post(name).cloned().ok_or_else(|| {
        format!(
            "no such post `{name}` — have: {}",
            company
                .posts
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

/// Runs one action past the Broker under a post's authority, and records it.
fn record(
    store: &Store,
    company: &Company,
    post: &Post,
    action: &Action,
) -> Result<wecode_gov::Decision, Box<dyn std::error::Error>> {
    let mut broker = Broker::new(company.charter.clone());
    let session = Session::new(
        format!("cli-{}", post.name),
        post.name.clone(),
        post.agent.clone(),
        IntentId::new("cli"),
        company.effective(post),
    );
    let decision = broker.authorize(&session, action);
    store.append_records(broker.ledger())?;
    Ok(decision)
}

fn parse_action(a: &Args) -> Result<Action, String> {
    let verb = a.cmd(2);
    let target = a.cmd(3);
    Ok(match verb {
        "read" => Action::Read {
            path: require(target, "path")?.to_string(),
        },
        "write" => Action::Write {
            path: require(target, "path")?.to_string(),
        },
        "run" => Action::Run {
            argv: require(target, "command")?
                .split_whitespace()
                .map(str::to_string)
                .collect(),
        },
        "merge" => Action::Merge {
            branch: require(target, "branch")?.to_string(),
        },
        "spend" => Action::Spend {
            tokens: a.num("tokens").unwrap_or(0),
            wall_secs: a.num("wall").unwrap_or(0),
        },
        other => {
            return Err(format!(
                "unknown verb `{other}` (read write run merge spend)"
            ));
        }
    })
}

fn guard(a: &Args) -> Res {
    let (store, company) = open(a)?;
    let post = find_post(&company, require(a.cmd(1), "post")?)?;
    let action = parse_action(a)?;
    let decision = record(&store, &company, &post, &action)?;
    Ok(render::decision(
        &post.name,
        &post.agent,
        &action,
        &decision,
    ))
}

fn audit(a: &Args) -> Res {
    let (store, _) = open(a)?;
    let mut lines = store.load_audit()?;

    if a.has("denied") {
        lines.retain(wecode_store::AuditLine::is_denial);
    }
    if a.has("alarms") {
        lines.retain(wecode_store::AuditLine::is_alarm);
    }
    if let Some(pattern) = a.get("path") {
        lines.retain(|l| {
            matches!(l.action.as_str(), "read" | "write") && glob::matches(pattern, &l.target)
        });
    }
    Ok(render::audit(&lines))
}
