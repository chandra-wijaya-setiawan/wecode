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
  listWorkspaces,
  tree,
  type Node,
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
import { plan } from "./plan.js";

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
  if (head === "plan") return plan(rest);
  if (head === "workspaces") return workspaces();
  if (head === "tree") return showTree(rest);
  if (head === "watch") return watch(rest);
  if (head === "wait") return wait(rest);
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

/** `wecode watch [--project N] [--json]` — one line per state change, forever.
 *
 *  Read off the ledger, which is append-only, so this is a query with a cursor rather than
 *  an event bus. An orchestrator that wants to be told instead of asking runs this in the
 *  background and reads lines. */
function watch(args: readonly string[]): number {
  const { values } = parseArgs({
    args: [...args],
    options: {
      project: { type: "string" },
      json: { type: "boolean" },
      since: { type: "string" },
      once: { type: "boolean" },
    },
  });
  const conn = db();
  const project = values.project === undefined ? null : Number(values.project);

  let cursor =
    values.since === undefined
      ? ((conn.prepare("SELECT coalesce(max(id), 0) AS n FROM ledger").get() as { n: number }).n)
      : Number(values.since);

  const tick = (): void => {
    const rows = conn
      .prepare("SELECT id, entity, entity_id, verb, from_state, to_state, actor, at FROM ledger WHERE id > ? ORDER BY id")
      .all(cursor) as unknown as {
      id: number;
      entity: string;
      entity_id: number;
      verb: string;
      from_state: string;
      to_state: string;
      actor: string;
      at: string;
    }[];

    for (const r of rows) {
      cursor = r.id;
      if (project !== null && projectOf(r.entity, r.entity_id)?.id !== project) continue;
      process.stdout.write(
        values.json === true
          ? `${JSON.stringify(r)}\n`
          : `${r.at}  ${r.entity} #${r.entity_id}  ${r.from_state} → ${r.to_state}  ${r.verb} by ${r.actor}\n`,
      );
    }
  };

  tick();
  if (values.once === true) return 0;

  const timer = setInterval(tick, 1000);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      clearInterval(timer);
      process.exit(0);
    });
  }
  return 0;
}

/** `wecode wait <entity> <id> [--timeout <seconds>]` — block until it settles, then exit.
 *
 *  The exit code is the answer: 0 if it reached a state the work wanted, 1 if it did not.
 *  A harness that can run a command in the background gets a notification for free — the
 *  command finishing *is* the notification. */
function wait(args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { timeout: { type: "string" }, quiet: { type: "boolean" } },
  });
  const [entity, raw] = positionals;
  const id = Number(raw);
  if (entity === undefined || !Number.isInteger(id)) return fail("wecode wait <entity> <id>");
  if (!isStateful(entity)) return fail(`${entity} has no states to wait on`);

  const good: Readonly<Record<string, readonly string[]>> = {
    project: ["dropped"],
    release: ["released"],
    epic: ["delivered"],
    story: ["delivered"],
    requirement: ["met"],
    acceptance_criteria: ["accepted"],
    acceptance_test: ["passed"],
    task_test: ["passed"],
    task: ["done"],
    assignment: ["succeeded"],
  };
  const machine = loadMachines()[entity];
  const settled = new Set([...machine.terminal, ...(good[entity] ?? [])]);

  const conn = db();
  const col = entity === "assignment" ? "phase" : "state";
  const deadline = values.timeout === undefined ? null : Date.now() + Number(values.timeout) * 1000;

  const look = (): string | null =>
    (conn.prepare(`SELECT ${col} AS s FROM ${entity} WHERE id = ?`).get(id) as { s: string } | undefined)?.s ?? null;

  if (look() === null) return fail(`no ${entity} #${id}`);

  // Blocking on purpose, and synchronously: the command exists to not return until the
  // answer is known, and run() is not async. Atomics.wait is the one sleep that parks the
  // thread rather than the event loop.
  const park = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const state = look();
    if (state !== null && settled.has(state)) {
      if (values.quiet !== true) process.stdout.write(`${entity} #${id} ${state}\n`);
      return (good[entity] ?? []).includes(state) ? 0 : 1;
    }
    if (deadline !== null && Date.now() > deadline) {
      return fail(`${entity} #${id} is still ${state ?? "gone"} after ${values.timeout}s`) + 1;
    }
    Atomics.wait(park, 0, 0, 1000);
  }
}

/** `wecode tree [project]` — the whole shape, project to task_test. */
function showTree(args: readonly string[]): number {
  const only = args[0] === undefined ? undefined : Number(args[0]);
  const nodes = tree(db(), only);
  if (nodes.length === 0) return fail(only === undefined ? "no projects yet" : `no project #${only}`);

  const mark: Readonly<Record<string, string>> = {
    delivered: "✓",
    released: "✓",
    met: "✓",
    accepted: "✓",
    passed: "✓",
    done: "✓",
    dropped: "·",
    failed: "✗",
    on_hold: "‖",
  };

  const walk = (n: Node, prefix: string, last: boolean, top: boolean): void => {
    const elbow = top ? "" : last ? "└── " : "├── ";
    const state = mark[n.state] ?? "○";
    const label = n.label.length > 64 ? `${n.label.slice(0, 63)}…` : n.label;
    process.stdout.write(`${prefix}${elbow}${state} ${dimNum(n.id)} ${label}  ${grey(n.state)}\n`);
    const next = top ? "" : prefix + (last ? "    " : "│   ");
    n.children.forEach((c, i) => walk(c, next, i === n.children.length - 1, false));
  };

  for (const project of nodes) walk(project, "", true, true);
  return 0;
}

