import { INVARIANTS, now, type RecordNode, type Snapshot, type Violation } from "@wecode/core";
import type { DatabaseSync } from "node:sqlite";

/** docs/design/19, the check, on the runner's tick.
 *
 *  The invariant set is core's and is run here once a tick. What comes back is written to
 *  one runner-owned table so a view can say what drifted without running eight queries of
 *  its own. Nothing else is written: no entity is touched, no state moves, no chore is
 *  proposed. Healing is the next slice, and this one is allowed to be wrong in public.
 *
 *  A doctor failure never stops a tick. The work of the tick is the point; a check that
 *  could take the runner down with it would be a worse problem than the drift it looks
 *  for, so every invariant runs inside its own boundary and a throw becomes a line in the
 *  report rather than an exception in the caller. */

/** One invariant: the sentence and the function that finds who breaks it. */
export interface Invariant {
  readonly name: string;
  readonly check: (s: Snapshot) => readonly Violation[];
}

/** Where each entity's row lives and what its parent key is called. The one place in the
 *  runner that knows the shape of the tables; the invariants see only flattened nodes. */
const TABLES: readonly { entity: RecordNode["entity"]; fk: string; extra?: string }[] = [
  { entity: "release", fk: "NULL" },
  { entity: "epic", fk: "release_id" },
  { entity: "story", fk: "epic_id" },
  { entity: "requirement", fk: "story_id" },
  { entity: "acceptance_criteria", fk: "requirement_id" },
  { entity: "acceptance_test", fk: "parent_id", extra: ", red_at_base_sha" },
  { entity: "task", fk: "acceptance_test_id", extra: ", role" },
  { entity: "task_test", fk: "parent_id" },
];

const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) !== undefined;

/** The story a task belongs to, landed: `landed_branch` is the lander's own table, keyed
 *  by task, so a story is landed when something under it is recorded as merged. */
function landedShas(db: DatabaseSync): Map<number, string> {
  if (!hasTable(db, "landed_branch")) return new Map();
  const rows = db
    .prepare(
      `SELECT q.story_id AS story_id, b.sha AS sha
         FROM landed_branch b
         JOIN task t ON t.id = b.task_id
         JOIN acceptance_test a ON a.id = t.acceptance_test_id
         JOIN acceptance_criteria c ON c.id = a.parent_id
         JOIN requirement q ON q.id = c.requirement_id`,
    )
    .all() as unknown as { story_id: number; sha: string }[];
  return new Map(rows.map((r) => [r.story_id, r.sha]));
}

/** One plain object, no live handle: everything the invariants are allowed to see. */
export function snapshot(db: DatabaseSync): Snapshot {
  const landed = landedShas(db);
  const nodes = TABLES.flatMap(({ entity, fk, extra }) => {
    const rows = db
      .prepare(`SELECT id, slug, state, ${fk} AS parent_id${extra ?? ""} FROM ${entity} ORDER BY id`)
      .all() as unknown as Omit<RecordNode, "entity">[];
    // The table it came from is what the entity is; sqlite does not carry it on the row.
    return rows.map((n) =>
      entity === "story" ? { ...n, entity, landed_sha: landed.get(n.id) ?? null } : { ...n, entity },
    );
  });
  const workers = db.prepare("SELECT slug, role FROM worker ORDER BY id").all() as unknown as {
    slug: string;
    role: string;
  }[];
  const version = hasTable(db, "schema_version")
    ? (db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined)
    : undefined;
  return { nodes, workers, schema_version: version?.version ?? 0 };
}

/** The check, wired to a record.
 *
 *  Runner-owned, like `landed_branch`: the ledger says what is true of the work, this says
 *  what this pass observed about it. Rewritten whole every tick, because a violation that
 *  has been fixed is not history worth keeping — the record is. */
export class Doctor {
  constructor(
    private readonly db: DatabaseSync,
    /** Defaults to core's set. A caller passes its own only to test the boundary itself:
     *  the point being proven is that one bad check cannot take the tick with it. */
    private readonly invariants: readonly Invariant[] = INVARIANTS,
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS doctor_violation (
         invariant TEXT    NOT NULL,
         entity    TEXT    NOT NULL,
         entity_id INTEGER,
         slug      TEXT    NOT NULL,
         detail    TEXT    NOT NULL,
         found_at  TEXT    NOT NULL
       )`,
    );
  }

  /** One pass. Returns what it found and records the same, and throws for nothing. */
  check(): readonly Violation[] {
    const found = this.run();
    try {
      this.record(found);
    } catch {
      // The report is worth less than the tick. A table that could not be written is drift
      // of its own, and the next pass rewrites it whole anyway.
    }
    return found;
  }

  /** Each invariant inside its own boundary. A check that throws is not silently dropped:
   *  it becomes a violation naming itself, because an invariant nobody can evaluate is a
   *  thing a person needs to see as much as one that failed. */
  private run(): readonly Violation[] {
    let s: Snapshot;
    try {
      s = snapshot(this.db);
    } catch (err) {
      return [broken("snapshot", err)];
    }
    return this.invariants.flatMap((i) => {
      try {
        return i.check(s);
      } catch (err) {
        return [broken(i.name, err)];
      }
    });
  }

  /** Replaced, not appended: the answer to "what is wrong now" is this pass and only this
   *  pass. One transaction, so a view never reads half a report. */
  private record(found: readonly Violation[]): void {
    const at = now();
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM doctor_violation");
      const insert = this.db.prepare(
        `INSERT INTO doctor_violation (invariant, entity, entity_id, slug, detail, found_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const v of found) insert.run(v.invariant, v.entity, v.id, v.slug, v.detail, at);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** A check that could not be run, said out loud in the shape of the thing it failed to be. */
const broken = (name: string, err: unknown): Violation => ({
  invariant: name,
  entity: "invariant",
  id: null,
  slug: name,
  detail: `the check itself failed: ${(err as Error).message}`,
});

/** What a view reads. The last pass, in the order it was found. */
export function violations(db: DatabaseSync): readonly Violation[] {
  if (!hasTable(db, "doctor_violation")) return [];
  const rows = db
    .prepare("SELECT invariant, entity, entity_id, slug, detail FROM doctor_violation ORDER BY rowid")
    .all() as unknown as { invariant: string; entity: string; entity_id: number | null; slug: string; detail: string }[];
  return rows.map((r) => ({ invariant: r.invariant, entity: r.entity, id: r.entity_id, slug: r.slug, detail: r.detail }));
}
