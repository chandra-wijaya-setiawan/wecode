import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { approvalById, board, Engine, Maker, open, waitingApprovals } from "@wecode/core";
import { ACCEPTED, DRAFTED, DROPPED, healDesigns, type Design } from "../src/healer.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/16: a design waiting for a signature is a row in `needs you`.
 *
 *  A drafted design that crosses a port is not wecode's to accept, and until it is raised
 *  nobody can see that it is waiting: the board says nothing waits on the operator while a
 *  design does. These are the two halves of the fix — the question going up when the design
 *  is drafted and crosses something, and coming down the moment a person has answered it by
 *  accepting or dropping the design itself. */

let dir: string;
let db: DatabaseSync;
let make: Maker;
let taskId: number;
let dana: number;

/** The screen this suite drafts a design for, and where its projected mockup was written. */
const SCREEN = "outline";
const MOCKUP = "packages/tui/config/mockups/outline.txt";

const drafted = (over: Partial<Design> = {}): Design => ({
  screen: SCREEN,
  state: DRAFTED,
  crosses: ["ui"],
  mockup: MOCKUP,
  task: taskId,
  ...over,
});

beforeEach(() => {
  dir = tmp("wecode-design-signs-");
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  const engine = new Engine(db);

  const ws = make.workspace("acme", dir);
  const project = make.project(ws, "storefront", dir);
  const rel = make.release(project, "1.0.0");
  const ep = make.epic(rel, "the cockpit");
  const story = make.story(ep, "the outline page is undesigned");
  const req = make.requirement(story, "a design that needs a signature is a row in needs you");
  const criteria = make.criteria(req, "the operator signs the outline");
  const at = make.acceptanceTest(criteria, "the outline matches its design", "script", "pnpm exec vitest run");
  make.role("engineer", { write: ["packages/tui/**"], tools: ["bash"] }, "agent");
  make.role("operator", { write: [], tools: [] }, "human");
  dana = make.worker("dana", "operator", "human");
  taskId = make.task(at, "draft the outline design", {
    role: "engineer",
    scope: { write: ["packages/tui/config/design.yaml"], tools: ["bash"] },
  });

  for (const [entity, id] of [
    ["project", project],
    ["release", rel],
    ["epic", ep],
    ["story", story],
    ["requirement", req],
    ["acceptance_criteria", criteria],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }
});

describe("a drafted design that crosses a port waits on a person", () => {
  it("shows nothing in needs you while nobody has raised the design", () => {
    expect(waitingApprovals(db)).toEqual([]);
    expect(board(db).needs_human).toEqual([]);
  });

  it("raises an approval for the operator, naming the screen and its mockup", () => {
    const report = healDesigns(db, [drafted()]);

    expect(report.asked).toEqual([{ screen: SCREEN, approval: expect.any(Number), mockup: MOCKUP }]);
    expect(report.closed).toEqual([]);

    const raised = approvalById(db, report.asked[0]!.approval);
    expect(raised?.phase).toBe("waiting");
    expect(raised?.worker_id).toBe(dana);
    expect(raised?.question).toContain(SCREEN);
    expect(raised?.question).toContain(MOCKUP);
    expect(raised?.options).toEqual([ACCEPTED, DROPPED]);
    // Hung on the work that drafted it, so the question is read against the task and not
    // against a filename.
    expect(raised?.objective_type).toBe("task");
    expect(raised?.objective_id).toBe(taskId);
  });

  it("puts that row in needs you, with the mockup path on it", () => {
    const report = healDesigns(db, [drafted()]);

    const rows = board(db).needs_human;
    expect(rows.map((r) => r.id)).toEqual([report.asked[0]!.approval]);
    expect(rows[0]!.state).toBe("approval");
    expect(rows[0]!.detail).toContain(SCREEN);
    expect(rows[0]!.detail).toContain(MOCKUP);
  });

  it("asks once: a second pass over the same drafted design raises no second row", () => {
    const first = healDesigns(db, [drafted()]);
    const second = healDesigns(db, [drafted()]);

    expect(second.asked).toEqual([]);
    expect(second.left).toEqual([
      { task: taskId, slug: SCREEN, why: `the design of the ${SCREEN} screen is already waiting on approval #${first.asked[0]!.approval}` },
    ]);
    expect(waitingApprovals(db).map((a) => a.id)).toEqual([first.asked[0]!.approval]);
  });

  it("leaves a design that crosses no port alone: nobody has to sign it", () => {
    const report = healDesigns(db, [drafted({ crosses: [] })]);

    expect(report.asked).toEqual([]);
    expect(report.left).toEqual([
      { task: taskId, slug: SCREEN, why: `the design of the ${SCREEN} screen crosses no port, so nobody has to sign it` },
    ]);
    expect(waitingApprovals(db)).toEqual([]);
  });

  it("leaves a design that is not drafted alone", () => {
    const report = healDesigns(db, [drafted({ state: ACCEPTED })]);

    expect(report).toEqual({ asked: [], closed: [], left: [] });
    expect(waitingApprovals(db)).toEqual([]);
  });
});

describe("the question closes when the design is answered", () => {
  it("closes on accepted, in the operator's name", () => {
    const raised = healDesigns(db, [drafted()]).asked[0]!;

    const report = healDesigns(db, [drafted({ state: ACCEPTED })]);

    expect(report.closed).toEqual([{ screen: SCREEN, approval: raised.approval, answer: ACCEPTED }]);
    const after = approvalById(db, raised.approval);
    expect(after?.phase).not.toBe("waiting");
    expect(after?.answer).toBe(ACCEPTED);
    expect(after?.answered_by).toBe("dana");
    expect(waitingApprovals(db)).toEqual([]);
    expect(board(db).needs_human).toEqual([]);
  });

  it("closes on dropped too", () => {
    const raised = healDesigns(db, [drafted()]).asked[0]!;

    const report = healDesigns(db, [drafted({ state: DROPPED })]);

    expect(report.closed).toEqual([{ screen: SCREEN, approval: raised.approval, answer: DROPPED }]);
    expect(approvalById(db, raised.approval)?.answer).toBe(DROPPED);
    expect(waitingApprovals(db)).toEqual([]);
  });

  it("closes only its own screen's question", () => {
    const other: Design = { screen: "detail", state: DRAFTED, crosses: ["ui"], mockup: "m/detail.txt", task: taskId };
    const both = healDesigns(db, [drafted(), other]);
    expect(both.asked).toHaveLength(2);

    healDesigns(db, [drafted({ state: ACCEPTED }), other]);

    expect(waitingApprovals(db).map((a) => a.id)).toEqual([both.asked[1]!.approval]);
  });
});

describe("who is asked", () => {
  it("asks the operator named, when one is named", () => {
    make.worker("erin", "operator", "human");

    const report = healDesigns(db, [drafted()], { operator: "erin" });

    expect(approvalById(db, report.asked[0]!.approval)?.worker_id).not.toBe(dana);
  });

  it("raises nothing and says so when there are two people and neither was named", () => {
    make.worker("erin", "operator", "human");

    const report = healDesigns(db, [drafted()]);

    expect(report.asked).toEqual([]);
    expect(report.left).toEqual([
      { task: taskId, slug: SCREEN, why: `the design of the ${SCREEN} screen needs a signature and no human worker is there to give it` },
    ]);
  });
});
