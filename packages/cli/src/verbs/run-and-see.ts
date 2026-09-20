/** The verbs that act: worker, plan, land, ask, answer, onboard.
 *
 *  Where `verbs/tree.ts` and `verbs/work.ts` hold the rungs `create` makes, these are the
 *  words that are not about making a row at all. The five that only look — board, doctor,
 *  delivered, explore, design — are in `verbs/see.ts`; what is left here is the half that
 *  writes. `plan` stays because it makes rows. These bodies were in run.ts.
 *
 *  Nothing in this file decides what the arguments mean. run.ts parses argv and owns the
 *  record — the table declarations, the database handle, `fail` — and hands both in, so
 *  what is left in run.ts is argument parsing and the dispatch table. The context is an
 *  interface rather than an import because importing run.ts back would be a cycle. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
// The landing rules are a module of their own in core, deliberately outside the barrel: no
// git, no clock, no filesystem, so the command half and the runner half can be held to the
// same words. Addressed through the package's build output, the way its barrel is.
import { type BaseState, refuseDirtyBase, reportAbort, reportLeftover } from "@wecode/core/dist/land.js";
import {
  answerApproval,
  raiseApproval,
  APPROVAL_KIND,
  Engine,
  Maker,
  OPERATOR,
  detect,
  databaseOf,
  listWorkspaces,
  loadRoles,
  open,
  readPointer,
  workspaceDir,
  writePointer,
  readProjectConfig,
  Verbs,
  writeProjectConfig,
  type Actor,
  type WorkerKind,
} from "@wecode/core";
import { excluded, queries, type TableDef } from "@wecode/core/dist/db.js";
import type {
  AcceptanceTestRow,
  AssignmentRow,
  CriteriaRow,
  LandedRow,
  ProjectRow,
  RequirementRow,
  StoryRow,
  TaskRow,
  WorkerRow,
  WorkspaceRow,
} from "../run.js";
export { plan } from "../plan.js";

type Conn = ReturnType<typeof open>;

/** The tables these verbs read and write. Declared once in run.ts, because `show` prints a
 *  whole record and so needs every column of every table; passed in rather than declared
 *  again here, since two copies of a schema with no check between them is the defect. */
export interface Tables {
  readonly workspace: TableDef<WorkspaceRow>;
  readonly project: TableDef<ProjectRow>;
  readonly story: TableDef<StoryRow>;
  readonly requirement: TableDef<RequirementRow>;
  readonly criteria: TableDef<CriteriaRow>;
  readonly acceptanceTest: TableDef<AcceptanceTestRow>;
  readonly task: TableDef<TaskRow>;
  readonly worker: TableDef<WorkerRow>;
  readonly assignment: TableDef<AssignmentRow>;
  readonly landedBranch: TableDef<LandedRow>;
}

/** What run.ts knows and these verbs need: the argv tail, the workspace, and the two ways
 *  of answering — `fail` to standard error with exit 1, or writing and returning 0. */
export interface See {
  readonly args: readonly string[];
  /** The workspace database, or a throw naming the directory that has none. */
  readonly conn: () => Conn;
  readonly fail: (why: string) => number;
  /** The project this repository is, or null when you are standing outside all of them. */
  readonly hereProject: () => { id: number; name: string } | null;
  /** Whose name a change is recorded under. */
  readonly actor: () => Actor;
  readonly tables: Tables;
}

/** Making a worker: the one `create` case that is neither a rung of the tree nor a piece of
 *  the work, which is why it is here rather than in those two files. */
export interface Hand {
  readonly make: Maker;
  /** What the positionals spelled: the worker's name. */
  readonly text: string;
  /** `--role`, the role this worker answers for. */
  readonly role: string;
  /** `--kind`, already narrowed: an agent unless a person is said. */
  readonly kind: WorkerKind;
}

export const worker = (at: Hand): number => at.make.worker(at.text, at.role, at.kind);

// ─── ask and answer ──────────────────────────────────────────────────────────────────────

