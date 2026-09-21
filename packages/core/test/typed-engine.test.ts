import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Repo, SCHEMA_VERSION, diagnose, guards, open } from "../src/index.js";
import { recordAttemptCommit } from "./db.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";
import { tmp } from "./tmpdir.js";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

const APPLY = read("apply.ts");
const CHECKS = read("checks.ts");
const STORE = read("store.ts");

/** Every quoted or backticked literal in a module, as written. */
const literals = (source: string): string[] =>
  [...source.matchAll(/"([^"\\\n]*)"|`([^`\\]*)`/g)].map((m) => m[1] ?? m[2]);

/** A literal that opens with a SQL keyword is SQL, whatever it is passed to. */
const SQLISH = /^(PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|REPLACE)\b/;

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
});

/** The point of the port: a query the compiler cannot read is a query no test covers until
 *  it breaks in the field, and one left behind loses the guarantee for the whole module. So
 *  this is spelled as "none", against the source, rather than as a test of what was ported.
 *
 *  `settle()` was the worst of them — `SELECT id, state FROM ${entity}` put an entity name
 *  into the SQL text, so nothing said `state` was a column of that table, or that the table
 *  existed at all. */
describe("the engine, the guards and the store, ported onto the typed layer", () => {
  it("leaves no prepared statement in any of the three modules", () => {
    for (const [name, source] of [["apply.ts", APPLY], ["checks.ts", CHECKS], ["store.ts", STORE]] as const) {
      expect(source, name).not.toMatch(/\bprepare\s*\(/);
      expect(source, name).toContain('from "./db.js"');
    }
  });

  it("leaves no SQL text at all in the engine or the guards", () => {
    for (const [name, source] of [["apply.ts", APPLY], ["checks.ts", CHECKS]] as const) {
      expect(source.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT)\b/g), name).toBeNull();
      expect(source, name).not.toMatch(/\bdb\.(prepare|exec|get|all|run)\b/);
    }
  });

  /** The store keeps the SQL the typed layer has no spelling for and nothing else: the two
   *  pragmas an open sets, and transaction control. Every statement that reads or writes a
   *  row — the version stamp included — goes through the dialect. Migration DDL reaches
   *  `exec` from a file, so it is not a literal here at all. */
  it("leaves the store only the SQL the dialect cannot spell", () => {
    expect([...new Set(literals(STORE).filter((l) => SQLISH.test(l)))].sort()).toEqual([
      "BEGIN IMMEDIATE",
      "COMMIT",
      "PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}",
      "PRAGMA foreign_keys = ON",
      "RELEASE ${name}",
      "ROLLBACK",
      "ROLLBACK TO ${name}",
      "SAVEPOINT ${name}",
    ]);
  });

  /** The declarations are held against the real schema, so a table declared here and a
   *  migration that never built it cannot drift apart quietly. `sqlite_master` is SQLite's
   *  own and is checked the same way. */
  it("asks only for columns the database actually has", () => {
    const shared = [...(/const NODE = \[([^\]]*)\]/.exec(APPLY)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(shared).toEqual(["id", "state"]);

    const declared = [APPLY, CHECKS, STORE].flatMap((source) =>
      [...source.matchAll(/table<[\s\S]*?>\(\s*"(\w+)",\s*\[([\s\S]*?)\]/g)].map((m) => ({
        name: m[1],
        columns: [
          ...(m[2].includes("...NODE") ? shared : []),
          ...[...m[2].matchAll(/"(\w+)"/g)].map((c) => c[1]),
        ],
      })),
    );

    expect([...new Set(declared.map((d) => d.name))].sort()).toEqual([
      "acceptance_criteria",
      "acceptance_test",
      "assignment",
      "design",
      "epic",
      "requirement",
      "schema_version",
      "sqlite_master",
      "story",
      "task",
      "worker",
    ]);
    // A table may be declared twice, by two modules reading two parts of it, so the names
    // above are a set — but each declaration is held against the schema on its own.
    for (const d of declared) {
      const actual = (db.prepare(`PRAGMA table_info(${d.name})`).all() as { name: string }[]).map((c) => c.name);
      expect(actual.length, d.name).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });
});

/** settle() reads state and fires, so nothing waits for an event that already happened —
 *  which is why it is the sweep that must read every entity's own table. The fixture moves
 *  rows behind the engine's back, exactly as the things settle() exists to catch do. */
describe("the level-triggered sweep, through the typed layer", () => {
  // `task.finish` asks for a commit the task's own branch carries as well as for its tests,
  // so the attempt that wrote one is on the record before the sweep reads anything.
  beforeEach(() => {
    recordAttemptCommit(db, tree.task);
  });

  const behindTheEnginesBack = (): void => {
    db.prepare("UPDATE task SET state = 'ready' WHERE id = ?").run(tree.task);
    db.prepare("UPDATE task_test SET state = 'passed' WHERE id = ?").run(tree.taskTest);
    db.prepare("UPDATE acceptance_test SET state = 'passed' WHERE id = ?").run(tree.acceptance);
  };

  it("fires every entity it sweeps, bottom upward, in one call", () => {
    behindTheEnginesBack();
    const changes = engine.settle();

    expect(stateOf(db, "task", tree.task)).toBe("done");
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("accepted");
    expect(stateOf(db, "requirement", tree.requirement)).toBe("met");
    expect(stateOf(db, "story", tree.story)).toBe("delivered");
    expect(stateOf(db, "epic", tree.epic)).toBe("delivered");

    expect(changes.map((c) => c.entity)).toEqual([
      "task",
      "acceptance_criteria",
      "requirement",
      "story",
      "epic",
    ]);
    expect(changes.every((c) => c.automatic)).toBe(true);
    expect(changes.map((c) => c.id)).toEqual([
      tree.task,
      tree.criteria,
      tree.requirement,
      tree.story,
      tree.epic,
    ]);
  });

  /** Each row is read from its own table. Two entities whose ids collide — the ordinary
   *  case in this schema, where every level has one row — must not be told apart by id, so
   *  a row that cannot move stays put while its neighbour at the same id moves. */
  it("moves nothing whose own guard does not hold", () => {
    db.prepare("UPDATE task SET state = 'ready' WHERE id = ?").run(tree.task);
    db.prepare("UPDATE task_test SET state = 'passed' WHERE id = ?").run(tree.taskTest);
    const changes = engine.settle();

    // The task settles on its own tests; the criteria above it does not, because its
    // acceptance_test is still only ready.
    expect(changes.map((c) => c.entity)).toEqual(["task"]);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");
  });

  it("ledgers every move it makes, as settle", () => {
    behindTheEnginesBack();
    engine.settle();
    const lines = db
      .prepare("SELECT entity, to_state FROM ledger WHERE actor = 'settle' ORDER BY id")
      .all() as unknown as { entity: string; to_state: string }[];
    expect(lines.map((l) => `${l.entity} ${l.to_state}`)).toEqual([
      "task done",
      "acceptance_criteria accepted",
      "requirement met",
      "story delivered",
      "epic delivered",
    ]);
  });

  it("stops when nothing more can move", () => {
    expect(engine.settle()).toEqual([]);
  });
});

/** Why the sweep above has to record an attempt at all. `finish` is one guard asking two
 *  questions, and the second is read off the record of what was committed — so a task whose
 *  tests all pass on a branch holding no commit of its own stays where it is, and the whole
 *  chain above it stays with it. Spelled out here so a fixture that stops finishing tasks
 *  reads as this rule rather than as the sweep breaking. */
describe("a task finishes on its own work, not on its tests alone", () => {
  beforeEach(() => {
    db.prepare("UPDATE task SET state = 'ready' WHERE id = ?").run(tree.task);
    db.prepare("UPDATE task_test SET state = 'passed' WHERE id = ?").run(tree.taskTest);
  });

  it("leaves a task whose branch carries no commit exactly where it was", () => {
    expect(engine.settle()).toEqual([]);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
    expect(engine.may("task", tree.task, "finish").ok).toBe(false);
  });

  it("finishes it once an attempt has committed", () => {
    recordAttemptCommit(db, tree.task);
    expect(engine.settle().map((c) => c.entity)).toEqual(["task"]);
    expect(stateOf(db, "task", tree.task)).toBe("done");
  });
});

/** test_has_been_red is the one guard that reads a column Repo exposes no accessor for, so
 *  it is the one that reaches past the repository — and the refusal it writes names the row
 *  it read, which is what the extra columns are for. */
describe("the red-at-base guard, through the typed layer", () => {
  it("refuses a test nobody has watched fail, naming the row it read", () => {
    const r = engine.may("acceptance_test", tree.acceptance, "pass");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("mail-arrives");
    expect(!r.ok && r.why).toContain("the mail arrives with a link");
    expect(!r.ok && r.why).toContain("has never been seen to fail");
  });

  it("allows it once the red run is on the record", () => {
    recordRed(db, tree.acceptance);
    expect(engine.may("acceptance_test", tree.acceptance, "pass").ok).toBe(true);
  });

  /** A missing row is "no such row", never a row of nulls — the typed layer's `get()` says
   *  null where the old statement said undefined, and a guard that mistook one for a row
   *  would refuse with "undefined has never been seen to fail". Asked of the guard itself,
   *  because `may` answers for a missing row before any guard runs. */
  it("refuses a row that is not there rather than reading nulls", () => {
    db.prepare("DELETE FROM task_test WHERE id = ?").run(tree.taskTest);
    db.prepare("DELETE FROM task WHERE id = ?").run(tree.task);
    db.prepare("DELETE FROM acceptance_test WHERE id = ?").run(tree.acceptance);
    const r = guards(new Repo(db)).test_has_been_red({ entity: "acceptance_test", id: tree.acceptance });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toBe(`no acceptance_test #${tree.acceptance}`);
  });

  it("refuses an entity that records no red run at all", () => {
    const r = guards(new Repo(db)).test_has_been_red({ entity: "task_test", id: tree.taskTest });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toBe("task_test records no red run at its base");
  });
});

/** The version stamp is the store's only write outside a migration file, and it is one row
 *  replaced rather than appended: a second row would make `version()` answer whichever one
 *  SQLite happened to hand back first. */
describe("the schema version, through the typed layer", () => {
  it("reports absent for a file that has no schema_version table", () => {
    const path = join(tmp(), "empty.db");
    open(path, { to: 0 }).close();
    expect(diagnose(path).state).toBe("absent");
    expect(diagnose(path).found).toBe(0);
  });

  it("stamps the version a partial migration reached, and only that", () => {
    const path = join(tmp(), "old.db");
    open(path, { to: 1 }).close();
    const at = diagnose(path);
    expect(at.found).toBe(1);
    expect(at.state).toBe(SCHEMA_VERSION === 1 ? "current" : "behind");
  });

  it("leaves exactly one version row after migrating the rest of the way", () => {
    const path = join(tmp(), "upgraded.db");
    open(path, { to: 1 }).close();
    const upgraded = open(path);
    try {
      const rows = upgraded.prepare("SELECT version FROM schema_version").all() as unknown as { version: number }[];
      expect(rows).toEqual([{ version: SCHEMA_VERSION }]);
    } finally {
      upgraded.close();
    }
    expect(diagnose(path).state).toBe("current");
  });

  it("reads the version back through the same layer a fresh open wrote it with", () => {
    const path = join(tmp(), "fresh.db");
    open(path).close();
    expect(diagnose(path)).toEqual({
      path,
      state: "current",
      found: SCHEMA_VERSION,
      understood: SCHEMA_VERSION,
    });
  });
});
