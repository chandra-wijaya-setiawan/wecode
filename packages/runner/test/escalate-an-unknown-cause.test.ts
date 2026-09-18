import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  answerApproval,
  ApprovalError,
  choreFor,
  Engine,
  Maker,
  open,
  raiseApproval,
  Verbs,
  waitingApprovals,
  type Scope,
} from "@wecode/core";
import { queries, table } from "@wecode/core/dist/db.js";
import { diagnose, healTasks } from "../src/healer.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/19, the other half of the healing. A task that stopped for a cause with no
 *  safe fix is not the machine's to decide: 19 forbids inventing work and forbids an
 *  unexplained fix, so what is left is to say what was found and put the question where the
 *  one person who can answer it will see it.
 *
 *  | | |
 *  |---|---|
 *  | the pass never fixes it | no retry, no widening, no chore — the task is left where it stopped |
 *  | the finding is said out loud | the sentence names the exhaustion and whose decision the next attempt is |
 *  | the question goes on the board | an approval: an assignment of kind `approval`, hanging on the task itself |
 *  | asked of a person | `raiseApproval` refuses an agent, and `answerApproval` refuses an answer on a person's behalf |
 *  | the answer is not the machine's | answering settles the question and moves the task not at all |
 */

const taskRow = table<{ id: number; state: string; attempts: number; scope: string }>("task", [
  "id",
  "state",
  "attempts",
  "scope",
]);

let dir: string;
let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteriaId: number;
let storyId: number;
let taskId: number;
let dana: number;
let claude: number;

/** A task with one script task_test whose file its own scope already covers, taken to
 *  `failed` the only way the machine allows: attempts at the ceiling, then `give_up`.
 *  Nothing about it is stale and nothing about it is out of scope — it is the unknown
 *  cause, the one `diagnose` reports with no cause at all. */