/** `wecode ask <task> "<question>"` / `wecode ask story <id> "<question>"` [--option "<answer>=<cost>"] [--operator <name>]
 *
 *  A decision the operator must make is a row in needs you, not a line in a report: six of
 *  them on 20 Sep reached the operator only as chat messages, because a story titled NEEDS
 *  APPROVAL sits in `planned` among fifty others. A bare id is a task, which is what every
 *  existing caller means; `story <id>` hangs the question on the story, for the decisions
 *  about the whole of it rather than about one attempt. An option is the answer and what
 *  taking it costs, split on the first `=`; only the answers are stored as options, since an
 *  answer is checked against them, and the costs go into the question, which is what a person
 *  reads before choosing. No options is an open question, and any words settle it. */
export function ask(at: See): number {
  const { values, positionals } = parseArgs({
    args: [...at.args],
    allowPositionals: true,
    options: { option: { type: "string", multiple: true }, operator: { type: "string" } },
  });
  const kind = positionals[0] === "story" ? ("story" as const) : ("task" as const);
  const rest = positionals[0] === kind ? positionals.slice(1) : positionals;
  const id = Number(rest[0]);
  const question = rest.slice(1).join(" ");
  if (!Number.isInteger(id) || question === "") {
    return at.fail('wecode ask <task> "<question>" | wecode ask story <id> "<question>"  [--option "<answer>=<what it costs>"] [--operator <name>]');
  }
  const split = (o: string) => (o.includes("=") ? o.indexOf("=") : o.length); // no `=` is all answer, no cost
  const offered = (values.option ?? []).map((o) => ({ answer: o.slice(0, split(o)).trim(), costs: o.slice(split(o) + 1).trim() }));

  const conn = at.conn();
  try {
    const who = operator(conn, at.tables, values.operator);
    const raised = raiseApproval(conn, {
      objective_type: kind,
      objective_id: id,
      worker_id: who.id,
      question: [question, ...offered.map((o) => `  ${o.answer}${o.costs === "" ? "" : ` — ${o.costs}`}`)].join("\n"),
      options: offered.length === 0 ? null : offered.map((o) => o.answer),
    });
    process.stdout.write(`approval #${raised.id} waits on ${who.name}\n  wecode answer ${raised.id} "<text>"\n`);
    return 0;
  } catch (err) {
    return at.fail((err as Error).message);
  }
}

/** Who is asked, or why nobody can be. A name given is honoured or nothing; with no name,
 *  the sole human worker — a workspace with two people has no obvious one to burden, and
 *  choosing would be wecode deciding whose signature a decision needs. */
function operator(conn: Conn, tables: Tables, named: string | undefined): { id: number; name: string } {
  const people = queries(conn).selectFrom(tables.worker).all().filter((w) => w.kind === "human");
  const found = named === undefined ? (people.length === 1 ? people[0] : undefined) : people.find((w) => w.name === named);
  if (found !== undefined) return { id: found.id, name: found.name };
  if (named !== undefined) return fails(`no human worker named ${named}. Human workers: ${names(people)}`);
  return fails(
    people.length === 0
      ? "nobody to ask: wecode worker create <you> --role operator --kind human"
      : `${people.length} people could be asked (${names(people)}), so name one with --operator <name>`,
  );
}

const names = (people: readonly { name: string }[]): string => (people.length === 0 ? "none" : people.map((p) => p.name).join(", "));
/** Nobody to carry the authority. Its own class because `answer` treats it as a fact about
 *  the workspace rather than as a refusal — see there. */
class NoOperator extends Error {}
const fails = (why: string): never => {
  throw new NoOperator(why);
};

/** `wecode answer <assignment> "<text>"` — the one verb that clears a needs_human.
 *  An approval is recorded as the operator wrote it; nothing restates it. */
