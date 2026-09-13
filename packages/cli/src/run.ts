import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  board,
  Engine,
  Maker,
  detect,
  currentDatabase,
  databaseOf,
  loadMachines,
  open,
  readPointer,
  workspaceDir,
  writePointer,
  readProjectConfig,
  setTaskScope,
  STATEFUL,
  type StatefulEntity,
  type TestKind,
  type WorkerKind,
  writeProjectConfig,
} from "@wecode/core";

const DB = (): string => currentDatabase();

const isStateful = (s: string): s is StatefulEntity => (STATEFUL as readonly string[]).includes(s);

export function run(argv: readonly string[]): number {
  try {
    return dispatch(argv);
  } catch (err) {
    return fail(err instanceof Missing ? err.message : `${(err as Error).message}`);
  }
}

function dispatch(argv: readonly string[]): number {
  const [head, ...rest] = argv;
  if (head === undefined || head === "--help" || head === "-h" || (head === "help" && rest.length === 0)) {
    return usage();
  }
  // --help after a command is the whole manual; after an entity it is that entity's verbs.
  if (rest[0] === "--help" || rest[0] === "-h") return isStateful(head) ? entityHelp(head) : usage();
  if (head === "help") {
    const what = rest[0] ?? "";
    return isStateful(what) ? entityHelp(what) : usage();
  }
  if (head === "board") return showBoard();
  if (head === "init") return init();
  if (head === "answer") return answer(rest);
  if (head === "show") return show(rest);
  if (head === "land") return land(rest);
  if (head === "onboard") return onboard(rest);
  return verb(head, rest);
}

/** `wecode init` — an empty workspace, and nothing else.
 *
 *  A workspace holds projects; onboarding a repository is what puts one in it. This exists
 *  for the case where you want the workspace before you have a repository. */
function init(): number {
  const path = DB();
  mkdirSync(dirname(path), { recursive: true });
  open(path).close();
  process.stdout.write(`workspace at ${path}\n  wecode onboard   in a repository, to put a project in it\n`);
  return 0;
}

/** The database, the worktrees and the session logs are wecode's, not the project's. */
function ignore(path: string, line: string): void {
  const body = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (body.split("\n").some((l) => l.trim() === line)) return;
  writeFileSync(path, body === "" || body.endsWith("\n") ? `${body}${line}\n` : `${body}\n${line}\n`);
}

/** Never over an existing file: a config somebody edited is not ours to replace. */
function write(path: string, body: string): void {
  if (existsSync(path)) return;
  writeFileSync(path, body);
}

/** `wecode answer <assignment> "<text>"` — the one verb that clears a needs_human.
 *  An approval is recorded as the operator wrote it; nothing restates it. */
function answer(args: readonly string[]): number {
  const id = Number(args[0]);
  const text = args.slice(1).join(" ");
  if (!Number.isInteger(id) || text === "") return fail('wecode answer <assignment> "<text>"');

  const conn = db();
  const row = conn.prepare("SELECT phase, kind FROM assignment WHERE id = ?").get(id) as
    | { phase: string; kind: string | null }
    | undefined;
  if (row === undefined) return fail(`no assignment #${id}`);
  if (row.phase !== "waiting") return fail(`assignment #${id} is ${row.phase}, and is not waiting on anybody`);

  const who = process.env["WECODE_ACTOR"] ?? "operator";
  conn
    .prepare("UPDATE assignment SET answer = ?, answered_by = ?, updated_at = ? WHERE id = ?")
    .run(text, who, new Date().toISOString(), id);
  process.stdout.write(`assignment #${id} answered by ${who}\n`);
  return 0;
}

/** `wecode onboard [name]` — what happens when wecode meets a repository.
 *
 *  It learns the stack, records what it learned, and registers the project. Before this,
 *  every test carried a hand-typed command and every scope a hand-typed path. */
