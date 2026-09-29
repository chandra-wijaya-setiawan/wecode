import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { DEFAULT_TIMEOUT_MS, Examiner, TIMED_OUT, defaultTimeoutOf } from "../src/index.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;
let dir: string;

const stateOf = (id: number): string =>
  (db.prepare("SELECT state FROM task_test WHERE id = ?").get(id) as { state: string }).state;

const outputOf = (id: number): string =>
  (db.prepare("SELECT last_output FROM task_test WHERE id = ?").get(id) as { last_output: string }).last_output;

/** A `config/project.yaml` in the tree being examined. Without `prepare:` on purpose: what
 *  is under test is the budget a run is given, not the build before it. */
function declare(yaml: string): void {
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "project.yaml"), yaml);
}

beforeEach(() => {
  dir = tmp("wecode-default-timeout-");
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", dir);
  const p = make.project(ws, "s", dir);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  const story = make.story(e, "s");
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

function readyTask(artefact: string): { task: number; taskTest: number } {
  const at = make.acceptanceTest(criteria, `proof-${artefact}`, "script", "true");
  const task = make.task(at, `do-${artefact}`, { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, `unit-${artefact}`, "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  recordRed(db, at);
  return { task, taskTest };
}

describe("the tree declares the default every proof is given", () => {
  it("reads the default off the tree being examined, in milliseconds", () => {
    declare("timeout_default: 45\n");
    expect(defaultTimeoutOf(dir)).toBe(45_000);
  });

  it("declares nothing where there is no config, and nothing where there is no default", () => {
    expect(defaultTimeoutOf(dir)).toBeNull();
    declare("prepare: true\ntimeout:\n  - proof: unit\n    seconds: 30\n");
    expect(defaultTimeoutOf(dir)).toBeNull();
  });

  it("ignores anything that is not a positive number of seconds", () => {
    for (const value of ["soon", "0", "-5", "[]", "{ seconds: 30 }"]) {
      declare(`timeout_default: ${value}\n`);
      expect(defaultTimeoutOf(dir)).toBeNull();
    }
  });
});

describe("and the examiner runs on it", () => {
  it("kills a proof at the tree's default when the proof declared none", async () => {
    declare("timeout_default: 1\n");
    const { task, taskTest } = readyTask("sleep 30");

    const started = Date.now();
    const r = await new Examiner(db).runTaskTests(task, dir);
    const took = Date.now() - started;

    expect(r.failed).toContain(taskTest);
    expect(took).toBeLessThan(20_000);
    expect(outputOf(taskTest)).toContain(TIMED_OUT);
    expect(outputOf(taskTest)).toContain("1000ms");
  });

  it("lets a proof that declared its own seconds outlive the tree's default", async () => {
    declare("timeout_default: 1\ntimeout:\n  - proof: patient.ts\n    seconds: 30\n");
    const { task, taskTest } = readyTask("sleep 2 && test -f patient.ts");
    writeFileSync(join(dir, "patient.ts"), "x\n");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.passed).toContain(taskTest);
    expect(stateOf(taskTest)).toBe("passed");
  });

  it("lets an explicit limit from the caller beat the tree's default", async () => {
    declare("timeout_default: 1800\n");
    const { task, taskTest } = readyTask("sleep 30");

    const r = await new Examiner(db, 250).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(outputOf(taskTest)).toContain("250ms");
  });

  it("falls back to the built-in limit where the tree declares nothing", async () => {
    declare("prepare: true\n");
    const { task, taskTest } = readyTask("test -f nowhere.ts");

    const r = await new Examiner(db).runTaskTests(task, dir);

    // Nothing kept it waiting: the built-in is the limit here, and it is ten minutes.
    expect(DEFAULT_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(r.failed).toContain(taskTest);
    expect(outputOf(taskTest)).not.toContain(TIMED_OUT);
  });
});
