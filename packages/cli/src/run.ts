import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  actorOf,
  attributedTo,
  Completions,
  Engine,
  Maker,
  OPERATOR,
  currentDatabase,
  databaseOf,
  listWorkspaces,
  lessons,
  dropLesson,
  tree,
  type Node,
  loadMachines,
  open,
  restate,
  isRestatable,
  RESTATABLE,
  setArtefact,
  setScriptPath,
  setTaskScope,
  STATEFUL,
  TRANSITIONS,
  Verbs,
  readProjectConfig,
  type Actor,
  type Outcome,
  type StatefulEntity,
  type TestKind,
  type WorkerKind,
} from "@wecode/core";
// The typed query layer is not on `@wecode/core`'s index, so it is reached by its own path.
import { queries, table, type Dialect, type TableDef, type Value } from "@wecode/core/dist/db.js";
import { paint } from "./paint.js";
// The verbs that run something or show you something. Namespaced because several of them —
// `board`, `worker`, `answer` — are also words this file uses for a table or a column.
import * as see from "./verbs/run-and-see.js";
// The verbs that only look: board, doctor, delivered, explore, design. Namespaced for the
// same reason — `board` and `design` are also words this file uses.
import * as read from "./verbs/read.js";
// Namespaced because `tree` is already the core query that reads the whole shape back.
import * as rungs from "./verbs/tree.js";
// Namespaced for the same reason: `requirement` and `task` are already tables in this file.
import * as work from "./verbs/work.js";

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
  if (head === "board") return read.board(seen(rest));
  if (head === "doctor") return read.doctor(rest);
  if (head === "init") return init(rest);
  if (head === "answer") return see.answer(seen(rest));
  if (head === "ask") return see.ask(seen(rest));
  if (head === "show") return show(rest);
  if (head === "land") return see.land(seen(rest));
  if (head === "onboard") return see.onboard(seen(rest));
  if (head === "plan") return see.plan(rest);
  if (head === "explore") return later(read.explore(rest));
  if (head === "paint") return later(paint(rest));
  if (head === "workspaces") return workspaces();
  if (head === "tree") return showTree(rest);
  if (head === "watch") return watch(rest);
  if (head === "wait") return wait(rest);
  // Before verb(): `delivered` is a story state as well as a command, so falling through
  // would read it as an entity and answer "delivered has no states".
  if (head === "delivered") return read.delivered(rest);
  if (head === "lessons") return showLessons(rest);
  if (head === "lesson") return lesson(rest);
  return verb(head, rest);
}

/** The commands whose answer is not known by the time dispatch returns.
 *
 *  A repository index builds a snapshot, and the projector loads `@wecode/lens` at the moment
 *  of use, so both are async and `run()` is not — bin.ts assigns what run() returns straight to
 *  process.exitCode, and a promise is not an exit code. So the command settles the exit
 *  code itself once the index has answered; node does not exit while that promise is
 *  outstanding, and nothing after it here overwrites a non-zero one.
 *
 *  A caller who needs the answer rather than the side effect awaits `answered()`. */
let pending: Promise<number> = Promise.resolve(0);

function later(answer: Promise<number>): number {
  pending = answer.then((code) => {
    if (code !== 0) process.exitCode = code;
    return code;
  });
  return 0;
}

/** What the last such command answered, once it has. Zero when none has been asked. */
export const answered = (): Promise<number> => pending;

/** `wecode init [name] [--workspace <name>]` — an empty workspace, and nothing else.
 *
 *  A workspace holds projects; onboarding a repository is what puts one in it. This exists
 *  for the case where you want the workspace before you have a repository.
 *
 *  Which workspace it makes is not read off the directory you are standing in. Resolving
 *  through this repository's pointer made `wecode init` inside an onboarded repo report
 *  "workspace at …/acme" — it named the workspace you were already in and created nothing.
 *  A name given here wins; otherwise an explicit database, then an explicit name in the
 *  environment, then "default". The pointer never decides. */
