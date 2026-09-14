import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
let dir: string;

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

const outputOf = (id: number): string | null =>
  (db.prepare("SELECT last_output FROM task_test WHERE id = ?").get(id) as { last_output: string | null })
    .last_output;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wecode-unrunnable-"));
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
  engine.apply("task", task, "start", "chief");
  return { task, taskTest };
}

/** A script the runner can actually invoke, written into the tree the run happens in. */
function writeScript(relative: string, body: string): void {
  mkdirSync(join(dir, relative, ".."), { recursive: true });
  writeFileSync(join(dir, relative), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, relative), 0o755);
}

describe("a test whose script is not there is unrunnable, not failed", () => {
  it("leaves a test whose script_path is absent ready, with the reason", async () => {
    const { task, taskTest } = readyTask("./scripts/proof.sh");

    const r = await new Scripts(db).runTaskTests(task, dir);

    expect(r.unrunnable).toContain(taskTest);
    expect(r.failed).toEqual([]);
    expect(stateOf("task_test", taskTest)).toBe("ready");
    expect(stateOf("task", task)).toBe("ready");
    expect(outputOf(taskTest)).toContain("its script is not in this tree");
    expect(outputOf(taskTest)).toContain("./scripts/proof.sh");
  });

  it("still fails a test whose script is there and exits non-zero", async () => {
    const { task, taskTest } = readyTask("./scripts/proof.sh");
    writeScript("scripts/proof.sh", "echo no; exit 3");

    const r = await new Scripts(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    // The bucket is always reported, so the board can tell "no missing scripts" from
    // "this runner does not know about missing scripts".
    expect(r.unrunnable).toEqual([]);
    expect(stateOf("task_test", taskTest)).toBe("failed");
    expect(outputOf(taskTest)).not.toContain("its script is not in this tree");
    expect(outputOf(taskTest)).toContain("no");
  });
});