function onboard(args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { workspace: { type: "string" } },
  });
  const root = process.cwd();
  const name = positionals[0] ?? basename(root);

  if (!existsSync(join(root, ".git"))) {
    return fail(
      "this is not a git repository, and wecode works in branches and worktrees.\n" +
        "  git init && git add -A && git commit -m \"seed\"",
    );
  }
  if (gitConfig("user.email") === "") {
    return fail(
      "this repository has no git identity, so nothing an agent writes could be attributed.\n" +
        '  git config user.name "Your Name" && git config user.email you@example.com',
    );
  }
  if (execFileSync("git", ["rev-list", "-n", "1", "--all"], { cwd: root, encoding: "utf8" }).trim() === "") {
    return fail(
      "this repository has no commits, so there is nothing to cut a branch from.\n" +
        '  git add -A && git commit -m "seed"',
    );
  }

  const stack = detect(root);
  if (stack === null) {
    return fail(
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
  write(join(config, "budget.yaml"), BUDGET);
  ignore(resolve(root, ".gitignore"), ".wecode/");

  // The workspace is named once, and the repository remembers which one it joined.
  const wsName = values.workspace ?? readPointer(root) ?? process.env["WECODE_WORKSPACE"] ?? "default";
  writePointer(root, wsName);

  const path = databaseOf(wsName);
  mkdirSync(dirname(path), { recursive: true });
  const conn = open(path);
  const make = new Maker(conn);

  const workspace =
    (conn.prepare("SELECT id FROM workspace WHERE name = ?").get(wsName) as { id: number } | undefined)?.id ??
    make.workspace(wsName, workspaceDir(wsName));

  const existing = conn.prepare("SELECT id FROM project WHERE repo = ?").get(root) as { id: number } | undefined;
  if (existing !== undefined) {
    process.stdout.write(`project #${existing.id} is already onboarded here\n`);
    return 0;
  }

  const project = make.project(workspace, name, root);
  const release = make.release(project, "0.1");
  new Engine(conn).apply("project", project, "start", "operator");
  new Engine(conn).apply("release", release, "start", "operator");

  process.stdout.write(
    [
      `stack       ${learned.stack}`,
      `test        ${learned.test}`,
      learned.typecheck === null ? null : `typecheck   ${learned.typecheck}`,
      `source      ${learned.source.join(", ")}`,
      "",
      `workspace    ${wsName}  (${path})`,
      `project #${project}  release #${release}`,
      "",
      "next: wecode epic create --parent " + String(release) + ' "<what this release is for>"',
      "",
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
  return 0;
}

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

/** `wecode land <story>` — merge a delivered story into the branch you have checked out.
 *
 *  The operator runs this, not the runner. Landing moves the branch the operator is sitting
 *  on; a background process doing that under them would rewrite their working tree without
 *  asking. Shipping is a decision, and so is this. */
function land(args: readonly string[]): number {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) return fail("wecode land <story>");

  const conn = db();
  const story = conn.prepare("SELECT slug, state FROM story WHERE id = ?").get(id) as
    | { slug: string; state: string }
    | undefined;
  if (story === undefined) return fail(`no story #${id}`);
  if (story.state !== "delivered") {
    return fail(`story #${id} is ${story.state}. Only a delivered story lands.`);
  }

  const branch = `story/${story.slug}`;

  // The landing commit is the operator's, so it needs the operator's identity. wecode signs
  // an agent's attempt; it does not sign a person's merge.
  const who = gitConfig("user.name");
  const email = gitConfig("user.email");
  if (who === "" || email === "") {
    return fail(
      'this repository has no git identity, so the merge would be unattributed.\n' +
        '  git config user.name "Your Name" && git config user.email you@example.com',
    );
  }

  try {
    // Tracked changes only. An untracked file does not affect a merge, and git refuses on
    // its own if one would be overwritten — refusing here as well blocked a landing over
    // wecode's own config directory.
    const dirty = execFileSync("git", ["status", "--porcelain", "-uno"], { encoding: "utf8" }).trim();
    if (dirty !== "") {
      return fail(`your working tree has changes. Commit or stash them first:\n${dirty}`);
    }
    execFileSync("git", ["merge", "--no-ff", "-m", `land ${branch}`, branch], { stdio: "inherit" });
  } catch (err) {
    return fail(`git: ${(err as Error).message}`);
  }

  process.stdout.write(`${branch} landed\n`);
  return 0;
}

function gitConfig(key: string): string {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** `wecode show <entity> <id>` — one record, and what hangs off it. */
function show(args: readonly string[]): number {
  const [entity, raw] = args;
  const id = Number(raw);
  if (entity === undefined || !Number.isInteger(id)) return fail("wecode show <entity> <id>");
  const conn = db();
  const row = conn.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (row === undefined) return fail(`no ${entity} #${id}`);
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === "") continue;
    process.stdout.write(`${k.padEnd(18)} ${String(v)}\n`);
  }
  return 0;
}

/** Every command but init and onboard needs a database. A missing one is the commonest
 *  first contact there is — it used to be an unhandled exception and a stack trace. */
function db() {
  const path = DB();
  if (!existsSync(path)) {
    throw new Missing(
      `no wecode workspace at ${path}.\n  wecode onboard   to set this project up`,
    );
  }
  return open(path);
}

class Missing extends Error {}

function showBoard(): number {
  const b = board(db());
  const groups: [string, readonly { id: number; what: string; state: string; detail: string }[]][] = [
    ["RUNNING", b.running],
    ["NEEDS YOU", b.needs_human],
    ["QUEUE", b.queued],
    ["FAILED", b.failed],
    ["ROADMAP", b.roadmap],
  ];
  for (const [title, rows] of groups) {
    process.stdout.write(`\n${title} (${rows.length})\n`);
    if (rows.length === 0) {
      process.stdout.write("  —\n");
      continue;
    }
    for (const r of rows) {
      process.stdout.write(`  #${String(r.id).padStart(4)}  ${r.what.padEnd(40)} ${r.state.padEnd(12)} ${r.detail}\n`);
    }
  }
  process.stdout.write("\n");
  return 0;
}

/** `wecode <entity> <verb> [id|args]` — the surface in docs/design/06. */
function verb(entity: string, rest: readonly string[]): number {
  const [name, ...args] = rest;
  if (name === undefined) return fail(`wecode ${entity} <verb> …`);

  if (name === "create") return create(entity, args);
  if (name === "scope") return scope(entity, args);

  if (!isStateful(entity)) return fail(`${entity} has no states; its only verb is create`);
  const id = Number(args[0]);
  if (!Number.isInteger(id)) return fail(`wecode ${entity} ${name} <id>`);

  const actor = process.env["WECODE_ACTOR"] ?? "operator";
  const out = new Engine(db()).apply(entity, id, name, actor);
  if (!out.ok) return fail(out.why);

  for (const c of out.changes) {
    process.stdout.write(`${c.entity} #${c.id}  ${c.from} → ${c.to}${c.automatic ? "  (cascade)" : ""}\n`);
  }
  return 0;
}

/** `wecode task scope <id> --write "src/**,tests/**" --tools bash,read` */
function scope(entity: string, args: readonly string[]): number {
  if (entity !== "task") return fail("only a task carries a scope");
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { write: { type: "string" }, tools: { type: "string" } },
  });
  const id = Number(positionals[0]);
  if (!Number.isInteger(id)) return fail('wecode task scope <id> --write "src/**" --tools bash');

  const list = (v: string | undefined): string[] =>
    v === undefined || v === "" ? [] : v.split(",").map((s) => s.trim()).filter((s) => s !== "");

  const learned = project();
  const write =
    values.write === undefined && learned !== null ? [...learned.source, ...learned.tests] : list(values.write);
  const tools = values.tools === undefined ? ["bash", "read", "edit", "write"] : list(values.tools);

  try {
    setTaskScope(db(), id, { write, tools });
    process.stdout.write(`task #${id} scope ${write.join(", ")}\n`);
    return 0;
  } catch (err) {
    return fail((err as Error).message);
  }
}