function init(args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { workspace: { type: "string" } },
  });
  const asked = values.workspace ?? positionals[0];
  const path =
    asked !== undefined
      ? databaseOf(asked)
      : process.env["WECODE_DB"] !== undefined
        ? resolve(process.env["WECODE_DB"])
        : databaseOf(process.env["WECODE_WORKSPACE"] ?? "default");

  mkdirSync(dirname(path), { recursive: true });
  open(path).close();
  process.stdout.write(`workspace at ${path}\n  wecode onboard   in a repository, to put a project in it\n`);
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
  const q = queries(db());
  const narrow = values.project === undefined ? null : Number(values.project);

  // The dialect has no `max(id)` and no LIMIT, so the ledger's high-water mark is the
  // largest of the ids it hands back. Only the id column crosses.
  let cursor =
    values.since === undefined
      ? q.selectFrom(ledger).select(["id"]).all().reduce((n, r) => Math.max(n, r.id), 0)
      : Number(values.since);

  const tick = (): void => {
    // Nor an ORDER BY: the ledger is append-only and read by id, so the ordering the lines
    // are printed in is done here rather than in SQL.
    const rows = q
      .selectFrom(ledger)
      .where("id", ">", cursor)
      .all()
      .sort((a, b) => a.id - b.id);

    for (const r of rows) {
      cursor = r.id;
      if (narrow !== null && projectOf(r.entity, r.entity_id)?.id !== narrow) continue;
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

  // Which column holds the state is the entity's business, not this command's: it used to
  // be `entity === "assignment" ? "phase" : "state"` spliced into the SQL beside the table
  // name, and both are now the entity's own typed read.
  const read = ENTITIES[entity]?.state;
  if (read === undefined || read === null) return fail(`${entity} has no states to wait on`);

  const q = queries(db());
  const deadline = values.timeout === undefined ? null : Date.now() + Number(values.timeout) * 1000;

  const look = (): string | null => read(q, id);

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

  for (const root of nodes) walk(root, "", true, true);
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
  // No `count(*)` in the dialect. One column of every row is what a count over a table this
  // size costs anyway, and it is a number nothing has to be cast to.
  const n = queries(conn).selectFrom(project).select(["id"]).all().length;
  conn.close();
  return n;
}

// ─── the record, in tables rather than in strings ────────────────────────────────────────
//
// `repo.ts` declares only the columns it speaks about; this client cannot, because `show`
// prints a whole record and the SQL it replaces was `SELECT *`. So these lists are the
// schema, which makes them a second copy of it — and a second copy with no check between it
// and the first is the defect. `typed-run.test.ts` holds every list below against
// `PRAGMA table_info`, name for name and in order, so a column added on either side fails.

export type WorkspaceRow = { id: number; slug: string; name: string; path: string; created_at: string; updated_at: string };
export type ProjectRow = { id: number; slug: string; workspace_id: number; name: string; repo: string; objective: string;
  state: string; created_at: string; updated_at: string };
type ReleaseRow = { id: number; slug: string; project_id: number; version: string; released_at: string | null;
  state: string; created_at: string; updated_at: string };
type EpicRow = { id: number; slug: string; release_id: number; title: string; state: string; created_at: string; updated_at: string };
export type StoryRow = { id: number; slug: string; epic_id: number; title: string; state: string; created_at: string; updated_at: string };
export type RequirementRow = { id: number; slug: string; story_id: number; statement: string; state: string;
  created_at: string; updated_at: string };
export type CriteriaRow = { id: number; slug: string; requirement_id: number; statement: string; state: string;
  created_at: string; updated_at: string };
/** Both test tables carry the same columns bar the extra three an acceptance_test earns by
 *  being the thing that must have been seen to fail at the base. */
export type TestRow = { id: number; slug: string; parent_id: number; statement: string; kind: string; artefact: string | null;
  last_run_at: string | null; last_output: string | null; state: string; created_at: string; updated_at: string;
  script_path: string | null; provenance_sha: string | null };
export type AcceptanceTestRow = TestRow & { red_at_base_sha: string | null; red_at_base_at: string | null;
  red_at_base_reason: string | null };
export type TaskRow = { id: number; slug: string; acceptance_test_id: number; title: string; scope: string; role: string;
  budget: string; attempts: number; max_retry: number; state: string; created_at: string; updated_at: string };
type RoleRow = { id: number; slug: string; name: string; scope: string; worker_kind: string; harness: string | null;
  created_at: string; updated_at: string };
export type WorkerRow = { id: number; slug: string; name: string; role: string; kind: string; created_at: string; updated_at: string };
export type AssignmentRow = { id: number; slug: string; objective_type: string; objective_id: number; worker_id: number;
  scope: string; budget: string; worktree: string; phase: string; reason: string | null; kind: string | null;
  question: string | null; options: string | null; answer: string | null; answered_by: string | null;
  session: string | null; last_seen: string | null; spent: string; commit_sha: string | null; created_at: string;
  updated_at: string };
type LedgerRow = {
  id: number;
  entity: string;
  entity_id: number;
  verb: string;
  from_state: string;
  to_state: string;
  actor: string;
  at: string;
};
/** The runner's table, written here too because this is the path that actually merges. */
export type LandedRow = { task_id: number; branch: string; sha: string; merged_at: string };

const workspace = table<WorkspaceRow>("workspace", ["id", "slug", "name", "path", "created_at", "updated_at"]);
const project = table<ProjectRow>("project", [
  "id", "slug", "workspace_id", "name", "repo", "objective", "state", "created_at", "updated_at",
]);
const release = table<ReleaseRow>("release", [
  "id", "slug", "project_id", "version", "released_at", "state", "created_at", "updated_at",
]);
const epic = table<EpicRow>("epic", ["id", "slug", "release_id", "title", "state", "created_at", "updated_at"]);
const story = table<StoryRow>("story", ["id", "slug", "epic_id", "title", "state", "created_at", "updated_at"]);
const requirement = table<RequirementRow>("requirement", [
  "id", "slug", "story_id", "statement", "state", "created_at", "updated_at",
]);
const criteria = table<CriteriaRow>("acceptance_criteria", [
  "id", "slug", "requirement_id", "statement", "state", "created_at", "updated_at",
]);
const TEST_COLUMNS = [
  "id", "slug", "parent_id", "statement", "kind", "artefact", "last_run_at", "last_output",
  "state", "created_at", "updated_at", "script_path",
] as const;
// The order is the migrations' order: 005 added script_path, 006 the three red-at-base
// columns, 013 provenance_sha — and `show` prints columns in the order they are declared.
const acceptanceTest = table<AcceptanceTestRow>("acceptance_test", [
  ...TEST_COLUMNS, "red_at_base_sha", "red_at_base_at", "red_at_base_reason", "provenance_sha",
]);
const taskTest = table<TestRow>("task_test", [...TEST_COLUMNS, "provenance_sha"]);
const task = table<TaskRow>("task", [
  "id", "slug", "acceptance_test_id", "title", "scope", "role", "budget", "attempts", "max_retry",
  "state", "created_at", "updated_at",
]);
const role = table<RoleRow>("role", ["id", "slug", "name", "scope", "worker_kind", "harness", "created_at", "updated_at"]);
const worker = table<WorkerRow>("worker", ["id", "slug", "name", "role", "kind", "created_at", "updated_at"]);
const assignment = table<AssignmentRow>("assignment", [
  "id", "slug", "objective_type", "objective_id", "worker_id", "scope", "budget", "worktree",
  "phase", "reason", "kind", "question", "options", "answer", "answered_by", "session",
  "last_seen", "spent", "commit_sha", "created_at", "updated_at",
]);
const ledger = table<LedgerRow>("ledger", [
  "id", "entity", "entity_id", "verb", "from_state", "to_state", "actor", "at",
]);
const landedBranch = table<LandedRow>("landed_branch", ["task_id", "branch", "sha", "merged_at"]);

/** Every list above, for the test that holds them against the database. Only the names and
 *  the order escape: `TableDef<Row>` is invariant in `Row`, so a list of differently-shaped
 *  tables has no useful element type — but `{ name, columns: readonly string[] }` is what
 *  the check needs and every `TableDef` already is one. */
export const DECLARED: readonly { readonly name: string; readonly columns: readonly string[] }[] = [
  workspace, project, release, epic, story, requirement, criteria, acceptanceTest, taskTest,
  task, role, worker, assignment, ledger,
];

/** A row this client can be handed by name: it has an id, and every column holds something
 *  SQLite stores. The index signature is what lets one whole record be printed without
 *  knowing which entity it is. */
type Shape = { id: number } & Record<string, Value>;

/** What `show`, `wait`, `where` and the missing-id answer ask of one entity.
 *
 *  The shape of the tree is still written down once, as it was — but each row carries the
 *  typed query rather than a table name and a column name spliced into SQL text. The column
 *  is checked against the table it narrows where the lookup is written, which is the whole
 *  point of the port: a `Record<string, TableDef<Shape>>` cannot work, because `TableDef`'s
 *  `columns: (keyof Row)[]` makes it invariant in `Row`. */
interface Kin {
  /** The entity this hangs off, or null for the ones that hang off nothing. */
  readonly parent: string | null;
  /** Every row's id and the words that name it. */
  readonly names: (q: Dialect) => { id: number; label: string }[];
  /** The words that name one row. */
  readonly name: (q: Dialect, id: number) => string | null;
  /** One whole record, in the order the columns are declared above. */
  readonly row: (q: Dialect, id: number) => Record<string, Value> | null;
  /** The parent's id, for walking up to the project. */
  readonly up: ((q: Dialect, id: number) => number | null) | null;
  /** The state it is in — an assignment keeps it in `phase` — or null when it has none. */
  readonly state: ((q: Dialect, id: number) => string | null) | null;
}

function kin<Row extends Shape>(
  def: TableDef<Row>,
  label: keyof Row & string,
  opts: {
    readonly parent?: { readonly table: string; readonly fk: keyof Row & string };
    readonly state?: keyof Row & string;
  } = {},
): Kin {
  const { parent, state } = opts;
  const one = <K extends keyof Row & string>(q: Dialect, col: K, id: number): Row[K] | null => {
    const row = q.selectFrom(def).select([col]).where("id", "=", id).get();
    return row === null ? null : row[col];
  };
  return {
    parent: parent?.table ?? null,
    names: (q) =>
      q
        .selectFrom(def)
        .select(["id", label])
        .all()
        .map((r) => ({ id: r.id, label: String(r[label]) })),
    name: (q, id) => {
      const got = one(q, label, id);
      return got === null ? null : String(got);
    },
    row: (q, id) => q.selectFrom(def).where("id", "=", id).get(),
    up:
      parent === undefined
        ? null
        : (q, id) => {
            const got = one(q, parent.fk, id);
            return typeof got === "number" ? got : null;
          },
    state:
      state === undefined
        ? null
        : (q, id) => {
            const got = one(q, state, id);
            return typeof got === "string" ? got : null;
          },
  };
}

/** Which table each entity is, what names one, and the row it hangs off. The one place
 *  the shape of the tree is written down in this client — `where`, `show` and the missing-id
 *  answer all read it rather than each carrying their own copy. */
const ENTITIES: Readonly<Record<string, Kin>> = {
  workspace: kin(workspace, "name"),
  project: kin(project, "name", { parent: { table: "workspace", fk: "workspace_id" }, state: "state" }),
  release: kin(release, "version", { parent: { table: "project", fk: "project_id" }, state: "state" }),
  epic: kin(epic, "title", { parent: { table: "release", fk: "release_id" }, state: "state" }),
  story: kin(story, "title", { parent: { table: "epic", fk: "epic_id" }, state: "state" }),
  requirement: kin(requirement, "statement", { parent: { table: "story", fk: "story_id" }, state: "state" }),
  acceptance_criteria: kin(criteria, "statement", {
    parent: { table: "requirement", fk: "requirement_id" },
    state: "state",
  }),
  acceptance_test: kin(acceptanceTest, "statement", {
    parent: { table: "acceptance_criteria", fk: "parent_id" },
    state: "state",
  }),
  task: kin(task, "title", { parent: { table: "acceptance_test", fk: "acceptance_test_id" }, state: "state" }),
  task_test: kin(taskTest, "statement", { parent: { table: "task", fk: "parent_id" }, state: "state" }),
  assignment: kin(assignment, "slug", { state: "phase" }),
  role: kin(role, "name"),
  worker: kin(worker, "name"),
};

/** `wecode show <entity> <id>` — one record, whatever state it is in, and where it lives.
 *
 *  A record is shown in every state, dropped and done included: somebody reading an id out of
 *  old notes is asking what became of it, and a refusal answers that with silence. When the id
 *  is not there at all, the ids that are there are the answer — the epic did not vanish, it was
 *  rebuilt under another number, and only a list of the live ones says so. */
/** What run.ts lends the verbs in `verbs/run-and-see.ts`: the argv tail they were given,
 *  and the four things only this file knows — the workspace database, how a refusal is
 *  said, where you are standing, and the tables. */
const TABLES: see.Tables = {
  workspace, project, story, requirement, criteria, acceptanceTest, task, worker, assignment, landedBranch,
};

const seen = (args: readonly string[]): see.See => ({
  args, conn: db, fail, hereProject, actor: whoIsAsking, tables: TABLES,
});

function show(args: readonly string[]): number {
  const [entity, raw] = args;
  const id = Number(raw);
  if (entity === undefined || !Number.isInteger(id)) return fail("wecode show <entity> <id>");
  const kind = ENTITIES[entity];
  if (kind === undefined) {
    return fail(`no entity called ${entity}. There is ${Object.keys(ENTITIES).join(", ")}`);
  }
  const q = queries(db());
  const row = kind.row(q, id);
  if (row === null) return fail(instead(q, entity, id));
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === "") continue;
    process.stdout.write(`${k.padEnd(18)} ${String(v)}\n`);
  }
  const owner = projectOf(entity, id);
  if (owner !== null) process.stdout.write(`${"project".padEnd(18)} #${owner.id} ${owner.name}\n`);
  return 0;
}

