import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine, bulkDrop } from "../src/index.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let engine: Engine;

const T = "2026-09-13T00:00:00.000Z";

/** Another task under the same acceptance_test, with a ready task_test of its own, so a
 *  list can hold several droppable ids. */
const task = (slug: string): number => {
  db.prepare(
    "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(slug, tree.acceptance, slug, JSON.stringify({ write: ["src/**"], tools: ["bash"] }), "engineer", JSON.stringify({ tokens: 1000, seconds: 60 }), "planned", T, T);
  const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.prepare(
    "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(`${slug}-test`, id, "it works", "script", "vitest run", "ready", T, T);
  return id;
};

const ledgerLines = (): number => (db.prepare("SELECT count(*) AS n FROM ledger").get() as { n: number }).n;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  engine = new Engine(db);
  recordRed(db, tree.acceptance);
});

describe("a bulk drop is all or nothing", () => {
  it("refuses the whole list when one id refuses, and names the offender", () => {
    const second = task("second");
    // done is terminal for a task: the drop verb does not exist from there.
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");
    expect(stateOf(db, "task", tree.task)).toBe("done");

    const before = ledgerLines();
    const r = bulkDrop(db, [second, tree.task], "chief");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => x.id)).toEqual([tree.task]);
    expect(r.refusals[0]?.why).toContain("terminal");

    // nothing written: not the id that would have gone through, not a ledger line
    expect(stateOf(db, "task", second)).toBe("planned");
    expect(stateOf(db, "task", tree.task)).toBe("done");
    expect(ledgerLines()).toBe(before);
  });

  it("refuses a done task rather than skipping it silently", () => {
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");

    const asked = engine.may("task", tree.task, "drop");
    expect(asked.ok).toBe(false);

    const r = bulkDrop(db, [tree.task], "chief");
    expect(r.ok).toBe(false);
    if (r.ok || asked.ok) return;
    // the engine's own words, not a summary this module invented
    expect(r.refusals).toEqual([{ id: tree.task, why: asked.why }]);
  });

  it("names every offender in the list, not just the first", () => {
    const second = task("second");
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");
    db.prepare("UPDATE task SET state = 'dropped' WHERE id = ?").run(second);

    const r = bulkDrop(db, [tree.task, second], "chief");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => x.id)).toEqual([tree.task, second]);
  });

  it("reports an unknown id rather than dropping the rest", () => {
    const second = task("second");
    const r = bulkDrop(db, [second, 9999], "chief");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals[0]?.why).toBe("no task #9999");
    expect(stateOf(db, "task", second)).toBe("planned");
  });
});

describe("a clean list drops every id through the engine", () => {
  it("drops all of them and reports one change each", () => {
    const second = task("second");
    const third = task("third");

    const r = bulkDrop(db, [tree.task, second, third], "chief");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.changes.map((c) => `${c.entity}:${c.id}:${c.to}`)).toEqual([
      `task:${tree.task}:dropped`,
      `task:${second}:dropped`,
      `task:${third}:dropped`,
    ]);
    for (const id of [tree.task, second, third]) expect(stateOf(db, "task", id)).toBe("dropped");
  });

  it("cascades once: the same changes and the same ledger the engine writes one at a time", () => {
    const second = task("second");
    const ids = [tree.task, second];

    const bulk = bulkDrop(db, ids, "chief");
    expect(bulk.ok).toBe(true);
    const lines = ledgerLines();

    // the same drops, one apply at a time, against a database in the same starting shape
    db = freshDb();
    tree = seed(db);
    engine = new Engine(db);
    recordRed(db, tree.acceptance);
    const again = [tree.task, task("second")];
    const singly = again.flatMap((id) => {
      const r = engine.apply("task", id, "drop", "chief");
      return r.ok ? r.changes : [];
    });

    expect(bulk.ok && bulk.changes.map((c) => `${c.entity}:${c.verb}:${c.automatic}`)).toEqual(
      singly.map((c) => `${c.entity}:${c.verb}:${c.automatic}`),
    );
    expect(lines).toBe(ledgerLines());
  });

  it("leaves the ancestors to the cascade: nothing above moves until it is owed", () => {
    const second = task("second");
    bulkDrop(db, [tree.task, second], "chief");
    // the acceptance_test has no automatic transition owed by a dropped task, so the
    // cascade stops there rather than settling the criteria behind the guards' back
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("ready");
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("in_progress");
  });

  it("writes nothing for an empty list", () => {
    const before = ledgerLines();
    const r = bulkDrop(db, [], "chief");
    expect(r.ok).toBe(true);
    expect(r.ok && r.changes).toEqual([]);
    expect(ledgerLines()).toBe(before);
  });
});
