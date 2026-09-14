import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Maker, open, setScriptPath, type TestScript } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";
import { tmp } from "./tmpdir.js";

const MIGRATIONS = fileURLToPath(new URL("../sql/migrations", import.meta.url));

/** Reads the column back through the type that carries it, so a row that has drifted from
 *  the declared shape fails here rather than somewhere downstream. */
const scriptPathOf = (db: DatabaseSync, entity: "acceptance_test" | "task_test", id: number): string | null =>
  (db.prepare(`SELECT script_path FROM ${entity} WHERE id = ?`).get(id) as TestScript).script_path;

/** A database as it stood before this column existed: every migration up to 004, run by
 *  hand, with the version recorded the way the store records it. */
function dbAtVersion4(): string {
  const path = join(tmp("wecode-v4-"), "wecode.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql") && Number.parseInt(f, 10) <= 4)
    .sort();
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  db.exec("DELETE FROM schema_version");
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(4);
  db.close();
  return path;
}

describe("a test says where its script is meant to live", () => {
  it("round-trips the path the maker was given, on both tables", () => {
    const db = freshDb();
    const t = seed(db);
    const make = new Maker(db);

    const acceptance = make.acceptanceTest(t.criteria, "the link expires", "script", "bash x.sh", "test/expiry.sh");
    const taskTest = make.taskTest(t.task, "the token is single use", "script", "vitest run t", "test/token.test.ts");

    expect(scriptPathOf(db, "acceptance_test", acceptance)).toBe("test/expiry.sh");
    expect(scriptPathOf(db, "task_test", taskTest)).toBe("test/token.test.ts");
  });

  it("defaults to null when the maker is not told", () => {
    const db = freshDb();
    const t = seed(db);
    const make = new Maker(db);

    const acceptance = make.acceptanceTest(t.criteria, "the link expires", "judged", "read the mail");
    const taskTest = make.taskTest(t.task, "the token is single use", "judged", "read the code");

    expect(scriptPathOf(db, "acceptance_test", acceptance)).toBeNull();
    expect(scriptPathOf(db, "task_test", taskTest)).toBeNull();
  });

  it("takes an edit, on both tables, and clears back to null", () => {
    const db = freshDb();
    const t = seed(db);

    setScriptPath(db, "acceptance_test", t.acceptance, "test/mail.sh");
    setScriptPath(db, "task_test", t.taskTest, "test/mailer.test.ts");
    expect(scriptPathOf(db, "acceptance_test", t.acceptance)).toBe("test/mail.sh");
    expect(scriptPathOf(db, "task_test", t.taskTest)).toBe("test/mailer.test.ts");

    setScriptPath(db, "acceptance_test", t.acceptance, "test/mail-v2.sh");
    expect(scriptPathOf(db, "acceptance_test", t.acceptance)).toBe("test/mail-v2.sh");

    setScriptPath(db, "task_test", t.taskTest, null);
    expect(scriptPathOf(db, "task_test", t.taskTest)).toBeNull();
  });

  it("refuses an edit to a row that is not there", () => {
    const db = freshDb();
    expect(() => setScriptPath(db, "task_test", 9999, "test/x.sh")).toThrow("no task_test #9999");
  });

  it("stamps updated_at, so an edit is visible as a change", () => {
    const db = freshDb();
    const t = seed(db);
    const before = (db.prepare("SELECT updated_at FROM task_test WHERE id = ?").get(t.taskTest) as { updated_at: string }).updated_at;

    setScriptPath(db, "task_test", t.taskTest, "test/mailer.test.ts");

    const after = (db.prepare("SELECT updated_at FROM task_test WHERE id = ?").get(t.taskTest) as { updated_at: string }).updated_at;
    expect(after > before).toBe(true);
  });

  it("migrates a database written before the column, losing nothing", () => {
    const path = dbAtVersion4();

    const old = new DatabaseSync(path);
    const t = seed(old);
    const rows = old.prepare("SELECT id, slug, statement, kind, artefact, state FROM task_test ORDER BY id").all();
    expect(rows).toHaveLength(1);
    expect(() => old.prepare("SELECT script_path FROM task_test").get()).toThrow();
    old.close();

    const db = open(path);

    expect(db.prepare("SELECT id, slug, statement, kind, artefact, state FROM task_test ORDER BY id").all()).toEqual(rows);
    expect(scriptPathOf(db, "task_test", t.taskTest)).toBeNull();
    expect(scriptPathOf(db, "acceptance_test", t.acceptance)).toBeNull();

    // And the migrated database is a working one: the column takes a value like any other.
    setScriptPath(db, "task_test", t.taskTest, "test/mailer.test.ts");
    expect(scriptPathOf(db, "task_test", t.taskTest)).toBe("test/mailer.test.ts");
    db.close();
  });
});
