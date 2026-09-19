import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Examiner, TIMED_OUT, budgetsOf, timeoutFor } from "../src/index.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;
let dir: string;

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

const outputOf = (id: number): string =>
  (db.prepare("SELECT last_output FROM task_test WHERE id = ?").get(id) as { last_output: string }).last_output;

/** A `config/project.yaml` in the tree being examined. Deliberately without `prepare:` —
 *  what these tests are about is the budget a run is given, not the build before it. */
function declare(yaml: string): void {
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "project.yaml"), yaml);
}

beforeEach(() => {
  dir = tmp("wecode-own-timeout-");
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

describe("the tree declares what each artefact is allowed to take", () => {
  it("reads the timeout list off the tree being examined", () => {
    declare("timeout:\n  - proof: slow-suite.sh\n    seconds: 1800\n  - proof: unit\n    seconds: 30\n");
    expect(budgetsOf(dir)).toEqual([
      { proof: "slow-suite.sh", seconds: 1800 },
      { proof: "unit", seconds: 30 },
    ]);
  });

  it("declares nothing where there is no config, and nothing where there is no list", () => {
    expect(budgetsOf(dir)).toEqual([]);
    declare("prepare: true\n");
    expect(budgetsOf(dir)).toEqual([]);
  });

  it("ignores an entry that names no proof or no positive number of seconds", () => {
    declare(
      [
        "timeout:",
        "  - proof: ''",
        "    seconds: 30",
        "  - proof: no-seconds",
        "  - proof: not-a-number",
        "    seconds: soon",
        "  - proof: negative",
        "    seconds: -5",
        "  - proof: good",
        "    seconds: 12",
      ].join("\n"),
    );
    expect(budgetsOf(dir)).toEqual([{ proof: "good", seconds: 12 }]);
  });
});

describe("what an artefact declared is what it is given", () => {
  const budgets = [
    { proof: "scripts/slow.sh", seconds: 1800 },
    { proof: "vitest", seconds: 120 },
  ];

  it("gives a declaring artefact its own seconds, in milliseconds", () => {
    expect(timeoutFor("bash scripts/slow.sh --all", budgets, 600_000)).toBe(1_800_000);
  });

  it("leaves the runner's own limit on an artefact that declared none", () => {
    expect(timeoutFor("test -f hello.ts", budgets, 600_000)).toBe(600_000);
  });

  it("takes the first declaration the command matches, so a config reads top to bottom", () => {
    expect(timeoutFor("bash scripts/slow.sh && pnpm vitest run", budgets, 600_000)).toBe(1_800_000);
  });

  it("covers the narrowed re-run of the same command, which carries it whole", () => {
    expect(timeoutFor("pnpm vitest run test/a.test.ts test/b.test.ts", budgets, 600_000)).toBe(120_000);
  });
});

describe("and the examiner honours it", () => {
  it("lets an artefact outlive the runner's default when it declared longer", async () => {
    declare("timeout:\n  - proof: patient.ts\n    seconds: 30\n");
    const { task, taskTest } = readyTask("sleep 1 && test -f patient.ts");
    writeFileSync(join(dir, "patient.ts"), "x\n");

    // A quarter-second default: without the declaration this run is killed before the sleep.
    const r = await new Examiner(db, 250).runTaskTests(task, dir);

    expect(r.passed).toContain(taskTest);
    expect(stateOf("task_test", taskTest)).toBe("passed");
  });

  it("kills an artefact that overran the budget it asked for, and says so", async () => {
    declare("timeout:\n  - proof: impatient.ts\n    seconds: 1\n");
    const { task, taskTest } = readyTask("sleep 30 && test -f impatient.ts");
    writeFileSync(join(dir, "impatient.ts"), "x\n");

    const started = Date.now();
    // Ten minutes by default: the declaration is the only thing that can end this run early.
    const r = await new Examiner(db, 10 * 60 * 1000).runTaskTests(task, dir);
    const took = Date.now() - started;

    expect(r.failed).toContain(taskTest);
    expect(took).toBeLessThan(20_000);
    expect(outputOf(taskTest)).toContain(TIMED_OUT);
    expect(outputOf(taskTest)).toContain("1000ms");
  });

  it("keeps the runner's own limit for an artefact that declared nothing", async () => {
    declare("timeout:\n  - proof: somebody-else\n    seconds: 1800\n");
    const { task, taskTest } = readyTask("sleep 30");

    const r = await new Examiner(db, 250).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(outputOf(taskTest)).toContain("250ms");
  });

  it("says timed out only when the run was killed, never of a command that simply failed", async () => {
    declare("timeout:\n  - proof: nowhere.ts\n    seconds: 30\n");
    const { task, taskTest } = readyTask("test -f nowhere.ts");

    const r = await new Examiner(db, 250).runTaskTests(task, dir);

    expect(r.failed).toContain(taskTest);
    expect(outputOf(taskTest)).not.toContain(TIMED_OUT);
  });
});