function create(entity: string, args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      parent: { type: "string" },
      kind: { type: "string" },
      artefact: { type: "string" },
      role: { type: "string" },
      path: { type: "string" },
    },
  });

  const text = positionals.join(" ");
  const parent = Number(values["parent"]);
  const make = new Maker(db());
  const needsParent = (): number => {
    if (!Number.isInteger(parent)) throw new Error(`wecode ${entity} create --parent <id> "<text>"`);
    return parent;
  };

  try {
    let id: number;
    switch (entity) {
      case "workspace":
        id = make.workspace(text, values["path"] ?? process.cwd());
        break;
      case "project":
        id = make.project(needsParent(), text, values["path"] ?? process.cwd());
        break;
      case "release":
        id = make.release(needsParent(), text);
        break;
      case "epic":
        id = make.epic(needsParent(), text);
        break;
      case "story":
        id = make.story(needsParent(), text);
        break;
      case "requirement":
        id = make.requirement(needsParent(), text);
        break;
      case "acceptance_criteria":
        id = make.criteria(needsParent(), text);
        break;
      case "acceptance_test":
        id = make.acceptanceTest(needsParent(), text, kindOf(values["kind"]), artefactOr(values["artefact"]));
        break;
      case "task_test":
        id = make.taskTest(needsParent(), text, kindOf(values["kind"]), artefactOr(values["artefact"]));
        break;
      case "task":
        id = make.task(needsParent(), text, { role: values["role"] ?? "" });
        break;
      case "worker":
        id = make.worker(text, values["role"] ?? "", (values["kind"] ?? "agent") as WorkerKind);
        break;
      default:
        return fail(`no such entity: ${entity}`);
    }
    process.stdout.write(`${entity} #${id}\n`);
    return 0;
  } catch (err) {
    return fail((err as Error).message);
  }
}

/** A test with no artefact falls back to the project's own test command, which onboarding
 *  learned from the repository. Retyping it into every test is how they drift. */
