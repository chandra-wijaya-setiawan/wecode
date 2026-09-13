import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  board,
  Engine,
  Maker,
  open,
  setTaskScope,
  STATEFUL,
  type StatefulEntity,
  type TestKind,
  type WorkerKind,
} from "@wecode/core";

const DB = (): string => process.env["WECODE_DB"] ?? resolve(process.cwd(), ".wecode/wecode.db");

const isStateful = (s: string): s is StatefulEntity => (STATEFUL as readonly string[]).includes(s);

export function run(argv: readonly string[]): number {
  const [head, ...rest] = argv;
  if (head === undefined || head === "help" || head === "--help") return usage();
  if (head === "board") return showBoard();
  if (head === "init") return init();
  if (head === "answer") return answer(rest);
  if (head === "show") return show(rest);
  return verb(head, rest);
}

function init(): number {
  const path = DB();
  mkdirSync(dirname(path), { recursive: true });
  open(path).close();

  const config = resolve(process.cwd(), "config");
  mkdirSync(config, { recursive: true });
  write(join(config, "roles.yaml"), ROLES);
  write(join(config, "budget.yaml"), BUDGET);

  process.stdout.write(`wecode at ${path}\nconfig/roles.yaml, config/budget.yaml\n`);
  return 0;
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

function db() {
  return open(DB());
}

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

  try {
    setTaskScope(db(), id, { write: list(values.write), tools: list(values.tools) });
    process.stdout.write(`task #${id} scope set\n`);
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
        id = make.acceptanceTest(needsParent(), text, kindOf(values["kind"]), values["artefact"] ?? null);
        break;
      case "task_test":
        id = make.taskTest(needsParent(), text, kindOf(values["kind"]), values["artefact"] ?? null);
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
      "wecode — deterministic project management for coding agents",
      "",
      "  wecode init",
      "  wecode board",
      '  wecode <entity> create --parent <id> "<text>"',
      "  wecode <entity> <verb> <id>",
      '  wecode task scope <id> --write "src/**" --tools bash',
      '  wecode answer <assignment> "<text>"',
      "  wecode show <entity> <id>",
      "",
      `entities with states: ${STATEFUL.join(", ")}`,
      "",
    ].join("\n"),
  );
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