/** What to say about an id that is not there: the ids of that entity that are. */
function instead(q: Dialect, entity: string, id: number): string {
  // No ORDER BY in the dialect, and the ids are what the answer is about, so they are sorted
  // here. `show` has already refused a word that is not an entity.
  const rows = (ENTITIES[entity]?.names(q) ?? []).sort((a, b) => a.id - b.id);
  if (rows.length === 0) return `no ${entity} #${id}, and no ${entity} at all yet.`;
  const shown = rows.slice(0, 20).map((r) => `  #${r.id}  ${String(r.label)}`);
  const more = rows.length > shown.length ? [`  … and ${rows.length - shown.length} more`] : [];
  return [`no ${entity} #${id}. These ${entity} ids exist:`, ...shown, ...more].join("\n");
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

/** The project this repository is, or null when you are standing outside all of them. */
function hereProject(): { id: number; name: string } | null {
  return queries(db())
    .selectFrom(project)
    .select(["id", "name"])
    .where("repo", "=", resolve(process.cwd()))
    .get();
}

/** What to say to somebody standing in a directory that is not a project: the command that
 *  would put one here, and — only when the workspace already holds projects — the ids that
 *  could be asked for instead. "no project here" alone left the next move to be guessed,
 *  and the guess was usually that the workspace was broken. */
function noProjectHere(command: string): string {
  const rows = queries(db())
    .selectFrom(project)
    .select(["id", "name"])
    .all()
    .sort((a, b) => a.id - b.id);
  const shown = rows.slice(0, 5).map((r) => `    #${r.id}  ${r.name}`);
  const more = rows.length > shown.length ? [`    … and ${rows.length - shown.length} more`] : [];
  return [
    // The first clause is kept as it was: another test reads this refusal by that phrase.
    `no project here — ${resolve(process.cwd())} is not one.`,
    "  wecode onboard   here, to make this repository one",
    ...(rows.length === 0 ? [] : [`  ${command} --project <id>   for a project you already have:`, ...shown, ...more]),
  ].join("\n");
}

/** `wecode lessons [--project N]` — what earlier attempts on this repository learned.
 *
 *  Each line carries the assignment that learned it and how old it is, because those are
 *  what a suspicious lesson is judged on: a lesson is a note about a world that changes. */
function showLessons(args: readonly string[]): number {
  const { values } = parseArgs({ args: [...args], options: { project: { type: "string" } } });
  const chosen = values.project === undefined ? hereProject()?.id ?? null : Number(values.project);
  if (chosen === null) {
    return fail(noProjectHere("wecode lessons"));
  }
  if (!Number.isInteger(chosen)) return fail("wecode lessons --project <id>");

  const conn = db();
  const found = lessons(conn, chosen);
  if (found.length === 0) {
    process.stdout.write("no lessons here yet\n");
    return 0;
  }
  for (const l of found) {
    const from = l.assignment_id === null ? "by hand" : assignmentName(conn, l.assignment_id);
    process.stdout.write(`  #${String(l.id).padStart(3)}  ${l.text}\n`);
    process.stdout.write(`        ${grey(`${from} · ${age(l.created_at)}`)}\n`);
  }
  return 0;
}

/** The assignment a lesson came from, so a suspicious one can be traced back to the attempt
 *  that wrote it. The foreign key is what makes the row certain to be there. */
function assignmentName(conn: ReturnType<typeof open>, id: number): string {
  const row = queries(conn).selectFrom(assignment).select(["slug"]).where("id", "=", id).get();
  return row === null ? `assignment #${id}` : `${row.slug} #${id}`;
}

function age(at: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

/** `wecode lesson drop <id>` — the operator's call, like everything else that is a
 *  judgement. A wrong lesson is worse than none, so this is one command with no ceremony. */
function lesson(args: readonly string[]): number {
  const [name, raw] = args;
  if (name !== "drop") return fail("wecode lesson drop <id>");
  const id = Number(raw);
  if (!Number.isInteger(id)) return fail("wecode lesson drop <id>");
  if (!dropLesson(db(), id)) return fail(`no lesson #${id}`);
  process.stdout.write(`lesson #${id} dropped\n`);
  return 0;
}

/** One invocation of the facade: every method on `Verbs` and on `Completions` takes an id
 *  and an actor and answers an Outcome, so a verb resolved off the command line has this
 *  one shape. */
type Invocation = (id: number, actor: Actor) => Outcome;

/** Who the command is attributed to: the environment's actor, or the person at the terminal.
 *  One place, so no command invents a second spelling of the same identity — and a blank
 *  `WECODE_ACTOR` is nobody rather than an empty name on the ledger. */
const whoIsAsking = (): Actor => actorOf(process.env["WECODE_ACTOR"]) ?? OPERATOR;

/** The facade method the command line's `<entity> <verb>` names, or null when no row of the
 *  machine table names that verb at all.
 *
 *  The machine table is not copied here. `TRANSITIONS` is generated beside `Verbs` from the
 *  same config and carries each row's method name, so the lookup resolves a name it was
 *  given rather than one this file spells — a verb renamed in machines.yaml regenerates
 *  both sides and this keeps working.
 *
 *  A declared verb resolves either way: an actor's verb to a `Verbs` method, a completion
 *  verb — `story deliver`, `task finish` — to a `Completions` one. The engine judged both
 *  before and judges both now, through the same guard; what is gone is the string call that
 *  reached them. Null is left for one thing only, a verb nobody declared. */
function invocation(
  verbs: Verbs,
  completions: Completions,
  entity: StatefulEntity,
  name: string,
): Invocation | null {
  const row = TRANSITIONS.find((t) => t.entity === entity && t.verb === name);
  if (row === undefined) return null;
  // Generated names, held against the two classes by facade.test.ts, so one descriptor is
  // there: `method` and `completion` are never both null and never both set.
  const on = row.method === null ? Completions.prototype : Verbs.prototype;
  const found = Object.getOwnPropertyDescriptor(on, row.method ?? (row.completion as string));
  const method = found?.value as Invocation | undefined;
  const self = row.method === null ? completions : verbs;
  return method === undefined ? null : (id, actor) => method.call(self, id, actor);
}

/** `wecode <entity> <verb> [id|args]` — the surface in docs/design/06. */
function verb(entity: string, rest: readonly string[]): number {
  const [name, ...args] = rest;
  if (name === undefined) return fail(`wecode ${entity} <verb> …`);

  // `design` is the one word that names both a record and a drawing. `show` is the
  // drawing — a screen declared in a file, projected to an svg, no ledger involved — and
  // every other verb, `create` first, is the row, so it goes on down this function.
  // The split is here rather than in dispatch() so the row stays the default and the
  // drawing the exception, both read in one place.
  if (entity === "design" && name === "show") return later(read.design([name, ...args]));

  // parseArgs would call --help an unknown option. It is the one place a newcomer looks
  // for create's flags, so answer it here, before the flags are parsed at all.
  const asked = args.some((a) => a === "--help" || a === "-h");
  if (name === "create") return asked ? createHelp(entity) : create(entity, args);
  if (name === "scope") return asked ? scopeHelp() : scope(entity, args);
  if (name === "artefact") return asked ? artefactHelp() : artefact(entity, args);
  if (name === "restate") return asked ? restateHelp() : restateVerb(entity, args);
  if (name === "retry" && entity === "task") return retry(args);

  if (!isStateful(entity)) return fail(`${entity} has no states; its only verb is create`);
  const id = Number(args[0]);
  if (!Number.isInteger(id)) return fail(`wecode ${entity} ${name} <id>`);

  const actor = whoIsAsking();
  const engine = new Engine(db());
  const invoke = invocation(new Verbs(engine), new Completions(engine), entity, name);
  // Only a verb no row of the machine table declares is left to the string call, and the
  // engine answers it with the same sentence it always did.
  const out = invoke === null ? engine.apply(entity, id, name, actor) : invoke(id, actor);
  if (!out.ok) return fail(out.why);

  for (const c of out.changes) {
    process.stdout.write(`${c.entity} #${c.id}  ${c.from} → ${c.to}${c.automatic ? "  (cascade)" : ""}\n`);
  }
  return 0;
}

/** `wecode task retry <id> --reason "<text>"` — the way back from failed.
 *
 *  The reason is required, and attempts go back to zero: a retry with the counter left at
 *  the limit fails the guard again on the next tick, which is how an exhausted task
 *  dangles. The runner never comes down this path — it can push a task to failed and no
 *  further, because a fourth attempt is a judgement about why the first three did not
 *  work. The reason rides on the ledger's actor, which is the only column that survives
 *  with the transition it explains. */
function retry(args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { reason: { type: "string" } },
  });
  const id = Number(positionals[0]);
  const reason = (values.reason ?? "").trim();
  if (!Number.isInteger(id) || reason === "") {
    return fail('wecode task retry <id> --reason "<why a further attempt will go differently>"');
  }

  const wrong = elsewhere("task", id);
  if (wrong !== null) return fail(wrong);

  const conn = db();
  const q = queries(conn);
  const before = q.selectFrom(task).select(["attempts", "max_retry"]).where("id", "=", id).get();
  if (before === null) return fail(`no task #${id}`);

  const who = whoIsAsking();
  const out = new Verbs(new Engine(conn)).retryTask(id, attributedTo(who, reason));
  if (!out.ok) return fail(out.why);
  // After the transition: a refused retry must not leave the counter reset behind it.
  q.update(task).set({ attempts: 0, updated_at: new Date().toISOString() }).where("id", "=", id).run();

  for (const c of out.changes) {
    process.stdout.write(`${c.entity} #${c.id}  ${c.from} → ${c.to}${c.automatic ? "  (cascade)" : ""}\n`);
  }
  process.stdout.write(`attempts ${before.attempts} → 0 of ${before.max_retry}  ·  ${who}: ${reason}\n`);
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

  const learned = projectConfig();
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

/** `wecode acceptance_test artefact <id> --set "bash test/mail.sh" [--script-path test/mail.sh]`
 *
 *  Without this the only cure for a wrongly typed artefact was to drop the test, which
 *  cascades its parent to a settled state and cannot be undone. */
function artefact(entity: string, args: readonly string[]): number {
  if (entity !== "acceptance_test" && entity !== "task_test") {
    return fail("only an acceptance_test or a task_test carries an artefact");
  }
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { set: { type: "string" }, "script-path": { type: "string" } },
  });
  const id = Number(positionals[0]);
  const how = `wecode ${entity} artefact <id> --set "<cmd>" [--script-path <path>]`;
  if (!Number.isInteger(id)) return fail(how);

  // The same guard scope has: ids are global, and this one writes.
  const wrong = elsewhere(entity, id);
  if (wrong !== null) return fail(wrong);

  const path = values["script-path"];
  if (values.set === undefined && path === undefined) return fail(how);

  try {
    if (values.set !== undefined) {
      setArtefact(db(), entity, id, values.set);
      process.stdout.write(`${entity} #${id} artefact ${values.set}\n`);
    }
    if (path !== undefined) {
      // An empty --script-path clears it: the path is spec, and a test may stop having one.
      setScriptPath(db(), entity, id, path.trim() === "" ? null : path);
      process.stdout.write(
        path.trim() === ""
          ? `${entity} #${id} script path cleared\n`
          : `${entity} #${id} script path ${path}\n`,
      );
    }
    return 0;
  } catch (err) {
    return fail((err as Error).message);
  }
}

