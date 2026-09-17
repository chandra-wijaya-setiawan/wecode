import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  answerApproval,
  ApprovalError,
  approvalById,
  board,
  loadMachines,
  openAssignments,
  raiseApproval,
  waitingApprovals,
  Maker,
} from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

const set = loadMachines();

/** A person and an agent, so every test can ask the wrong one. */
const cast = (db: DatabaseSync) => {
  const make = new Maker(db);
  make.role("operator", { write: [], tools: [] }, "human");
  make.role("engineer", { write: ["src/**"], tools: ["bash"] }, "agent");
  return {
    dana: make.worker("dana", "operator", "human"),
    claude: make.worker("claude", "engineer", "agent"),
  };
};

const ask = (db: DatabaseSync, task: number, worker: number, options?: readonly string[]) =>
  raiseApproval(db, {
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    question: "ship the reset mail to production?",
    ...(options === undefined ? {} : { options }),
  });

const ledgerOf = (db: DatabaseSync, id: number) =>
  db
    .prepare("SELECT verb, from_state, to_state, actor FROM ledger WHERE entity = 'assignment' AND entity_id = ? ORDER BY id")
    .all(id) as { verb: string; from_state: string; to_state: string; actor: string }[];

describe("the machine has a way into waiting that does not run first", () => {
  it("raises an assignment straight from pending to waiting", () => {
    const raise = set.assignment.transitions.find((t) => t.verb === "raise");
    expect(raise).toMatchObject({ from: ["pending"], to: "waiting" });
  });

  it("leaves the agent's own route to waiting alone", () => {
    expect(set.assignment.transitions.find((t) => t.verb === "ask")).toMatchObject({
      from: ["running"],
      to: "waiting",
    });
  });
});

describe("an approval is raised for a person", () => {
  it("is waiting the moment it exists, with its question on it", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);

    const approval = ask(db, task, dana);

    expect(approval).toMatchObject({
      objective_type: "task",
      objective_id: task,
      worker_id: dana,
      phase: "waiting",
      kind: "approval",
      question: "ship the reset mail to production?",
      answer: null,
      answered_by: null,
    });
  });

  it("carries the answers it will accept, when the question is closed", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);

    expect(ask(db, task, dana, ["ship", "hold"]).options).toEqual(["ship", "hold"]);
    expect(approvalById(db, ask(db, task, dana).id)?.options).toBeNull();
  });

  it("refuses to ask an agent: an approval is a person's to give", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { claude } = cast(db);

    expect(() => ask(db, task, claude)).toThrow(ApprovalError);
    expect(openAssignments(db)).toBe(0);
  });

  it("refuses a question that asks nothing, and writes no row for it", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);

    expect(() =>
      raiseApproval(db, { objective_type: "task", objective_id: task, worker_id: dana, question: "  " }),
    ).toThrow(ApprovalError);
    expect(waitingApprovals(db)).toEqual([]);
  });
});

describe("it reaches the board", () => {
  it("is in needs_human, under its kind, saying what it asks", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);

    const approval = ask(db, task, dana);

    expect(board(db).needs_human).toEqual([
      { id: approval.id, what: `task #${task}`, state: "approval", detail: "ship the reset mail to production?" },
    ]);
  });

  it("shows on the project its objective belongs to, and not on another", () => {
    const db = freshDb();
    const { task, project } = seed(db);
    const { dana } = cast(db);
    const approval = ask(db, task, dana);

    expect(board(db, project).needs_human.map((r) => r.id)).toEqual([approval.id]);
    expect(board(db, project + 999).needs_human).toEqual([]);
  });

  it("counts against the attention budget while it waits, and not after", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);

    const approval = ask(db, task, dana);
    expect(openAssignments(db)).toBe(1);

    answerApproval(db, approval.id, "ship it", "dana");
    expect(openAssignments(db)).toBe(0);
  });

  it("is off needs_human once it is answered", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);

    const approval = ask(db, task, dana);
    answerApproval(db, approval.id, "ship it", "dana");

    expect(board(db).needs_human).toEqual([]);
    expect(waitingApprovals(db)).toEqual([]);
  });
});

describe("it records who answered", () => {
  it("keeps the answer and the name on the row", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);

    const answered = answerApproval(db, ask(db, task, dana).id, "ship it", "dana");

    expect(answered).toMatchObject({ phase: "succeeded", answer: "ship it", answered_by: "dana" });
  });

  it("keeps the moment in the ledger, where a second answer cannot overwrite it", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);

    const approval = ask(db, task, dana);
    answerApproval(db, approval.id, "ship it", "dana");

    expect(ledgerOf(db, approval.id)).toEqual([
      { verb: "raise", from_state: "pending", to_state: "waiting", actor: "wecode" },
      { verb: "answer", from_state: "waiting", to_state: "running", actor: "dana" },
      { verb: "finish", from_state: "running", to_state: "succeeded", actor: "dana" },
    ]);
  });

  it("refuses an answer relayed by an agent", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);
    const approval = ask(db, task, dana);

    expect(() => answerApproval(db, approval.id, "ship it", "claude")).toThrow(ApprovalError);
    expect(approvalById(db, approval.id)).toMatchObject({ phase: "waiting", answered_by: null });
  });

  it("refuses an answer the question never offered", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);
    const approval = ask(db, task, dana, ["ship", "hold"]);

    expect(() => answerApproval(db, approval.id, "maybe", "dana")).toThrow(ApprovalError);
    expect(approvalById(db, approval.id)).toMatchObject({ phase: "waiting", answer: null });
  });

  it("refuses to answer one that is already settled", () => {
    const db = freshDb();
    const { task } = seed(db);
    const { dana } = cast(db);
    const approval = ask(db, task, dana);
    answerApproval(db, approval.id, "ship it", "dana");

    expect(() => answerApproval(db, approval.id, "hold it", "dana")).toThrow(ApprovalError);
    expect(approvalById(db, approval.id)).toMatchObject({ answer: "ship it", answered_by: "dana" });
  });
});
