import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/index.js";
import { cascadeDrop } from "../src/cascade.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

/** The acceptance tests for "carry a drop down to the acceptance tests": when a criteria
 *  is abandoned, the tests written to prove it are abandoned with it, and nothing else
 *  moves. drop-cascades-to-tests.test.ts is the unit-level twin; these are the criteria. */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const T = "2026-09-20T00:00:00.000Z";

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const addCriteria = (slug: string): number =>
  ins(
    "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, tree.requirement, "a second thing is accepted", "in_progress", T, T,
  );

const addTest = (criteria: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    slug, criteria, "a further thing is proved", "script", "bash test/further.sh", state, T, T,
  );

/** What an operator does: says `drop`, then lets the cascade follow. */
const dropCriteria = (id: number) => {
  expect(engine.apply("acceptance_criteria", id, "drop", "chief").ok).toBe(true);
  return cascadeDrop(db, "acceptance_criteria", id);
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
  recordRed(db, tree.acceptance);
});

describe("a dropped criteria carries the drop down to its acceptance tests", () => {
  it("drops every live test under it, whatever state it was left in", () => {
    const planned = addTest(tree.criteria, "mail-planned", "planned");
    const failed = addTest(tree.criteria, "mail-failed", "failed");

    const r = dropCriteria(tree.criteria);

    expect(r.ok).toBe(true);
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("dropped"); // ready
    expect(stateOf(db, "acceptance_test", planned)).toBe("dropped");
    expect(stateOf(db, "acceptance_test", failed)).toBe("dropped");
  });

  it("names each carried test in its report, as nobody's doing", () => {
    const failed = addTest(tree.criteria, "mail-failed", "failed");

    const r = dropCriteria(tree.criteria);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tests = r.dropped.filter((d) => d.entity === "acceptance_test");
    expect(tests.map((d) => [d.id, d.from])).toEqual([
      [tree.acceptance, "ready"],
      [failed, "failed"],
    ]);
    expect(tests.every((d) => d.verb === "drop" && d.to === "dropped" && d.automatic)).toBe(true);
  });

  it("carries on past the test, so no task is left dispatchable under it", () => {
    dropCriteria(tree.criteria);

    expect(stateOf(db, "task", tree.task)).toBe("dropped");
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("dropped");
  });

  it("attributes the carried drops to the cascade, not to the operator", () => {
    dropCriteria(tree.criteria);

    const rows = db
      .prepare(
        "SELECT actor FROM ledger WHERE verb = 'drop' AND entity = 'acceptance_test' ORDER BY id",
      )
      .all() as unknown as { actor: string }[];
    expect(rows).toEqual([{ actor: "cascade" }]);
  });
});

describe("it carries the drop no further than the criteria it was told about", () => {
  it("leaves a sibling criteria and its tests alone", () => {
    const sibling = addCriteria("delivered");
    const siblingTest = addTest(sibling, "receipt-arrives", "ready");

    dropCriteria(tree.criteria);

    expect(stateOf(db, "acceptance_criteria", sibling)).toBe("in_progress");
    expect(stateOf(db, "acceptance_test", siblingTest)).toBe("ready");
  });

  it("does not reach upward: the requirement above is untouched by the cascade", () => {
    addCriteria("delivered"); // keeps the requirement from settling on the drop itself
    const before = stateOf(db, "requirement", tree.requirement);

    dropCriteria(tree.criteria);

    expect(stateOf(db, "requirement", tree.requirement)).toBe(before);
  });
});

describe("a carried drop does not undo a proof, and does not claim one", () => {
  it("keeps a passed test, and says which state kept it", () => {
    addTest(tree.criteria, "mail-twice", "ready"); // keeps the criteria droppable
    expect(engine.apply("acceptance_test", tree.acceptance, "pass", "runner").ok).toBe(true);

    const r = dropCriteria(tree.criteria);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kept).toEqual([{ entity: "acceptance_test", id: tree.acceptance, state: "passed" }]);
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("passed");
    expect(
      r.dropped.some((d) => d.entity === "acceptance_test" && d.id === tree.acceptance),
    ).toBe(false);
  });

  it("passes nothing on the way down: no test it touched ends up passed", () => {
    const failed = addTest(tree.criteria, "mail-failed", "failed");

    dropCriteria(tree.criteria);

    const states = db
      .prepare("SELECT state FROM acceptance_test WHERE id IN (?, ?)")
      .all(tree.acceptance, failed) as unknown as { state: string }[];
    expect(states.map((s) => s.state)).toEqual(["dropped", "dropped"]);
  });
});

describe("it asks first, and carries nothing it was not asked to", () => {
  it("refuses a criteria nobody dropped, and leaves its tests dispatchable", () => {
    const r = cascadeDrop(db, "acceptance_criteria", tree.criteria);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("not dropped");
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("ready");
  });

  it("carries nothing a second time", () => {
    dropCriteria(tree.criteria);

    const again = cascadeDrop(db, "acceptance_criteria", tree.criteria);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.dropped).toEqual([]);
    expect(again.kept).toEqual([]);
  });
});