const dimNum = (id: number): string => `\u001b[2m#${id}\u001b[0m`;
const grey = (s: string): string => `\u001b[2m${s}\u001b[0m`;

/** `wecode workspaces` — which ones exist, and which one you are talking to. */
function workspaces(): number {
  const known = listWorkspaces();
  if (known.length === 0) {
    return fail("no workspaces yet.\n  wecode onboard   in a repository, to make one");
  }
  const here = currentDatabase();
  for (const name of known) {
    const path = databaseOf(name);
    const n = existsSync(path) ? projectCount(path) : 0;
    process.stdout.write(`${path === here ? "*" : " "} ${name.padEnd(16)} ${n} project${n === 1 ? "" : "s"}\n`);
  }
  return 0;
}

function projectCount(path: string): number {
  const conn = open(path);
  const row = conn.prepare("SELECT count(*) AS n FROM project").get() as { n: number };
  conn.close();
  return row.n;
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
  ignore(resolve(root, ".gitignore"), ".wecode/");

  // The workspace is named once, and the repository remembers which one it joined.
  //
  // Falling back to "default" while other workspaces exist put a project on a board its
  // owner was not looking at. If there is a choice to make, it is made out loud.
  const known = listWorkspaces();
  const chosen = values.workspace ?? readPointer(root) ?? process.env["WECODE_WORKSPACE"];
  if (chosen === undefined && known.length > 0 && !known.includes("default")) {
    return fail(
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
  const release = make.release(project, "0.0.1");
  new Engine(conn).apply("project", project, "start", "operator");
  new Engine(conn).apply("release", release, "start", "operator");

  process.stdout.write(
    [
      `stack       ${learned.stack}`,
      `test        ${learned.test}`,
      learned.typecheck === null ? null : `typecheck   ${learned.typecheck}`,
      `source      ${learned.source.join(", ")}`,
      "",
      `workspace   ${wsName}  (${path})`,
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
    ["STALE", b.stale],
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
      // A title longer than the column pushed every other column off the line.
      const what = r.what.length > 52 ? `${r.what.slice(0, 51)}…` : r.what.padEnd(52);
      process.stdout.write(`  #${String(r.id).padStart(4)}  ${what}  ${r.state.padEnd(12)} ${r.detail}\n`);
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

  // The same guard create has. Ids are global, and this one writes: scoping another
  // project's task is silent, and was.
  const wrong = elsewhere("task", id);
  if (wrong !== null) return fail(wrong);

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
      project: { type: "string" },
    },
  });

  const text = positionals.join(" ");
  const parent = Number(values["parent"]);

  // Ids are global. A parent in another project's tree is how a story ends up built in the
  // wrong repository — the agents run wherever the task's project points, which is correct
  // and was not what anybody meant.
  if (Number.isInteger(parent) && values["project"] === undefined) {
    const wrong = crossesProject(entity, parent);
    if (wrong !== null) return fail(wrong);
  }
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
    // Say what it joined. --parent takes any number, and ids are global: attaching to
    // another project's tree is silent otherwise, and was.
    process.stdout.write(`${entity} #${id}${where(entity, id)}\n`);
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

/** The project a row belongs to, by walking up. Null when the entity has no project. */
function projectOf(entity: string, id: number): { id: number; name: string; repo: string } | null {
  const up: Readonly<Record<string, string>> = {
    release: "SELECT p.id, p.name, p.repo FROM release x JOIN project p ON p.id = x.project_id WHERE x.id = ?",
    epic: "SELECT p.id, p.name, p.repo FROM epic x JOIN release r ON r.id = x.release_id JOIN project p ON p.id = r.project_id WHERE x.id = ?",
    story:
      "SELECT p.id, p.name, p.repo FROM story x JOIN epic e ON e.id = x.epic_id JOIN release r ON r.id = e.release_id JOIN project p ON p.id = r.project_id WHERE x.id = ?",
    requirement:
      "SELECT p.id, p.name, p.repo FROM requirement x JOIN story s ON s.id = x.story_id JOIN epic e ON e.id = s.epic_id JOIN release r ON r.id = e.release_id JOIN project p ON p.id = r.project_id WHERE x.id = ?",
    acceptance_criteria:
      "SELECT p.id, p.name, p.repo FROM acceptance_criteria x JOIN requirement q ON q.id = x.requirement_id JOIN story s ON s.id = q.story_id JOIN epic e ON e.id = s.epic_id JOIN release r ON r.id = e.release_id JOIN project p ON p.id = r.project_id WHERE x.id = ?",
    acceptance_test:
      "SELECT p.id, p.name, p.repo FROM acceptance_test x JOIN acceptance_criteria c ON c.id = x.parent_id JOIN requirement q ON q.id = c.requirement_id JOIN story s ON s.id = q.story_id JOIN epic e ON e.id = s.epic_id JOIN release r ON r.id = e.release_id JOIN project p ON p.id = r.project_id WHERE x.id = ?",
    task: "SELECT p.id, p.name, p.repo FROM task x JOIN acceptance_test a ON a.id = x.acceptance_test_id JOIN acceptance_criteria c ON c.id = a.parent_id JOIN requirement q ON q.id = c.requirement_id JOIN story s ON s.id = q.story_id JOIN epic e ON e.id = s.epic_id JOIN release r ON r.id = e.release_id JOIN project p ON p.id = r.project_id WHERE x.id = ?",
    project: "SELECT p.id, p.name, p.repo FROM project p WHERE p.id = ?",
  };
  const sql = up[entity];
  if (sql === undefined) return null;
  try {
    return (db().prepare(sql).get(id) as { id: number; name: string; repo: string } | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The parent entity a child of this kind hangs off. */
const PARENT_OF: Readonly<Record<string, string>> = {
  release: "project",
  epic: "release",
  story: "epic",
  requirement: "story",
  acceptance_criteria: "requirement",
  acceptance_test: "acceptance_criteria",
  task: "acceptance_test",
  task_test: "task",
};

/** Refuse a parent whose project is not the one this repository is. */
function crossesProject(entity: string, parent: number): string | null {
  const parentEntity = PARENT_OF[entity];
  if (parentEntity === undefined || parentEntity === "project") return null;
  return elsewhere(parentEntity, parent);
}

/** Null when this row is in the project you are standing in, a complaint when it is not. */
function elsewhere(entity: string, id: number): string | null {
  const theirs = projectOf(entity, id);
  if (theirs === null) return null;

  const here = resolve(process.cwd());
  const mine = db().prepare("SELECT id, name FROM project WHERE repo = ?").get(here) as
    | { id: number; name: string }
    | undefined;
  if (mine === undefined || mine.id === theirs.id) return null;

  return (
    `${entity} #${id} belongs to project #${theirs.id} ${theirs.name} (${theirs.repo}),\n` +
    `but you are in #${mine.id} ${mine.name}.\n` +
    `  wecode tree ${mine.id}          to find the right one\n` +
    `  --project ${theirs.id}          if you meant it`
  );
}

/** The parent this row hangs off, named. */
function where(entity: string, id: number): string {
  const parents: Readonly<Record<string, { table: string; fk: string; label: string }>> = {
    project: { table: "workspace", fk: "workspace_id", label: "name" },
    release: { table: "project", fk: "project_id", label: "name" },
    epic: { table: "release", fk: "release_id", label: "version" },
    story: { table: "epic", fk: "epic_id", label: "title" },
    requirement: { table: "story", fk: "story_id", label: "title" },
    acceptance_criteria: { table: "requirement", fk: "requirement_id", label: "statement" },
    acceptance_test: { table: "acceptance_criteria", fk: "parent_id", label: "statement" },
    task: { table: "acceptance_test", fk: "acceptance_test_id", label: "statement" },
    task_test: { table: "task", fk: "parent_id", label: "title" },
  };
  const up = parents[entity];
  if (up === undefined) return "";
  try {
    const row = db()
      .prepare(
        `SELECT p.id AS id, p.${up.label} AS label FROM ${entity} c JOIN ${up.table} p ON p.id = c.${up.fk} WHERE c.id = ?`,
      )
      .get(id) as { id: number; label: string } | undefined;
    if (row === undefined) return "";
    const label = row.label.length > 44 ? `${row.label.slice(0, 43)}…` : row.label;
    return `   under ${up.table} #${row.id}  ${label}`;
  } catch {
    return "";
  }
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
      "  wecode workspaces                          which workspaces exist, and which is current",
      "",
      "MAKING WORK",
      '  wecode <entity> create --parent <id> "<text>" [--artefact "<cmd>"] [--role <name>]',
      '  wecode task scope <id> --write "a.ts,b.ts"  which files that task may change',
      "  wecode plan <file.yaml> [--epic <id>]      a whole story as one document (--dry-run to look)",
      "  wecode worker create <name> --role engineer --kind agent",
      "",
      "MOVING WORK",
      "  wecode <entity> <verb> <id>                start, deliver, pass, fail, drop, retry …",
      '  wecode answer <assignment> "<text>"        clears a needs_human',
      "  wecode land <story>                        merge a delivered story into your branch",
      "",
      "LOOKING",
      "  wecode show <entity> <id>                  one record",
      "  wecode tree [project]                      the whole shape, project to task_test",
      "  wecode watch [--project N] [--json]        one line per state change, forever (--once to drain)",
      "  wecode wait <entity> <id>                  block until it settles; the exit code is the answer",
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