/** `wecode story restate <id> --to "the words that are right"`
 *
 *  The cure for a typo. Before this the only route was to drop the record and create it
 *  again, which costs the slug (taken forever, so the replacement must be worded round it),
 *  a drop event on the ledger for what was a typo, and every record citing the id, which
 *  now points at a dropped row.
 *
 *  It takes only words. There is no flag here that names a state, and none is accepted:
 *  what happened to a record is a verdict, and a verdict is not a thing you retype. */
function restateVerb(entity: string, args: readonly string[]): number {
  if (!isRestatable(entity)) {
    return fail(`only ${Object.keys(RESTATABLE).join(", ")} carry prose to restate`);
  }
  const how = `wecode ${entity} restate <id> --to "<the words that are right>"`;
  let values: { to?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { to: { type: "string" } },
    }));
  } catch {
    // An unknown flag — `--state` among them — is the usage line, not a crash.
    return fail(how);
  }
  const id = Number(positionals[0]);
  if (!Number.isInteger(id) || values.to === undefined) return fail(how);

  // The same guard scope and artefact have: ids are global, and this one writes.
  const wrong = elsewhere(entity, id);
  if (wrong !== null) return fail(wrong);

  try {
    const who = whoIsAsking();
    const said = restate(db(), entity, id, values.to, who);
    process.stdout.write(`${entity} #${id} restated  was "${said.was}"  now "${said.now}"\n`);
    return 0;
  } catch (err) {
    return fail((err as Error).message);
  }
}

