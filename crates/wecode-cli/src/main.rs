//! `wecode` — the single control driver.

mod args;
mod org;
mod render;

use std::process::ExitCode;

use args::Args;
use wecode_core::{Admission, Budget, Cmp, Intent, IntentId, Link, Measure, Scope, Sphere};
use wecode_gov::{Action, Broker, Session};
use wecode_store::{Store, horizon_from_str, intent_kind_from_str, standalone_reason_from_str};

const USAGE: &str = "\
wecode — run coding agents as staff

USAGE
  wecode intent add <kind> <id> \"<statement>\"   kind: vision|goal|project|task
        --parent <id>            what this serves
        --link <requires|alternative|contributes>
        --standalone <maintenance|urgent|exploration|personal>
        --measure-cmd \"<cmd>\"    executable acceptance (repeatable)
        --measure-metric <name>:<lt|lte|gt|gte|eq>:<target>
        --write <glob>           writable paths (repeatable)
        --read <glob>            readable paths (repeatable)
        --tokens <n>  --wall <secs>
        --horizon <now|week|month|quarter|year|indefinite>
        --personal               personal rather than org sphere
        --force                  admit despite defects (recorded as a waiver)

  wecode intent tree                   the whole hierarchy
  wecode intent show <id>              lineage: what this serves
  wecode intent check <id>             admission verdict and questions
  wecode intent link <id> --parent <p> resolve drift

  wecode org show                      posts, occupants and what each may do

  wecode guard <post> <verb> <target>  authorise an action; records the decision
        verbs: read write run merge spend
        --intent <id>   which intent this is for
        --tokens <n>    for `spend`

  wecode audit                         the ledger, newest last
        --denied   refused actions only
        --alarms   invariant violations only
        --path <glob>   who touched these paths, any agent

ENVIRONMENT
  WECODE_HOME   state directory (default $XDG_STATE_HOME/wecode)
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

fn run(a: &Args) -> Result<String, Box<dyn std::error::Error>> {
    let store = Store::open(Store::default_root())?;

    match (a.cmd(0), a.cmd(1)) {
        ("intent", "add") => intent_add(a, &store),
        ("intent", "tree") => Ok(render::tree(&store.load_tree()?)),
        ("intent", "show") => {
            let id = require(a.cmd(2), "intent id")?;
            Ok(render::lineage(&store.load_tree()?, &IntentId::new(id)))
        }
        ("intent", "check") => intent_check(a, &store),
        ("intent", "link") => intent_link(a, &store),
        ("org", "show") => Ok(org_show()),
        ("guard", _) => guard(a, &store),
        ("audit", _) => audit(a, &store),
        ("", _) | ("help", _) | ("--help", _) => Ok(USAGE.to_string()),
        (cmd, sub) => Err(format!("unknown command `{cmd} {sub}`\n\n{USAGE}").into()),
    }
}

fn require<'a>(value: &'a str, what: &str) -> Result<&'a str, String> {
    if value.is_empty() {
        Err(format!("missing {what}"))
    } else {
        Ok(value)
    }
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

fn intent_add(a: &Args, store: &Store) -> Result<String, Box<dyn std::error::Error>> {
    let intent = build_intent(a)?;
    let tree = store.load_tree()?;

    let verdict = Admission::decide(&intent, &tree, "operator", Vec::new());
    let mut out = render::admission(&intent, &verdict);

    if verdict.is_admitted() || a.has("force") {
        // Insert into a scratch tree first so a grammar violation is caught before
        // anything is written. The log is append-only; a bad line stays forever.
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

fn intent_check(a: &Args, store: &Store) -> Result<String, Box<dyn std::error::Error>> {
    let id = IntentId::new(require(a.cmd(2), "intent id")?);
    let tree = store.load_tree()?;
    let intent = tree
        .get(&id)
        .ok_or_else(|| format!("no such intent: {id}"))?;
    let verdict = Admission::check(intent, &tree);
    Ok(render::admission(intent, &verdict))
}

fn org_show() -> String {
    let mut out = String::from("post        occupant      role       writes\n");
    for p in org::posts() {
        let writes = if p.grant.write.is_empty() {
            "— (read only)".to_string()
        } else {
            p.grant.write.join(", ")
        };
        out.push_str(&format!(
            "{:<11} {:<13} {:<10} {}\n",
            p.name, p.occupant, p.role, writes
        ));
    }
    out.push_str("\ninvariants outrank every grant above:\n");
    for inv in &org::charter().invariants {
        out.push_str(&format!("  {inv:?}\n"));
    }
    out
}

/// Builds the action named on the command line.
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

fn guard(a: &Args, store: &Store) -> Result<String, Box<dyn std::error::Error>> {
    let post_name = require(a.cmd(1), "post")?;
    let post = org::find(post_name).ok_or_else(|| {
        format!(
            "no such post `{post_name}` — try one of: {}",
            org::posts()
                .iter()
                .map(|p| p.name)
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    let action = parse_action(a)?;
    let intent = IntentId::new(a.get("intent").unwrap_or("unassigned"));

    let mut broker = Broker::new(org::charter());
    let session = Session::new(
        format!("cli-{post_name}"),
        post.name,
        post.occupant,
        intent,
        org::effective(&post),
    );
    let decision = broker.authorize(&session, &action);

    // Every decision is recorded, allowed or not.
    store.append_records(broker.ledger())?;
    Ok(render::decision(
        &post.name,
        &post.occupant,
        &action,
        &decision,
    ))
}

fn audit(a: &Args, store: &Store) -> Result<String, Box<dyn std::error::Error>> {
    let mut lines = store.load_audit()?;

    if a.has("denied") {
        lines.retain(wecode_store::AuditLine::is_denial);
    }
    if a.has("alarms") {
        lines.retain(wecode_store::AuditLine::is_alarm);
    }
    if let Some(pattern) = a.get("path") {
        lines.retain(|l| {
            matches!(l.action.as_str(), "read" | "write")
                && wecode_gov::glob::matches(pattern, &l.target)
        });
    }
    Ok(render::audit(&lines))
}

fn intent_link(a: &Args, store: &Store) -> Result<String, Box<dyn std::error::Error>> {
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
