import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  answerApproval,
  approvalById,
  choreFor,
  INVARIANTS,
  Maker,
  open,
  RUNNER_INVARIANTS,
  VERDICT_INVARIANTS,
  waitingApprovals,
  type Violation,
} from "@wecode/core";
import { healViolations, questionFor, REMEDIES, remedyFor } from "../src/healer.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/19: an open violation becomes a chore when its heal is safe, and an approval
 *  when it is not. Two destinations and one rule between them — whether a machine may make
 *  the fix is written down per invariant, and everything the table does not call safe is a
 *  question for a person rather than a fix nobody asked for. */

let dir: string;
let db: DatabaseSync;
let make: Maker;
let storyId: number;
let taskId: number;
let acceptanceId: number;
let dana: number;

beforeEach(() => {
  dir = tmp("wecode-heal-violation-");
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);

  const ws = make.workspace("acme", dir);
  const project = make.project(ws, "storefront", dir);
  const rel = make.release(project, "1.0.0");
  const ep = make.epic(rel, "recovery");
  storyId = make.story(ep, "password reset");
  const req = make.requirement(storyId, "one change per link");
  const criteria = make.criteria(req, "emailed in 60s");
  acceptanceId = make.acceptanceTest(criteria, "the mail arrives", "script", "pnpm exec vitest run");
  taskId = make.task(acceptanceId, "send the mail", { role: "engineer", scope: { write: [], tools: [] } });

  make.role("operator", { write: [], tools: [] }, "human");
  make.role("engineer", { write: ["packages/**"], tools: ["bash"] }, "agent");
  dana = make.worker("dana", "operator", "human");
  make.worker("claude", "engineer", "agent");
});

/** A violation in the shape a check reports it, for whichever invariant a test is about. */
const drift = (invariant: string, entity: string, id: number | null, slug: string, detail = "so it says"): Violation => ({
  invariant,
  entity,
  id,
  slug,
  detail,
});

const unlanded = (): Violation =>
  drift("delivered_story_has_landed", "story", storyId, "password-reset", "delivered with no landed_sha");

const testless = (): Violation =>
  drift("ready_task_has_a_ready_task_test", "task", taskId, "send-the-mail", "ready with no task_test ready or passed");

describe("a violation whose heal is safe", () => {
  it("becomes a chore against the thing it names, and asks nobody", () => {
    const report = healViolations(db, [unlanded()]);

    expect(report.chored.map((c) => c.kind)).toEqual(["land"]);
    expect(report.asked).toEqual([]);
    expect(report.standing).toEqual([]);

    const chore = choreFor(db, "land", "story", storyId);
    expect(chore?.id).toBe(report.chored[0]?.chore);
    expect(chore?.state).toBe("planned");
    expect(chore?.check).toBe("the story branch is an ancestor of the base");
    // A safe fix is work wecode owes itself. Nothing is put to a person about it.
    expect(waitingApprovals(db)).toEqual([]);
  });

  it("raises one chore however many passes report the same drift", () => {
    healViolations(db, [unlanded()]);
    const first = choreFor(db, "land", "story", storyId)?.id;
    healViolations(db, [unlanded()]);
    healViolations(db, [unlanded()]);
    expect(choreFor(db, "land", "story", storyId)?.id).toBe(first);
  });

  it("leaves it standing when there is no row to raise the chore against", () => {
    const report = healViolations(db, [drift("delivered_story_has_landed", "story", null, "password-reset")]);
    expect(report.chored).toEqual([]);
    expect(report.standing[0]?.why).toContain("names no row");
  });
});

describe("a violation whose heal is not safe", () => {
  it("becomes an approval waiting on a person, against the work it is about", () => {
    const report = healViolations(db, [testless()]);

    expect(report.chored).toEqual([]);
    expect(report.asked.map((a) => a.invariant)).toEqual(["ready_task_has_a_ready_task_test"]);

    const waiting = waitingApprovals(db);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.id).toBe(report.asked[0]?.approval);
    expect(waiting[0]?.worker_id).toBe(dana);
    // The question is answered against the work, not against a number.
    expect(waiting[0]?.evidence).toMatchObject({ type: "task", id: taskId, statement: "send the mail" });
  });

  it("asks in words that carry the drift and the reason a machine may not fix it", () => {
    healViolations(db, [testless()]);
    const question = waitingApprovals(db)[0]?.question ?? "";
    expect(question).toContain("ready with no task_test ready or passed");
    expect(question).toContain("how a task proves itself is the task's own statement");
    expect(question).toContain("task send-the-mail");
  });

  it("raises no chore for it", () => {
    healViolations(db, [testless()]);
    expect(choreFor(db, "land", "story", storyId)).toBeNull();
    expect(choreFor(db, "refresh", "story", storyId)).toBeNull();
  });

  it("asks the person the caller names rather than the first one on the record", () => {
    const sam = make.worker("sam", "operator", "human");
    healViolations(db, [testless()], { operator: sam });
    expect(waitingApprovals(db)[0]?.worker_id).toBe(sam);
  });
});

