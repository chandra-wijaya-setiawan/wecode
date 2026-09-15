import { describe, expect, it } from "vitest";
import {
  applyChore,
  board,
  choresPerformed,
  choreSettled,
  closeChore,
  ensureChore,
  settledChores,
} from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

const mergeSpec = (project: number, story: number) =>
  ({
    project_id: project,
    kind: "merge",
    target_type: "story",
    target_id: story,
    check: "the branch merges cleanly",
  }) as const;

const refreshSpec = (project: number, story: number) =>
  ({
    project_id: project,
    kind: "refresh",
    target_type: "story",
    target_id: story,
    check: "the branch is on top of the base",
  }) as const;

/** A chore a system worker took all the way through: started, begun, finished. */
const perform = (db: ReturnType<typeof freshDb>, id: number): void => {
  expect(applyChore(db, id, "start", "runner").ok).toBe(true);
  expect(applyChore(db, id, "begin", "worker-1").ok).toBe(true);
  expect(applyChore(db, id, "finish", "worker-1").ok).toBe(true);
};

const CLOSURE = "story/the-cockpit-says-whether-the-machinery-is-alive no longer conflicts with master";

describe("a chore closed because its condition disappeared", () => {
  it("is distinguishable from one a worker proved, though both are done", () => {
    const db = freshDb();
    const { project, story } = seed(db);

    const proved = ensureChore(db, mergeSpec(project, story));
    perform(db, proved.id);

    const gone = ensureChore(db, refreshSpec(project, story));
    expect(closeChore(db, gone.id, CLOSURE).ok).toBe(true);

    // The column says the same thing about both — that is the complaint.
    expect(db.prepare("SELECT state FROM chore WHERE id = ?").get(proved.id)).toEqual({ state: "done" });
    expect(db.prepare("SELECT state FROM chore WHERE id = ?").get(gone.id)).toEqual({ state: "done" });

    // The record does not.
    expect(choreSettled(db, proved.id)).toMatchObject({ settlement: "performed" });
    expect(choreSettled(db, gone.id)).toMatchObject({ settlement: "closed" });
  });

  it("carries its reason, and so does the one a worker proved", () => {
    const db = freshDb();
    const { project, story } = seed(db);

    const proved = ensureChore(db, mergeSpec(project, story));
    perform(db, proved.id);
    const gone = ensureChore(db, refreshSpec(project, story));
    closeChore(db, gone.id, CLOSURE);

    // What a worker proved: the check.
    expect(choreSettled(db, proved.id)?.why).toBe("the branch merges cleanly");
    // Why the world let this one go: the epitaph the runner read it by.
    expect(choreSettled(db, gone.id)?.why).toBe(CLOSURE);
  });

  it("is nothing until it is settled, and reads by the verb that settled it last", () => {
    const db = freshDb();
    const { project, story } = seed(db);

    const chore = ensureChore(db, mergeSpec(project, story));
    expect(choreSettled(db, chore.id)).toBeNull();

    // Closed once because the world moved...
    closeChore(db, chore.id, CLOSURE);
    expect(choreSettled(db, chore.id)?.settlement).toBe("closed");

    // ...then the condition came back and a worker proved it. The chore stands on the
    // last thing that settled it, not the first.
    ensureChore(db, mergeSpec(project, story));
    perform(db, chore.id);
    expect(choreSettled(db, chore.id)).toMatchObject({
      settlement: "performed",
      why: "the branch merges cleanly",
    });
  });

  it("shows on the board as a closure, beside the one shown as done", () => {
    const db = freshDb();
    const { project, story } = seed(db);

    const proved = ensureChore(db, mergeSpec(project, story));
    perform(db, proved.id);
    const gone = ensureChore(db, refreshSpec(project, story));
    closeChore(db, gone.id, CLOSURE);

    const settled = settledChores(db);
    expect(settled).toEqual([
      { id: proved.id, what: "merge story password reset", state: "done", detail: "the branch merges cleanly" },
      { id: gone.id, what: "refresh story password reset", state: "closed", detail: CLOSURE },
    ]);

    // The row is history and stays raised — closing does not remove it.
    expect(db.prepare("SELECT count(*) AS n FROM chore").get()).toEqual({ n: 2 });
    // And it is not still on the list of work owed.
    expect(board(db).chores).toEqual([]);
  });

  it("is not counted as work performed", () => {
    const db = freshDb();
    const { project, story } = seed(db);

    const proved = ensureChore(db, mergeSpec(project, story));
    perform(db, proved.id);
    const gone = ensureChore(db, refreshSpec(project, story));
    closeChore(db, gone.id, CLOSURE);

    const b = board(db);
    expect(b.settled).toHaveLength(2);
    expect(b.chores_performed).toBe(1);
    expect(choresPerformed(b.settled)).toBe(1);
  });

  it("counts nothing performed when every chore ended because the world moved", () => {
    const db = freshDb();
    const { project, story } = seed(db);

    const gone = ensureChore(db, mergeSpec(project, story));
    closeChore(db, gone.id, CLOSURE);

    const b = board(db);
    expect(b.chores_performed).toBe(0);
    expect(b.settled.map((r) => r.state)).toEqual(["closed"]);
  });
});
