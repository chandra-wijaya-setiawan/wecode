import type { DatabaseSync } from "node:sqlite";
import { queries, table, type Dialect } from "./db.js";
import { now } from "./store.js";
import type { StatefulEntity } from "./types.js";

/** Only the columns this module reads or writes are declared. A table is not a schema here;
 *  it is the part of the schema Repo speaks about. */
type Node = { id: number; state: string; updated_at: string };
/** A row that names its parent, in the column that parent's link is keyed by. */
type Under<F extends string> = Node & { [K in F]: number };
/** A test row: it names a parent and carries the artefact that proves it ran. */
type Proof = Under<"parent_id"> & { artefact: string | null };

const NODE = ["id", "state", "updated_at"] as const;

const project = table<Node>("project", [...NODE]);
const release = table<Under<"project_id">>("release", [...NODE, "project_id"]);
const epic = table<Under<"release_id">>("epic", [...NODE, "release_id"]);
const story = table<Under<"epic_id">>("story", [...NODE, "epic_id"]);
const requirement = table<Under<"story_id">>("requirement", [...NODE, "story_id"]);
const criteria = table<Under<"requirement_id">>("acceptance_criteria", [...NODE, "requirement_id"]);
const acceptanceTest = table<Proof>("acceptance_test", [...NODE, "parent_id", "artefact"]);
const taskTest = table<Proof>("task_test", [...NODE, "parent_id", "artefact"]);
const task = table<
  Under<"acceptance_test_id"> & { attempts: number; max_retry: number; scope: string; role: string }
>("task", [...NODE, "acceptance_test_id", "attempts", "max_retry", "scope", "role"]);
/** An assignment keeps its machine's state in `phase`, and bears nothing. */
const assignment = table<{ id: number; phase: string; updated_at: string }>("assignment", [
  "id",
  "phase",
  "updated_at",
]);
/** Append only. `id` is the database's to choose, so it is optional in the shape and never
 *  in a line handed over to be written. */
const ledger = table<{
  id?: number;
  entity: string;
  entity_id: number;
  verb: string;
  from_state: string;
  to_state: string;
  actor: string;
  at: string;
}>("ledger", ["id", "entity", "entity_id", "verb", "from_state", "to_state", "actor", "at"]);

export interface StateRow {
  readonly id: number;
  readonly state: string;
}

/** What Repo asks of one entity. This is the ERD in docs/design/04 as data — a child list is
 *  a lookup, never a join hand-written at each call site — but each row carries the typed
 *  query rather than a column name, so the column the query narrows by is checked against
 *  the table it narrows, at the point the lookup is written. */
interface Spec {
  /** This row's state, from whichever column the entity keeps it in. */
  readonly state: (q: Dialect, id: number) => string | null;
  /** Write that state, and stamp the row. */
  readonly touch: (q: Dialect, id: number, to: string, at: string) => void;
  /** Which entity this bears, and every child row of one, with its state. */
  readonly bears: {
    readonly child: StatefulEntity;
    readonly rows: (q: Dialect, id: number) => readonly StateRow[];
  } | null;
  /** The parent a completed child may cascade into, and the id of this row's own. */
  readonly under: {
    readonly parent: StatefulEntity;
    readonly id: (q: Dialect, id: number) => number | null;
  } | null;
}