describe("the question is asked once", () => {
  it("does not ask again while it is waiting", () => {
    const first = healViolations(db, [testless()]);
    const again = healViolations(db, [testless()]);
    expect(again.asked[0]?.approval).toBe(first.asked[0]?.approval);
    expect(waitingApprovals(db)).toHaveLength(1);
  });

  it("does not ask again once a person has answered it", () => {
    const raised = healViolations(db, [testless()]).asked[0]?.approval ?? 0;
    answerApproval(db, raised, "write the task_test", "dana");
    expect(approvalById(db, raised)?.answer).toBe("write the task_test");

    const again = healViolations(db, [testless()]);
    expect(again.asked[0]?.approval).toBe(raised);
    expect(waitingApprovals(db)).toEqual([]);
  });

  it("asks a new question when the record has moved under the old one", () => {
    healViolations(db, [testless()]);
    healViolations(db, [drift("ready_task_has_a_ready_task_test", "task", taskId, "send-the-mail", "and now something else")]);
    expect(waitingApprovals(db)).toHaveLength(2);
  });
});

describe("a violation with nowhere to put the question", () => {
  it("is left standing when it names something an approval may not hang on", () => {
    const report = healViolations(db, [drift("story_in_progress_has_a_requirement", "story", storyId, "password-reset")]);

    expect(report.asked).toEqual([]);
    expect(report.chored).toEqual([]);
    expect(report.standing[0]?.why).toContain("an approval is asked against task, acceptance_test, task_test");
    expect(waitingApprovals(db)).toEqual([]);
  });

  it("is left standing when the violation names no row at all", () => {
    const report = healViolations(db, [drift("role_with_ready_work_has_a_worker", "role", null, "engineer")]);
    expect(report.standing[0]?.invariant).toBe("role_with_ready_work_has_a_worker");
    expect(waitingApprovals(db)).toEqual([]);
  });

  it("is left standing when there is nobody to ask", () => {
    const bare = open(join(tmp("wecode-heal-nobody-"), "wecode.db"));
    const other = new Maker(bare);
    const project = other.project(other.workspace("acme", dir), "storefront", dir);
    const criteria = other.criteria(
      other.requirement(other.story(other.epic(other.release(project, "1.0.0"), "e"), "s"), "r"),
      "c",
    );
    const at = other.acceptanceTest(criteria, "it works", "script", "true");
    const lonely = other.task(at, "do it", { role: "engineer", scope: { write: [], tools: [] } });

    const report = healViolations(bare, [drift("ready_task_has_a_ready_task_test", "task", lonely, "do-it")]);
    expect(report.standing[0]?.why).toBe("there is no human worker on the record to ask");
  });
});

describe("the remedies are a table a person can read", () => {
  it("has a row for every check a pass runs, so none of them defaults in silence", () => {
    const checks = [...INVARIANTS, ...RUNNER_INVARIANTS, ...VERDICT_INVARIANTS].map((i) => i.name);
    expect(checks.filter((name) => REMEDIES[name] === undefined)).toEqual([]);
  });

  it("treats a check it has never heard of as unsafe", () => {
    const remedy = remedyFor("a_check_added_last_tuesday");
    expect(remedy.safe).toBe(false);

    const report = healViolations(db, [drift("a_check_added_last_tuesday", "acceptance_test", acceptanceId, "the-mail")]);
    expect(report.chored).toEqual([]);
    expect(report.asked).toHaveLength(1);
    expect(waitingApprovals(db)[0]?.question).toContain("no remedy has been reasoned about");
  });

  it("names only fixes that invent nothing: one chore, and a question for everything else", () => {
    expect(Object.entries(REMEDIES).filter(([, r]) => r.safe).map(([name]) => name)).toEqual([
      "delivered_story_has_landed",
    ]);
  });

  it("phrases a question from the violation alone", () => {
    const v = testless();
    expect(questionFor(v, remedyFor(v.invariant))).toContain(`#${taskId}`);
  });
});

describe("one pass over a board with both kinds on it", () => {
  it("sorts each violation to its own destination and leaves the rest standing", () => {
    const report = healViolations(db, [
      unlanded(),
      testless(),
      drift("schema_version_is_understood", "schema_version", null, "3"),
    ]);

    expect(report.chored.map((c) => c.invariant)).toEqual(["delivered_story_has_landed"]);
    expect(report.asked.map((a) => a.invariant)).toEqual(["ready_task_has_a_ready_task_test"]);
    expect(report.standing.map((s) => s.invariant)).toEqual(["schema_version_is_understood"]);
  });

  it("changes nothing when there is nothing open", () => {
    expect(healViolations(db, [])).toEqual({ chored: [], asked: [], standing: [] });
    expect(waitingApprovals(db)).toEqual([]);
    expect(choreFor(db, "land", "story", storyId)).toBeNull();
  });
});
