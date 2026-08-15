//! The workspaces on this machine, the company inside one, and what a seat is told
//! when it starts work.
//!
//! Every claim here is derived from the charter and the grants rather than stored: a
//! briefing that asserted an authority of its own would keep asserting it after a role
//! was narrowed, and the Broker would then refuse what the briefing promised. So the
//! permissions come from the grant, the prohibitions from the charter, and a seat that
//! reads its own briefing is reading the same two files the Broker will judge it by.

use std::time::Duration;

use wecode_core::{Plan, Project, Task};
use wecode_gov::{Grant, Invariant, WorkKind};
use wecode_org::{Company, Intelligence, Post};
use wecode_store::SessionInfo;

use super::ago;
use super::gov::available_commands;

/// Available org templates.
#[must_use]
pub(crate) fn templates() -> String {
    let mut out = String::from("templates:\n");
    for t in wecode_org::template::all() {
        out.push_str(&format!("  {:<18} {}\n", t.name, t.summary));
    }
    out.push_str("\n  wecode init <dir> --template <name>\n");
    out
}

/// Named orgs, and which is the default.
#[must_use]
pub(crate) fn orgs() -> String {
    let found = wecode_org::workspace::list();
    if found.is_empty() {
        return format!(
            "no orgs yet in {}\n  wecode init <name>\n",
            wecode_org::workspace::workspaces_root().display()
        );
    }
    let default = wecode_org::workspace::default_workspace();
    let mut out = String::new();
    for (name, ws) in found {
        let mark = if default.as_ref().is_some_and(|d| d.root() == ws.root()) {
            "*"
        } else {
            " "
        };
        let title = ws.load().map_or_else(
            |e| format!("⚠ {e}"),
            |c| format!("{} ({} posts)", c.name, c.posts.len()),
        );
        out.push_str(&format!("{mark} {name:<14} {title}\n"));
    }
    out.push_str("\n* = default. wecode use <name> to change.\n");
    out
}

