import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { COLUMN_OF, open, ROW_FIELDS, SCHEMA_VERSION } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";
import { tmp } from "./tmpdir.js";

/** Read from the migrated database rather than from the migration files: a column added by
 *  005 and renamed by 012 is only one column, and only the database knows that. */
const columnsOf = (db: DatabaseSync, table: string): readonly string[] =>
  (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((r) => r.name);

/** A column with its declared type and whether it may be absent — what `columnsOf` drops.
 *  A migration that spelled `story_id TEXT` would leave every name here right. */
const typesOf = (db: DatabaseSync, table: string): Record<string, string> =>
  Object.fromEntries(
    (db.prepare("SELECT name, type, `notnull` FROM pragma_table_info(?)").all(table) as {
      name: string;
      type: string;
      notnull: number;
    }[]).map((r) => [r.name, r.notnull === 1 ? `${r.type} NOT NULL` : r.type]),
  );

/** The message SQLite raises, or "" when the statement was accepted. Returned rather than
 *  asserted on, so each caller says which refusal it means. */
const refusal = (run: () => void): string => {
  try {
    run();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
};

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
  // 017. The column is in the record before anything reads it: `Story` in entities.ts is
  // unchanged, so a story loaded through it is typed as a story with no rank. That is the
  // same drift as the rows above and is recorded the same way, and it closes when the
  // reader that orders by priority arrives and declares the field.
  story: ["priority"],
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
  // 017. An edge, not an entity: two story ids and nothing else, with no id of its own to
  // name it by and no state to work it through. There is no interface to declare because
  // there is no row anyone constructs — the shape is the pair, and the group below is what
  // holds it.
  "story_depends_on",
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

/** Another story under the same epic, so an edge has two real ends to join. */
const sibling = (db: DatabaseSync, epic: number, slug = "checkout"): number => {
  const t = "2026-09-13T00:00:00.000Z";
  db.prepare("INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(slug, epic, slug, "in_progress", t, t);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

/** A database honestly older than this build, the way chore.test.ts makes one. The
 *  workspaces people are working in already have stories in them, and those are the ones
 *  an ALTER with the wrong default silently ruins — a fresh file would never notice. */
const predating = (): { db: DatabaseSync; story: number; epic: number } => {
  const path = join(tmp(), "wecode.db");
  const old = open(path, { to: SCHEMA_VERSION - 1 });
  const { story, epic } = seed(old);
  old.close();
  return { db: open(path), story, epic };
};

describe("the dependency edge 017 adds", () => {
  it("holds two integer story ids and nothing else", () => {
    expect(typesOf(freshDb(), "story_depends_on")).toEqual({
      story_id: "INTEGER NOT NULL",
      depends_on_id: "INTEGER NOT NULL",
    });
  });

  /** Both ends at `story(id)`. A `depends_on_id` left pointing at `epic` would take every
   *  insert below without complaint, because the ids overlap. */
  it("points both ends at a story", () => {
    const fks = freshDb()
      .prepare("SELECT `table`, `from`, `to` FROM pragma_foreign_key_list('story_depends_on')")
      .all() as { table: string; from: string; to: string }[];
    expect(sorted(fks.map((f) => `${f.from} -> ${f.table}.${f.to}`))).toEqual([
      "depends_on_id -> story.id",
      "story_id -> story.id",
    ]);
  });

  it("takes an edge between two stories", () => {
    const db = freshDb();
    const { story, epic } = seed(db);
    const other = sibling(db, epic);
    db.prepare("INSERT INTO story_depends_on (story_id, depends_on_id) VALUES (?,?)").run(other, story);
    expect(db.prepare("SELECT depends_on_id FROM story_depends_on WHERE story_id = ?").all(other)).toEqual([
      { depends_on_id: story },
    ]);
  });

  it("refuses an end that is not a story", () => {
    const db = freshDb();
    const { story } = seed(db);
    const run = () =>
      db.prepare("INSERT INTO story_depends_on (story_id, depends_on_id) VALUES (?,?)").run(story, 9999);
    expect(refusal(run)).toMatch(/FOREIGN KEY/i);
  });

  /** Nothing distinguishes the second statement of an edge from the first — no id, no
   *  author, no time — so two rows would only make "is this blocked" answer with a count. */
  it("refuses the same edge twice", () => {
    const db = freshDb();
    const { story, epic } = seed(db);
    const other = sibling(db, epic);
    const add = () =>
      db.prepare("INSERT INTO story_depends_on (story_id, depends_on_id) VALUES (?,?)").run(other, story);
    add();
    expect(refusal(add)).toMatch(/UNIQUE/i);
  });

  /** The pair is what is unique, not either end of it. A key on `story_id` alone would take
   *  every test above and still say a story may be waiting on exactly one thing, which is
   *  not a dependency graph. */
  it("lets one story wait on more than one", () => {
    const db = freshDb();
    const { story, epic } = seed(db);
    const other = sibling(db, epic);
    const third = sibling(db, epic, "receipts");
    const add = db.prepare("INSERT INTO story_depends_on (story_id, depends_on_id) VALUES (?,?)");
    add.run(story, other);
    add.run(story, third);
    expect(sorted(
      (db.prepare("SELECT depends_on_id AS d FROM story_depends_on WHERE story_id = ?").all(story) as { d: number }[])
        .map((r) => String(r.d)),
    )).toEqual(sorted([String(other), String(third)]));
  });

  /** And more than one may wait on the same story, which is the other end of the same key. */
  it("lets more than one story wait on the same one", () => {
    const db = freshDb();
    const { story, epic } = seed(db);
    const other = sibling(db, epic);
    const third = sibling(db, epic, "receipts");
    const add = db.prepare("INSERT INTO story_depends_on (story_id, depends_on_id) VALUES (?,?)");
    add.run(other, story);
    add.run(third, story);
    expect(db.prepare("SELECT COUNT(*) AS n FROM story_depends_on WHERE depends_on_id = ?").get(story)).toEqual({ n: 2 });
  });

  /** The other direction is a different edge: "a waits on b" is not "b waits on a". */
  it("keeps the two directions apart", () => {
    const db = freshDb();
    const { story, epic } = seed(db);
    const other = sibling(db, epic);
    const add = db.prepare("INSERT INTO story_depends_on (story_id, depends_on_id) VALUES (?,?)");
    add.run(other, story);
    add.run(story, other);
    expect(db.prepare("SELECT COUNT(*) AS n FROM story_depends_on").get()).toEqual({ n: 2 });
  });

  /** A row that can never be discharged. Longer cycles are the doctor's — a CHECK cannot
   *  walk a graph — but the one-step case is the typo, and it is refused here. */
  it("refuses a story that waits on itself", () => {
    const db = freshDb();
    const { story } = seed(db);
    const run = () =>
      db.prepare("INSERT INTO story_depends_on (story_id, depends_on_id) VALUES (?,?)").run(story, story);
    expect(refusal(run)).toMatch(/CHECK/i);
  });

  /** "What is waiting on this story" is asked the moment one is delivered. The primary key
   *  indexes the other direction only, so without this it is a scan. */
  it("indexes the reverse question", () => {
    const db = freshDb();
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT story_id FROM story_depends_on WHERE depends_on_id = 1")
      .all() as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/USING (COVERING )?INDEX/);
  });

  it("reaches a database that predates it", () => {
    const { db, story, epic } = predating();
    const other = sibling(db, epic);
    db.prepare("INSERT INTO story_depends_on (story_id, depends_on_id) VALUES (?,?)").run(other, story);
    expect(db.prepare("SELECT COUNT(*) AS n FROM story_depends_on").get()).toEqual({ n: 1 });
  });
});

describe("the priority 017 gives a story", () => {
  it("is an integer the row must have", () => {
    expect(typesOf(freshDb(), "story").priority).toBe("INTEGER NOT NULL");
  });

  it("defaults a story nobody ranked to 0", () => {
    const db = freshDb();
    const { story } = seed(db);
    expect(db.prepare("SELECT priority FROM story WHERE id = ?").get(story)).toEqual({ priority: 0 });
  });

  /** Unbounded, and lower first: `ORDER BY priority` is the plain reading, and a story can
   *  be squeezed above another without renumbering the ones below it. */
  it("takes a rank either side of the default, lowest first", () => {
    const db = freshDb();
    const { story, epic } = seed(db);
    const other = sibling(db, epic);
    db.prepare("UPDATE story SET priority = ? WHERE id = ?").run(-1, other);
    db.prepare("UPDATE story SET priority = ? WHERE id = ?").run(7, story);
    expect(db.prepare("SELECT id FROM story ORDER BY priority").all()).toEqual([{ id: other }, { id: story }]);
  });

  /** The rows the ALTER had to reach. A story written before 017 is unranked, not NULL and
   *  not the most urgent work in the record. */
  it("reaches a story written before it", () => {
    const { db, story } = predating();
    expect(db.prepare("SELECT priority FROM story WHERE id = ?").get(story)).toEqual({ priority: 0 });
  });
});
