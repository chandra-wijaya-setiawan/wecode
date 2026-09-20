import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Examiner, NOT_IN_TREE } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A test whose command names no path — `vitest run <name>` and friends — cannot be read
 *  for the file it proves. Without the file the test declared, a tree that simply does not
 *  have that proof in it runs the whole suite, goes red on something else or on nothing at
 *  all, and the work is accused of a failure that is really an absence.
 *
 *  So the declared `script_path` is what the examiner looks for, and only when the test
 *  declared none does it fall back to reading the command. */

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;
let dir: string;

const stateOf = (id: number): string =>
  (db.prepare("SELECT state FROM task_test WHERE id = ?").get(id) as { state: string }).state;

const outputOf = (id: number): string | null =>
  (db.prepare("SELECT last_output FROM task_test WHERE id = ?").get(id) as { last_output: string | null })
    .last_output;

beforeEach(() => {
  dir = tmp("wecode-missing-artefact-");
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

/** A started task with one ready script task_test, carrying the command it runs and the
 *  file it says that proof lives in. */
function readyTask(artefact: string, scriptPath: string | null): { task: number; taskTest: number } {
  const at = make.acceptanceTest(criteria, `proof-${artefact}`, "script", "true");
  const task = make.task(at, `do-${artefact}`, { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, `unit-${artefact}`, "script", artefact, scriptPath);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  return { task, taskTest };
}

function write(relative: string, body: string): void {
  mkdirSync(join(dir, relative, ".."), { recursive: true });
  writeFileSync(join(dir, relative), body);
}

describe("a test whose declared file is not in the tree", () => {
  it("is unrunnable and names the file, though its command names no path at all", async () => {
    // `exit 7` stands for every command that would go red for reasons of its own: the
    // point is that it is never run, because the file it proves is not here.
    const { task, taskTest } = readyTask("exit 7", "packages/mail/test/token.test.ts");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.unrunnable).toContain(taskTest);
    expect(r.failed).toEqual([]);
    expect(stateOf(taskTest)).toBe("ready");
    expect(outputOf(taskTest)).toContain(NOT_IN_TREE);
    expect(outputOf(taskTest)).toContain("packages/mail/test/token.test.ts");
  });

  it("leaves the task ready rather than failing it over an absence", async () => {
    const { task, taskTest } = readyTask("vitest run the-token-is-single-use", "test/token.test.ts");

    await new Examiner(db).runTaskTests(task, dir);

    expect(stateOf(taskTest)).toBe("ready");
    expect((db.prepare("SELECT state FROM task WHERE id = ?").get(task) as { state: string }).state).toBe("ready");
  });

  it("runs the command, and judges it, once the declared file is in the tree", async () => {
    const { task, taskTest } = readyTask("echo ran; exit 0", "test/token.test.ts");
    write("test/token.test.ts", "// the proof\n");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.passed).toContain(taskTest);
    expect(r.unrunnable).toEqual([]);
    expect(stateOf(taskTest)).toBe("passed");
    expect(outputOf(taskTest)).toContain("ran");
  });

  it("still fails a test whose declared file is there and whose command goes red", async () => {
    const { task, taskTest } = readyTask("echo broken; exit 3", "test/token.test.ts");
    write("test/token.test.ts", "// the proof\n");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(stateOf(taskTest)).toBe("failed");
    expect(outputOf(taskTest)).not.toContain(NOT_IN_TREE);
    expect(outputOf(taskTest)).toContain("broken");
  });

  it("falls back to the command when the test declares no file, as it always did", async () => {
    const { task, taskTest } = readyTask("./scripts/proof.sh", null);

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.unrunnable).toContain(taskTest);
    expect(outputOf(taskTest)).toContain("./scripts/proof.sh");
  });

  it("believes the declaration over the command when the two disagree", async () => {
    // The command's own script is right here; the file the test says it proves is not. An
    // absent proof is an absence whichever of the two names it.
    const { task, taskTest } = readyTask("bash scripts/proof.sh", "test/gone.test.ts");
    write("scripts/proof.sh", "echo ran\n");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.unrunnable).toContain(taskTest);
    expect(outputOf(taskTest)).toContain("test/gone.test.ts");
  });
});
