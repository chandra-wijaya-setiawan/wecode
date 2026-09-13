import type { DatabaseSync } from "node:sqlite";
import { now } from "./store.js";
import type { StatefulEntity } from "./types.js";

/** Which entity bears which, and the column a child points back through. This is the ERD
 *  in docs/design/04 as data — a child list is a lookup, never a join hand-written at each
 *  call site. */
const CHILDREN: Readonly<Record<StatefulEntity, { child: StatefulEntity; fk: string } | null>> = {
  project: { child: "release", fk: "project_id" },
  release: { child: "epic", fk: "release_id" },
  epic: { child: "story", fk: "epic_id" },
  story: { child: "requirement", fk: "story_id" },
  requirement: { child: "acceptance_criteria", fk: "requirement_id" },
  acceptance_criteria: { child: "acceptance_test", fk: "parent_id" },
  acceptance_test: { child: "task", fk: "acceptance_test_id" },
  task: { child: "task_test", fk: "parent_id" },
  task_test: null,
  assignment: null,
};

export interface StateRow {
  readonly id: number;
  readonly state: string;
}

/** Every child row of one entity, with its id and state — the free-function form, for
 *  callers holding a db rather than a Repo. The lookup stays in one place: this is Repo. */
export function children(db: DatabaseSync, entity: StatefulEntity, id: number): readonly StateRow[] {
  return new Repo(db).childrenOf(entity, id);
}

export class Repo {
  constructor(private readonly db: DatabaseSync) {}

  stateOf(entity: StatefulEntity, id: number): string | null {
    const col = entity === "assignment" ? "phase" : "state";
    const row = this.db.prepare(`SELECT ${col} AS state FROM ${entity} WHERE id = ?`).get(id) as
      | { state: string }
      | undefined;
    return row?.state ?? null;
  }

  /** Every child of this entity, with its state. Empty when the entity bears none. */
  childrenOf(entity: StatefulEntity, id: number): readonly StateRow[] {
    const link = CHILDREN[entity];
    if (link === null) return [];
    return this.db
      .prepare(`SELECT id, state FROM ${link.child} WHERE ${link.fk} = ?`)
      .all(id) as unknown as StateRow[];
  }

  childEntityOf(entity: StatefulEntity): StatefulEntity | null {
    return CHILDREN[entity]?.child ?? null;
  }

  /** Write the new state and append the transition. Both, or neither — the caller holds
   *  the transaction. */
  setState(
    entity: StatefulEntity,
    id: number,
    from: string,
    to: string,
    verb: string,
    actor: string,
  ): void {
    const at = now();
    const col = entity === "assignment" ? "phase" : "state";
    this.db.prepare(`UPDATE ${entity} SET ${col} = ?, updated_at = ? WHERE id = ?`).run(to, at, id);
    this.db
      .prepare(
        `INSERT INTO ledger (entity, entity_id, verb, from_state, to_state, actor, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entity, id, verb, from, to, actor, at);
  }

  /** The parent that a completed child may cascade into: the entity, and its id. */
  parentOf(entity: StatefulEntity, id: number): { entity: StatefulEntity; id: number } | null {
    const link: Partial<Record<StatefulEntity, { parent: StatefulEntity; fk: string }>> = {
      release: { parent: "project", fk: "project_id" },
      epic: { parent: "release", fk: "release_id" },
      story: { parent: "epic", fk: "epic_id" },
      requirement: { parent: "story", fk: "story_id" },
      acceptance_criteria: { parent: "requirement", fk: "requirement_id" },
      acceptance_test: { parent: "acceptance_criteria", fk: "parent_id" },
      task: { parent: "acceptance_test", fk: "acceptance_test_id" },
      task_test: { parent: "task", fk: "parent_id" },
    };
    const up = link[entity];
    if (up === undefined) return null;
    const row = this.db.prepare(`SELECT ${up.fk} AS pid FROM ${entity} WHERE id = ?`).get(id) as
      | { pid: number }
      | undefined;
    return row === undefined ? null : { entity: up.parent, id: row.pid };
  }

  artefactOf(entity: "acceptance_test" | "task_test", id: number): string | null {
    const row = this.db.prepare(`SELECT artefact FROM ${entity} WHERE id = ?`).get(id) as
      | { artefact: string | null }
      | undefined;
    return row?.artefact ?? null;
  }

  taskRetry(id: number): { attempts: number; max_retry: number } | null {
    return (
      (this.db.prepare("SELECT attempts, max_retry FROM task WHERE id = ?").get(id) as
        | { attempts: number; max_retry: number }
        | undefined) ?? null
    );
  }

  taskScopeAndRole(id: number): { scope: string; role: string } | null {
    return (
      (this.db.prepare("SELECT scope, role FROM task WHERE id = ?").get(id) as
        | { scope: string; role: string }
        | undefined) ?? null
    );
  }
}
