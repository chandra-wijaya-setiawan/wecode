import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { board } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** A second task under the same acceptance test, so one tree can hold a dropped task and
 *  an exhausted one at once — which is the case a person triages and the case the two
 *  filters have to keep apart. */
const task = (db: DatabaseSync, testId: number, slug: string, title: string): number => {
  db.prepare(
    `INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    slug,
    testId,
    title,
    JSON.stringify({ write: ["src/**"], tools: ["bash"] }),
    "engineer",
    JSON.stringify({ tokens: 1000, seconds: 60 }),
    "planned",
    "2026-09-13T00:00:00.000Z",
    "2026-09-13T00:00:00.000Z",
  );
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const stop = (db: DatabaseSync, id: number, state: string, attempts: number): void => {
  db.prepare("UPDATE task SET state = ?, attempts = ? WHERE id = ?").run(state, attempts, id);
};

describe("stopped work, by the two ways work stops", () => {
  it("keeps a dropped task out of failed and names it under dropped", () => {
    const db = freshDb();
    const tree = seed(db);
    // Put down after one attempt: abandoning work does not require exhausting it.
    stop(db, tree.task, "dropped", 1);

    const b = board(db);
    expect(b.failed.map((r) => r.id)).toEqual([]);
    expect(b.dropped.map((r) => r.id)).toEqual([tree.task]);
    expect(b.dropped[0]?.what).toBe("send the reset mail");
    expect(b.dropped[0]?.state).toBe("dropped");
    expect(b.dropped[0]?.detail).toBe("dropped by decision");
  });

  it("shows an exhausted task under failed, with its attempts and what to do", () => {
    const db = freshDb();
    const tree = seed(db);
    stop(db, tree.task, "failed", 3);

    const b = board(db);
    expect(b.failed.map((r) => r.id)).toEqual([tree.task]);
    expect(b.failed[0]?.state).toBe("failed");
    expect(b.failed[0]?.detail).toBe(
      "out of attempts · 3 of 3 · retry it with a reason, or drop it",
    );
    expect(b.dropped).toEqual([]);
  });

  it("separates the two when both are under the same test", () => {
    const db = freshDb();
    const tree = seed(db);
    stop(db, tree.task, "dropped", 1);
    const beaten = task(db, tree.acceptance, "retry-mail", "retry the reset mail");
    stop(db, beaten, "failed", 3);

    const b = board(db);
    // The point of the split: a ten-row triage reads one fact per box, not two mixed.
    expect(b.failed.map((r) => r.id)).toEqual([beaten]);
    expect(b.dropped.map((r) => r.id)).toEqual([tree.task]);
  });

  it("still shows a failed task with attempts left, and says how many", () => {
    const db = freshDb();
    const tree = seed(db);
    stop(db, tree.task, "failed", 1);

    // Not exhausted: the next pass will pick it up, and the row says so rather than
    // asking a person for a decision it does not need.
    expect(board(db).failed[0]?.detail).toBe("attempts 1/3");
  });

  it("narrows dropped to the project asked for, like every other filter", () => {
    const db = freshDb();
    const tree = seed(db);
    stop(db, tree.task, "dropped", 1);

    expect(board(db, tree.project).dropped.map((r) => r.id)).toEqual([tree.task]);
    expect(board(db, tree.project + 1).dropped).toEqual([]);
  });
});