function artefactOr(given: string | undefined): string | null {
  if (given !== undefined) return given;
  return project()?.test ?? null;
}

function project(): ReturnType<typeof readProjectConfig> {
  return readProjectConfig(resolve(process.cwd(), "config/project.yaml"));
}

function kindOf(v: string | undefined): TestKind {
  return v === "judged" ? "judged" : "script";
}

function fail(why: string): number {
  process.stderr.write(`${why}\n`);
  return 1;
}

function usage(): number {
  process.stdout.write(
    [
      "wecode — deterministic project management for a developer and their coding agents.",
      "",
      "Work is written down as tests before it is built. Agents get one task each inside a",
      "scope they cannot leave. Nothing is finished because an agent said so: a task is done",
      "when its tests pass, and a story is delivered when every test that proves it passes.",
      "",
      "THE SHAPE OF THE WORK",
      "  project → release → epic → story → requirement → acceptance_criteria",
      "                                      → acceptance_test → task → task_test",
      "",
      "  requirement          a rule that must be true",
      "  acceptance_criteria  one named expectation that proves it",
      "  acceptance_test      the command that proves the criteria",
      "  task                 work that exists to make one acceptance_test pass",
      "  task_test            the task's own unit test",
      "",
      "START HERE",
      "  wecode onboard [name] [--workspace <ws>]   learn this repo, join a workspace, write config",
      "  wecode init                                an empty workspace, before you have a repo",
      "  wecode board                               what is running, waiting, queued, failed",
      "",
      "MAKING WORK",
      '  wecode <entity> create --parent <id> "<text>" [--artefact "<cmd>"] [--role <name>]',
      '  wecode task scope <id> --write "a.ts,b.ts"  which files that task may change',
      "  wecode worker create <name> --role engineer --kind agent",
      "",
      "MOVING WORK",
      "  wecode <entity> <verb> <id>                start, deliver, pass, fail, drop, retry …",
      '  wecode answer <assignment> "<text>"        clears a needs_human',
      "  wecode land <story>                        merge a delivered story into your branch",
      "",
      "LOOKING",
      "  wecode show <entity> <id>                  one record",
      "  wecode <entity> --help                     that entity's states and verbs",
      "",
      "RUNNING",
      "  wecode-runner --once                       one tick: allocate, run an agent, prove, land",
      "  wecode-runner                              the loop",
      "  wecode-tui                                 the live board",
      "",
      `entities: ${STATEFUL.join(", ")}, workspace, role, worker`,
      "",
      "RULES THAT BITE",
      "  a task needs a scope, a role and a task_test that is ready before it can start",
      "  two tasks whose write scopes overlap will not run at the same time",
      "  a failing test is the answer — make another task, do not edit the code by hand",
      "",
    ].join("\n"),
  );
  return 0;
}

/** Every state and verb an entity has, read off the machine table — so help cannot drift
 *  from what the engine will actually allow. */
function entityHelp(entity: string): number {
  if (!isStateful(entity)) return fail(`${entity} has no states. Its only verb is create.`);

  const m = loadMachines()[entity];
  process.stdout.write(`${entity}\n\n  states  ${m.states.join(" · ")}\n\n`);

  const width = Math.max(...m.transitions.map((t) => t.verb.length));
  for (const t of m.transitions) {
    const guard = t.guard === undefined ? "" : `  [${t.guard}]`;
    const who = t.automatic === true ? "  (automatic — nobody invokes it)" : "";
    process.stdout.write(`  ${t.verb.padEnd(width)}  ${t.from.join(" | ")} → ${t.to}${guard}${who}\n`);
  }
  process.stdout.write(`\n  wecode ${entity} <verb> <id>\n\n`);
  return 0;
}

const ROLES = `invariants:
  never_touch: [".github/**", "infra/**", "**/*.pem", "**/*.key", "**/.env"]
  never_run: ["git push --force*", "npm publish*", "terraform apply*", "rm -rf /*"]

defaults:
  budget: { tokens: 250000, seconds: 3600 }
  harness: claude-code

roles:
  engineer:
    worker_kind: agent
    scope:
      write: ["src/**", "tests/**"]
      tools: ["bash", "read", "edit", "write"]

  acceptance-tester:
    worker_kind: agent
    scope:
      write: ["tests/acceptance/**"]
      tools: ["bash", "read", "edit", "write"]
    budget: { tokens: 120000, seconds: 1800 }
`;

const BUDGET = `# Raising max_open is the easiest change in this file and usually the wrong one.
max_open: 3

order:
  fresh_first: true
  oldest_first: true

collision:
  scope_overlap: refuse
`;