const ENTITIES: Readonly<Record<StatefulEntity, Spec>> = {
  project: {
    state: (q, id) => q.selectFrom(project).select(["state"]).where("id", "=", id).get()?.state ?? null,
    touch: (q, id, to, at) => void q.update(project).set({ state: to, updated_at: at }).where("id", "=", id).run(),
    bears: {
      child: "release",
      rows: (q, id) => q.selectFrom(release).select(["id", "state"]).where("project_id", "=", id).all(),
    },
    under: null,
  },
  release: {
    state: (q, id) => q.selectFrom(release).select(["state"]).where("id", "=", id).get()?.state ?? null,
    touch: (q, id, to, at) => void q.update(release).set({ state: to, updated_at: at }).where("id", "=", id).run(),
    bears: {
      child: "epic",
      rows: (q, id) => q.selectFrom(epic).select(["id", "state"]).where("release_id", "=", id).all(),
    },
    under: {
      parent: "project",
      id: (q, id) => q.selectFrom(release).select(["project_id"]).where("id", "=", id).get()?.project_id ?? null,
    },
  },
  epic: {
    state: (q, id) => q.selectFrom(epic).select(["state"]).where("id", "=", id).get()?.state ?? null,
    touch: (q, id, to, at) => void q.update(epic).set({ state: to, updated_at: at }).where("id", "=", id).run(),
    bears: {
      child: "story",
      rows: (q, id) => q.selectFrom(story).select(["id", "state"]).where("epic_id", "=", id).all(),
    },
    under: {
      parent: "release",
      id: (q, id) => q.selectFrom(epic).select(["release_id"]).where("id", "=", id).get()?.release_id ?? null,
    },
  },
  story: {
    state: (q, id) => q.selectFrom(story).select(["state"]).where("id", "=", id).get()?.state ?? null,
    touch: (q, id, to, at) => void q.update(story).set({ state: to, updated_at: at }).where("id", "=", id).run(),
    bears: {
      child: "requirement",
      rows: (q, id) => q.selectFrom(requirement).select(["id", "state"]).where("story_id", "=", id).all(),
    },
    under: {
      parent: "epic",
      id: (q, id) => q.selectFrom(story).select(["epic_id"]).where("id", "=", id).get()?.epic_id ?? null,
    },
  },
  requirement: {
    state: (q, id) => q.selectFrom(requirement).select(["state"]).where("id", "=", id).get()?.state ?? null,
    touch: (q, id, to, at) => void q.update(requirement).set({ state: to, updated_at: at }).where("id", "=", id).run(),
    bears: {
      child: "acceptance_criteria",
      rows: (q, id) => q.selectFrom(criteria).select(["id", "state"]).where("requirement_id", "=", id).all(),
    },
    under: {
      parent: "story",
      id: (q, id) => q.selectFrom(requirement).select(["story_id"]).where("id", "=", id).get()?.story_id ?? null,
    },
  },
  acceptance_criteria: {
    state: (q, id) => q.selectFrom(criteria).select(["state"]).where("id", "=", id).get()?.state ?? null,
    touch: (q, id, to, at) => void q.update(criteria).set({ state: to, updated_at: at }).where("id", "=", id).run(),
    bears: {
      child: "acceptance_test",
      rows: (q, id) => q.selectFrom(acceptanceTest).select(["id", "state"]).where("parent_id", "=", id).all(),
    },
    under: {
      parent: "requirement",
      id: (q, id) =>
        q.selectFrom(criteria).select(["requirement_id"]).where("id", "=", id).get()?.requirement_id ?? null,
    },
  },
  acceptance_test: {
    state: (q, id) => q.selectFrom(acceptanceTest).select(["state"]).where("id", "=", id).get()?.state ?? null,
    touch: (q, id, to, at) =>
      void q.update(acceptanceTest).set({ state: to, updated_at: at }).where("id", "=", id).run(),
    bears: {
      child: "task",
      rows: (q, id) => q.selectFrom(task).select(["id", "state"]).where("acceptance_test_id", "=", id).all(),
    },
    under: {
      parent: "acceptance_criteria",
      id: (q, id) => q.selectFrom(acceptanceTest).select(["parent_id"]).where("id", "=", id).get()?.parent_id ?? null,
    },
  },
  task: {
    state: (q, id) => q.selectFrom(task).select(["state"]).where("id", "=", id).get()?.state ?? null,
    touch: (q, id, to, at) => void q.update(task).set({ state: to, updated_at: at }).where("id", "=", id).run(),
    bears: {
      child: "task_test",
      rows: (q, id) => q.selectFrom(taskTest).select(["id", "state"]).where("parent_id", "=", id).all(),
    },
    under: {
      parent: "acceptance_test",
      id: (q, id) =>
        q.selectFrom(task).select(["acceptance_test_id"]).where("id", "=", id).get()?.acceptance_test_id ?? null,
    },
  },
  task_test: {
    state: (q, id) => q.selectFrom(taskTest).select(["state"]).where("id", "=", id).get()?.state ?? null,
    touch: (q, id, to, at) => void q.update(taskTest).set({ state: to, updated_at: at }).where("id", "=", id).run(),
    bears: null,
    under: {
      parent: "task",
      id: (q, id) => q.selectFrom(taskTest).select(["parent_id"]).where("id", "=", id).get()?.parent_id ?? null,
    },
  },
  assignment: {
    state: (q, id) => q.selectFrom(assignment).select(["phase"]).where("id", "=", id).get()?.phase ?? null,
    touch: (q, id, to, at) => void q.update(assignment).set({ phase: to, updated_at: at }).where("id", "=", id).run(),
    bears: null,
    under: null,
  },
};

