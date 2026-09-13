import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Scripts } from "../src/index.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

beforeEach(() => {
  db = open(join(mkdtempSync(join(tmpdir(), "wecode-scripts-")), "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", "/acme");
  const p = make.project(ws, "s", "/r");
  const rel = make.release(p, "1.0");
  const e = make.epic(rel, "e");
  const s = make.story(e, "s");
  const req = make.requirement(s, "r");
  criteria = make.criteria(req, "c");
  for (const [entity, id] of [["project", p], ["release", rel], ["epic", e], ["story", s], ["requirement", req], ["acceptance_criteria", criteria]] as const) {
    engine.apply(entity, id, "start", "chief");
  }
});

function readyTask(artefact: string): { task: number; taskTest: number; acceptance: number } {
  const acceptance = make.acceptanceTest(criteria, "proof", "script", "true");
  const task = make.task(acceptance, "do it", { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, "unit", "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  engine.apply("acceptance_test", acceptance, "deliver", "chief");
  return { task, taskTest, acceptance };
}

describe("script tests need no agent", () => {
  it("passes a command that exits 0, and cascades", async () => {
    const { task, taskTest } = readyTask("true");
    const r = await new Scripts(db, process.cwd()).tick();
    expect(r.passed).toContain(taskTest);
    expect(stateOf("task_test", taskTest)).toBe("passed");
    expect(stateOf("task", task)).toBe("done");
  });

  it("fails a command that does not, and keeps what it printed", async () => {
    const { taskTest } = readyTask("echo 'no such file' >&2; exit 3");
    await new Scripts(db, process.cwd()).tick();
    expect(stateOf("task_test", taskTest)).toBe("failed");
    const row = db.prepare("SELECT last_output FROM task_test WHERE id = ?").get(taskTest) as {
      last_output: string;
    };
    expect(row.last_output).toContain("no such file");
  });

  it("does not run an acceptance_test while its tasks are unfinished", async () => {
    const { acceptance } = readyTask("false");
    await new Scripts(db, process.cwd()).tick();
    expect(stateOf("acceptance_test", acceptance)).toBe("ready");
  });

  it("runs it once they are done, and delivers the story", async () => {
    const { acceptance } = readyTask("true");
    await new Scripts(db, process.cwd()).tick();
    await new Scripts(db, process.cwd()).tick();
    expect(stateOf("acceptance_test", acceptance)).toBe("passed");
    expect(stateOf("story", (db.prepare("SELECT id FROM story").get() as { id: number }).id)).toBe("delivered");
  });
});
