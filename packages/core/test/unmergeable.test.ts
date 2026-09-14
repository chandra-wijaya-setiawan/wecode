import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { board } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** The lander's own table, created the way the runner creates `landed_branch`: beside the
 *  record rather than in it, because whether a branch merges is a fact about a repository
 *  on a machine and not about the work. A fixture that means to have tried to land has to
 *  write it, so the board reads a record and never a guess. */
const landConflict = (db: DatabaseSync, storyId: number, branch: string, reason: string): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS land_conflict (
       story_id INTEGER PRIMARY KEY,
       branch   TEXT NOT NULL,
       reason   TEXT NOT NULL,
       at       TEXT NOT NULL
     )`,
  );
  db.prepare(
    `INSERT INTO land_conflict (story_id, branch, reason, at) VALUES (?, ?, ?, ?)
     ON CONFLICT (story_id) DO UPDATE SET
       branch = excluded.branch, reason = excluded.reason, at = excluded.at`,
  ).run(storyId, branch, reason, "2026-09-14T00:00:00.000Z");
};

/** Delivered, so nothing else on the board is going to mention it again. */
const deliver = (db: DatabaseSync, storyId: number): void => {
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(storyId);
};

describe("the unmergeable filter", () => {
  it("shows a delivered story whose branch the lander could not merge, and why", () => {
    const db = freshDb();
    const tree = seed(db);
    deliver(db, tree.story);
    landConflict(db, tree.story, "story/reset", "conflict in src/mail/send.ts");

    const rows = board(db).unmergeable;
    expect(rows.map((r) => r.id)).toEqual([tree.story]);
    expect(rows[0]?.what).toBe("password reset");
    // The reason is on the row: the point of the box is that you do not have to run land
    // to find out what is wrong.
    expect(rows[0]?.detail).toBe("story/reset · conflict in src/mail/send.ts");
  });

  it("leaves out a delivered story nothing has failed to land", () => {
    const db = freshDb();
    const tree = seed(db);
    deliver(db, tree.story);
    // The table exists — something has tried to land, just not this story.
    landConflict(db, tree.story, "story/reset", "conflict");
    db.prepare("DELETE FROM land_conflict WHERE story_id = ?").run(tree.story);

    expect(board(db).delivered.map((r) => r.id)).toEqual([tree.story]);
    expect(board(db).unmergeable).toEqual([]);
  });

  it("is empty, rather than an error, before anything has ever tried to land", () => {
    const db = freshDb();
    deliver(db, seed(db).story);

    expect(board(db).unmergeable).toEqual([]);
  });

  it("says nothing about a story that is not delivered yet", () => {
    const db = freshDb();
    const tree = seed(db);
    landConflict(db, tree.story, "story/reset", "conflict in src/mail/send.ts");

    // in_progress: the branch is still being written, so a conflict with master is the
    // ordinary state of the world rather than something waiting on a person.
    expect(board(db).unmergeable).toEqual([]);
  });

  it("narrows to the project asked for, like every other filter", () => {
    const db = freshDb();
    const tree = seed(db);
    deliver(db, tree.story);
    landConflict(db, tree.story, "story/reset", "conflict");

    expect(board(db, tree.project).unmergeable.map((r) => r.id)).toEqual([tree.story]);
    expect(board(db, tree.project + 1).unmergeable).toEqual([]);
  });

  it("carries the reason the last attempt recorded, not the first", () => {
    const db = freshDb();
    const tree = seed(db);
    deliver(db, tree.story);
    landConflict(db, tree.story, "story/reset", "conflict in src/mail/send.ts");
    landConflict(db, tree.story, "story/reset", "conflict in config/views.yaml");

    expect(board(db).unmergeable[0]?.detail).toBe("story/reset · conflict in config/views.yaml");
    // One row per story: a history would make the box grow every tick.
    expect(board(db).unmergeable).toHaveLength(1);
  });
});
