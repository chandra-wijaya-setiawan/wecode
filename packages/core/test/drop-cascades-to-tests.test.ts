import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/index.js";
import { cascadeDrop } from "../src/cascade.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

/** Dropping a criteria used to leave its acceptance_test in `ready` — dispatchable work
 *  under a criteria nobody means to accept. These are about what follows a drop
 *  downward; the upward half is cascade.test.ts's subject. */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const T = "2026-09-15T00:00:00.000Z";

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const addTest = (criteria: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    slug, criteria, "a second thing is proved", "script", "bash test/two.sh", state, T, T,
  );

const addTaskTest = (task: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    slug, task, "a second unit is proved", "script", "vitest run two", state, T, T,
  );

const drop = (entity: "acceptance_criteria" | "acceptance_test", id: number) => {
  expect(engine.apply(entity, id, "drop", "chief").ok).toBe(true);
  return cascadeDrop(db, entity, id);
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
  recordRed(db, tree.acceptance);
});

describe("a dropped criteria abandons what hangs off it", () => {
  it("drops its live acceptance_test", () => {
    const r = drop("acceptance_criteria", tree.criteria);
    expect(r.ok).toBe(true);
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("dropped");
  });

  it("reaches the whole subtree, not just the tests", () => {
    drop("acceptance_criteria", tree.criteria);
    expect(stateOf(db, "task", tree.task)).toBe("dropped");
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("dropped");
  });

  it("reports every row it dropped, deepest last, as nobody's doing", () => {
    const r = drop("acceptance_criteria", tree.criteria);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropped.map((d) => `${d.entity}:${d.from}`)).toEqual([
      "acceptance_test:ready",
      "task:planned",
      "task_test:ready",
    ]);
    expect(r.dropped.every((d) => d.automatic && d.to === "dropped")).toBe(true);
    expect(r.kept).toEqual([]);
  });

  it("writes one ledger line per row, attributed to the cascade", () => {
    drop("acceptance_criteria", tree.criteria);
    const rows = db
      .prepare("SELECT entity, actor FROM ledger WHERE verb = 'drop' ORDER BY id")
      .all() as unknown as { entity: string; actor: string }[];
    expect(rows).toEqual([
      { entity: "acceptance_criteria", actor: "chief" },
      { entity: "acceptance_test", actor: "cascade" },
      { entity: "task", actor: "cascade" },
      { entity: "task_test", actor: "cascade" },
    ]);
  });

  it("drops every test, not only the first", () => {
    const second = addTest(tree.criteria, "mail-twice", "failed");
    drop("acceptance_criteria", tree.criteria);
    expect(stateOf(db, "acceptance_test", second)).toBe("dropped");
  });

  it("cascades from a dropped acceptance_test too", () => {
    const r = drop("acceptance_test", tree.acceptance);
    expect(r.ok).toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("dropped");
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");
  });
});

describe("a drop does not undo a success, and does not prove one", () => {
  /** One test passed, one still ready: the criteria is not accepted yet, so it is still
   *  droppable, and the cascade meets both a success and a live row. */
  const mixed = (): number => {
    const second = addTest(tree.criteria, "mail-twice", "ready");
    expect(engine.apply("acceptance_test", tree.acceptance, "pass", "runner").ok).toBe(true);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");
    return second;
  };

  it("keeps a passed acceptance_test, and says which state kept it", () => {
    mixed();
    const r = drop("acceptance_criteria", tree.criteria);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kept).toEqual([{ entity: "acceptance_test", id: tree.acceptance, state: "passed" }]);
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("passed");
  });

  it("still abandons the live work under a test it kept", () => {
    const second = mixed();
    drop("acceptance_criteria", tree.criteria);
    expect(stateOf(db, "acceptance_test", second)).toBe("dropped");
    expect(stateOf(db, "task", tree.task)).toBe("dropped");
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("dropped");
  });

  it("does not finish a task on the way down when one of its task_tests passed", () => {
    expect(engine.apply("task", tree.task, "start", "chief").ok).toBe(true);
    const second = addTaskTest(tree.task, "unit-two", "passed");
    drop("acceptance_criteria", tree.criteria);

    // Dropping taskTest settles the last live child of the task. Had the cascade gone
    // through Engine.apply, that would have fired `finish` upward and recorded the task
    // done. It is dropped, and the passed task_test is untouched.
    expect(stateOf(db, "task", tree.task)).toBe("dropped");
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("dropped");
    expect(stateOf(db, "task_test", second)).toBe("passed");
  });
});

describe("it refuses rather than guessing", () => {
  it("will not cascade from a row nobody dropped", () => {
    const r = cascadeDrop(db, "acceptance_criteria", tree.criteria);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("is in_progress, not dropped");
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("ready");
  });

  it("says so when there is no such row", () => {
    const r = cascadeDrop(db, "acceptance_criteria", 9999);
    expect(!r.ok && r.why).toContain("no acceptance_criteria #9999");
  });

  it("changes nothing, and reports nothing, on a second run", () => {
    drop("acceptance_criteria", tree.criteria);
    const again = cascadeDrop(db, "acceptance_criteria", tree.criteria);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.dropped).toEqual([]);
    expect(again.kept).toEqual([]);
  });

  it("does nothing for a dropped task_test, which bears nothing", () => {
    expect(engine.apply("task_test", tree.taskTest, "drop", "runner").ok).toBe(true);
    const r = cascadeDrop(db, "task_test", tree.taskTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropped).toEqual([]);
  });
});
