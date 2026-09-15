import type { DatabaseSync } from "node:sqlite";
import { commandOf } from "./checks.js";
import type { Budget, ObjectiveType, Scope } from "./entities.js";
import { loadMachines } from "./machines.js";
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

/** "UNIQUE constraint failed: task.slug" — sqlite names the columns, and only the columns. */
const UNIQUE = /UNIQUE constraint failed: (.+)/;

/** The row that already holds the slug is the only thing that tells the caller what to do
 *  next, so it is looked up and named. A dropped row still holds its slug: the collision is
 *  invisible on a board that hides dropped work, and unexplained without this. */
function taken(db: DatabaseSync, table: string, row: Record<string, string | number | null>, columns: string): string {
  const keys = columns.split(",").map((c) => c.trim().split(".").pop() as string);
  const where = keys.map((k) => `${k} IS ?`).join(" AND ");
  const held = db
    .prepare(`SELECT * FROM ${table} WHERE ${where}`)
    .get(...keys.map((k) => row[k] ?? null)) as Record<string, string | number | null> | undefined;
  const slug = String(row.slug ?? "");
  if (held === undefined) return `${table}: slug ${JSON.stringify(slug)} is already taken. Choose a different title.`;
  const state = typeof held.state === "string" ? held.state : null;
  const dropped = state === "dropped" ? " A dropped row still holds its slug." : "";
  return (
    `${table}: slug ${JSON.stringify(slug)} is already taken by ${table} #${held.id}` +
    `${state === null ? "" : ` (${state})`}.${dropped} Choose a different title.`
  );
}

function insert(db: DatabaseSync, table: string, row: Record<string, string | number | null>): number {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
  try {
    db.prepare(sql).run(...cols.map((c) => row[c] ?? null));
  } catch (err) {
    const message = (err as Error).message;
    const hit = UNIQUE.exec(message);
    const columns = hit?.[1];
    throw new CreateError(columns === undefined ? `${table}: ${message}` : taken(db, table, row, columns));
  }
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
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
  const parent = db.prepare("SELECT state FROM acceptance_test WHERE id = ?").get(acceptance_test_id) as
    | { state: string }
    | undefined;
  if (parent === undefined) return;
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
  ) {
    this.m = machines;
  }

  private stamp(entity: StatefulEntity | null, slug: string): Record<string, string> {
    const at = now();
    return entity === null
      ? { slug, created_at: at, updated_at: at }
      : { slug, state: initialOf(this.m, entity), created_at: at, updated_at: at };
  }

  workspace(name: string, path: string): number {
    return insert(this.db, "workspace", { ...this.stamp(null, slugify(name)), name, path });
  }

  project(workspace_id: number, name: string, repo: string, objective = ""): number {
    return insert(this.db, "project", {
      ...this.stamp("project", slugify(name)),
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
    return insert(this.db, "release", { ...this.stamp("release", slugify(version)), project_id, version });
  }

  epic(release_id: number, title: string): number {
    return insert(this.db, "epic", { ...this.stamp("epic", slugify(title)), release_id, title });
  }

  story(epic_id: number, title: string): number {
    return insert(this.db, "story", { ...this.stamp("story", slugify(title)), epic_id, title });
  }

  requirement(story_id: number, statement: string): number {
    return insert(this.db, "requirement", {
      ...this.stamp("requirement", slugify(statement)),
      story_id,
      statement,
    });
  }

  criteria(requirement_id: number, statement: string): number {
    return insert(this.db, "acceptance_criteria", {
      ...this.stamp("acceptance_criteria", slugify(statement)),
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
    return insert(this.db, "acceptance_test", {
      ...this.stamp("acceptance_test", slugify(statement)),
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
    return insert(this.db, "task", {
      ...this.stamp("task", slugify(title)),
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
    return insert(this.db, "task_test", {
      ...this.stamp("task_test", slugify(statement)),
      parent_id,
      statement,
      kind,
      artefact,
      script_path,
    });
  }

  role(name: string, scope: Scope, worker_kind: WorkerKind, harness: string | null = null): number {
    return insert(this.db, "role", { ...this.stamp(null, slugify(name)), name, scope: JSON.stringify(scope), worker_kind, harness });
  }

  worker(name: string, role: string, kind: WorkerKind): number {
    return insert(this.db, "worker", { ...this.stamp(null, slugify(name)), name, role, kind });
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
    const id = insert(this.db, "assignment", {
      ...this.stamp(null, `pending-${Math.random().toString(36).slice(2, 10)}`),
      objective_type: spec.objective_type,
      objective_id: spec.objective_id,
      worker_id: spec.worker_id,
      scope: JSON.stringify(spec.scope),
      budget: JSON.stringify(spec.budget),
      worktree: spec.worktree,
      phase: initialOf(this.m, "assignment"),
      spent: JSON.stringify({ tokens: 0, seconds: 0 }),
    });
    this.db
      .prepare("UPDATE assignment SET slug = ? WHERE id = ?")
      .run(`${spec.objective_type}-${spec.objective_id}-${id}`, id);
    return id;
  }
}
