import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { answerApproval, ApprovalError, board, evidenceFor, Maker, raiseApproval, waitingApprovals } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** A decision is most often about a story — "do we ship this at all" is not a question about
 *  whichever task happened to surface it. Before this, `ask` could only hang a question on a
 *  task, an acceptance_test or a task_test, so a story-wide decision was either asked against
 *  words nobody chose for it or left out of the board altogether. */

const dana = (db: DatabaseSync) => {
  const make = new Maker(db);
  make.role("operator", { write: [], tools: [] }, "human");
  return make.worker("dana", "operator", "human");
};

const askAboutStory = (db: DatabaseSync, worker: number, story: number, question = "ship password reset in v1?") =>
  raiseApproval(db, { objective_type: "story", objective_id: story, worker_id: worker, question });

describe("a story is an objective an approval can hang on", () => {
  it("is evidenced by the story's own title and state", () => {
    const db = freshDb();
    const { story } = seed(db);

    expect(evidenceFor(db, "story", story)).toEqual({
      type: "story",
      id: story,
      statement: "password reset",
      state: "in_progress",
    });
  });

  it("carries that evidence onto the approval it raises", () => {
    const db = freshDb();
    const { story } = seed(db);

    const approval = askAboutStory(db, dana(db), story);

    expect(approval.objective_type).toBe("story");
    expect(approval.objective_id).toBe(story);
    expect(approval.evidence).toEqual({ type: "story", id: story, statement: "password reset", state: "in_progress" });
    expect(waitingApprovals(db).map((a) => a.id)).toEqual([approval.id]);
  });

  it("refuses a story that is not there, rather than raising a question about nothing", () => {
    const db = freshDb();
    seed(db);

    const person = dana(db);
    expect(() => askAboutStory(db, person, 9999)).toThrow(ApprovalError);
    expect(() => askAboutStory(db, person, 9999)).toThrow(/no story #9999/);
  });

  it("reaches the board's needs_human, which is the whole point of asking", () => {
    const db = freshDb();
    const { project, story } = seed(db);

    const approval = askAboutStory(db, dana(db), story);

    const rows = board(db, project).needs_human;
    expect(rows.map((r) => r.id)).toEqual([approval.id]);
    expect(rows[0]?.what).toBe(`story #${story}`);
  });

  it("is placed under its project, so a narrowed board does not drop it", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    askAboutStory(db, dana(db), story);

    expect(board(db, project + 1).needs_human).toEqual([]);
    expect(board(db, project).needs_human).toHaveLength(1);
  });

  it("is answered like any other approval, and leaves the board when it is", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const approval = askAboutStory(db, dana(db), story);

    const answered = answerApproval(db, approval.id, "ship it", "dana");

    expect(answered.answer).toBe("ship it");
    expect(answered.answered_by).toBe("dana");
    expect(board(db, project).needs_human).toEqual([]);
  });
});
