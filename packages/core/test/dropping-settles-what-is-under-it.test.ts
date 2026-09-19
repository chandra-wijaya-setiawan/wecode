import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** `task.drop` carries no guard, so a task can be dropped with its task_tests still
 *  `ready`: dispatchable work under a task nobody means to attempt. cascade.ts walks a
 *  drop downward, but only for a caller that remembers to call it — the daemon's own
 *  drops did not. settle() is the level-triggered sweep, which is where a state nobody
 *  followed up on is supposed to be noticed, and it swept the tasks and not their tests.
 *
 *  Everything here is about the sweep. drop-cascades-to-tests.test.ts is about the walk
 *  itself, and all-dropped.test.ts about what a drop must never prove. */

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const T = "2026-09-19T00:00:00.000Z";

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const addTaskTest = (task: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    slug, task, "a second unit is proved", "script", "vitest run two", state, T, T,
  );

const addTask = (acceptance: number, slug: string, state: string): number =>
  ins(
    "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    slug, acceptance, "a second task", JSON.stringify({ write: ["src/two/**"] }), "engineer",
    JSON.stringify({ tokens: 10, seconds: 10 }), state, T, T,
  );

/** Drop the task the way a caller that forgot the downward walk does. */
const dropTask = (id = tree.task): void => {
  expect(engine.apply("task", id, "drop", "chief").ok).toBe(true);
};

const moves = (changes: readonly { entity: string; id: number; verb: string; to: string }[]) =>
  changes.map((c) => `${c.entity}#${c.id}:${c.verb}:${c.to}`);

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
});

describe("the sweep settles the tests of a dropped task", () => {
  it("leaves a ready task_test live until it runs", () => {
    dropTask();
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("ready");
  });

  it("drops it, and says so as the cascade's doing", () => {
    dropTask();
    const changes = engine.settle();
    expect(moves(changes)).toEqual([`task_test#${tree.taskTest}:drop:dropped`]);
    expect(changes[0]?.actor).toBe("cascade");
    expect(changes[0]?.automatic).toBe(true);
    expect(changes[0]?.reason).toBe(null);
    expect(changes[0]?.from).toBe("ready");
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("dropped");
  });

  it("writes a ledger line for the test, attributed to the cascade", () => {
    dropTask();
    engine.settle();
    const rows = db
      .prepare("SELECT entity, actor FROM ledger WHERE verb = 'drop' ORDER BY id")
      .all() as unknown as { entity: string; actor: string }[];
    expect(rows).toEqual([
      { entity: "task", actor: "chief" },
      { entity: "task_test", actor: "cascade" },
    ]);
  });

  it("reaches every test of the task, whatever state it was left in", () => {
    const planned = addTaskTest(tree.task, "unit-planned", "planned");
    const failed = addTaskTest(tree.task, "unit-failed", "failed");
    dropTask();
    engine.settle();
    for (const id of [tree.taskTest, planned, failed]) {
      expect(stateOf(db, "task_test", id)).toBe("dropped");
    }
  });

  it("keeps a passed task_test: a drop above it does not undo a success", () => {
    const passed = addTaskTest(tree.task, "unit-passed", "passed");
    dropTask();
    const changes = engine.settle();
    expect(moves(changes)).toEqual([`task_test#${tree.taskTest}:drop:dropped`]);
    expect(stateOf(db, "task_test", passed)).toBe("passed");
  });

  it("does not finish the task on the way, and does not report it twice", () => {
    dropTask();
    engine.settle();
    expect(stateOf(db, "task", tree.task)).toBe("dropped");
    expect(engine.settle()).toEqual([]);
  });
});

describe("it settles what is under a drop and nothing else", () => {
  it("leaves the tests of a task nobody dropped alone", () => {
    expect(engine.settle()).toEqual([]);
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("ready");
    expect(stateOf(db, "task", tree.task)).toBe("planned");
  });

  it("touches only the dropped task's tests when a sibling task is live", () => {
    const sibling = addTask(tree.acceptance, "send-mail-twice", "planned");
    const siblingTest = addTaskTest(sibling, "mailer-twice", "ready");
    dropTask();
    engine.settle();
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("dropped");
    expect(stateOf(db, "task_test", siblingTest)).toBe("ready");
    expect(stateOf(db, "task", sibling)).toBe("planned");
  });

  it("does not carry the acceptance_test above it anywhere", () => {
    dropTask();
    engine.settle();
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("ready");
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");
  });

  it("settles every dropped task, not just the first one found", () => {
    const second = addTask(tree.acceptance, "send-mail-twice", "planned");
    const secondTest = addTaskTest(second, "mailer-twice", "ready");
    dropTask();
    dropTask(second);
    engine.settle();
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("dropped");
    expect(stateOf(db, "task_test", secondTest)).toBe("dropped");
  });

  it("settles a task dropped long before the sweep it is noticed in", () => {
    dropTask();
    engine.settle();
    const late = addTaskTest(tree.task, "unit-late", "ready");
    expect(moves(engine.settle())).toEqual([`task_test#${late}:drop:dropped`]);
  });
});
