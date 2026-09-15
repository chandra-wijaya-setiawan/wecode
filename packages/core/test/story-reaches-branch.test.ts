import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { delivered, deliveredRows } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** "Delivered" says the record is satisfied; it says nothing about where the code is. These
 *  cover the three ways a delivered story's work can fail to be on the base — nothing
 *  landed it, the base moved past it, a chore owes it work — and that a landing outranks
 *  all of them. */

const T = "2026-09-13T00:00:00.000Z";

const ins = (db: DatabaseSync, sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

const story = (db: DatabaseSync, epic: number, slug: string): number =>
  ins(
    db,
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug, epic, slug, "delivered", T, "2026-09-14T00:00:00.000Z",
  );

/** A chore against a story, in the state given. Written straight into the table, because
 *  the subject is what a reader of the record sees, not how the chore got there. */
const chore = (db: DatabaseSync, project: number, kind: string, target: number, state: string): number =>
  ins(
    db,
    `INSERT INTO chore (slug,kind,project_id,target_type,target_id,"check",state,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    `${kind}-${target}`, kind, project, "story", target, "git merge --no-ff", state, T, T,
  );

const land = (db: DatabaseSync, branch: string, sha: string): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  db.prepare("INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?,?,?,?)").run(
    1, branch, sha, T,
  );
};

const reachOf = (db: DatabaseSync, id: number) => delivered(db).find((s) => s.id === id);
const detailOf = (db: DatabaseSync, id: number): string =>
  deliveredRows(db).find((r) => r.id === id)?.detail ?? "";

describe("what a delivered story says about its branch", () => {
  it("says landed when landed_branch holds the branch", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "on-base");
    land(db, "story/on-base", "abc1234");

    expect(reachOf(db, id)).toMatchObject({ reach: "landed", owed: null, sha: "abc1234" });
    expect(detailOf(db, id)).toContain("landed story/on-base");
  });

  it("says unlanded when nothing landed it and no chore owes it anything", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "not-yet");

    expect(reachOf(db, id)).toMatchObject({ reach: "unlanded", owed: null, landed: false });
    expect(detailOf(db, id)).toContain("unlanded");
  });

  it("says behind the base when an open refresh chore targets it", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "drifted");
    chore(db, s.project, "refresh", id, "ready");

    expect(reachOf(db, id)).toMatchObject({ reach: "behind", owed: "refresh" });
    expect(detailOf(db, id)).toContain("behind the base");
  });

  it("says it waits on a chore, and names the kind, for a chore that is not a refresh", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "stuck");
    chore(db, s.project, "merge", id, "running");

    expect(reachOf(db, id)).toMatchObject({ reach: "waiting", owed: "merge" });
    expect(detailOf(db, id)).toContain("waits on a merge chore");
  });

  it("still counts a failed chore as owed, because a failed chore is re-raised", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "fought");
    chore(db, s.project, "merge", id, "failed");

    expect(reachOf(db, id)?.reach).toBe("waiting");
  });

  it("ignores a chore that is done, because nothing is owed from there", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "settled");
    chore(db, s.project, "refresh", id, "done");

    expect(reachOf(db, id)).toMatchObject({ reach: "unlanded", owed: null });
  });

  it("prefers behind the base over a plain wait when both chores are open", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "both");
    chore(db, s.project, "merge", id, "ready");
    chore(db, s.project, "refresh", id, "ready");

    expect(reachOf(db, id)).toMatchObject({ reach: "behind", owed: "refresh" });
  });

  it("says landed even with a chore still open, because the base branch settles it", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "landed-anyway");
    chore(db, s.project, "refresh", id, "ready");
    land(db, "story/landed-anyway", "def5678");

    expect(reachOf(db, id)).toMatchObject({ reach: "landed", owed: null });
  });

  it("reads a chore against one story only against that story", () => {
    const db = freshDb();
    const s = seed(db);
    const waiting = story(db, s.epic, "waiting");
    const clear = story(db, s.epic, "clear");
    chore(db, s.project, "merge", waiting, "ready");

    expect(reachOf(db, waiting)?.reach).toBe("waiting");
    expect(reachOf(db, clear)?.reach).toBe("unlanded");
  });

  it("reads every reach in a workspace where the runner has never landed anything", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "no-table");
    chore(db, s.project, "refresh", id, "ready");

    // No landed_branch table at all: the chore is still read, and nothing throws.
    expect(reachOf(db, id)).toMatchObject({ reach: "behind", landed: false, sha: null });
  });
});
