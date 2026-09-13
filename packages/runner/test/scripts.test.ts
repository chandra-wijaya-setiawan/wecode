import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Scripts } from "../src/index.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let story: number;
let criteria: number;
let dir: string;

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wecode-scripts-"));
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", dir);
  const p = make.project(ws, "s", dir);
  const rel = make.release(p, "1.0");
  const e = make.epic(rel, "e");
  story = make.story(e, "s");
  const req = make.requirement(story, "r");
  criteria = make.criteria(req, "c");
  for (const [entity, id] of [["project", p], ["release", rel], ["epic", e], ["story", story], ["requirement", req], ["acceptance_criteria", criteria]] as const) {
    engine.apply(entity, id, "start", "chief");
  }
});

function readyTask(artefact: string, acceptance = "true"): { task: number; taskTest: number; acceptance: number } {
  const at = make.acceptanceTest(criteria, `proof-${artefact}`, "script", acceptance);
  const task = make.task(at, `do-${artefact}`, { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, `unit-${artefact}`, "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  return { task, taskTest, acceptance: at };
}

describe("a task_test proves one attempt, in that attempt's tree", () => {
  it("passes when the file the attempt wrote is there", async () => {
    const { task, taskTest } = readyTask("test -f hello.ts");
    writeFileSync(join(dir, "hello.ts"), "x\n");

    const r = await new Scripts(db).runTaskTests(task, dir);
    expect(r.passed).toContain(taskTest);
    expect(stateOf("task", task)).toBe("done");
  });

  it("fails in a tree where the work is not, and keeps what it printed", async () => {
    const { task, taskTest } = readyTask("test -f nowhere.ts");
    const r = await new Scripts(db).runTaskTests(task, dir);
    expect(r.failed).toContain(taskTest);
    expect(stateOf("task", task)).toBe("ready");
    const row = db.prepare("SELECT last_output FROM task_test WHERE id = ?").get(taskTest) as {
      last_output: string;
    };
    expect(row.last_output).toContain("Command failed");
  });

  it("runs a test that failed before, so a retry can settle it", async () => {
    const { task, taskTest } = readyTask("test -f later.ts");
    await new Scripts(db).runTaskTests(task, dir);
    expect(stateOf("task_test", taskTest)).toBe("failed");

    writeFileSync(join(dir, "later.ts"), "x\n");
    await new Scripts(db).runTaskTests(task, dir);
    expect(stateOf("task_test", taskTest)).toBe("passed");
  });
});

describe("an acceptance_test proves a criteria, once its tasks are finished", () => {
  it("does not run while a task is unfinished", async () => {
    const { acceptance } = readyTask("test -f missing.ts", "true");
    const r = await new Scripts(db).runAcceptanceTests(story, dir);
    expect(r.passed).not.toContain(acceptance);
    expect(stateOf("acceptance_test", acceptance)).toBe("ready");
  });

  it("runs once they are, and delivers the story", async () => {
    const { task, acceptance } = readyTask("true", "true");
    await new Scripts(db).runTaskTests(task, dir);
    await new Scripts(db).runAcceptanceTests(story, dir);
    expect(stateOf("acceptance_test", acceptance)).toBe("passed");
    expect(stateOf("story", story)).toBe("delivered");
  });
});
