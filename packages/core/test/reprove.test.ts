import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/index.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

/** Put a test in `failed` the way the runner would: it ran, and the exit code was not zero. */
const failIt = (db: DatabaseSync, entity: "acceptance_test" | "task_test", id: number) => {
  const out = new Engine(db).apply(entity, id, "fail", "runner");
  if (!out.ok) throw new Error(`could not fail ${entity} #${id}: ${out.why}`);
};

const verdictOf = (db: DatabaseSync, entity: string, id: number) =>
  db.prepare(`SELECT state FROM ${entity} WHERE id = ?`).get(id) as { state: string };

describe("a failed test may be re-proved", () => {
  it("moves an acceptance_test from failed back to ready", () => {
    const db = freshDb();
    const t = seed(db);
    failIt(db, "acceptance_test", t.acceptance);

    const out = new Engine(db).apply("acceptance_test", t.acceptance, "reprove", "operator");

    expect(out.ok).toBe(true);
    expect(stateOf(db, "acceptance_test", t.acceptance)).toBe("ready");
  });

  it("moves a task_test from failed back to ready too", () => {
    const db = freshDb();
    const t = seed(db);
    failIt(db, "task_test", t.taskTest);

    const out = new Engine(db).apply("task_test", t.taskTest, "reprove", "operator");

    expect(out.ok).toBe(true);
    expect(stateOf(db, "task_test", t.taskTest)).toBe("ready");
  });

  it("clears the recorded verdict: nothing is proved of the test afterwards", () => {
    const db = freshDb();
    const t = seed(db);
    failIt(db, "acceptance_test", t.acceptance);
    expect(verdictOf(db, "acceptance_test", t.acceptance)).toEqual({ state: "failed" });

    new Engine(db).apply("acceptance_test", t.acceptance, "reprove", "operator");

    // `failed` was the verdict. `ready` is the absence of one — which is what the runner
    // reads to decide the test is owed a run rather than standing on an old one.
    expect(verdictOf(db, "acceptance_test", t.acceptance)).toEqual({ state: "ready" });
  });

  it("asserts no outcome: it is not a way to reach passed", () => {
    const db = freshDb();
    const t = seed(db);
    failIt(db, "acceptance_test", t.acceptance);

    const out = new Engine(db).apply("acceptance_test", t.acceptance, "reprove", "operator");

    if (!out.ok) throw new Error(out.why);
    expect(out.changes.map((c) => c.to)).not.toContain("passed");
    expect(stateOf(db, "acceptance_criteria", t.criteria)).toBe("in_progress");
  });

  it("is refused from passed — a settled pass is invalidated, not re-proved", () => {
    const db = freshDb();
    const t = seed(db);
    recordRed(db, t.acceptance);
    new Engine(db).apply("acceptance_test", t.acceptance, "pass", "runner");
    expect(stateOf(db, "acceptance_test", t.acceptance)).toBe("passed");

    const out = new Engine(db).apply("acceptance_test", t.acceptance, "reprove", "operator");

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected the reprove to be refused");
    expect(out.why).toContain("reprove is not legal from passed");
    expect(stateOf(db, "acceptance_test", t.acceptance)).toBe("passed");
  });

  it("is refused from planned — an undelivered test has no verdict to clear", () => {
    const db = freshDb();
    const t = seed(db);
    db.prepare("UPDATE acceptance_test SET state = 'planned' WHERE id = ?").run(t.acceptance);

    const out = new Engine(db).apply("acceptance_test", t.acceptance, "reprove", "operator");

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected the reprove to be refused");
    expect(out.why).toContain("reprove is not legal from planned");
    expect(stateOf(db, "acceptance_test", t.acceptance)).toBe("planned");
  });

  it("refuses a test with no artefact: back in ready it would be unrunnable", () => {
    const db = freshDb();
    const t = seed(db);
    failIt(db, "acceptance_test", t.acceptance);
    db.prepare("UPDATE acceptance_test SET artefact = NULL WHERE id = ?").run(t.acceptance);

    const out = new Engine(db).apply("acceptance_test", t.acceptance, "reprove", "operator");

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected the reprove to be refused");
    expect(out.why).toContain("nothing to run again");
  });

  it("refuses through may() as well, so nothing has to be attempted to find out", () => {
    const db = freshDb();
    const t = seed(db);
    const engine = new Engine(db);

    expect(engine.may("acceptance_test", t.acceptance, "reprove").ok).toBe(false);

    failIt(db, "acceptance_test", t.acceptance);
    expect(engine.may("acceptance_test", t.acceptance, "reprove").ok).toBe(true);
  });
});

describe("a re-proved test still has to earn its pass", () => {
  it("still needs its red-at-base evidence before it may pass", () => {
    const db = freshDb();
    const t = seed(db);
    failIt(db, "acceptance_test", t.acceptance);
    const engine = new Engine(db);

    expect(engine.apply("acceptance_test", t.acceptance, "reprove", "operator").ok).toBe(true);

    const out = engine.apply("acceptance_test", t.acceptance, "pass", "runner");

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected the pass to be refused");
    expect(out.why).toContain("has never been seen to fail");
    expect(stateOf(db, "acceptance_test", t.acceptance)).toBe("ready");
  });

  it("reaches passed once the red run at base is recorded, and cascades as any pass does", () => {
    const db = freshDb();
    const t = seed(db);
    failIt(db, "acceptance_test", t.acceptance);
    const engine = new Engine(db);
    engine.apply("acceptance_test", t.acceptance, "reprove", "operator");

    recordRed(db, t.acceptance, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    const out = engine.apply("acceptance_test", t.acceptance, "pass", "runner");

    expect(out.ok).toBe(true);
    expect(stateOf(db, "acceptance_test", t.acceptance)).toBe("passed");
    // The story the dead end was blocking: it delivers.
    expect(stateOf(db, "story", t.story)).toBe("delivered");
  });

  it("leaves reprove itself unable to pass anything — the only edge to passed is pass", () => {
    const db = freshDb();
    const t = seed(db);
    failIt(db, "acceptance_test", t.acceptance);
    recordRed(db, t.acceptance);

    const out = new Engine(db).apply("acceptance_test", t.acceptance, "reprove", "operator");

    if (!out.ok) throw new Error(out.why);
    expect(stateOf(db, "acceptance_test", t.acceptance)).toBe("ready");
  });
});