/// The company profile: who exists, what they may do, what outranks them.
#[must_use]
pub(crate) fn company(c: &Company) -> String {
    let mut out = format!("{}  ({} profile)\n", c.name, c.profile);
    if !c.description.is_empty() {
        for line in c.description.lines() {
            out.push_str(&format!("  {line}\n"));
        }
    }
    if !c.vision.is_empty() {
        out.push_str(&format!("\nvision: {}\n", c.vision));
    }

    out.push_str("\nposts\n");
    out.push_str(&format!(
        "  {:<10} {:<11} {:<14} {:<18} {}\n",
        "post", "role", "agent", "model", "writes"
    ));
    for p in &c.posts {
        let writes = match c.grant_of(p) {
            Some(g) if g.write.is_empty() => "— (read only)".to_string(),
            Some(g) => g.write.join(", "),
            None => "?? unknown role".to_string(),
        };
        // The level *and* what it resolved to. Either alone is half the answer: the
        // number is what the file says, the name is what will actually be launched, and
        // the whole point of the level is that the name is not written down anywhere.
        let model = match (c.model_for(p), c.intelligence_of(p)) {
            (Some(m), Some(i)) => format!("{m} ({i})"),
            _ => "— harness default".to_string(),
        };
        out.push_str(&format!(
            "  {:<10} {:<11} {:<14} {:<18} {}\n",
            p.name, p.role, p.agent, model, writes
        ));
    }
    // The catalogue the numbers above are matched against, weakest first, with the
    // level each answers up to. Without it the column reads as a model chosen by magic.
    let ranked: Vec<_> = c
        .agents
        .iter()
        .filter(|(_, a)| !a.models.is_empty())
        .collect();
    if !ranked.is_empty() {
        out.push_str("\nmodels, weakest first\n");
        for (name, a) in ranked {
            let scale: Vec<String> = a
                .models
                .iter()
                .enumerate()
                .map(|(i, m)| format!("{m} ≤{}", Intelligence::of_rank(i, a.models.len())))
                .collect();
            out.push_str(&format!("  {:<14} {}\n", name, scale.join(", ")));
        }
    }

    if let Some(chief) = c.chief() {
        out.push_str(&format!(
            "\nchief of staff: {} — configures and assigns; cannot write or run\n",
            chief.name
        ));
    } else {
        out.push_str("\n⚠ no chief post: nothing can assign work\n");
    }

    if c.repos.is_empty() {
        out.push_str("\n⚠ no [[repos]] declared — nothing to work on yet\n");
    } else {
        out.push_str("\nrepos\n");
        for r in &c.repos {
            out.push_str(&format!("  {:<10} {}\n", r.name, r.path));
        }
    }

    out.push_str(&format!(
        "\nattention: {} open items, {} interrupts/hour, digest every {}m\n",
        c.attention.max_open_items,
        c.attention.max_interrupts_per_hour,
        c.attention.digest_interval_mins
    ));
    // Shown either way. A hook that is not there is the thing an operator wondering
    // why nothing told them needs to read, and silence would look like the same
    // silence they are already complaining about.
    match &c.notify.command {
        Some(cmd) => out.push_str(&format!(
            "notify:    {cmd} — when a task starts waiting, killed after {}s\n",
            c.notify.timeout.as_secs()
        )),
        None => out.push_str("notify:    nothing — no [notify] command; waits are silent\n"),
    }
    // And the way back, on the same terms. "I replied and nothing happened" has two
    // answers — nothing reads the channel, or nothing knows the account that replied —
    // and both are here rather than in a log somewhere.
    match &c.telegram.fetch {
        Some(cmd) => {
            out.push_str(&format!(
                "replies:   {cmd} — read every pass of `wecode loop`, killed after {}s\n",
                c.telegram.timeout.as_secs()
            ));
            let mut signers: Vec<&str> = c
                .users
                .iter()
                .filter(|u| u.telegram.is_some())
                .map(|u| u.name.as_str())
                .collect();
            signers.sort_unstable();
            match signers.as_slice() {
                [] => out.push_str(
                    "           nobody may sign by reply — no [[users]] entry names a telegram id\n",
                ),
                names => out.push_str(&format!("           signed by: {}\n", names.join(", "))),
            }
        }
        None => out.push_str("replies:   nothing — no [telegram] fetch; approvals are typed\n"),
    }

    out.push_str("\ninvariants (outrank every grant above)\n");
    for inv in &c.charter.invariants {
        out.push_str(&format!("  {}\n", invariant_line(inv)));
    }
    // Listed with the others, though it is not a `Charter` invariant: it is checked at
    // load rather than judged per action, and an operator reading this block wants the
    // whole ceiling and not the part that happens to be enforced at run time.
    if let Some(cap) = c.max_intelligence {
        // Spelled in full rather than padded to the column the others share: this one
        // is the name of a key somebody has to find in a file, and an abbreviation that
        // aligned prettily would be a worse thing to search for.
        out.push_str(&format!("  max intelligence {cap}\n"));
    }
    out
}

fn invariant_line(inv: &Invariant) -> String {
    match inv {
        Invariant::NeverTouch(v) => format!("never touch    {}", v.join(", ")),
        Invariant::NeverRun(v) => format!("never run      {}", v.join(", ")),
        Invariant::ApprovalToMerge(v) => format!("approve merge  {}", v.join(", ")),
        Invariant::MaxTokens(n) => format!("max tokens     {n}"),
        Invariant::MaxWallSecs(n) => format!("max wall       {n}s"),
    }
}

