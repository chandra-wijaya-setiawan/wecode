import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalById, board, open, waitingApprovals } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A decision the operator must make is a row in needs you, not a line in a report.
 *
 *  Six decisions reached the operator as chat messages on 20 Sep because there was no way
 *  to put one on the board: a story titled NEEDS APPROVAL sits in `planned` among fifty
 *  others and the needs-you box says nothing waits on you. `wecode ask` is the way in —
 *  core already raises and answers approvals, and this is the command that does it.
 *
 *  Driven through `run()` end to end rather than against `raiseApproval`: what was missing
 *  was never the mechanism, it was a way for a person or an agent to reach it by typing. */

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(tmp("wecode-ask-"), "wecode.db");
  delete process.env["WECODE_ACTOR"];
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");
const complained = (): string => err.join("");
const db = () => open(process.env["WECODE_DB"] as string);

/** One task to ask about, and one person to ask. The tree is built through the commands so
 *  the ids are the ones a reader would get by typing the same thing. */
function fixture(people: readonly string[] = ["cws"]): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "1.0.0"]);
  run(["epic", "create", "--parent", "1", "recovery"]);
  run(["story", "create", "--parent", "1", "password reset"]);
  run(["requirement", "create", "--parent", "1", "one change per link"]);
  run(["acceptance_criteria", "create", "--parent", "1", "a reset link arrives in 60s"]);
  run(["acceptance_test", "create", "--parent", "1", "the mail arrives"]);
  run(["task", "create", "--parent", "1", "send the reset mail", "--role", "engineer"]);
  for (const name of people) run(["worker", "create", name, "--role", "operator", "--kind", "human"]);
  out.length = 0;
  err.length = 0;
}

const QUESTION = "the branch has diverged from master. Rebase it or cut a fresh one?";

describe("wecode ask", () => {
  it("raises an approval that waits on the operator, carrying the question", () => {
    fixture();

    expect(run(["ask", "1", QUESTION])).toBe(0);
    expect(complained()).toBe("");
    expect(said()).toContain("approval #1");
    expect(said()).toContain("cws");

    const raised = approvalById(db(), 1);
    expect(raised?.phase).toBe("waiting");
    expect(raised?.kind).toBe("approval");
    expect(raised?.question).toContain(QUESTION);
    expect(raised?.worker_id).toBe(1);
    // Answered against the work, not against a number: the task's own words come back with it.
    expect(raised?.evidence).toMatchObject({ type: "task", id: 1, statement: "send the reset mail" });
  });

  it("carries what each answer costs beside the answer itself", () => {
    fixture();

    run(["ask", "1", QUESTION, "--option", "rebase=loses the two attempts already on it", "--option", "cut=a day"]);

    const raised = approvalById(db(), 1);
    // The options are the answers alone, because an answer is checked against them; the
    // costs are in the question, where a person reads them before choosing.
    expect(raised?.options).toEqual(["rebase", "cut"]);
    expect(raised?.question).toContain("rebase — loses the two attempts already on it");
    expect(raised?.question).toContain("cut — a day");
  });

  it("puts the row in needs you, where the board draws it", () => {
    fixture();

    run(["ask", "1", QUESTION, "--option", "rebase=loses two attempts"]);

    const rows = board(db()).needs_human;
    expect(rows.map((r) => r.id)).toEqual([1]);
    expect(rows[0]?.state).toBe("approval");
    expect(rows[0]?.what).toBe("task #1");
    expect(rows[0]?.detail).toContain(QUESTION);
  });

  it("refuses to ask about work that does not exist, rather than raising a question about #99", () => {
    fixture();

    expect(run(["ask", "99", QUESTION])).toBe(1);
    expect(complained()).toContain("no task #99");
    expect(waitingApprovals(db())).toEqual([]);
  });

  it("names the operator when there is more than one person it could burden", () => {
    fixture(["cws", "ada"]);

    expect(run(["ask", "1", QUESTION])).toBe(1);
    expect(complained()).toContain("--operator");
    expect(run(["ask", "1", QUESTION, "--operator", "ada"])).toBe(0);
    expect(approvalById(db(), 1)?.worker_id).toBe(2);
  });

  it("says what it takes, on a question with no words", () => {
    fixture();

    expect(run(["ask", "1"])).toBe(1);
    expect(complained()).toContain('wecode ask <task> "<question>"');
  });
});

describe("wecode answer, on an approval", () => {
  it("records the answer and closes the assignment", () => {
    fixture();
    run(["ask", "1", QUESTION, "--option", "rebase=loses two attempts", "--option", "cut=a day"]);
    out.length = 0;

    expect(run(["answer", "1", "cut"])).toBe(0);
    expect(complained()).toBe("");
    expect(said()).toContain("cut");

    const closed = approvalById(db(), 1);
    expect(closed?.answer).toBe("cut");
    expect(closed?.answered_by).toBe("cws");
    // Closed, not left waiting: an approval has no work to go back to.
    expect(closed?.phase).toBe("succeeded");
    expect(waitingApprovals(db())).toEqual([]);
    expect(board(db()).needs_human).toEqual([]);
  });

  it("holds the answer to the options that were offered", () => {
    fixture();
    run(["ask", "1", QUESTION, "--option", "rebase=loses two attempts", "--option", "cut=a day"]);
    out.length = 0;

    expect(run(["answer", "1", "maybe"])).toBe(1);
    expect(complained()).toContain("rebase, cut");
    expect(approvalById(db(), 1)?.phase).toBe("waiting");
  });

  it("takes any words when the question was left open", () => {
    fixture();
    run(["ask", "1", QUESTION]);
    out.length = 0;

    expect(run(["answer", "1", "cut", "a", "fresh", "one"])).toBe(0);
    expect(approvalById(db(), 1)?.answer).toBe("cut a fresh one");
    expect(approvalById(db(), 1)?.phase).toBe("succeeded");
  });

  it("leaves an agent's own ask alone — that one goes back to running", () => {
    fixture();
    const conn = db();
    conn
      .prepare(
        "INSERT INTO assignment (slug, objective_type, objective_id, worker_id, scope, budget, worktree," +
          " phase, kind, question, spent, created_at, updated_at)" +
          " VALUES ('a', 'task', 1, 1, '{}', '{}', '', 'waiting', 'input', 'which mailer?', '{}', 'now', 'now')",
      )
      .run();

    expect(run(["answer", "1", "the SES one"])).toBe(0);
    const row = conn.prepare("SELECT phase, answer, answered_by FROM assignment WHERE id = 1").get() as {
      phase: string;
      answer: string;
      answered_by: string;
    };
    expect(row).toMatchObject({ phase: "waiting", answer: "the SES one" });
  });
});
