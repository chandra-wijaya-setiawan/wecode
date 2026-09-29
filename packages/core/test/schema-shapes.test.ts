import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { COLUMN_OF, ROW_FIELDS } from "../src/index.js";
import { freshDb } from "./helpers.js";

/** Read from the migrated database rather than from the migration files: a column added by
 *  005 and renamed by 012 is only one column, and only the database knows that. */
const columnsOf = (db: DatabaseSync, table: string): readonly string[] =>
  (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((r) => r.name);

const tablesOf = (db: DatabaseSync): readonly string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);

/** The column a field is stored in — the field's own name unless COLUMN_OF renames it. */
const columnFor = (field: string): string => COLUMN_OF[field] ?? field;

const sorted = (names: Iterable<string>): string[] => [...names].sort();

/** Columns the record has and no row interface declares, as of migration 013.
 *
 *  This is drift, not design: every one of these is read and written by name elsewhere in
 *  core, so a reader typed as the interface is typed as less than the row actually holds.
 *  It is recorded here rather than fixed because entities.ts is what a fix would change and
 *  every caller that constructs one of these rows would have to change with it.
 *
 *  Asserted exactly, so it can only shrink deliberately: a new column that skips the
 *  interface fails this test, and closing one of these without trimming the list fails it
 *  too. */
const UNDECLARED: Readonly<Record<string, readonly string[]>> = {
  // 005 script_path, 006/007 red_at_base_*, 013 provenance_sha. `Test` is the shape of both
  // test tables, and these columns are why the two tables are no longer the same shape:
  // only an acceptance_test carries a red-at-base verdict.
  acceptance_test: ["script_path", "red_at_base_sha", "red_at_base_at", "red_at_base_reason", "provenance_sha"],
  task_test: ["script_path", "provenance_sha"],
};

/** Tables no interface in entities.ts claims. Not drift: each is either bookkeeping the
 *  record keeps about itself, or an entity whose shape lives with the code that owns it —
 *  chore in src/chore.ts, lesson in src/lessons.ts, refusal and chore_refusal in
 *  src/types.ts, doctor_run and doctor_violation in src/invariants.ts. Listed so that a
 *  table added with no shape anywhere is caught here. */
const UNCLAIMED = [
  "chore",
  "chore_refusal",
  // 014. The doctor's own record of what it found and when it last ran: a violation row is
  // open from first_seen until cleared_at, and a doctor_run row is one pass. Their shapes
  // are the writes described in src/invariants.ts, not an entity anyone else constructs.
  "doctor_run",
  "doctor_violation",
  "ledger",
  "lesson",
  "refusal",
  "runner_lease",
  "schema_version",
  "scope_refusal",
  // 016. A sketch has no state and no parent, so it is not one of the tree entities
  // entities.ts declares — its shape is `SketchRow` in src/sketch.ts, and
  // a-sketch-is-a-record.test.ts is what holds that shape against pragma_table_info.
  "sketch",
];

describe("every entity row shape against pragma_table_info", () => {
  for (const [table, declared] of Object.entries(ROW_FIELDS)) {
    it(`${table} declares every column it has, and no column it does not`, () => {
      const db = freshDb();
      const columns = columnsOf(db, table);
      expect(columns, `${table} is not in the migrated schema`).not.toHaveLength(0);

      const claimed = new Set(declared.map(columnFor));
      const surplus = columns.filter((c) => !claimed.has(c));
      const missing = [...claimed].filter((c) => !columns.includes(c));

      expect(sorted(missing), `${table}: declared fields with no column`).toEqual([]);
      expect(sorted(surplus), `${table}: columns no field declares`).toEqual(sorted(UNDECLARED[table] ?? []));
    });
  }

  it("names every table, so a new one cannot arrive without a shape", () => {
    const db = freshDb();
    expect(sorted(tablesOf(db))).toEqual(sorted([...Object.keys(ROW_FIELDS), ...UNCLAIMED]));
  });

  /** The pass row, as the typed layer in packages/cli/src/doctor.ts declares it. That
   *  declaration names four columns; if the migration ever built fewer, or different ones,
   *  the first pass to be recorded would fail on a write rather than here. */
  it("builds doctor_run with the four columns a pass records", () => {
    const db = freshDb();
    expect(columnsOf(db, "doctor_run")).toEqual(["at", "duration_ms", "checks_run", "checks_failed"]);
  });

  /** `doctor_pass` is the runner's, one row per check, created at runtime by its own
   *  `CREATE TABLE IF NOT EXISTS`. A migration that took the name would silence that and
   *  leave the runner inserting into a table of the wrong grain. */
  it("leaves doctor_pass to the runner", () => {
    expect(tablesOf(freshDb())).not.toContain("doctor_pass");
  });

  it("renames only what it must, and renames it to a column that exists", () => {
    const db = freshDb();
    const assignment = columnsOf(db, "assignment");
    expect(Object.keys(COLUMN_OF)).toEqual(["commit"]);
    expect(assignment).toContain("commit_sha");
    expect(assignment).not.toContain("commit");
  });
});