/// The current seat, and what it may do.
#[must_use]
pub(crate) fn whoami(
    company: &Company,
    s: &SessionInfo,
    post: &Post,
    grant: Option<&Grant>,
) -> String {
    let mut out = format!(
        "{}  ·  {}\n  seat     {} ({})\n  who      {}\n",
        company.name,
        s.id,
        post.name,
        post.role,
        s.who()
    );

    let Some(g) = grant else {
        out.push_str("\n  ⚠ role has no grant — this seat can do nothing\n");
        return out;
    };

    if !g.write.is_empty() {
        out.push_str(&format!("  writes   {}\n", g.write.join(", ")));
    }
    if let Some(t) = g.tokens {
        out.push_str(&format!("  budget   {t} tokens\n"));
    }

    out.push_str("\ncommands\n");
    for (cmd, note) in available_commands(g) {
        out.push_str(&format!("  {cmd:<28} {note}\n"));
    }
    out
}

/// Everything connected right now.
#[must_use]
pub(crate) fn who(sessions: &[SessionInfo], ttl: Duration, now: u64) -> String {
    if sessions.is_empty() {
        return "nobody connected — wecode login <user>\n".to_string();
    }
    let mut out = format!(
        "{:<11} {:<10} {:<24} {:<7} {:<7} {}\n",
        "session", "post", "who", "age", "idle", "state"
    );
    for s in sessions {
        let expired = s.is_expired(ttl, now);
        out.push_str(&format!(
            "{:<11} {:<10} {:<24} {:<7} {:<7} {}\n",
            s.id,
            s.post,
            s.who(),
            ago(s.age_secs(now)),
            ago(s.idle_secs(now)),
            if expired {
                "expired"
            } else if s.is_autonomous() {
                "working"
            } else {
                "live"
            }
        ));
    }
    out
}