function seedTask(scope: Scope, artefact: string): number {
  const at = make.acceptanceTest(criteriaId, `it works ${artefact}`, "script", "pnpm exec vitest run");
  const id = make.task(at, `do the work for ${artefact}`, { role: "engineer", scope, max_retry: 3 });
  const tt = make.taskTest(id, `proved by ${artefact}`, "script", `pnpm exec vitest run ${artefact}`);
  engine.apply("task_test", tt, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  const started = engine.apply("task", id, "start", "chief");
  expect(started.ok, started.ok ? "" : started.why).toBe(true);
  queries(db).update(taskRow).set({ attempts: 3 }).where("id", "=", id).run();
  const out = new Verbs(engine).giveUpTask(id, "runner");
  expect(out.ok, out.ok ? "" : out.why).toBe(true);
  return id;
}

beforeEach(() => {
  dir = tmp("wecode-escalate-cause-");
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);

  const ws = make.workspace("acme", dir);
  const project = make.project(ws, "storefront", dir);
  const rel = make.release(project, "1.0.0");
  const ep = make.epic(rel, "recovery");
  storyId = make.story(ep, "password reset");
  const req = make.requirement(storyId, "one change per link");
  criteriaId = make.criteria(req, "emailed in 60s");

  for (const [entity, id] of [
    ["project", project],
    ["release", rel],
    ["epic", ep],
    ["story", storyId],
    ["requirement", req],
    ["acceptance_criteria", criteriaId],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }

  make.role("operator", { write: [], tools: [] }, "human");
  make.role("engineer", { write: ["packages/runner/**"], tools: ["bash"] }, "agent");
  dana = make.worker("dana", "operator", "human");
  claude = make.worker("claude", "engineer", "agent");

  taskId = seedTask({ write: ["packages/runner/**"], tools: ["bash"] }, "packages/runner/test/plain.test.ts");
});

const state = (id: number): string =>
  queries(db).selectFrom(taskRow).select(["state"]).where("id", "=", id).get()?.state ?? "";

const attempts = (id: number): number =>
  queries(db).selectFrom(taskRow).select(["attempts"]).where("id", "=", id).get()?.attempts ?? -1;

const scopeOf = (id: number): Scope =>
  JSON.parse(queries(db).selectFrom(taskRow).select(["scope"]).where("id", "=", id).get()?.scope ?? "{}") as Scope;

/** One pass of the doctor's healing half, with the world answering "not behind". */
const heal = (): ReturnType<typeof healTasks> => healTasks(db, diagnose(db, { behind: () => false }));

/** The question wecode asks about a task it could not heal, in the words the pass found. */
const escalate = (task: number, finding: string) =>
  raiseApproval(db, {
    objective_type: "task",
    objective_id: task,
    worker_id: dana,
    question: `${finding}. Is a further attempt owed?`,
    options: ["retry", "leave it"],
  });

describe("a failed task whose cause has no safe fix", () => {
  it("is reported with no cause, and a finding that says whose decision the next attempt is", () => {
    const found = diagnose(db, { behind: () => false });
    expect(found.map((d) => d.task)).toEqual([taskId]);
    expect(found[0]?.cause).toBeNull();
    expect(found[0]?.file).toBeNull();
    expect(found[0]?.finding).toContain("no cause with a safe fix");
    expect(found[0]?.finding).toContain("a person decides whether a further attempt is owed");
  });

  it("is left exactly where it stopped: no retry, no widening, no chore", () => {
    const before = scopeOf(taskId);
    const report = heal();

    expect(report.repaired).toEqual([]);
    expect(report.waiting).toEqual([]);
    expect(report.left.map((l) => l.task)).toEqual([taskId]);
    expect(report.left[0]?.why).toContain("no cause with a safe fix");

    expect(state(taskId)).toBe("failed");
    expect(attempts(taskId)).toBe(3);
    expect(scopeOf(taskId)).toEqual(before);
    expect(choreFor(db, "refresh", "story", storyId)).toBeNull();
  });

  it("says the same thing however many passes see it, and never talks itself into a fix", () => {
    heal();
    const again = heal();
    expect(again.repaired).toEqual([]);
    expect(again.left.map((l) => l.why)).toEqual([expect.stringContaining("no cause with a safe fix")]);
    expect(state(taskId)).toBe("failed");
  });

  it("is not how a cause with a safe fix is treated", () => {
    // The same exhaustion, but the test it is judged by is outside its write scope: that
    // one the machine may fix by itself, and does, so it never becomes a question.
    const outside = seedTask({ write: ["packages/runner/src/a.ts"], tools: [] }, "packages/runner/test/far.test.ts");
    const report = heal();
    expect(report.repaired.map((r) => r.task)).toEqual([outside]);
    expect(report.left.map((l) => l.task)).toEqual([taskId]);
  });
});

describe("the question wecode raises about it", () => {
  it("goes on the board as an approval hanging on the task, in the words of the finding", () => {
    const finding = heal().left[0]?.why ?? "";
    const raised = escalate(taskId, finding);

    const asked = waitingApprovals(db);
    expect(asked.map((a) => a.id)).toEqual([raised.id]);
    expect(asked[0]?.kind).toBe("approval");
    expect(asked[0]?.phase).toBe("waiting");
    expect(asked[0]?.worker_id).toBe(dana);
    expect(asked[0]?.objective_type).toBe("task");
    expect(asked[0]?.objective_id).toBe(taskId);
    expect(asked[0]?.question).toContain("no cause with a safe fix");
    expect(asked[0]?.options).toEqual(["retry", "leave it"]);
    // Answered against the work as it stands, not against a number.
    expect(asked[0]?.evidence?.statement).toBe("do the work for packages/runner/test/plain.test.ts");
    expect(asked[0]?.evidence?.state).toBe("failed");
  });

  it("cannot be asked of an agent", () => {
    expect(() =>
      raiseApproval(db, {
        objective_type: "task",
        objective_id: taskId,
        worker_id: claude,
        question: "is a further attempt owed?",
      }),
    ).toThrow(ApprovalError);
    expect(waitingApprovals(db)).toEqual([]);
  });

  it("cannot be answered on a person's behalf", () => {
    const raised = escalate(taskId, heal().left[0]?.why ?? "");
    expect(() => answerApproval(db, raised.id, "retry", "claude")).toThrow(ApprovalError);
    expect(waitingApprovals(db).map((a) => a.id)).toEqual([raised.id]);
  });

  it("is settled by the person, and settling it moves the task not at all", () => {
    const raised = escalate(taskId, heal().left[0]?.why ?? "");
    const answered = answerApproval(db, raised.id, "leave it", "dana");

    expect(answered.answer).toBe("leave it");
    expect(answered.answered_by).toBe("dana");
    expect(waitingApprovals(db)).toEqual([]);

    // Asking is not fixing, and neither is being answered: the retry, if it is owed, is a
    // verb somebody invokes afterwards.
    expect(state(taskId)).toBe("failed");
    expect(attempts(taskId)).toBe(3);
    expect(heal().left.map((l) => l.task)).toEqual([taskId]);
  });
});
