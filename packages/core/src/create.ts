import type { DatabaseSync } from "node:sqlite";
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

function insert(db: DatabaseSync, table: string, row: Record<string, string | number | null>): number {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
  try {
    db.prepare(sql).run(...cols.map((c) => row[c] ?? null));
  } catch (err) {
    throw new CreateError(`${table}: ${(err as Error).message}`);
  }
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
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

  acceptanceTest(parent_id: number, statement: string, kind: TestKind, artefact: string | null = null): number {
    return insert(this.db, "acceptance_test", {
      ...this.stamp("acceptance_test", slugify(statement)),
      parent_id,
      statement,
      kind,
      artefact,
    });
  }

  task(
    acceptance_test_id: number,
    title: string,
    opts: { scope?: Scope; role?: string; budget?: Budget; max_retry?: number } = {},
  ): number {
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

  taskTest(parent_id: number, statement: string, kind: TestKind, artefact: string | null = null): number {
    return insert(this.db, "task_test", {
      ...this.stamp("task_test", slugify(statement)),
      parent_id,
      statement,
      kind,
      artefact,
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
    return insert(this.db, "assignment", {
      ...this.stamp(null, `${spec.objective_type}-${spec.objective_id}-${Date.now()}`),
      objective_type: spec.objective_type,
      objective_id: spec.objective_id,
      worker_id: spec.worker_id,
      scope: JSON.stringify(spec.scope),
      budget: JSON.stringify(spec.budget),
      worktree: spec.worktree,
      phase: initialOf(this.m, "assignment"),
      spent: JSON.stringify({ tokens: 0, seconds: 0 }),
    });
  }
}
