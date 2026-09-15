import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyChore,
  closeChore,
  delivered,
  deliveredRows,
  ensureChore,
  recordChoreRefusal,
} from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** A delivered story behind the base said only that a refresh chore was open. The chore
 *  knew why — `no merge is left standing: the tree is as it was` — and a person reading the
 *  delivered list had to go and find the chore to learn it. Worse, a refresh chore that
 *  failed out of its attempts is never handed out again and nothing will ever come back to
 *  rewrite its reason: that sentence is the last word on the story, and it was the one
 *  sentence the story did not carry. */

const T = "2026-09-13T00:00:00.000Z";

const ABORTED = "no merge is left standing: the tree is as it was";
const MID_MERGE = "the merge would not abort: story/drifted is left mid-merge and wants a person";

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

const spec = (project: number, kind: string, target: number) =>
  ({
    project_id: project,
    kind,
    target_type: "story",
    target_id: target,
    check: kind === "refresh" ? "the branch is on top of the base" : "the branch merges cleanly",
  }) as const;

/** A chore the runner attempted and failed, with the sentence it read written after the
 *  verb — `applyChore` clears the row on every successful verb, so a reason meant to outlive
 *  a state change has to be written once the chore is already in it. */
const failedWith = (db: DatabaseSync, project: number, kind: string, target: number, why: string): number => {
  const id = ensureChore(db, spec(project, kind, target)).id;
  for (const verb of ["start", "begin", "fail"]) expect(applyChore(db, id, verb, "system-1").ok).toBe(true);
  expect(stateOf(db, "chore", id)).toBe("failed");
  recordChoreRefusal(db, why, id);
  return id;
};

const land = (db: DatabaseSync, branch: string, sha: string): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  db.prepare("INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?,?,?,?)").run(1, branch, sha, T);
};

const storyOf = (db: DatabaseSync, id: number) => delivered(db).find((s) => s.id === id);
const detailOf = (db: DatabaseSync, id: number): string =>
  deliveredRows(db).find((r) => r.id === id)?.detail ?? "";

describe("what a delivered story says about the chore that blocks it", () => {
  it("carries a failed refresh chore's reason, beside the reach it explains", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "drifted");
    failedWith(db, s.project, "refresh", id, ABORTED);

    expect(storyOf(db, id)).toMatchObject({ reach: "behind", owed: "refresh", why: ABORTED });
    expect(detailOf(db, id)).toBe(`behind the base · refresh chore open · ${ABORTED} · 0 criteria`);
  });

  it("carries the sentence that says a person is wanted, which is the whole point of it", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "drifted");
    failedWith(db, s.project, "refresh", id, MID_MERGE);

    expect(detailOf(db, id)).toContain(MID_MERGE);
  });

  it("says only that the chore is open when nothing has been said about why", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "quiet");
    ensureChore(db, spec(s.project, "refresh", id));

    expect(storyOf(db, id)).toMatchObject({ reach: "behind", why: null });
    // No dangling separator where a reason would have gone.
    expect(detailOf(db, id)).toBe("behind the base · refresh chore open · 0 criteria");
  });

  it("carries a reason from the kind it names, for a chore that is not a refresh", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "stuck");
    failedWith(db, s.project, "merge", id, "out of attempts · 3 of 3");

    expect(storyOf(db, id)).toMatchObject({ reach: "waiting", owed: "merge", why: "out of attempts · 3 of 3" });
    expect(detailOf(db, id)).toContain("waits on a merge chore · out of attempts · 3 of 3");
  });

  it("carries the refresh chore's reason, not the other open chore's, when both have one", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "both");
    failedWith(db, s.project, "merge", id, "the branch conflicts");
    failedWith(db, s.project, "refresh", id, ABORTED);

    // The reach is the refresh chore's, so the reason has to be too — a reach explained by
    // a different chore's sentence is worse than no sentence.
    expect(storyOf(db, id)).toMatchObject({ reach: "behind", owed: "refresh", why: ABORTED });
  });

  it("says nothing about a chore's reason once the story is on the base", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "landed-anyway");
    failedWith(db, s.project, "refresh", id, ABORTED);
    land(db, "story/landed-anyway", "def5678");

    expect(storyOf(db, id)).toMatchObject({ reach: "landed", owed: null, why: null });
    expect(detailOf(db, id)).not.toContain(ABORTED);
  });

  it("does not carry a closed chore's epitaph, because nothing is blocked any more", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "settled");
    const chore = ensureChore(db, spec(s.project, "refresh", id)).id;
    expect(closeChore(db, chore, "story/settled no longer conflicts with master").ok).toBe(true);

    // The row is still there — a closure keeps its reason — but it explains an ending, and
    // the story is not behind anything.
    expect(storyOf(db, id)).toMatchObject({ reach: "unlanded", owed: null, why: null });
    expect(detailOf(db, id)).toBe("unlanded · 0 criteria");
  });

  it("reads a reason against the story its chore targets and no other", () => {
    const db = freshDb();
    const s = seed(db);
    const blocked = story(db, s.epic, "blocked");
    const clear = story(db, s.epic, "clear");
    failedWith(db, s.project, "refresh", blocked, ABORTED);

    expect(storyOf(db, blocked)?.why).toBe(ABORTED);
    expect(storyOf(db, clear)).toMatchObject({ reach: "unlanded", why: null });
  });

  it("reads the reach in a workspace too old to have a chore_refusal table", () => {
    const db = freshDb();
    const s = seed(db);
    const id = story(db, s.epic, "ancient");
    ensureChore(db, spec(s.project, "refresh", id));
    db.exec("DROP TABLE chore_refusal");

    expect(storyOf(db, id)).toMatchObject({ reach: "behind", owed: "refresh", why: null });
  });
});
