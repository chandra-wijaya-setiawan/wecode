import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { children } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
});

describe("children", () => {
  it("returns each child with its id and state", () => {
    expect(children(db, "epic", tree.epic)).toEqual([{ id: tree.story, state: "in_progress" }]);
    expect(children(db, "task", tree.task)).toEqual([{ id: tree.taskTest, state: "ready" }]);
  });

  it("returns every child, not just the first", () => {
    db.prepare(
      `INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run("lockout", tree.epic, "lockout", "planned", "2026-09-13T00:00:00.000Z", "2026-09-13T00:00:00.000Z");
    // the query promises every row, not an order — so assert as a set
    const rows = children(db, "epic", tree.epic);
    expect(rows).toHaveLength(2);
    expect([...rows].map((r) => r.state).sort()).toEqual(["in_progress", "planned"]);
  });

  it("is empty for an entity that bears no children", () => {
    expect(children(db, "task_test", tree.taskTest)).toEqual([]);
    expect(children(db, "assignment", 1)).toEqual([]);
  });

  it("is empty when the entity has no children yet", () => {
    expect(children(db, "acceptance_test", tree.acceptance)).not.toHaveLength(0);
    db.prepare("DELETE FROM task_test WHERE parent_id = ?").run(tree.task);
    db.prepare("DELETE FROM task WHERE id = ?").run(tree.task);
    expect(children(db, "acceptance_test", tree.acceptance)).toEqual([]);
  });

  it("reads the live state rather than a snapshot", () => {
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(tree.story);
    expect(children(db, "epic", tree.epic)).toEqual([{ id: tree.story, state: "delivered" }]);
  });
});
