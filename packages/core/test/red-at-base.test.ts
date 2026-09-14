import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { board, Engine } from "../src/index.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

const redOf = (db: DatabaseSync, id: number) =>
  db.prepare("SELECT red_at_base_sha, red_at_base_at FROM acceptance_test WHERE id = ?").get(id) as {
    red_at_base_sha: string | null;
    red_at_base_at: string | null;
  };

describe("a test nobody has seen fail cannot pass", () => {
  it("starts with no recorded red run", () => {
    const db = freshDb();
    const t = seed(db);
    expect(redOf(db, t.acceptance)).toEqual({ red_at_base_sha: null, red_at_base_at: null });
  });

  it("refuses pass while red_at_base_sha is null, and leaves the test ready", () => {
    const db = freshDb();
    const t = seed(db);

    const out = new Engine(db).apply("acceptance_test", t.acceptance, "pass", "runner");

    expect(out.ok).toBe(false);
    expect(stateOf(db, "acceptance_test", t.acceptance)).toBe("ready");
  });

  it("names the test in the refusal, so the reader knows which one to go and break", () => {
    const db = freshDb();
    const t = seed(db);

    const out = new Engine(db).apply("acceptance_test", t.acceptance, "pass", "runner");

    if (out.ok) throw new Error("expected the pass to be refused");
    expect(out.why).toContain("mail-arrives");
    expect(out.why).toContain(`#${t.acceptance}`);
    expect(out.why).toContain("the mail arrives with a link");
  });

  it("allows pass once a red run at a base is recorded", () => {
    const db = freshDb();
    const t = seed(db);
    recordRed(db, t.acceptance, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

    const out = new Engine(db).apply("acceptance_test", t.acceptance, "pass", "runner");

    expect(out.ok).toBe(true);
    expect(stateOf(db, "acceptance_test", t.acceptance)).toBe("passed");
  });

  it("refuses through may() as well, so nothing has to be attempted to find out", () => {
    const db = freshDb();
    const t = seed(db);
    const engine = new Engine(db);

    expect(engine.may("acceptance_test", t.acceptance, "pass").ok).toBe(false);

    recordRed(db, t.acceptance, "c0ffee");
    expect(engine.may("acceptance_test", t.acceptance, "pass").ok).toBe(true);
  });

  it("guards nothing but pass: fail and drop still work unrecorded", () => {
    const db = freshDb();
    const t = seed(db);
    const engine = new Engine(db);

    expect(engine.apply("acceptance_test", t.acceptance, "fail", "runner").ok).toBe(true);
    expect(engine.apply("acceptance_test", t.acceptance, "drop", "chief").ok).toBe(true);
  });

  it("keeps the record when the test is invalidated, because the red run still happened", () => {
    const db = freshDb();
    const t = seed(db);
    recordRed(db, t.acceptance, "abc123");
    const engine = new Engine(db);
    engine.apply("acceptance_test", t.acceptance, "pass", "runner");

    expect(engine.apply("acceptance_test", t.acceptance, "invalidate", "chief").ok).toBe(true);
    expect(redOf(db, t.acceptance).red_at_base_sha).toBe("abc123");
    expect(engine.apply("acceptance_test", t.acceptance, "pass", "runner").ok).toBe(true);
  });
});

describe("the unproven group", () => {
  it("lists a ready test with no red run, and drops it once one is recorded", () => {
    const db = freshDb();
    const t = seed(db);

    expect(board(db).unproven.map((r) => r.id)).toEqual([t.acceptance]);

    recordRed(db, t.acceptance, "abc123");
    expect(board(db).unproven).toEqual([]);
  });

  it("ignores a test that is not ready", () => {
    const db = freshDb();
    const t = seed(db);
    new Engine(db).apply("acceptance_test", t.acceptance, "fail", "runner");

    expect(board(db).unproven).toEqual([]);
  });

  it("narrows to the project asked for", () => {
    const db = freshDb();
    const t = seed(db);

    expect(board(db, t.project).unproven.map((r) => r.id)).toEqual([t.acceptance]);
    expect(board(db, t.project + 999).unproven).toEqual([]);
  });
});
