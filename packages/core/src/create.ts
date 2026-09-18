import type { DatabaseSync } from "node:sqlite";
import { commandOf } from "./checks.js";
import { queries, table, type TableDef, type Value } from "./db.js";
import type { Budget, ObjectiveType, Scope } from "./entities.js";
import { loadMachines } from "./machines.js";
import type { RoleConfig } from "./roles.js";
import { now } from "./store.js";
import type { MachineSet, StatefulEntity, TestKind, WorkerKind } from "./types.js";

export class CreateError extends Error {}

/** major.minor.patch, with an optional prerelease — semver's shape, without its full grammar. */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** Where a new row starts is the machine's business, not the caller's. */
const initialOf = (m: MachineSet, e: StatefulEntity): string => m[e].initial;

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "item";

/** What every row this module writes carries. `id` is the database's to choose, so it is
 *  optional in the shape and never in a row handed over to be written — but it is declared,
 *  because reading the new id back is how this module learns it. */
interface Made {
  id?: number;
  slug: string;
  created_at: string;
  updated_at: string;
}

/** A row whose entity has a machine. `state` is the machine's initial state, never the
 *  caller's choice. */
interface Staged extends Made {
  state: string;
}

const STAMP = ["id", "slug", "created_at", "updated_at"] as const;
const STAGED = [...STAMP, "state"] as const;

/** The columns this module writes, table by table. Narrow on purpose: a column the module
 *  never writes has no business being spellable here, and `typed-create.test.ts` holds each
 *  list against `PRAGMA table_info` so a renamed column fails a test rather than a run. */
interface WorkspaceRow extends Made {
  name: string;
  path: string;
}
const workspace = table<WorkspaceRow>("workspace", [...STAMP, "name", "path"]);

interface ProjectRow extends Staged {
  workspace_id: number;
  name: string;
  repo: string;
  objective: string;
}
const project = table<ProjectRow>("project", [...STAGED, "workspace_id", "name", "repo", "objective"]);

interface ReleaseRow extends Staged {
  project_id: number;
  version: string;
}
const release = table<ReleaseRow>("release", [...STAGED, "project_id", "version"]);

interface EpicRow extends Staged {
  release_id: number;
  title: string;
}
const epic = table<EpicRow>("epic", [...STAGED, "release_id", "title"]);

interface StoryRow extends Staged {
  epic_id: number;
  title: string;
}
const story = table<StoryRow>("story", [...STAGED, "epic_id", "title"]);

interface RequirementRow extends Staged {
  story_id: number;
  statement: string;
}
const requirement = table<RequirementRow>("requirement", [...STAGED, "story_id", "statement"]);

interface CriteriaRow extends Staged {
  requirement_id: number;
  statement: string;
}
const criteria = table<CriteriaRow>("acceptance_criteria", [...STAGED, "requirement_id", "statement"]);

/** Both test tables are written with the same columns, so they share one shape and differ
 *  only in the name they are declared under. */
interface TestRow extends Staged {
  parent_id: number;
  statement: string;
  kind: string;
  artefact: string | null;
  script_path: string | null;
}
const TEST_COLUMNS = [...STAGED, "parent_id", "statement", "kind", "artefact", "script_path"] as const;
const acceptanceTest = table<TestRow>("acceptance_test", TEST_COLUMNS);
const taskTest = table<TestRow>("task_test", TEST_COLUMNS);

interface TaskRow extends Staged {
  acceptance_test_id: number;
  title: string;
  scope: string;
  role: string;
  budget: string;
  max_retry: number;
}
const task = table<TaskRow>("task", [
  ...STAGED,
  "acceptance_test_id",
  "title",
  "scope",
  "role",
  "budget",
  "max_retry",
]);

interface RoleRow extends Made {
  name: string;
  scope: string;
  worker_kind: string;
  harness: string | null;
}
const role = table<RoleRow>("role", [...STAMP, "name", "scope", "worker_kind", "harness"]);

interface WorkerRow extends Made {
  name: string;
  role: string;
  kind: string;
}
const worker = table<WorkerRow>("worker", [...STAMP, "name", "role", "kind"]);

interface AssignmentRow extends Made {
  objective_type: string;
  objective_id: number;
  worker_id: number;
  scope: string;
  budget: string;
  worktree: string;
  phase: string;
  spent: string;
}
const assignment = table<AssignmentRow>("assignment", [
  ...STAMP,
  "objective_type",
  "objective_id",
  "worker_id",
  "scope",
  "budget",
  "worktree",
  "phase",
  "spent",
]);

/** "UNIQUE constraint failed: task.slug" — sqlite names the columns, and only the columns. */
const UNIQUE = /UNIQUE constraint failed: (.+)/;

const entries = <Row>(row: Row): [string, Value][] =>
  Object.entries(row as Record<string, Value | undefined>).filter((e): e is [string, Value] => e[1] !== undefined);

/** A column of `t`, or null if the name is not one this module declared. The names come
 *  from sqlite's own message, so they are checked rather than trusted. */
