import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
});

describe("a task is ready only when it can prove itself", () => {
  it("starts when it has a scope, a role and a ready task_test", () => {
    const r = engine.apply("task", tree.task, "start", "chief");
    expect(r.ok).toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
  });

  it("refuses when no task_test is ready, and says so", () => {
    db.prepare("UPDATE task_test SET state = 'planned' WHERE id = ?").run(tree.taskTest);
    const r = engine.apply("task", tree.task, "start", "chief");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("no task_test is ready");
  });

  it("refuses when the scope is empty", () => {
    db.prepare("UPDATE task SET scope = ? WHERE id = ?").run(JSON.stringify({ write: [], tools: [] }), tree.task);
    const r = engine.apply("task", tree.task, "start", "chief");
    expect(!r.ok && r.why).toContain("no write scope");
  });
});

describe("the cascade", () => {
  it("runs from a passing task_test to a delivered epic in one apply", () => {
    engine.apply("task", tree.task, "start", "chief");
    const r = engine.apply("task_test", tree.taskTest, "pass", "runner");

    expect(r.ok).toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("done");

    // the task is done, but its acceptance_test has not been run, so the chain stops there
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");

    const after = engine.apply("acceptance_test", tree.acceptance, "pass", "runner");
    expect(after.ok).toBe(true);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("accepted");
    expect(stateOf(db, "requirement", tree.requirement)).toBe("met");
    expect(stateOf(db, "story", tree.story)).toBe("delivered");
    expect(stateOf(db, "epic", tree.epic)).toBe("delivered");
  });

  it("stops at the release: shipping is a decision", () => {
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");
    engine.apply("acceptance_test", tree.acceptance, "pass", "runner");
    expect(stateOf(db, "release", tree.release)).toBe("in_progress");
  });

  it("reports every state it changed, and which were nobody's doing", () => {
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");
    const r = engine.apply("acceptance_test", tree.acceptance, "pass", "runner");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes.map((c) => `${c.entity}:${c.to}`)).toEqual([
      "acceptance_test:passed",
      "acceptance_criteria:accepted",
      "requirement:met",
      "story:delivered",
      "epic:delivered",
    ]);
    expect(r.changes.filter((c) => c.automatic)).toHaveLength(4);
  });

  it("writes one ledger line per state it changed", () => {
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");
    engine.apply("acceptance_test", tree.acceptance, "pass", "runner");
    const n = db.prepare("SELECT count(*) AS n FROM ledger").get() as { n: number };
    expect(n.n).toBe(8); // start, pass, finish, pass, accept, meet, deliver, deliver
    const actors = db.prepare("SELECT DISTINCT actor FROM ledger ORDER BY actor").all();
    expect(actors).toEqual([{ actor: "cascade" }, { actor: "chief" }, { actor: "runner" }]);
  });

  it("does not half-run: a refused verb changes nothing", () => {
    const before = db.prepare("SELECT count(*) AS n FROM ledger").get();
    engine.apply("story", tree.story, "deliver", "chief");
    expect(db.prepare("SELECT count(*) AS n FROM ledger").get()).toEqual(before);
    expect(stateOf(db, "story", tree.story)).toBe("in_progress");
  });
});

describe("a failing test does not cascade", () => {
  it("leaves the criteria where it was", () => {
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");
    engine.apply("acceptance_test", tree.acceptance, "fail", "runner");
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");
  });
});

describe("settle is the level-triggered half", () => {
  it("accepts a criteria whose tests all passed while nothing else happened", () => {
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");

    // A verdict written straight to the row, as a runner recovering state would: no apply,
    // so no cascade walks up from it.
    db.prepare("UPDATE acceptance_test SET state = 'passed' WHERE id = ?").run(tree.acceptance);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");

    const changes = engine.settle();
    expect(changes.map((c) => `${c.entity}:${c.to}`)).toEqual([
      "acceptance_criteria:accepted",
      "requirement:met",
      "story:delivered",
      "epic:delivered",
    ]);
    expect(stateOf(db, "epic", tree.epic)).toBe("delivered");
  });

  it("does nothing when nothing is owed", () => {
    expect(engine.settle()).toEqual([]);
  });
});
