import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/index.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

/** The attempt record `task.finish` reads: a branch of the task's own carrying a commit.
 *  Since the second guard on `every_task_test_settled` went in, settled tests alone do not
 *  finish a task — the record has to name work, and only an attempt writes a sha. */
const wroteACommit = (task: number, sha = "c0ffee0"): void => {
  db.prepare(
    "INSERT OR IGNORE INTO worker (id,slug,name,role,kind,created_at,updated_at) VALUES (1,'w','w','engineer','agent','t','t')",
  ).run();
  db.prepare(
    `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,kind,commit_sha,spent,created_at,updated_at)
     VALUES (?,'task',?,1,'{}','{}','/tmp','succeeded','work',?,'{}','t','t')`,
  ).run(sha, task, sha);
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
  // These are tests about the cascade, not about the branch: the task's attempt wrote a
  // commit, so `finish` turns on the tests alone. What the other guard refuses is the
  // subject of "a task finishes on its own work" below.
  wroteACommit(tree.task);
  // These are tests about the cascade, not about `test_has_been_red`: the acceptance_test
  // has been watched failing at its base, so passing it is legal and what follows is the
  // cascade. What that guard refuses is red-at-base.test.ts's subject.
  recordRed(db, tree.acceptance);
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

describe("a task finishes on its own work", () => {
  /** The rule that replaced the unconditional pass → done cascade. A passing task_test
   *  still fires `finish`, but only where the record says something was written. */
  it("does not finish a task whose branch holds no commit of its own", () => {
    db.prepare("DELETE FROM assignment").run();
    engine.apply("task", tree.task, "start", "chief");
    const r = engine.apply("task_test", tree.taskTest, "pass", "runner");

    expect(r.ok).toBe(true);
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("passed");
    expect(stateOf(db, "task", tree.task)).toBe("ready");
    expect(r.ok && r.changes.map((c) => c.entity)).toEqual(["task_test"]);
  });

  it("does not finish it in the sweep either", () => {
    db.prepare("DELETE FROM assignment").run();
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");
    expect(engine.settle()).toEqual([]);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
  });

  it("finishes it once an attempt records one, and says why it refused before", () => {
    db.prepare("DELETE FROM assignment").run();
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");

    const refused = engine.apply("task", tree.task, "finish", "chief");
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.why).toContain("holds no commit of its own");

    wroteACommit(tree.task);
    expect(engine.settle().map((c) => `${c.entity}:${c.to}`)).toEqual(["task:done"]);
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
