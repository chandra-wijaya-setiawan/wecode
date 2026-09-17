import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  answerApproval,
  ApprovalError,
  approvalById,
  evidenceFor,
  openAssignments,
  raiseApproval,
  waitingApprovals,
  Maker,
} from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** One person to ask. The agent's half of the cast lives in approval-assignment.test.ts;
 *  this file is about what the question is about, not who may answer it. */
const dana = (db: DatabaseSync) => {
  const make = new Maker(db);
  make.role("operator", { write: [], tools: [] }, "human");
  return make.worker("dana", "operator", "human");
};

const ask = (
  db: DatabaseSync,
  worker: number,
  objective: { objective_type: "task" | "acceptance_test" | "task_test"; objective_id: number },
) => raiseApproval(db, { ...objective, worker_id: worker, question: "ship the reset mail to production?" });

describe("an approval carries the objective it is about", () => {
  it("says what the task is, in the task's own words", () => {
    const db = freshDb();
    const { task } = seed(db);

    const approval = ask(db, dana(db), { objective_type: "task", objective_id: task });

    expect(approval.evidence).toEqual({
      type: "task",
      id: task,
      statement: "send the reset mail",
      state: "planned",
    });
  });

  it("reads a test's statement, where the schema keeps the words in another column", () => {
    const db = freshDb();
    const { acceptance, taskTest } = seed(db);
    const person = dana(db);

    expect(ask(db, person, { objective_type: "acceptance_test", objective_id: acceptance }).evidence).toEqual({
      type: "acceptance_test",
      id: acceptance,
      statement: "the mail arrives with a link",
      state: "ready",
    });
    expect(ask(db, person, { objective_type: "task_test", objective_id: taskTest }).evidence).toEqual({
      type: "task_test",
      id: taskTest,
      statement: "the mailer is called with the token",
      state: "ready",
    });
  });

  it("shows the state the work is in now, not the state it was raised against", () => {
    const db = freshDb();
    const { task } = seed(db);
    const id = ask(db, dana(db), { objective_type: "task", objective_id: task }).id;

    db.prepare("UPDATE task SET state = 'in_progress' WHERE id = ?").run(task);

    expect(approvalById(db, id)?.evidence?.state).toBe("in_progress");
  });

  it("carries it on every way of reading one, not only on the one that raised it", () => {
    const db = freshDb();
    const { task } = seed(db);
    const person = dana(db);
    const id = ask(db, person, { objective_type: "task", objective_id: task }).id;

    expect(waitingApprovals(db).map((a) => a.evidence?.statement)).toEqual(["send the reset mail"]);
    expect(answerApproval(db, id, "yes", "dana").evidence?.statement).toBe("send the reset mail");
  });

  it("reads as no evidence, rather than throwing, when the objective is gone", () => {
    const db = freshDb();
    const { taskTest } = seed(db);
    const id = ask(db, dana(db), { objective_type: "task_test", objective_id: taskTest }).id;

    db.prepare("DELETE FROM task_test WHERE id = ?").run(taskTest);

    expect(approvalById(db, id)?.evidence).toBeNull();
  });

  it("has no evidence for a kind of objective that is not one of the three", () => {
    expect(evidenceFor(freshDb(), "chore", 1)).toBeNull();
  });
});

describe("an approval with nothing behind it is refused", () => {
  it("refuses an objective that does not exist, and writes no row for it", () => {
    const db = freshDb();
    const person = dana(db);

    expect(() => ask(db, person, { objective_type: "task", objective_id: 9999 })).toThrow(
      /no task #9999 to ask about/,
    );
    expect(waitingApprovals(db)).toEqual([]);
    expect(openAssignments(db)).toBe(0);
  });

  it("refuses it before it refuses the worker: the question is checked against the work first", () => {
    const db = freshDb();

    expect(() => ask(db, 404, { objective_type: "task", objective_id: 9999 })).toThrow(/no task #9999/);
  });

  it("refuses a question that asks nothing, however good the evidence is", () => {
    const db = freshDb();
    const { task } = seed(db);
    const person = dana(db);

    for (const question of ["", "   ", "\n\t"]) {
      expect(() =>
        raiseApproval(db, { objective_type: "task", objective_id: task, worker_id: person, question }),
      ).toThrow(ApprovalError);
    }
    expect(waitingApprovals(db)).toEqual([]);
    expect(openAssignments(db)).toBe(0);
  });

  it("refuses an answer of nothing to a question that was asked properly", () => {
    const db = freshDb();
    const { task } = seed(db);
    const id = ask(db, dana(db), { objective_type: "task", objective_id: task }).id;

    expect(() => answerApproval(db, id, "  ", "dana")).toThrow(ApprovalError);
    expect(approvalById(db, id)?.phase).toBe("waiting");
  });
});
