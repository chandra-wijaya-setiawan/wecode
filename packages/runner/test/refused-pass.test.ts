import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Scripts } from "../src/index.js";
import { recordRed } from "../../core/test/helpers.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let story: number;
let criteria: number;
let dir: string;

const stateOf = (id: number): string =>
  (db.prepare("SELECT state FROM acceptance_test WHERE id = ?").get(id) as { state: string }).state;

const outputOf = (id: number): string =>
  (db.prepare("SELECT last_output FROM acceptance_test WHERE id = ?").get(id) as { last_output: string })
    .last_output;

/** Every entry the ledger holds for one test. A verdict that never reached the ledger did
 *  not happen, whatever the runner's log said about it. */
const ledgerFor = (id: number): { verb: string; to_state: string }[] =>
  db
    .prepare("SELECT verb, to_state FROM ledger WHERE entity = 'acceptance_test' AND entity_id = ?")
    .all(id) as unknown as { verb: string; to_state: string }[];

/** A ready acceptance_test with no task under it, so nothing stands between the script's
 *  exit code and the verdict the engine is asked for. */
function readyTest(artefact: string): number {
  const at = make.acceptanceTest(criteria, `proof-${artefact}`, "script", artefact);
  engine.apply("acceptance_test", at, "deliver", "chief");
  return at;
}

/** A database as the old runner left it: schema 006, the whole tree seeded and started,
 *  one ready acceptance_test whose red run is in the runner's side table and not in the
 *  column the guard reads. Built by running the migrations up to 006 by hand, because that
 *  is the only way to have a database the upgrade has not touched yet. */
function atSchemaSix(): { path: string; story: number; test: number } {
  const home = mkdtempSync(join(tmpdir(), "wecode-schema-006-"));
  const path = join(home, "wecode.db");
  const old = new DatabaseSync(path);
  old.exec("PRAGMA foreign_keys = ON");
  const sql = fileURLToPath(new URL("../../core/sql/migrations", import.meta.url));
  for (const file of readdirSync(sql).sort().filter((f) => Number.parseInt(f, 10) <= 6)) {
    old.exec(readFileSync(join(sql, file), "utf8"));
  }
  old.exec("DELETE FROM schema_version");
  old.exec("INSERT INTO schema_version (version) VALUES (6)");

  const m = new Maker(old);
  const en = new Engine(old);
  const ws = m.workspace("acme", home);
  const p = m.project(ws, "s", home);
  const rel = m.release(p, "1.0.0");
  const e = m.epic(rel, "e");
  const s = m.story(e, "s");
  const req = m.requirement(s, "r");
  const c = m.criteria(req, "c");
  const at = m.acceptanceTest(c, "old", "script", "true");
  for (const [entity, id] of [["project", p], ["release", rel], ["epic", e], ["story", s], ["requirement", req], ["acceptance_criteria", c]] as const) {
    en.apply(entity, id, "start", "chief");
  }
  en.apply("acceptance_test", at, "deliver", "chief");

  old.exec(
    `CREATE TABLE red_at_base (test_id INTEGER PRIMARY KEY, red_at_base_sha TEXT,
                               red_at_base_at TEXT, reason TEXT)`,
  );
  old
    .prepare("INSERT INTO red_at_base (test_id, red_at_base_sha, red_at_base_at) VALUES (?, ?, ?)")
    .run(at, "09353ec", "2026-09-14T00:00:00.000Z");
  old.close();
  return { path, story: s, test: at };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wecode-refused-"));
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", dir);
  const p = make.project(ws, "s", dir);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  story = make.story(e, "s");
  const req = make.requirement(story, "r");
  criteria = make.criteria(req, "c");
  for (const [entity, id] of [["project", p], ["release", rel], ["epic", e], ["story", story], ["requirement", req], ["acceptance_criteria", criteria]] as const) {
    engine.apply(entity, id, "start", "chief");
  }
});

describe("a pass the engine refuses is not a pass", () => {
  it("reports it as refused in the engine's words and leaves the test ready", async () => {
    // Nobody watched this one fail at its base, so `test_has_been_red` refuses the pass.
    const at = readyTest("true");

    const r = await new Scripts(db).runAcceptanceTests(story, dir);

    expect(r.passed).not.toContain(at);
    expect(r.failed).not.toContain(at);
    expect(r.refused?.map((x) => x.id)).toEqual([at]);
    expect(r.refused?.[0]?.why).toContain("has never been seen to fail");
    // Still ready: a refused transition changed nothing, and the next tick owes the same run.
    expect(stateOf(at)).toBe("ready");
    // and the refusal is where the board reads the run's output, rather than nowhere.
    expect(outputOf(at)).toContain("has never been seen to fail");
    // The ledger is the record of what happened. Nothing happened.
    expect(ledgerFor(at)).toEqual([{ verb: "deliver", to_state: "ready" }]);
  });

  it("passes the same test once the red run is recorded, and reaches the ledger", async () => {
    const at = readyTest("true");
    // Recorded where the guard reads it: the column on acceptance_test.
    recordRed(db, at);

    const r = await new Scripts(db).runAcceptanceTests(story, dir);

    expect(r.passed).toContain(at);
    expect(r.refused ?? []).toEqual([]);
    expect(stateOf(at)).toBe("passed");
    expect(ledgerFor(at)).toContainEqual({ verb: "pass", to_state: "passed" });
  });

  it("passes a test whose verdict the old runner left in the side table", async () => {
    // The live shape of acceptance_test 157 and 160: a sha recorded at 09353ec in the
    // runner's own table, a null column, a test refused a pass on every tick since.
    const old = atSchemaSix();
    db = open(old.path);
    make = new Maker(db);
    engine = new Engine(db);
    story = old.story;

    const r = await new Scripts(db).runAcceptanceTests(old.story, dir);

    expect(r.refused ?? []).toEqual([]);
    expect(r.passed).toContain(old.test);
    expect(stateOf(old.test)).toBe("passed");
    expect(ledgerFor(old.test)).toContainEqual({ verb: "pass", to_state: "passed" });
  });
});

describe("the red run has one home", () => {
  it("is the column the guard reads, and the old side table is a lens on it", () => {
    const at = readyTest("true");
    recordRed(db, at, "09353ec");

    const row = db.prepare("SELECT red_at_base_sha FROM red_at_base WHERE test_id = ?").get(at) as {
      red_at_base_sha: string;
    };
    expect(row.red_at_base_sha).toBe("09353ec");
    // A lens, not a second home: nothing can write a verdict the guard would not see.
    expect(() =>
      db.prepare("INSERT INTO red_at_base (test_id, red_at_base_sha) VALUES (?, ?)").run(at, "deadbee"),
    ).toThrow();
  });
});