export function answer(at: See): number {
  const id = Number(at.args[0]);
  const text = at.args.slice(1).join(" ");
  if (!Number.isInteger(id) || text === "") return at.fail('wecode answer <assignment> "<text>"');

  const conn = at.conn();
  const q = queries(conn);
  const row = q.selectFrom(at.tables.assignment).select(["phase", "kind"]).where("id", "=", id).get();
  if (row === null) return at.fail(`no assignment #${id}`);
  if (row.phase !== "waiting") return at.fail(`assignment #${id} is ${row.phase}, and is not waiting on anybody`);

  // An approval closes as well as records: it has no work to go back to, so core checks the
  // answer against the options offered and finishes it, in the answerer's own name. Where
  // the workspace has no person on record there is no such name, and the answer is written
  // the way every other needs_human is — a row left waiting would be worse than a record.
  if (row.kind === APPROVAL_KIND) {
    try {
      const by = operator(conn, at.tables, process.env["WECODE_ACTOR"]).name;
      process.stdout.write(`approval #${id} answered ${answerApproval(conn, id, text, by).answer} by ${by}\n`);
      return 0;
    } catch (err) {
      if (!(err instanceof NoOperator)) return at.fail((err as Error).message);
    }
  }

  const who = at.actor();
  q.update(at.tables.assignment)
    .set({ answer: text, answered_by: who, updated_at: new Date().toISOString() })
    .where("id", "=", id)
    .run();
  process.stdout.write(`assignment #${id} answered by ${who}\n`);
  return 0;
}

// ─── onboard ─────────────────────────────────────────────────────────────────────────────

/** `wecode onboard [name]` — what happens when wecode meets a repository.
 *
 *  It learns the stack, records what it learned, and registers the project. Before this,
 *  every test carried a hand-typed command and every scope a hand-typed path. */