/** Which table an artefact is read from. Only a test has one. */
const ARTEFACTS: Readonly<Record<"acceptance_test" | "task_test", typeof acceptanceTest>> = {
  acceptance_test: acceptanceTest,
  task_test: taskTest,
};

/** Every child row of one entity, with its id and state — the free-function form, for
 *  callers holding a db rather than a Repo. The lookup stays in one place: this is Repo. */
export function children(db: DatabaseSync, entity: StatefulEntity, id: number): readonly StateRow[] {
  return new Repo(db).childrenOf(entity, id);
}

export class Repo {
  private readonly q: Dialect;

  constructor(private readonly db: DatabaseSync) {
    this.q = queries(db);
  }

  stateOf(entity: StatefulEntity, id: number): string | null {
    return ENTITIES[entity].state(this.q, id);
  }

  /** Every child of this entity, with its state. Empty when the entity bears none. */
  childrenOf(entity: StatefulEntity, id: number): readonly StateRow[] {
    return ENTITIES[entity].bears?.rows(this.q, id) ?? [];
  }

  childEntityOf(entity: StatefulEntity): StatefulEntity | null {
    return ENTITIES[entity].bears?.child ?? null;
  }

  /** Write the new state and append the transition. Both, or neither — the caller holds
   *  the transaction, and this opens none of its own, so the two statements land inside
   *  whichever transaction the caller is already in. */
  setState(
    entity: StatefulEntity,
    id: number,
    from: string,
    to: string,
    verb: string,
    actor: string,
  ): void {
    const at = now();
    ENTITIES[entity].touch(this.q, id, to, at);
    this.q
      .insertInto(ledger, {
        entity,
        entity_id: id,
        verb,
        from_state: from,
        to_state: to,
        actor,
        at,
      })
      .run();
  }

  /** The parent that a completed child may cascade into: the entity, and its id. */
  parentOf(entity: StatefulEntity, id: number): { entity: StatefulEntity; id: number } | null {
    const up = ENTITIES[entity].under;
    if (up === null) return null;
    const pid = up.id(this.q, id);
    return pid === null ? null : { entity: up.parent, id: pid };
  }

  artefactOf(entity: "acceptance_test" | "task_test", id: number): string | null {
    return this.q.selectFrom(ARTEFACTS[entity]).select(["artefact"]).where("id", "=", id).get()?.artefact ?? null;
  }

  taskRetry(id: number): { attempts: number; max_retry: number } | null {
    return this.q.selectFrom(task).select(["attempts", "max_retry"]).where("id", "=", id).get();
  }

  taskScopeAndRole(id: number): { scope: string; role: string } | null {
    return this.q.selectFrom(task).select(["scope", "role"]).where("id", "=", id).get();
  }
}
