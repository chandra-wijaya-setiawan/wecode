import { describe, expect, it } from "vitest";
import { board, lastLine } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** Put a task in `failed` without walking the machine: the board reads state, and what is
 *  under test here is what it reads, not how the task got there. */
const failTask = (db: ReturnType<typeof freshDb>, id: number): void => {
  db.prepare("UPDATE task SET state = 'failed', attempts = 3 WHERE id = ?").run(id);
};

const failTest = (
  db: ReturnType<typeof freshDb>,
  table: "task_test" | "acceptance_test",
  id: number,
  output: string,
  at = "2026-09-13T00:00:00.000Z",
): void => {
  db.prepare(`UPDATE ${table} SET state = 'failed', last_output = ?, last_run_at = ? WHERE id = ?`).run(
    output,
    at,
    id,
  );
};

/** What the board says about attempts on its own, before the last line is hung off it.
 *  `failTask` exhausts the task, so this is the out-of-attempts wording. */
const ATTEMPTS = "out of attempts · 3 of 3 · retry it with a reason, or drop it";

describe("the last line of a failed test's output", () => {
  it("is the last line that has something on it", () => {
    expect(lastLine("running\n\nAssertionError: expected 2 to be 3\n\n")).toBe(
      "AssertionError: expected 2 to be 3",
    );
  });

  it("is empty when there is no output to carry", () => {
    expect(lastLine(null)).toBe("");
    expect(lastLine(undefined)).toBe("");
    expect(lastLine("\n  \n")).toBe("");
  });

  it("is one line: a board row cannot carry a paragraph", () => {
    expect(lastLine("a".repeat(400))).toHaveLength(120);
    expect(lastLine("a".repeat(400)).endsWith("…")).toBe(true);
  });

  it("carries a task test's failure onto the board's failed row", () => {
    const db = freshDb();
    const tree = seed(db);
    failTask(db, tree.task);
    failTest(db, "task_test", tree.taskTest, "FAIL test/mail.test.ts\nexpected the mailer to be called");

    const row = board(db).failed[0];
    expect(row?.id).toBe(tree.task);
    expect(row?.detail).toBe(`${ATTEMPTS} · expected the mailer to be called`);
  });

  it("falls back to the acceptance test when no task test is red", () => {
    const db = freshDb();
    const tree = seed(db);
    failTask(db, tree.task);
    failTest(db, "acceptance_test", tree.acceptance, "no link arrived within 60s");

    expect(board(db).failed[0]?.detail).toBe(`${ATTEMPTS} · no link arrived within 60s`);
  });

  it("prefers the task's own test to the acceptance test above it", () => {
    const db = freshDb();
    const tree = seed(db);
    failTask(db, tree.task);
    failTest(db, "acceptance_test", tree.acceptance, "no link arrived within 60s");
    failTest(db, "task_test", tree.taskTest, "expected the mailer to be called");

    expect(board(db).failed[0]?.detail).toContain("the mailer");
  });

  it("takes the test that ran most recently when several are red", () => {
    const db = freshDb();
    const tree = seed(db);
    failTask(db, tree.task);
    failTest(db, "task_test", tree.taskTest, "the older failure", "2026-09-13T00:00:00.000Z");
    db.prepare(
      `INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,last_run_at,last_output,created_at,updated_at)
       VALUES ('token','${tree.task}','the token is single use','script','vitest run token','failed',
               '2026-09-14T00:00:00.000Z','the newer failure','2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z')`,
    ).run();

    expect(board(db).failed[0]?.detail).toBe(`${ATTEMPTS} · the newer failure`);
  });

  it("says only the attempts when the tests left no output", () => {
    const db = freshDb();
    const tree = seed(db);
    failTask(db, tree.task);

    expect(board(db).failed[0]?.detail).toBe(ATTEMPTS);
    expect(board(db).failed[0]).not.toHaveProperty("output");
  });

  it("still narrows to the project asked for", () => {
    const db = freshDb();
    const tree = seed(db);
    failTask(db, tree.task);
    failTest(db, "task_test", tree.taskTest, "expected the mailer to be called");

    expect(board(db, tree.project).failed).toHaveLength(1);
    expect(board(db, tree.project + 1).failed).toEqual([]);
  });
});