const columnOf = <Row>(t: TableDef<Row>, name: string): (keyof Row & string) | null =>
  (t.columns as readonly string[]).includes(name) ? (name as keyof Row & string) : null;

/** Narrowed to the row just written, by every column that was written. The dialect spells
 *  no last-inserted-rowid query, and it does not need to: each of these tables is unique on its
 *  slug — globally, or within the parent this row also names — so the row is identified by
 *  what it was created with. Highest id, because there is only one. */
function idOf<Row extends Made>(db: DatabaseSync, t: TableDef<Row>, row: Row): number {
  let q = queries(db)
    .selectFrom(t)
    .select(["id" as keyof Row & string]);
  for (const [column, value] of entries(row)) q = q.where(column as never, "=", value as never);
  const ids = q.all().map((r) => Number((r as { id: number }).id));
  if (ids.length === 0) throw new CreateError(`${t.name}: the row was written and could not be read back`);
  return Math.max(...ids);
}

/** The row that already holds the slug is the only thing that tells the caller what to do
 *  next, so it is looked up and named. A dropped row still holds its slug: the collision is
 *  invisible on a board that hides dropped work, and unexplained without this. */
function taken<Row extends Made>(db: DatabaseSync, t: TableDef<Row>, row: Row, columns: string): string {
  const slug = JSON.stringify(row.slug);
  const keys = columns.split(",").map((c) => columnOf(t, c.trim().split(".").pop() as string));
  let q = queries(db).selectFrom(t);
  for (const key of keys) {
    if (key === null) return `${t.name}: slug ${slug} is already taken. Choose a different title.`;
    q = q.where(key as never, "=", ((row as unknown as Record<string, Value | undefined>)[key] ?? null) as never);
  }
  const held = q.get() as Record<string, Value> | null;
  if (held === null) return `${t.name}: slug ${slug} is already taken. Choose a different title.`;
  const state = typeof held.state === "string" ? held.state : null;
  const dropped = state === "dropped" ? " A dropped row still holds its slug." : "";
  return (
    `${t.name}: slug ${slug} is already taken by ${t.name} #${held.id}` +
    `${state === null ? "" : ` (${state})`}.${dropped} Choose a different title.`
  );
}

function insert<Row extends Made>(db: DatabaseSync, t: TableDef<Row>, row: Row): number {
  try {
    queries(db).insertInto(t, row).run();
  } catch (err) {
    const message = (err as Error).message;
    const hit = UNIQUE.exec(message);
    const columns = hit?.[1];
    throw new CreateError(columns === undefined ? `${t.name}: ${message}` : taken(db, t, row, columns));
  }
  return idOf(db, t, row);
}

/** The verdict states of acceptance_test, and the way out of each — a different verb from
 *  each state, because the machine has a different one: `invalidate` from `passed`,
 *  `reprove` from `failed`. Both used to say `invalidate`, and from `failed` that is not a
 *  legal verb. The commands come from `COMMAND_REFUSALS` so that they are checked.
 *
 *  Belongs in the machine's
 *  own config beside the states it names; it lives here until the task that owns
 *  machines.yaml lands, and a state added there without a row here reads as unsettled. */
const SETTLED: Record<string, string> = {
  passed: `Re-prove it with \`${commandOf("create.settled.passed")}\`, or choose another parent.`,
  failed: `Re-prove it with \`${commandOf("create.settled.failed")}\`, or choose another parent.`,
  dropped: "Choose another parent: a dropped test is never re-proved.",
};

/** A parent that is planned or ready is fine — the verdict is still open. */
function settled(db: DatabaseSync, acceptance_test_id: number): void {
  const parent = queries(db).selectFrom(acceptanceTest).select(["state"]).where("id", "=", acceptance_test_id).get();
  if (parent === null) return;
  const remedy = SETTLED[parent.state];
  if (remedy === undefined) return;
  throw new CreateError(
    `task: acceptance_test #${acceptance_test_id} is ${parent.state}, so a task under it could never be accepted. ${remedy}`,
  );
}

/** Creates rows. Nothing here decides a state — every row starts where its machine says. */
export class Maker {
  private readonly m: MachineSet;

  constructor(
    private readonly db: DatabaseSync,
    machines: MachineSet = loadMachines(),
    /** config/roles.yaml, when the caller has it. A worker's role is its ceiling, so a role
     *  no configuration declares is a worker with no ceiling at all — refused rather than
     *  written. Optional and checked only when given, the way `setTaskScope` takes it: a
     *  caller that has not loaded the config is not thereby granted the check. */
    private readonly roles: RoleConfig | null = null,
  ) {
    this.m = machines;
  }

  private stamp(slug: string): { slug: string; created_at: string; updated_at: string } {
    const at = now();
    return { slug, created_at: at, updated_at: at };
  }

  private staged(entity: StatefulEntity, slug: string): { slug: string; created_at: string; updated_at: string; state: string } {
    return { ...this.stamp(slug), state: initialOf(this.m, entity) };
  }

  workspace(name: string, path: string): number {
    return insert(this.db, workspace, { ...this.stamp(slugify(name)), name, path });
  }