/// What an agent needs to act as this seat.
///
/// Every claim is derived: the permissions come from the grant, the prohibitions from
/// the charter. A stored prompt would keep asserting authority after a role was
/// narrowed, and the Broker would then refuse what the briefing promised.
#[must_use]
pub(crate) fn brief(
    company: &Company,
    s: &SessionInfo,
    post: &Post,
    grant: Option<&Grant>,
    plan: &Plan,
    playbooks: &[(Project, Vec<&str>)],
    org: String,
) -> String {
    let mut out = format!(
        "You are working in {} as `{}` ({}), through {}.\n",
        company.name, post.name, post.role, post.agent
    );
    if let Some(h) = &s.human {
        out.push_str(&format!("The person in this seat is {h}.\n"));
    }
    if !company.vision.is_empty() {
        out.push_str(&format!("\n{}\n", company.vision));
    }

    let Some(g) = grant else {
        out.push_str("\n  ⚠ this role has no grant — the seat can do nothing\n");
        return out;
    };

    out.push_str("\nYOU MAY\n");
    for (cmd, note) in available_commands(g) {
        out.push_str(&format!("  {cmd:<26} {note}\n"));
    }
    if !g.write.is_empty() {
        out.push_str(&format!("  {:<26} {}\n", "write", g.write.join(", ")));
    }
    if !g.run.is_empty() {
        out.push_str(&format!("  {:<26} {}\n", "run", g.run.join(", ")));
    }

    // Stated explicitly, because an absent capability is invisible otherwise and the
    // agent would discover it as a refusal mid-task.
    out.push_str("\nYOU MAY NOT\n");
    if g.write.is_empty() {
        out.push_str("  write files                this seat assigns, it does not execute\n");
    }
    if g.run.is_empty() {
        out.push_str("  run commands\n");
    }
    out.push_str("  commit or merge            wecode does both, after checks pass\n");

    out.push_str("\nNEVER — charter invariants, which outrank every grant above\n");
    for inv in &company.charter.invariants {
        out.push_str(&format!("  {}\n", invariant_line(inv)));
    }

    out.push_str("\nPROJECTS\n");
    if playbooks.is_empty() {
        out.push_str("  none yet\n");
    }
    for (p, kinds) in playbooks {
        let total = plan.tasks_of(&p.id).count();
        out.push_str(&format!(
            "  {:<14} [{}]  {} task{}, {:.0}%   playbook: {}\n",
            p.id.to_string(),
            p.repo,
            total,
            if total == 1 { "" } else { "s" },
            plan.progress(&p.id) * 100.0,
            if kinds.is_empty() {
                "none — wecode playbook init".to_string()
            } else {
                kinds.join(" ")
            }
        ));
    }

    let ready: Vec<&Task> = plan.ready_tasks().collect();
    let waiting: Vec<&Task> = plan.tasks().filter(|t| t.status.needs_a_human()).collect();

    out.push_str("\nHOW TO WORK\n");
    if g.define.contains(&WorkKind::Task) {
        out.push_str(
            "  1  wecode playbook <kind>      read the project's guidance FIRST\n\
             \x20 2  wecode task add ...         one atomic task per outcome\n\
             \x20 3  wecode assign <t> --to <p>  admit it to the queue\n\
             \x20 4  wecode start <t>            worktree + envelope for the worker\n\
             \x20 5  wecode playbook gap \"...\"   when step 1 did not tell you something\n\
             \x20                                it should have. It reaches the next planner.\n",
        );
    } else {
        out.push_str(
            "  1  wecode ready                what you may pick up\n\
             \x20 2  wecode start <task>         your worktree and instructions\n\
             \x20 3  wecode show <task>          the acceptance you are judged by\n",
        );
    }
    out.push_str(&format!(
        "\n  {} ready · {} needs a human · worktrees under ~/.wecode/run/{}\n",
        ready.len(),
        waiting.len(),
        org
    ));
    if !waiting.is_empty() {
        for t in waiting.iter().take(5) {
            out.push_str(&format!(
                "    {} {}  {}\n",
                t.status.mark(),
                t.id,
                t.status.as_str()
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A company whose one seat is staffed at `level`, with whatever ceiling is passed.
    fn levelled(level: &str, ceiling: &str) -> Company {
        Company::parse(&format!(
            "[company]\nname = \"cws\"\n{ceiling}\n\
             [roles.engineer]\nwrite = [\"src/**\"]\n\n\
             [agents.claude-code]\ncommand = \"claude\"\n\
             models = [\"haiku\", \"sonnet\", \"opus\", \"fable\"]\n\n\
             [[posts]]\nname = \"impl\"\nrole = \"engineer\"\nagent = \"claude-code\"\n\
             intelligence = {level}\n"
        ))
        .expect("parses")
    }

    #[test]
    fn a_seat_names_the_model_its_level_resolved_to() {
        // Both halves: the number is what the file says, the name is what will be
        // launched, and a column with only one of them answers half the question.
        let out = company(&levelled("7.5", ""));
        assert!(out.contains("opus (7.5)"), "{out}");
        // The catalogue it was matched against, so the column is not magic.
        assert!(
            out.contains("haiku ≤2.5, sonnet ≤5, opus ≤7.5, fable ≤10"),
            "{out}"
        );
        assert!(
            !out.contains("max intelligence"),
            "no ceiling was declared: {out}"
        );
    }

    #[test]
    fn a_declared_ceiling_is_listed_with_the_invariants_it_belongs_to() {
        // It is not a `Charter` invariant — it is checked at load rather than judged
        // per action — but an operator reading this block wants the whole ceiling.
        let out = company(&levelled("5", "[invariants]\nmax_intelligence = 5\n"));
        assert!(out.contains("max intelligence 5"), "{out}");
        assert!(out.contains("sonnet (5)"), "{out}");
    }

    #[test]
    fn a_seat_with_no_level_says_so_rather_than_leaving_the_column_blank() {
        // "claude" alone reads as a complete answer to what ran. It is not one.
        let c = Company::parse(
            "[company]\nname = \"cws\"\n\n[roles.engineer]\nwrite = [\"src/**\"]\n\n\
             [agents.claude-code]\ncommand = \"claude\"\n\n\
             [[posts]]\nname = \"impl\"\nrole = \"engineer\"\nagent = \"claude-code\"\n",
        )
        .expect("parses");
        let out = company(&c);
        assert!(out.contains("harness default"), "{out}");
        assert!(
            !out.contains("models, weakest first"),
            "nothing to list: {out}"
        );
    }
}
