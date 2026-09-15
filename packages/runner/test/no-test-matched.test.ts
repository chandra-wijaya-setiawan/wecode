import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Examiner, matchedNoTest } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";
import { recordRed } from "../../core/test/helpers.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;
let story: number;
let dir: string;

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

const outputOf = (table: string, id: number): string =>
  (db.prepare(`SELECT last_output FROM ${table} WHERE id = ?`).get(id) as { last_output: string })
    .last_output;

beforeEach(() => {
  dir = tmp("wecode-no-test-matched-");
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", dir);
  const p = make.project(ws, "s", dir);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  story = make.story(e, "s");
  const req = make.requirement(story, "r");
  criteria = make.criteria(req, "c");
  for (const [entity, id] of [
    ["project", p],
    ["release", rel],
    ["epic", e],
    ["story", story],
    ["requirement", req],
    ["acceptance_criteria", criteria],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }
});

/** A started task with one ready script task_test, run in this tree. The parent
 *  acceptance_test is delivered first because a task will not start under a planned one. */
function readyTask(artefact: string): { task: number; taskTest: number } {
  const at = make.acceptanceTest(criteria, `proof-${artefact}`, "script", "true");
  const task = make.task(at, `do-${artefact}`, { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, `unit-${artefact}`, "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  return { task, taskTest };
}

describe("a run that matched no test is not a pass", () => {
  it("fails a task_test whose command exited 0 having found no test files", async () => {
    // `vitest --passWithNoTests` over a path filter that has gone stale: exit 0, and the
    // only thing in the output saying so is the banner.
    const { task, taskTest } = readyTask("echo 'No test files found, exiting with code 0'");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(r.passed).toEqual([]);
    expect(stateOf("task_test", taskTest)).toBe("failed");
    // and the reason is where the board reads it, ahead of what the command printed.
    expect(outputOf("task_test", taskTest)).toContain("no test matched");
    expect(outputOf("task_test", taskTest)).toContain("No test files found");
  });

  it("still passes a task_test whose suite actually ran", async () => {
    const { task, taskTest } = readyTask("echo 'Test Files 3 passed (3)'");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.passed).toContain(taskTest);
    expect(r.failed).toEqual([]);
    expect(stateOf("task_test", taskTest)).toBe("passed");
    expect(outputOf("task_test", taskTest)).not.toContain("no test matched");
  });

  it("leaves a command that already exited non-zero a plain failure", async () => {
    // Nothing is added to the output of a run that failed on its own terms: saying "no test
    // matched" over a suite that ran and went red would name the wrong defect.
    const { task, taskTest } = readyTask("echo 'assertion failed'; exit 1");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(outputOf("task_test", taskTest)).not.toContain("no test matched");
  });

  it("fails an acceptance_test the same way, rather than passing its criteria on nothing", async () => {
    const at = make.acceptanceTest(criteria, "proof", "script", "echo 'no tests ran in 0.01s'");
    engine.apply("acceptance_test", at, "deliver", "chief");
    // It has been seen to fail at its base, so nothing but this guard stands between the
    // exit code and a pass.
    recordRed(db, at);

    const r = await new Examiner(db).runAcceptanceTests(story, dir);

    expect(r.failed).toContain(at);
    expect(r.passed).toEqual([]);
    expect(stateOf("acceptance_test", at)).toBe("failed");
    expect(outputOf("acceptance_test", at)).toContain("no test matched");
  });
});

describe("what counts as having matched no test", () => {
  it("knows each runner's own words for an empty selection", () => {
    for (const banner of [
      "No test files found, exiting with code 0",
      "No tests found, exiting with code 0",
      "No test suites found, exiting with code 0",
      "no tests ran in 0.01s",
      "testing: warning: no tests to run",
      "?   \tgithub.com/acme/pkg\t[no test files]",
      "running 0 tests\n\ntest result: ok. 0 passed",
    ]) {
      expect(matchedNoTest(banner), banner).toBe(true);
    }
  });

  it("does not read a suite that ran as one that did not", () => {
    for (const banner of [
      "Test Files  3 passed (3)\n     Tests  41 passed (41)",
      "1 failed, 12 passed in 2.10s",
      "ok  \tgithub.com/acme/pkg\t0.012s",
      // A count is not a banner: a suite where everything errored also prints zeroes, and
      // that is a failure by its exit code, not an empty selection.
      "0 passing\n41 failing",
    ]) {
      expect(matchedNoTest(banner), banner).toBe(false);
    }
  });
});
