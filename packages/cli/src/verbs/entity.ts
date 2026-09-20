/** The entity half of the cli: what a record *is*, and the two verbs that amend one —
 *  scope and retry — with the help text each of them answers `--help` with. The making
 *  verbs, `create`'s help and `artefact`, live in `verbs/make.ts`: both halves in one file
 *  is over the ceiling.
 *
 *  Where `verbs/work.ts` and `verbs/tree.ts` hold one rung each, this holds what every rung
 *  has in common: the table it is, the column that names it, the row it hangs off. `Kin` is
 *  that, written down once, and `ENTITIES` is the shape of the tree as this client knows
 *  it — `under`, `instead`, `projectOf` and `elsewhere` all read it rather than each
 *  carrying a copy.
 *
 *  Nothing here reads argv it was not handed, and nothing here opens the workspace: the
 *  database, how a refusal is said and who is asking arrive as `At`, the same way
 *  `verbs/run-and-see.ts` takes its context. An interface rather than an import, because
 *  importing run.ts back would be a cycle. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  attributedTo,
  Engine,
  open,
  readProjectConfig,
  setTaskScope,
  Verbs,
  type Actor,
} from "@wecode/core";
// The typed query layer is not on `@wecode/core`'s index, so it is reached by its own path.
import { queries, table, type Dialect, type TableDef, type Value } from "@wecode/core/dist/db.js";

/** What run.ts lends: the workspace database, how a refusal is said, and who is asking. */
export interface At {
  readonly conn: () => ReturnType<typeof open>;
  readonly fail: (why: string) => number;
  readonly actor: () => Actor;
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
type LedgerRow = { id: number; entity: string; entity_id: number; verb: string; from_state: string; to_state: string;
  actor: string; at: string };
/** The runner's table, written here too because this is the path that actually merges. */
export type LandedRow = { task_id: number; branch: string; sha: string; merged_at: string };

export const workspace = table<WorkspaceRow>("workspace", ["id", "slug", "name", "path", "created_at", "updated_at"]);
export const project = table<ProjectRow>("project", [
  "id", "slug", "workspace_id", "name", "repo", "objective", "state", "created_at", "updated_at",
]);
const release = table<ReleaseRow>("release", [
  "id", "slug", "project_id", "version", "released_at", "state", "created_at", "updated_at",
]);
const epic = table<EpicRow>("epic", ["id", "slug", "release_id", "title", "state", "created_at", "updated_at"]);
export const story = table<StoryRow>("story", ["id", "slug", "epic_id", "title", "state", "created_at", "updated_at"]);
export const requirement = table<RequirementRow>("requirement", [
  "id", "slug", "story_id", "statement", "state", "created_at", "updated_at",
]);
export const criteria = table<CriteriaRow>("acceptance_criteria", [
  "id", "slug", "requirement_id", "statement", "state", "created_at", "updated_at",
]);
const TEST_COLUMNS = [
  "id", "slug", "parent_id", "statement", "kind", "artefact", "last_run_at", "last_output",
  "state", "created_at", "updated_at", "script_path",
] as const;
// The order is the migrations' order: 005 added script_path, 006 the three red-at-base
// columns, 013 provenance_sha — and `show` prints columns in the order they are declared.
export const acceptanceTest = table<AcceptanceTestRow>("acceptance_test", [
  ...TEST_COLUMNS, "red_at_base_sha", "red_at_base_at", "red_at_base_reason", "provenance_sha",
]);
const taskTest = table<TestRow>("task_test", [...TEST_COLUMNS, "provenance_sha"]);
export const task = table<TaskRow>("task", [
  "id", "slug", "acceptance_test_id", "title", "scope", "role", "budget", "attempts", "max_retry",
  "state", "created_at", "updated_at",
]);
const role = table<RoleRow>("role", ["id", "slug", "name", "scope", "worker_kind", "harness", "created_at", "updated_at"]);
export const worker = table<WorkerRow>("worker", ["id", "slug", "name", "role", "kind", "created_at", "updated_at"]);
export const assignment = table<AssignmentRow>("assignment", [
  "id", "slug", "objective_type", "objective_id", "worker_id", "scope", "budget", "worktree",
  "phase", "reason", "kind", "question", "options", "answer", "answered_by", "session",
  "last_seen", "spent", "commit_sha", "created_at", "updated_at",
]);
export const ledger = table<LedgerRow>("ledger", [
  "id", "entity", "entity_id", "verb", "from_state", "to_state", "actor", "at",
]);
export const landedBranch = table<LandedRow>("landed_branch", ["task_id", "branch", "sha", "merged_at"]);

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
export interface Kin {
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

export function kin<Row extends Shape>(
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
export const ENTITIES: Readonly<Record<string, Kin>> = {
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

/** What to say about an id that is not there: the ids of that entity that are. */
export function instead(q: Dialect, entity: string, id: number): string {
  // No ORDER BY in the dialect, and the ids are what the answer is about, so they are sorted
  // here. `show` has already refused a word that is not an entity.
  const rows = (ENTITIES[entity]?.names(q) ?? []).sort((a, b) => a.id - b.id);
  if (rows.length === 0) return `no ${entity} #${id}, and no ${entity} at all yet.`;
  const shown = rows.slice(0, 20).map((r) => `  #${r.id}  ${String(r.label)}`);
  const more = rows.length > shown.length ? [`  … and ${rows.length - shown.length} more`] : [];
  return [`no ${entity} #${id}. These ${entity} ids exist:`, ...shown, ...more].join("\n");
}

/** The project a row belongs to, by walking the tree up one link at a time. Null for the
 *  entities that hang off no project at all — a worker, a role, the workspace itself. */
export function projectOf(at: At, entity: string, id: number): { id: number; name: string; repo: string } | null {
  const q = queries(at.conn());
  let here = entity;
  let where = id;
  // The chain is nine deep at most; the bound stops a cycle in bad data spinning forever.
  for (let step = 0; step <= Object.keys(ENTITIES).length; step += 1) {
    if (here === "project") {
      return q.selectFrom(project).select(["id", "name", "repo"]).where("id", "=", where).get();
    }
    const kind = ENTITIES[here];
    if (kind === undefined || kind.up === null || kind.parent === null) return null;
    const pid = kind.up(q, where);
    if (pid === null) return null;
    here = kind.parent;
    where = pid;
  }
  return null;
}

/** Refuse a parent whose project is not the one this repository is. */
export function crossesProject(at: At, entity: string, parent: number): string | null {
  const parentEntity = ENTITIES[entity]?.parent;
  if (parentEntity === undefined || parentEntity === null || parentEntity === "project") return null;
  return elsewhere(at, parentEntity, parent);
}

/** Null when this row is in the project you are standing in, a complaint when it is not. */
export function elsewhere(at: At, entity: string, id: number): string | null {
  const theirs = projectOf(at, entity, id);
  if (theirs === null) return null;

  const here = resolve(process.cwd());
  const mine = queries(at.conn()).selectFrom(project).select(["id", "name"]).where("repo", "=", here).get();
  if (mine === null || mine.id === theirs.id) return null;

  return (
    `${entity} #${id} belongs to project #${theirs.id} ${theirs.name} (${theirs.repo}),\n` +
    `but you are in #${mine.id} ${mine.name}.\n` +
    `  wecode tree ${mine.id}          to find the right one\n` +
    `  --project ${theirs.id}          if you meant it`
  );
}

/** The parent this row hangs off, named. */
export function under(at: At, entity: string, id: number): string {
  const kind = ENTITIES[entity];
  if (kind === undefined || kind.up === null || kind.parent === null) return "";
  const up = ENTITIES[kind.parent];
  if (up === undefined) return "";
  try {
    // The join the SQL spelled, as its two halves: the child names its parent's id, and the
    // parent names itself. Each half is checked against the table it reads.
    const q = queries(at.conn());
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

/** `wecode task retry <id> --reason "<text>"` — the way back from failed.
 *
 *  The reason is required, and attempts go back to zero: a retry with the counter left at
 *  the limit fails the guard again on the next tick, which is how an exhausted task
 *  dangles. The runner never comes down this path — it can push a task to failed and no
 *  further, because a fourth attempt is a judgement about why the first three did not
 *  work. The reason rides on the ledger's actor, which is the only column that survives
 *  with the transition it explains. */
export function retry(at: At, args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { reason: { type: "string" } },
  });
  const id = Number(positionals[0]);
  const reason = (values.reason ?? "").trim();
  if (!Number.isInteger(id) || reason === "") {
    return at.fail('wecode task retry <id> --reason "<why a further attempt will go differently>"');
  }

  const wrong = elsewhere(at, "task", id);
  if (wrong !== null) return at.fail(wrong);

  const conn = at.conn();
  const q = queries(conn);
  const before = q.selectFrom(task).select(["attempts", "max_retry"]).where("id", "=", id).get();
  if (before === null) return at.fail(`no task #${id}`);

  const who = at.actor();
  const out = new Verbs(new Engine(conn)).retryTask(id, attributedTo(who, reason));
  if (!out.ok) return at.fail(out.why);
  // After the transition: a refused retry must not leave the counter reset behind it.
  q.update(task).set({ attempts: 0, updated_at: new Date().toISOString() }).where("id", "=", id).run();

  for (const c of out.changes) {
    process.stdout.write(`${c.entity} #${c.id}  ${c.from} → ${c.to}${c.automatic ? "  (cascade)" : ""}\n`);
  }
  process.stdout.write(`attempts ${before.attempts} → 0 of ${before.max_retry}  ·  ${who}: ${reason}\n`);
  return 0;
}

/** `wecode task scope <id> --write "src/**,tests/**" --tools bash,read` */
export function scope(at: At, entity: string, args: readonly string[]): number {
  if (entity !== "task") return at.fail("only a task carries a scope");
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { write: { type: "string" }, tools: { type: "string" } },
  });
  const id = Number(positionals[0]);
  if (!Number.isInteger(id)) return at.fail('wecode task scope <id> --write "src/**" --tools bash');

  // The same guard create has. Ids are global, and this one writes: scoping another
  // project's task is silent, and was.
  const wrong = elsewhere(at, "task", id);
  if (wrong !== null) return at.fail(wrong);

  const list = (v: string | undefined): string[] =>
    v === undefined || v === "" ? [] : v.split(",").map((s) => s.trim()).filter((s) => s !== "");

  const learned = projectConfig();
  const write =
    values.write === undefined && learned !== null ? [...learned.source, ...learned.tests] : list(values.write);
  const tools = values.tools === undefined ? ["bash", "read", "edit", "write"] : list(values.tools);

  try {
    setTaskScope(at.conn(), id, { write, tools });
    process.stdout.write(`task #${id} scope ${write.join(", ")}\n`);
    return 0;
  } catch (err) {
    return at.fail((err as Error).message);
  }
}

/** What onboarding learned about this repository, read where you are standing. `scope`
 *  defaults its write list from it, and run.ts's `create` falls a test's artefact back to
 *  it: retyping the test command into every record is how they drift. */
export function projectConfig(): ReturnType<typeof readProjectConfig> {
  return readProjectConfig(resolve(process.cwd(), "config/project.yaml"));
}

export function scopeHelp(): number {
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
