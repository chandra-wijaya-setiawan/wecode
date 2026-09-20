/** The verbs that act on the record itself: worker, ask, answer, onboard.
 *
 *  These were in `verbs/run-and-see.ts` until that file went over its ceiling. What is left
 *  there is `land`, the one acting verb that moves a git ref rather than writing a row; the
 *  four here are the ones that only touch the workspace — a worker made, a question raised,
 *  an answer recorded, a repository met for the first time.
 *
 *  Nothing in this file decides what the arguments mean. run.ts parses argv and owns the
 *  record — the table declarations, the database handle, `fail` — and hands both in. The
 *  context comes from `verbs/run-and-see.ts` as a type only, so there is no cycle at run
 *  time: the edge that exists is the other way, that file re-exporting these four so run.ts
 *  imports the same names it always did. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
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
  type WorkerKind,
} from "@wecode/core";
import { queries } from "@wecode/core/dist/db.js";
import type { See, Tables } from "./run-and-see.js";

type Conn = ReturnType<typeof open>;

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

/** What git says this repository is configured as, or "" when it says nothing. Lives here
 *  because `onboard` refuses without it; `land` reads it through this same function rather
 *  than keeping a second copy. */
export function gitConfig(key: string): string {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
