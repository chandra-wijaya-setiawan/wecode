import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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

/** Writes a suite runner into the tree and answers the command that drives it.
 *
 *  Run with no file named — the whole suite — it prints a vitest failure banner and exits
 *  1. Run with files named, it passes: the shape of a suite whose tests leak into each
 *  other, where the accused test is sound and its neighbour is what broke it. Every
 *  execution is logged, so a test below can say how many there were. */
function suite(body: string): string {
  const path = join(dir, "suite.sh");
  writeFileSync(path, `#!/bin/sh\necho ran >> ${join(dir, "runs.log")}\n${body}\n`);
  chmodSync(path, 0o755);
  writeFileSync(join(dir, "leaky.test.ts"), "// a test file, so the tree really has one\n");
  writeFileSync(join(dir, "runs.log"), "");
  return `${path}`;
}

const redThenGreenAlone = (): string =>
  suite(
    `if [ $# -eq 0 ]; then
       echo " FAIL  leaky.test.ts > it counts"
       echo "AssertionError: expected 1 to be 2"
       exit 1
     fi
     echo "Test Files  1 passed (1)"`,
  );

const runs = (): number => readFileSync(join(dir, "runs.log"), "utf8").trim().split("\n").filter(Boolean).length;

describe("a failure that passes when re-run alone", () => {
  it("is reported as flaky rather than as a failure", async () => {
    const { task, taskTest } = readyTask(redThenGreenAlone());

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.flaky).toContain(taskTest);
    expect(r.failed).toEqual([]);
    expect(r.passed).toEqual([]);
  });

  it("leaves the test exactly as it stood, because two opposite answers are no verdict", async () => {
    const { task, taskTest } = readyTask(redThenGreenAlone());

    await new Examiner(db).runTaskTests(task, dir);

    expect(stateOf("task_test", taskTest)).toBe("ready");
  });

  it("says so where the board reads it, ahead of what the failing run printed", async () => {
    const { task, taskTest } = readyTask(redThenGreenAlone());

    await new Examiner(db).runTaskTests(task, dir);

    expect(outputOf("task_test", taskTest)).toContain(FLAKY);
    // Named, so whoever reads it can run the same thing by hand.
    expect(outputOf("task_test", taskTest)).toContain("leaky.test.ts");
    // And the red itself is still there to read, not swallowed by the narrowed green.
    expect(outputOf("task_test", taskTest)).toContain("AssertionError");
  });

  it("runs the named file alone rather than the same red command twice", async () => {
    // The whole point: a failing artefact is never simply asked again. The second run is a
    // different command — the suite narrowed to the file it accused.
    const { task } = readyTask(redThenGreenAlone());

    await new Examiner(db).runTaskTests(task, dir);

    expect(runs()).toBe(2);
  });

  it("leaves a red that names no file a plain failure, run once", async () => {
    // A command that fails without saying where offers nothing to run alone. Re-running it
    // would be a second execution of a failing artefact, which proves nothing new.
    const { task, taskTest } = readyTask(suite(`echo "AssertionError"; exit 1`));

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(r.flaky).toEqual([]);
    expect(runs()).toBe(1);
    expect(stateOf("task_test", taskTest)).toBe("failed");
    expect(outputOf("task_test", taskTest)).not.toContain(FLAKY);
  });

  it("leaves a red that names a file not in the tree a plain failure, run once", async () => {
    // The name is stale or is not a path at all. Nothing is put on a command line unread.
    const { task, taskTest } = readyTask(suite(`echo " FAIL  gone.test.ts"; exit 1`));

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(runs()).toBe(1);
  });

  it("leaves a failure that reproduces alone a failure", async () => {
    // A red that survives isolation is the work's red, and must not become a shrug.
    const { task, taskTest } = readyTask(suite(`echo " FAIL  leaky.test.ts"; exit 1`));

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(r.flaky).toEqual([]);
    expect(runs()).toBe(2);
    expect(stateOf("task_test", taskTest)).toBe("failed");
  });

  it("does not call a red flaky because the narrowed run selected no test", async () => {
    // Exit 0 with nothing selected is not a green, so it disagrees with nothing.
    const { task, taskTest } = readyTask(
      suite(
        `if [ $# -eq 0 ]; then echo " FAIL  leaky.test.ts"; exit 1; fi
         echo "No test files found, exiting with code 0"`,
      ),
    );

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(r.flaky).toEqual([]);
  });

  it("never re-runs a command that passed the first time", async () => {
    // The narrowed run exists to give a red a second reading, not to give a green one.
    const { task, taskTest } = readyTask(suite(`echo "Test Files  1 passed (1)"`));

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.passed).toContain(taskTest);
    expect(runs()).toBe(1);
  });

  it("reports an acceptance_test's flake the same way", async () => {
    const at = make.acceptanceTest(criteria, "proof", "script", redThenGreenAlone());
    engine.apply("acceptance_test", at, "deliver", "chief");
    recordRed(db, at);

    const r = await new Examiner(db).runAcceptanceTests(story, dir);

    expect(r.flaky).toContain(at);
    expect(r.failed).toEqual([]);
    expect(stateOf("acceptance_test", at)).toBe("ready");
    expect(outputOf("acceptance_test", at)).toContain(FLAKY);
  });
});