  project(workspace_id: number, name: string, repo: string, objective = ""): number {
    return insert(this.db, project, {
      ...this.staged("project", slugify(name)),
      workspace_id,
      name,
      repo,
      objective,
    });
  }

  /** A version is `major.minor.patch`, with an optional prerelease. Free-form versions read
   *  fine one at a time and sort wrongly the moment there are three of them — 0.1 and 0.0.2
   *  in the same project is how this rule was found. */
  release(project_id: number, version: string): number {
    if (!VERSION.test(version)) {
      throw new CreateError(
        `version must be major.minor.patch, optionally with a prerelease; got ${JSON.stringify(version)}\n` +
          "  0.0.1   1.2.0   2.0.0-rc.1",
      );
    }
    return insert(this.db, release, { ...this.staged("release", slugify(version)), project_id, version });
  }

  epic(release_id: number, title: string): number {
    return insert(this.db, epic, { ...this.staged("epic", slugify(title)), release_id, title });
  }

  story(epic_id: number, title: string): number {
    return insert(this.db, story, { ...this.staged("story", slugify(title)), epic_id, title });
  }

  requirement(story_id: number, statement: string): number {
    return insert(this.db, requirement, {
      ...this.staged("requirement", slugify(statement)),
      story_id,
      statement,
    });
  }

  criteria(requirement_id: number, statement: string): number {
    return insert(this.db, criteria, {
      ...this.staged("acceptance_criteria", slugify(statement)),
      requirement_id,
      statement,
    });
  }

  acceptanceTest(
    parent_id: number,
    statement: string,
    kind: TestKind,
    artefact: string | null = null,
    script_path: string | null = null,
  ): number {
    return insert(this.db, acceptanceTest, {
      ...this.staged("acceptance_test", slugify(statement)),
      parent_id,
      statement,
      kind,
      artefact,
      script_path,
    });
  }

  /** A task under a settled acceptance_test is work that could never be accepted: the parent
   *  has already reached its verdict, and finishing the task cannot change it. Attached to a
   *  failed test on 14 Sep, and the work was carried out for nothing. */
  task(
    acceptance_test_id: number,
    title: string,
    opts: { scope?: Scope; role?: string; budget?: Budget; max_retry?: number } = {},
  ): number {
    settled(this.db, acceptance_test_id);
    return insert(this.db, task, {
      ...this.staged("task", slugify(title)),
      acceptance_test_id,
      title,
      scope: JSON.stringify(opts.scope ?? { write: [], tools: [] }),
      role: opts.role ?? "",
      budget: JSON.stringify(opts.budget ?? { tokens: 250000, seconds: 3600 }),
      max_retry: opts.max_retry ?? 3,
    });
  }

  taskTest(
    parent_id: number,
    statement: string,
    kind: TestKind,
    artefact: string | null = null,
    script_path: string | null = null,
  ): number {
    return insert(this.db, taskTest, {
      ...this.staged("task_test", slugify(statement)),
      parent_id,
      statement,
      kind,
      artefact,
      script_path,
    });
  }

  role(name: string, scope: Scope, worker_kind: WorkerKind, harness: string | null = null): number {
    return insert(this.db, role, {
      ...this.stamp(slugify(name)),
      name,
      scope: JSON.stringify(scope),
      worker_kind,
      harness,
    });
  }

  /** The declared roles are named in the refusal: a worker is refused for a typo far more
   *  often than for a role that was never meant to exist, and the list is the fix. */
  worker(name: string, role: string, kind: WorkerKind): number {
    if (this.roles !== null && this.roles.roles[role] === undefined) {
      const declared = Object.keys(this.roles.roles);
      throw new CreateError(
        `worker: no role named ${role === "" ? "(none)" : JSON.stringify(role)}. ` +
          (declared.length === 0
            ? "No configuration declares any role."
            : `Declared roles: ${declared.join(", ")}.`),
      );
    }
    return insert(this.db, worker, { ...this.stamp(slugify(name)), name, role, kind });
  }

  /** The spec is written here and never again. The scope is copied, not referenced, so a
   *  later edit to the task cannot widen an attempt that is already running. */
  assignment(spec: {
    objective_type: ObjectiveType;
    objective_id: number;
    worker_id: number;
    scope: Scope;
    budget: Budget;
    worktree: string;
  }): number {
    // The id is the only thing certain to be unique. A timestamp is not: two attempts at
    // one objective inside the same millisecond collide, and a retry is exactly that.
    const id = insert(this.db, assignment, {
      ...this.stamp(`pending-${Math.random().toString(36).slice(2, 10)}`),
      objective_type: spec.objective_type,
      objective_id: spec.objective_id,
      worker_id: spec.worker_id,
      scope: JSON.stringify(spec.scope),
      budget: JSON.stringify(spec.budget),
      worktree: spec.worktree,
      phase: initialOf(this.m, "assignment"),
      spent: JSON.stringify({ tokens: 0, seconds: 0 }),
    });
    queries(this.db)
      .update(assignment)
      .set({ slug: `${spec.objective_type}-${spec.objective_id}-${id}` })
      .where("id", "=", id)
      .run();
    return id;
  }
}