export function onboard(at: See): number {
  const { values, positionals } = parseArgs({
    args: [...at.args],
    allowPositionals: true,
    options: { workspace: { type: "string" } },
  });
  const root = process.cwd();
  const name = positionals[0] ?? basename(root);

  if (!existsSync(join(root, ".git"))) {
    return at.fail(
      "this is not a git repository, and wecode works in branches and worktrees.\n" +
        "  git init && git add -A && git commit -m \"seed\"",
    );
  }
  if (gitConfig("user.email") === "") {
    return at.fail(
      "this repository has no git identity, so nothing an agent writes could be attributed.\n" +
        '  git config user.name "Your Name" && git config user.email you@example.com',
    );
  }
  if (execFileSync("git", ["rev-list", "-n", "1", "--all"], { cwd: root, encoding: "utf8" }).trim() === "") {
    return at.fail(
      "this repository has no commits, so there is nothing to cut a branch from.\n" +
        '  git add -A && git commit -m "seed"',
    );
  }

  const stack = detect(root);
  if (stack === null) {
    return at.fail(
      "no stack recognised here. wecode looks for a lock file or a manifest — see config/stacks.yaml.\n" +
        "  add one there, or write config/project.yaml by hand.",
    );
  }

  const config = resolve(root, "config");
  mkdirSync(config, { recursive: true });
  const projectFile = join(config, "project.yaml");
  const already = readProjectConfig(projectFile);
  const learned = already ?? writeProjectConfig(projectFile, stack);

  write(join(config, "roles.yaml"), rolesFor(learned));
  ignore(resolve(root, ".gitignore"), ".wecode/");

  // The workspace is named once, and the repository remembers which one it joined.
  //
  // Falling back to "default" while other workspaces exist put a project on a board its
  // owner was not looking at. If there is a choice to make, it is made out loud.
  const known = listWorkspaces();
  const chosen = values.workspace ?? readPointer(root) ?? process.env["WECODE_WORKSPACE"];
  if (chosen === undefined && known.length > 0 && !known.includes("default")) {
    return at.fail(
      `which workspace should this project join?\n` +
        known.map((w) => `  wecode onboard --workspace ${w}`).join("\n") +
        `\n  wecode onboard --workspace <new-name>   to start another`,
    );
  }
  const wsName = chosen ?? "default";
  writePointer(root, wsName);

  const path = databaseOf(wsName);
  mkdirSync(dirname(path), { recursive: true });
  // The budget is the workspace's: attention is one person's and does not divide by how
  // many repositories they have.
  write(join(workspaceDir(wsName), "budget.yaml"), BUDGET);
  const conn = open(path);
  const q = queries(conn);
  const make = new Maker(conn);

  const wsId =
    q.selectFrom(at.tables.workspace).select(["id"]).where("name", "=", wsName).get()?.id ??
    make.workspace(wsName, workspaceDir(wsName));

  // Roles without workers is a board nothing can be dispatched from: the runner refuses
  // every candidate with "no worker free for role engineer", and nowhere does it say a
  // worker is a thing you make. So onboarding makes one per agent role, named after it.
  const hired = hire(conn, at.tables, make, join(config, "roles.yaml"));

  const existing = q.selectFrom(at.tables.project).select(["id"]).where("repo", "=", root).get();
  if (existing !== null) {
    process.stdout.write(
      `project #${existing.id} is already onboarded here\n${workerLines(hired).join("\n")}${hired.length > 0 ? "\n" : ""}`,
    );
    return 0;
  }

  const projectId = make.project(wsId, name, root);
  const releaseId = make.release(projectId, "0.0.1");
  const started = new Verbs(new Engine(conn));
  started.startProject(projectId, OPERATOR);
  started.startRelease(releaseId, OPERATOR);

  process.stdout.write(
    [
      `stack       ${learned.stack}`,
      `test        ${learned.test}`,
      learned.typecheck === null ? null : `typecheck   ${learned.typecheck}`,
      `source      ${learned.source.join(", ")}`,
      "",
      `workspace   ${wsName}  (${path})`,
      `project #${projectId}  release #${releaseId}`,
      ...workerLines(hired),
      "",
      "next: wecode epic create --parent " + String(releaseId) + ' "<what this release is for>"',
      "",
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
  return 0;
}

/** A line in .gitignore, added once. */
function ignore(path: string, line: string): void {
  const had = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (had.split("\n").some((l) => l.trim() === line)) return;
  writeFileSync(path, had === "" || had.endsWith("\n") ? `${had}${line}\n` : `${had}\n${line}\n`);
}

/** Written only where there is nothing: onboarding twice must not overwrite what the
 *  operator edited in between. */
function write(path: string, body: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

interface Hired {
  readonly id: number;
  readonly role: string;
  readonly fresh: boolean;
}

/** One agent worker per agent role, named after the role. A role that already has a worker
 *  keeps it: onboarding twice must not double the workforce. Human roles are people, and
 *  wecode does not get to hire those. */
function hire(conn: Conn, tables: Tables, make: Maker, rolesFile: string): Hired[] {
  const hired: Hired[] = [];
  const q = queries(conn);
  for (const want of Object.values(loadRoles(rolesFile).roles)) {
    if (want.worker_kind !== "agent") continue;
    const had = q.selectFrom(tables.worker).select(["id"]).where("role", "=", want.name).get();
    hired.push(
      had === null
        ? { id: make.worker(want.name, want.name, "agent"), role: want.name, fresh: true }
        : { id: had.id, role: want.name, fresh: false },
    );
  }
  return hired;
}

const workerLines = (hired: readonly Hired[]): string[] =>
  hired.map((h) => `worker #${h.id}  ${h.role}${h.fresh ? "" : "  (already there)"}`);

/** Roles whose scopes are paths this repository has, rather than paths wecode assumed. */
function rolesFor(c: { source: readonly string[]; tests: readonly string[] }): string {
  const globs = (gs: readonly string[]): string => gs.map((g) => JSON.stringify(g)).join(", ");
  return `invariants:
  never_touch: [".github/**", "infra/**", "**/*.pem", "**/*.key", "**/.env"]
  never_run: ["git push --force*", "npm publish*", "terraform apply*", "rm -rf /*"]

defaults:
  budget: { tokens: 250000, seconds: 3600 }
  harness: claude-code

roles:
  engineer:
    worker_kind: agent
    scope:
      write: [${globs([...c.source, ...c.tests])}]
      tools: ["bash", "read", "edit", "write"]

  acceptance-tester:
    worker_kind: agent
    scope:
      write: [${globs(c.tests)}]
      tools: ["bash", "read", "edit", "write"]
    budget: { tokens: 120000, seconds: 1800 }
`;
}

const BUDGET = `# Raising max_open is the easiest change in this file and usually the wrong one.
#
# These are limits on your attention, not on the machine's. Every open assignment is
# something you may be asked about; every needs_human is something only you can clear.
max_open: 6
max_needs_human: 3
`;

// ─── land ────────────────────────────────────────────────────────────────────────────────

/** `wecode land <story>` — merge a delivered story into the branch you have checked out.
 *
 *  The operator runs this, not the runner. Landing moves the branch the operator is sitting
 *  on; a background process doing that under them would rewrite their working tree without
 *  asking. Shipping is a decision, and so is this. */
export function land(at: See): number {
  const id = Number(at.args[0]);
  if (!Number.isInteger(id)) return at.fail("wecode land <story>");
  const conn = at.conn();
  const found = queries(conn).selectFrom(at.tables.story).select(["slug", "state"]).where("id", "=", id).get();
  if (found === null) return at.fail(`no story #${id}`);
  if (found.state !== "delivered") {
    return at.fail(`story #${id} is ${found.state}. Only a delivered story lands.`);
  }

  const branch = `story/${found.slug}`;
  const base = headBranch();

  // The landing commit is the operator's, so it needs the operator's identity. wecode signs
  // an agent's attempt; it does not sign a person's merge.
  const who = gitConfig("user.name");
  const email = gitConfig("user.email");
  if (who === "" || email === "") {
    return at.fail(
      'this repository has no git identity, so the merge would be unattributed.\n' +
        '  git config user.name "Your Name" && git config user.email you@example.com',
    );
  }

  let sha: string;
  try {
    // A dirty base is refused by name, not by a general "your tree has changes": the merge
    // would commit the operator's unrelated edits inside the landing commit, and the rule
    // that says so lives in core so the runner half can be held to the same words.
    const filthy = refuseDirtyBase(baseState(base));
    if (filthy !== null) return at.fail(filthy);
    // A delivered story whose branch is gone has nothing to merge, and calling that a
    // landing is the reported defect. It is a failure, not a quiet success: the work is
    // somewhere else, or nowhere.
    if (!hasRef(branch)) return at.fail(nothingToLand(branch, base, "no-branch"));
    // git answers "Already up to date" and exit 0 for a branch the base already holds, and
    // that was indistinguishable, afterwards, from a merge that happened.
    if (isAncestor(branch, "HEAD")) {
      process.stdout.write(`${nothingToLand(branch, base, "already-ancestor")}\n`);
      return 0;
    }
    const before = headSha();
    try {
      execFileSync("git", ["merge", "--no-ff", "-m", `land ${branch}`, branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // A half-finished merge is the hazard: left in the tree, the next thing to commit —
      // an agent, a hook, a person in a hurry — commits the conflict markers onto master.
      // So the tree goes back exactly as it was found, and the conflict becomes a chore.
      const conflicted = unmerged();
      abortMerge();
      const why = conflicted.length > 0
        ? `${branch} conflicts with your branch in:\n${conflicted.map((f) => `  ${f}`).join("\n")}`
        : `${branch} would not merge:\n${((err as { stderr?: string }).stderr ?? (err as Error).message).trim()}`;
      return at.fail(`${why}\n${reportAbort(baseState(base), branch)}`);
    }
    sha = headSha();
    if (sha === before) {
      process.stdout.write(`${nothingToLand(branch, base, "already-ancestor")}\n`);
      return 0;
    }
  } catch (err) {
    return at.fail(`git: ${(err as Error).message}`);
  }

  recordLanding(conn, at.tables, id, branch, sha);
  process.stdout.write(`${branch} landed on ${base}: ${sha.slice(0, 12)}\n`);
  // The landing is recorded either way — it happened — but a base left dirty by the merge
  // (a hook that writes, a merge driver that stages) is the next operator's mystery, so it
  // is said out loud and the command does not report success.
  const left = reportLeftover(baseState(base));
  return left === null ? 0 : at.fail(`${branch} landed, but the base was not left clean.\n${left}`);
}

/** The base checkout as the rule in core wants to see it. Read twice per landing: once
 *  before the merge and once after, because the whole promise is about the difference. */
function baseState(base: string): BaseState {
  const here = gitSay(["rev-parse", "--show-toplevel"]);
  const gitDir = gitSay(["rev-parse", "--git-dir"]);
  return {
    here,
    base,
    // Tracked changes only. An untracked file does not affect a merge, and git refuses on
    // its own if one would be overwritten — counting them here blocked a landing over
    // wecode's own config directory.
    dirty: gitSay(["status", "--porcelain", "-uno"]).split("\n").filter((l) => l !== ""),
    merging: gitDir !== "" && existsSync(join(gitDir, "MERGE_HEAD")),
  };
}

/** Why nothing happened. Same two reasons, and the same words, as the runner's own
 *  `landingReport`: an operator reading one and a log line from the other must not have to
 *  work out whether they mean the same thing. */
function nothingToLand(branch: string, base: string, why: "no-branch" | "already-ancestor"): string {
  return why === "no-branch"
    ? `nothing to land: there is no ${branch}`
    : `nothing to land: ${branch} is already in ${base}`;
}

/** The branch the operator is standing on, or the sha when they are detached. */
function headBranch(): string {
  const named = gitSay(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return named === "" ? headSha().slice(0, 12) : named;
}

const headSha = (): string => gitSay(["rev-parse", "HEAD"]);

const hasRef = (ref: string): boolean => gitSay(["rev-parse", "--verify", "--quiet", ref]) !== "";

/** True when the base already holds every commit on `ref`. */
function isAncestor(ref: string, of: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ref, of], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitSay(args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** What git says this repository is configured as, or "" when it says nothing. */
function gitConfig(key: string): string {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** The landing, where a query can see it. The doctor's first invariant reads `landed_branch`
 *  through the story's tasks, and it reported stories unlanded that were sitting in the base
 *  because this path merged and recorded nothing. Written here, on the path that actually
 *  merges, and nowhere else. */
function recordLanding(conn: Conn, tables: Tables, storyId: number, branch: string, sha: string): void {
  // The runner owns this table and creates it on its first merge; a repository landed by
  // hand may never have run a tick. DDL is the one statement here that is not a query, and
  // the dialect compiles queries — so this stays as schema text, and is the only SQL left.
  conn.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  // The four-table join the SQL spelled, composed instead: the dialect has neither JOIN nor
  // IN, and it is one link of the tree per step — requirement to criteria to acceptance_test
  // to task — which is the same walk `projectOf` makes in the other direction.
  const q = queries(conn);
  const reqs = new Set(
    q.selectFrom(tables.requirement).select(["id"]).where("story_id", "=", storyId).all().map((r) => r.id),
  );
  const crits = new Set(
    q.selectFrom(tables.criteria).select(["id", "requirement_id"]).all()
      .filter((r) => reqs.has(r.requirement_id))
      .map((r) => r.id),
  );
  const tests = new Set(
    q.selectFrom(tables.acceptanceTest).select(["id", "parent_id"]).all()
      .filter((r) => crits.has(r.parent_id))
      .map((r) => r.id),
  );
  const tasks = q
    .selectFrom(tables.task)
    .select(["id", "acceptance_test_id"])
    .all()
    .filter((r) => tests.has(r.acceptance_test_id))
    .map((r) => r.id);

  const at = new Date().toISOString();
  for (const taskId of tasks) {
    q.insertInto(tables.landedBranch, { task_id: taskId, branch, sha, merged_at: at })
      .onConflict(["task_id"], {
        branch: excluded<LandedRow>("branch"),
        sha: excluded<LandedRow>("sha"),
        merged_at: excluded<LandedRow>("merged_at"),
      })
      .run();
  }
}

/** The paths git left with conflict markers, read before the merge is undone. */
function unmerged(): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** Best effort: if the merge never started there is nothing to abort, and saying so helps nobody. */
function abortMerge(): void {
  try {
    execFileSync("git", ["merge", "--abort"], { stdio: "ignore" });
  } catch {
    /* no merge in progress */
  }
}
