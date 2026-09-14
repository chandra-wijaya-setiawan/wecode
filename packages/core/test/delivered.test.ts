import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { delivered, deliveredRows } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

const ins = (db: DatabaseSync, sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const T = "2026-09-13T00:00:00.000Z";

/** A second story under the same epic, with its own requirement, so criteria can hang off
 *  it without touching the seed's. */
const story = (db: DatabaseSync, epic: number, slug: string, state: string, at: string) => {
  const id = ins(
    db,
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, epic, slug, state, T, at,
  );
  const requirement = ins(
    db,
    "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    `${slug}-req`, id, `${slug} works`, "in_progress", T, at,
  );
  return { id, requirement };
};

const criteria = (db: DatabaseSync, requirement: number, slug: string, statement: string, state: string): number =>
  ins(
    db,
    "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, requirement, statement, state, T, T,
  );

/** The runner's table, created the way the runner creates it: beside the record, on the
 *  first landing. A query that reads it must not assume it exists. */
const landedBranch = (db: DatabaseSync): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
};

const land = (db: DatabaseSync, taskId: number, branch: string, sha: string): void => {
  landedBranch(db);
  db.prepare("INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?,?,?,?)").run(
    taskId, branch, sha, T,
  );
};

describe("delivered", () => {
  it("lists a delivered story with the statements of its accepted criteria", () => {
    const db = freshDb();
    const s = seed(db);
    const done = story(db, s.epic, "reset-link", "delivered", "2026-09-14T00:00:00.000Z");
    criteria(db, done.requirement, "emailed", "a link is emailed within 60s", "accepted");
    criteria(db, done.requirement, "expires", "the link expires after one use", "accepted");

    const out = delivered(db);
    const row = out.find((r) => r.id === done.id);
    expect(row).toBeDefined();
    expect(row?.criteria.map((c) => c.statement)).toEqual([
      "a link is emailed within 60s",
      "the link expires after one use",
    ]);
  });

  it("leaves out criteria that were dropped rather than accepted", () => {
    const db = freshDb();
    const s = seed(db);
    const done = story(db, s.epic, "reset-link", "delivered", "2026-09-14T00:00:00.000Z");
    criteria(db, done.requirement, "emailed", "a link is emailed within 60s", "accepted");
    criteria(db, done.requirement, "sms", "a code is sent by SMS", "dropped");

    const row = delivered(db).find((r) => r.id === done.id);
    expect(row?.criteria.map((c) => c.statement)).toEqual(["a link is emailed within 60s"]);
  });

  it("reads landing from landed_branch, and says unlanded when the branch is not there", () => {
    const db = freshDb();
    const s = seed(db);
    const on = story(db, s.epic, "on-base", "delivered", "2026-09-14T00:00:00.000Z");
    const off = story(db, s.epic, "not-yet", "delivered", "2026-09-13T00:00:00.000Z");
    land(db, 1, "story/on-base", "abc1234");

    const out = delivered(db);
    expect(out.find((r) => r.id === on.id)).toMatchObject({ landed: true, sha: "abc1234" });
    expect(out.find((r) => r.id === off.id)).toMatchObject({ landed: false, sha: null });
    expect(deliveredRows(db).find((r) => r.id === off.id)?.detail).toContain("unlanded");
  });

  it("reads unlanded in a workspace where the runner has never landed anything", () => {
    const db = freshDb();
    const s = seed(db);
    const done = story(db, s.epic, "reset-link", "delivered", "2026-09-14T00:00:00.000Z");

    expect(delivered(db).find((r) => r.id === done.id)?.landed).toBe(false);
  });

  it("does not list a story that is still in progress", () => {
    const db = freshDb();
    const s = seed(db);
    const open = story(db, s.epic, "in-flight", "in_progress", "2026-09-14T00:00:00.000Z");
    criteria(db, open.requirement, "half", "half of it works", "accepted");

    const ids = delivered(db).map((r) => r.id);
    expect(ids).not.toContain(open.id);
    // the seed's own story is in_progress too, and is the reason this is not vacuous
    expect(ids).not.toContain(s.story);
  });

  it("puts the newest delivery first", () => {
    const db = freshDb();
    const s = seed(db);
    const older = story(db, s.epic, "older", "delivered", "2026-09-10T00:00:00.000Z");
    const newer = story(db, s.epic, "newer", "delivered", "2026-09-14T00:00:00.000Z");

    expect(delivered(db).map((r) => r.id)).toEqual([newer.id, older.id]);
  });
});
