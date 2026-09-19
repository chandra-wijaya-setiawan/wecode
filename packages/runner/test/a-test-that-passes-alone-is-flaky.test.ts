import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Examiner, FLAKY } from "../src/index.js";
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
  (db.prepare(`SELECT last_output FROM ${table} WHERE id = ?`).get(id) as { last_output: string }).last_output;

beforeEach(() => {
  dir = tmp("wecode-flaky-");
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

/** A started task with one ready script task_test, run in this tree. */
function readyTask(artefact: string): { task: number; taskTest: number } {
  const at = make.acceptanceTest(criteria, `proof-${Math.random()}`, "script", "true");
  const task = make.task(at, "do", { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, "unit", "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  return { task, taskTest };
}

/** A command that fails the first time it is run in a tree and passes every time after:
 *  the shape of a test that leaks state between runs. Nothing about the tree changes
 *  between the two runs — only that the first one happened. */
const failsOnceThenPasses = (tree: string): string =>
  `f=${join(tree, "once")}; if [ -e "$f" ]; then echo 'ok 1 passed'; else touch "$f"; echo 'AssertionError'; exit 1; fi`;

describe("a failure that passes when re-run alone", () => {
  it("is reported as flaky rather than as a failure", async () => {
    const { task, taskTest } = readyTask(failsOnceThenPasses(dir));

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.flaky).toContain(taskTest);
    expect(r.failed).toEqual([]);
    expect(r.passed).toEqual([]);
  });

  it("leaves the test exactly as it stood, because a flake is no verdict either way", async () => {
    const { task, taskTest } = readyTask(failsOnceThenPasses(dir));

    await new Examiner(db).runTaskTests(task, dir);

    // Neither red nor green: the one thing two opposite answers cannot support is a verdict.
    expect(stateOf("task_test", taskTest)).toBe("ready");
  });

  it("says so where the board reads it, ahead of what the failing run printed", async () => {
    const { task, taskTest } = readyTask(failsOnceThenPasses(dir));

    await new Examiner(db).runTaskTests(task, dir);

    expect(outputOf("task_test", taskTest)).toContain(FLAKY);
    // and the red itself is still there to read, not swallowed by the retry's green.
    expect(outputOf("task_test", taskTest)).toContain("AssertionError");
  });

  it("is asked again on the next pass rather than settled by the flake", async () => {
    const { task, taskTest } = readyTask(failsOnceThenPasses(dir));
    const examiner = new Examiner(db);

    await examiner.runTaskTests(task, dir);
    // The marker is now in the tree, so the same command is green on both of its runs.
    const second = await examiner.runTaskTests(task, dir);

    expect(second.skipped).toEqual([]);
    expect(second.passed).toContain(taskTest);
    expect(stateOf("task_test", taskTest)).toBe("passed");
  });

  it("leaves a command that fails both times a plain failure", async () => {
    // A red that reproduces is the work's red. Re-running it must not turn a real failure
    // into a shrug.
    const { task, taskTest } = readyTask("echo 'AssertionError'; exit 1");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(r.flaky).toEqual([]);
    expect(stateOf("task_test", taskTest)).toBe("failed");
    expect(outputOf("task_test", taskTest)).not.toContain(FLAKY);
  });

  it("does not call a red flaky because its re-run selected no test", async () => {
    // Exit 0 with nothing selected is not a green, so it disagrees with nothing.
    const { task, taskTest } = readyTask(
      `f=${join(dir, "empty")}; if [ -e "$f" ]; then echo 'No test files found, exiting with code 0'; else touch "$f"; exit 1; fi`,
    );

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(r.flaky).toEqual([]);
  });

  it("never re-runs a command that passed the first time", async () => {
    // The second run exists to give a red a second chance, not to give a green one. A
    // command that counts its own runs stays at one.
    const counter = join(dir, "runs");
    const { task, taskTest } = readyTask(`echo x >> ${counter}; echo '1 passed'`);

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.passed).toContain(taskTest);
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("reports an acceptance_test's flake the same way", async () => {
    const at = make.acceptanceTest(criteria, "proof", "script", failsOnceThenPasses(dir));
    engine.apply("acceptance_test", at, "deliver", "chief");
    recordRed(db, at);

    const r = await new Examiner(db).runAcceptanceTests(story, dir);

    expect(r.flaky).toContain(at);
    expect(r.failed).toEqual([]);
    expect(stateOf("acceptance_test", at)).toBe("ready");
    expect(outputOf("acceptance_test", at)).toContain(FLAKY);
  });
});