function restateHelp(): number {
  process.stdout.write(
    [
      `wecode <${Object.keys(RESTATABLE).join("|")}> restate <id> --to "<words>"`,
      "",
      "  correct the wording of a record without dropping it. the old wording goes on",
      "  the ledger, so the correction is itself part of the record.",
      "",
      "  the slug does not move: worktrees and branches are named after it.",
      "  this corrects words only — it can never change a state.",
      "",
      '  wecode story restate 201 --to "the typescript build ships a bundle"',
      "",
      "",
    ].join("\n"),
  );
  return 0;
}

function artefactHelp(): number {
  process.stdout.write(
    [
      "wecode <acceptance_test|task_test> artefact <id> [flags]",
      "",
      "  the command that proves the test, and where its script is meant to live.",
      "  changing the command clears any recorded red-at-base run: that run proved",
      "  something about the old command.",
      "",
      "  --set <cmd>          the command — refused when it is empty",
      "  --script-path <path> where the script lives (empty to clear it)",
      "",
      '  wecode acceptance_test artefact 1 --set "bash test/mail.sh" --script-path test/mail.sh',
      "",
      "",
    ].join("\n"),
  );
  return 0;
}

function create(entity: string, args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      parent: { type: "string" }, kind: { type: "string" }, artefact: { type: "string" },
      role: { type: "string" }, path: { type: "string" }, project: { type: "string" },
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
  const rung: rungs.Rung = { make, text, parent: needsParent, path: values["path"] ?? process.cwd() };
  // A thunk, so the artefact fallback only reads the project's config when a test is what
  // is being made — it is a question about the working directory, and the other three
  // never asked it.
  const job = (): work.Work => ({
    make, text, parent: needsParent,
    kind: kindOf(values["kind"]), artefact: artefactOr(values["artefact"]), role: values["role"] ?? "",
  });

  try {
    let id: number;
    switch (entity) {
      case "workspace": id = rungs.workspace(rung); break;
      case "project": id = rungs.project(rung); break;
      case "release": id = rungs.release(rung); break;
      case "epic": id = rungs.epic(rung); break;
      case "story": id = rungs.story(rung); break;
      case "requirement": id = work.requirement(job()); break;
      case "acceptance_criteria": id = work.acceptanceCriteria(job()); break;
      case "acceptance_test": id = work.acceptanceTest(job()); break;
      case "task_test": id = work.taskTest(job()); break;
      case "task": id = work.task(job()); break;
      case "worker":
        id = see.worker({
          make, text, role: values["role"] ?? "", kind: (values["kind"] ?? "agent") as WorkerKind,
        });
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
  return projectConfig()?.test ?? null;
}

function projectConfig(): ReturnType<typeof readProjectConfig> {
  return readProjectConfig(resolve(process.cwd(), "config/project.yaml"));
}

/** The project a row belongs to, by walking the tree up one link at a time. Null for the
 *  entities that hang off no project at all — a worker, a role, the workspace itself. */
function projectOf(entity: string, id: number): { id: number; name: string; repo: string } | null {
  const q = queries(db());
  let here = entity;
  let at = id;
  // The chain is nine deep at most; the bound stops a cycle in bad data spinning forever.
  for (let step = 0; step <= Object.keys(ENTITIES).length; step += 1) {
    if (here === "project") {
      return q.selectFrom(project).select(["id", "name", "repo"]).where("id", "=", at).get();
    }
    const kind = ENTITIES[here];
    if (kind === undefined || kind.up === null || kind.parent === null) return null;
    const pid = kind.up(q, at);
    if (pid === null) return null;
    here = kind.parent;
    at = pid;
  }
  return null;
}

/** Refuse a parent whose project is not the one this repository is. */
function crossesProject(entity: string, parent: number): string | null {
  const parentEntity = ENTITIES[entity]?.parent;
  if (parentEntity === undefined || parentEntity === null || parentEntity === "project") return null;
  return elsewhere(parentEntity, parent);
}

/** Null when this row is in the project you are standing in, a complaint when it is not. */
function elsewhere(entity: string, id: number): string | null {
  const theirs = projectOf(entity, id);
  if (theirs === null) return null;

  const here = resolve(process.cwd());
  const mine = queries(db()).selectFrom(project).select(["id", "name"]).where("repo", "=", here).get();
  if (mine === null || mine.id === theirs.id) return null;

  return (
    `${entity} #${id} belongs to project #${theirs.id} ${theirs.name} (${theirs.repo}),\n` +
    `but you are in #${mine.id} ${mine.name}.\n` +
    `  wecode tree ${mine.id}          to find the right one\n` +
    `  --project ${theirs.id}          if you meant it`
  );
}

/** The parent this row hangs off, named. */
function where(entity: string, id: number): string {
  const kind = ENTITIES[entity];
  if (kind === undefined || kind.up === null || kind.parent === null) return "";
  const up = ENTITIES[kind.parent];
  if (up === undefined) return "";
  try {
    // The join the SQL spelled, as its two halves: the child names its parent's id, and the
    // parent names itself. Each half is checked against the table it reads.
    const q = queries(db());
    const pid = kind.up(q, id);
    if (pid === null) return "";
    const named = up.name(q, pid);
    if (named === null) return "";
    const label = named.length > 44 ? `${named.slice(0, 43)}…` : named;
    return `   under ${kind.parent} #${pid}  ${label}`;
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
      "  wecode init [name]                         an empty workspace, before you have a repo",
      "  wecode board [--all]                       what is running, waiting, queued, failed",
      "  wecode workspaces                          which workspaces exist, and which is current",
      "",
      "MAKING WORK",
      '  wecode <entity> create --parent <id> "<text>" [--artefact "<cmd>"] [--role <name>]',
      '  wecode task scope <id> --write "a.ts,b.ts"  which files that task may change',
      '  wecode <test> artefact <id> --set "<cmd>"   fix the command a test is proved by',
      '  wecode <entity> restate <id> --to "<words>" fix the wording, keeping the slug',
      "  wecode plan <file.yaml> [--epic <id>]      a whole story as one document (--dry-run to look)",
      "  wecode worker create <name> --role engineer --kind agent",
      "",
      "MOVING WORK",
      "  wecode <entity> <verb> <id>                start, deliver, pass, fail, drop, retry …",
      '  wecode ask <task> "<question>"             put a decision in needs you (--option "yes=<cost>")',
      '  wecode answer <assignment> "<text>"        clears a needs_human',
      "  wecode land <story>                        merge a delivered story into your branch",
      "",
      "LOOKING",
      "  wecode show <entity> <id>                  one record",
      "  wecode tree [project]                      the whole shape, project to task_test",
      "  wecode watch [--project N] [--json]        one line per state change, forever (--once to drain)",
      "  wecode wait <entity> <id>                  block until it settles; the exit code is the answer",
      "  wecode <entity> --help                     that entity's states and verbs",
      "  wecode delivered [--all] [--project N]     what wecode can already do (--json)",
      "  wecode explore read|uses|purpose <file>    what is in this repository, asked of an index",
      "  wecode paint open|poll|end|export <file>   a drawing in front of a person, and what they said",
      "  wecode lessons [--project N]               what earlier attempts here learned",
      "  wecode lesson drop <id>                    a wrong lesson is worse than none",
      "  wecode doctor                              one pass of the invariants; non-zero if any is broken",
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
      "WHAT WECODE WILL NOT DO",
      "  it will not decide what to build — you write the requirement, it holds you to it",
      "  it will not judge work by an agent's word — only a test that ran says done",
      "  it will not let an agent widen its own scope — a scope is set before the work starts",
      "  it will not edit your code itself — every change arrives as a task an agent ran",
      "  it will not push, release or deploy — landing stops at a merge into your branch",
      "  it will not replace your test runner, vcs or ci — it drives the ones you have",
      "",
    ].join("\n"),
  );
  return 0;
}

/** Which flags each entity's create reads, and what one call looks like. Kept beside the
 *  switch in create() — the two must agree, and nothing else can check that they do. */
const CREATE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  workspace: ["path"], project: ["parent", "path"],
  release: ["parent"], epic: ["parent"], story: ["parent"],
  requirement: ["parent"], acceptance_criteria: ["parent"],
  acceptance_test: ["parent", "kind", "artefact"],
  task_test: ["parent", "kind", "artefact"],
  task: ["parent", "role"],
  worker: ["role", "kind"],
};

