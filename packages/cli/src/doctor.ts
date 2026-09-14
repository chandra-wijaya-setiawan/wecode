import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { checkRecord, currentDatabase, type RecordNode, type Snapshot, type Violation } from "@wecode/core";

/** Where each entity's row lives and what its parent key is called. The one place in the
 *  doctor that knows the shape of the tables; the invariants themselves see only the
 *  flattened nodes. */
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

/** A workspace that has never landed anything has no `landed_branch` table beside the
 *  record, and that is not drift — it is a record with nothing observed against it. */
const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) !== undefined;

/** The story a task belongs to, landed: `landed_branch` is the lander's own table, keyed by
 *  task, so a story is landed when something under it is recorded as merged. That sha is
 *  what `delivered_story_has_landed` reads off the story node. */
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
function snapshot(db: DatabaseSync): Snapshot {
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

/** `wecode doctor` — one pass of the invariants, read only.
 *
 *  docs/design/19, first slice: it reads and reports. Nothing is healed, nothing is written
 *  to any entity, nothing is proposed for approval. The database is opened read-only so
 *  that is true by construction rather than by care — in particular it is never migrated,
 *  because a doctor that upgraded the file it was inspecting would repair the one drift it
 *  is meant to report.
 *
 *  Non-zero when anything is broken, so a script can gate on it. */
export function doctor(args: readonly string[]): number {
  const path = args[0] ?? currentDatabase();
  if (!existsSync(path)) {
    process.stderr.write(`no workspace at ${path} — wecode init\n`);
    return 1;
  }

  const db = new DatabaseSync(path, { readOnly: true });
  let violations: readonly Violation[];
  try {
    violations = checkRecord(snapshot(db));
  } finally {
    db.close();
  }

  // A record that holds says nothing at all. A doctor that printed "all well" would be
  // noise on every tick of the thing that runs it.
  if (violations.length === 0) return 0;

  process.stdout.write(report(violations));
  return 1;
}

/** Grouped by invariant, because the invariant is the sentence that was broken and the
 *  entities are the evidence for it. Ungrouped, the same drift on forty rows reads as
 *  forty problems. */
function report(violations: readonly Violation[]): string {
  const groups = new Map<string, Violation[]>();
  for (const v of violations) groups.set(v.invariant, [...(groups.get(v.invariant) ?? []), v]);

  const lines: string[] = [];
  for (const [name, found] of groups) {
    lines.push(name);
    // A violation with no id is not a row — `role` names a role nobody fills — so it is
    // named by its slug alone rather than by a `#null` nobody could go and look at.
    for (const v of found) {
      lines.push(`  ${v.entity}${v.id === null ? "" : ` #${v.id}`} ${v.slug} — ${v.detail}`);
    }
    lines.push("");
  }
  const what = violations.length === 1 ? "1 entity" : `${violations.length} entities`;
  const how = groups.size === 1 ? "1 invariant" : `${groups.size} invariants`;
  lines.push(`${what} breaking ${how}\n`);
  return lines.join("\n");
}