const FLAG_MEANS: Readonly<Record<string, string>> = {
  parent: "<id>     the record it hangs off — required, and ids are global",
  path: "<dir>      where the repository is (default: the current directory)",
  kind: "<kind>     acceptance_test / task_test: how it is run; worker: agent or human",
  artefact: "<cmd>  the command that proves it (default: this project's test command)",
  role: "<name>     which role does the work",
};

const CREATE_EXAMPLE: Readonly<Record<string, string>> = {
  workspace: 'wecode workspace create "acme" --path .',
  project: 'wecode project create --parent 1 "storefront" --path .',
  acceptance_test: 'wecode acceptance_test create --parent 1 "mail arrives" --artefact "bash mail.sh"',
  task_test: 'wecode task_test create --parent 1 "mailer called" --artefact "vitest run"',
  task: 'wecode task create --parent 1 "send the mail" --role engineer',
  worker: "wecode worker create ada --role engineer --kind agent",
};

function createHelp(entity: string): number {
  const flags = CREATE_FLAGS[entity];
  if (flags === undefined) return fail(`no such entity: ${entity}`);

  const example = CREATE_EXAMPLE[entity] ?? `wecode ${entity} create --parent 1 "<text>"`;
  const lines = [`wecode ${entity} create [flags] "<text>"`, "", "  the text is everything that is not a flag", ""];
  for (const f of flags) lines.push(`  --${f} ${FLAG_MEANS[f]}`);
  process.stdout.write(`${lines.join("\n")}\n\n  ${example}\n\n`);
  return 0;
}

function scopeHelp(): number {
  process.stdout.write(
    [
      "wecode task scope <id> [flags]",
      "",
      "  which files that task may change, and which tools its agent may use.",
      "  two tasks whose write scopes overlap will not run at the same time.",
      "",
      "  --write <globs>  comma-separated (default: this project's source and test paths)",
      "  --tools <names>  comma-separated (default: bash,read,edit,write)",
      "",
      '  wecode task scope 1 --write "src/**,tests/**" --tools bash,read',
      "",
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

