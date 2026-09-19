import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open, type Scope } from "@wecode/core";
import { allocate, appendOnly, collisionClasses, DEFAULT_BUDGET } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A file that is only ever appended to: one line per new module. */
const MAP = "packages/core/config/components.yaml";
/** A file two tasks can both edit and usually not clash: the risk is accepted. */
const LESSONS = "docs/design/17. Lessons.md";

let dir: string;
let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;
let workers: number[];

const place = async () => ({ worker_id: workers.pop() ?? 0, worktree: "/tmp/wt" });

/** Write the workspace's own budget.yaml, one block per class that has paths. */
function declare(classes: Record<string, string[]>): void {
  const body = Object.entries(classes)
    .filter(([, paths]) => paths.length > 0)
    .map(([name, paths]) => `  ${name}:\n${paths.map((p) => `    - "${p}"\n`).join("")}`)
    .join("");
  writeFileSync(join(dir, "budget.yaml"), `max_open: 10\ncollision:\n  scope_overlap: refuse\n${body}`);
}

function readyTask(title: string, write: string[]): number {
  const at = make.acceptanceTest(criteria, `${title} proof`, "script", "bash x.sh");
  const scope: Scope = { write, tools: [] };
  const t = make.task(at, title, { scope, role: "engineer" });
  make.taskTest(t, `${title} unit`, "script", "vitest run");
  const tests = db.prepare("SELECT id FROM task_test WHERE parent_id = ?").all(t) as unknown as {
    id: number;
  }[];
  for (const tt of tests) engine.apply("task_test", tt.id, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", t, "start", "chief");
  return t;
}

const running = (): number[] =>
  (
    db
      .prepare("SELECT objective_id, phase FROM assignment")
      .all() as unknown as { objective_id: number; phase: string }[]
  )
    .filter((r) => ["pending", "running", "waiting"].includes(r.phase))
    .map((r) => r.objective_id);

beforeEach(() => {
  dir = tmp("wecode-classes-");
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", "/acme");
  const p = make.project(ws, "s", "/r");
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  const s = make.story(e, "s");
  criteria = make.criteria(make.requirement(s, "r"), "c");
  workers = [1, 2, 3].map((n) => make.worker(`claude-${n}`, "engineer", "agent"));
});

describe("reading the classes", () => {
  it("reads all three from the workspace's budget.yaml", () => {
    declare({ exclusive: ["packages/core/src/order.ts"], append_only: [MAP], optimistic: [LESSONS] });
    expect(collisionClasses(db)).toEqual(
      new Map([
        ["packages/core/src/order.ts", "exclusive"],
        [MAP, "append_only"],
        [LESSONS, "optimistic"],
      ]),
    );
  });

  it("classifies an undeclared path as exclusive by saying nothing about it", () => {
    declare({ append_only: [MAP] });
    expect(collisionClasses(db).get("packages/ui/src/check.ts")).toBeUndefined();
  });

  it("leaves the rest of the collision block alone", () => {
    declare({});
    expect([...collisionClasses(db).keys()]).toEqual([]);
  });

  it("still answers appendOnly with only the append-only paths", () => {
    declare({ append_only: [MAP], optimistic: [LESSONS] });
    expect(appendOnly(db)).toEqual([MAP]);
  });
});

describe("an exclusive path", () => {
  it("is a lock even when it is written down as exclusive", async () => {
    declare({ exclusive: [MAP] });
    readyTask("first", ["packages/ui/src/check.ts", MAP]);
    const b = readyTask("second", ["packages/cli/src/ui.ts", MAP]);

    await allocate(db, DEFAULT_BUDGET, place);
    const r = await allocate(db, DEFAULT_BUDGET, place);

    expect(r.created).toBeNull();
    expect(r.refused.find((x) => x.id === b)?.why).toContain("overlaps");
  });
});

describe("an append-only path", () => {
  it("does not make two tasks that both name it exclusive", async () => {
    declare({ append_only: [MAP] });
    const a = readyTask("ui", ["packages/ui/src/check.ts", MAP]);
    const b = readyTask("cli", ["packages/cli/src/ui.ts", MAP]);

    await allocate(db, DEFAULT_BUDGET, place);
    await allocate(db, DEFAULT_BUDGET, place);

    expect(running().sort()).toEqual([a, b].sort());
  });

  it("is still a lock when a glob reaches over it", async () => {
    declare({ append_only: [MAP] });
    readyTask("first", ["packages/core/**"]);
    const b = readyTask("second", ["packages/cli/src/ui.ts", MAP]);

    await allocate(db, DEFAULT_BUDGET, place);
    const r = await allocate(db, DEFAULT_BUDGET, place);

    expect(r.created).toBeNull();
    expect(r.refused.find((x) => x.id === b)?.why).toContain("overlaps");
  });
});

describe("an optimistic path", () => {
  it("does not make two tasks that both name it exclusive", async () => {
    declare({ optimistic: [LESSONS] });
    const a = readyTask("ui", ["packages/ui/src/check.ts", LESSONS]);
    const b = readyTask("cli", ["packages/cli/src/ui.ts", LESSONS]);

    await allocate(db, DEFAULT_BUDGET, place);
    await allocate(db, DEFAULT_BUDGET, place);

    expect(running().sort()).toEqual([a, b].sort());
  });

  it("is not a lock even when a glob reaches over it", async () => {
    declare({ optimistic: [LESSONS] });
    const a = readyTask("first", ["docs/**"]);
    const b = readyTask("second", ["packages/cli/src/ui.ts", LESSONS]);

    await allocate(db, DEFAULT_BUDGET, place);
    await allocate(db, DEFAULT_BUDGET, place);

    expect(running().sort()).toEqual([a, b].sort());
  });

  it("does not discount the other paths the same pair shares", async () => {
    declare({ optimistic: [LESSONS] });
    readyTask("first", ["packages/ui/src/check.ts", LESSONS]);
    const b = readyTask("second", ["packages/ui/src/check.ts", LESSONS]);

    await allocate(db, DEFAULT_BUDGET, place);
    const r = await allocate(db, DEFAULT_BUDGET, place);

    expect(r.created).toBeNull();
    expect(r.refused.find((x) => x.id === b)?.why).toContain("overlaps");
  });
});

describe("the three classes together", () => {
  it("let through only the pairs no exclusive path holds", async () => {
    declare({ exclusive: ["packages/core/src/order.ts"], append_only: [MAP], optimistic: [LESSONS] });
    const a = readyTask("first", ["packages/core/src/order.ts", MAP, LESSONS]);
    const b = readyTask("second", ["packages/ui/src/check.ts", MAP, LESSONS]);
    const c = readyTask("third", ["packages/core/src/order.ts", LESSONS]);

    for (const _ of [a, b, c]) await allocate(db, DEFAULT_BUDGET, place);

    expect(running().sort()).toEqual([a, b].sort());
  });

  it("does not reconsider a role that is at its ceiling", async () => {
    declare({ optimistic: [LESSONS] });
    readyTask("first", ["packages/ui/src/check.ts", LESSONS]);
    const b = readyTask("second", ["packages/cli/src/ui.ts", LESSONS]);
    const config = { ...DEFAULT_BUDGET, max_open_per_role: { engineer: 1 } };

    await allocate(db, config, place);
    const r = await allocate(db, config, place);

    expect(r.created).toBeNull();
    expect(r.refused.find((x) => x.id === b)?.why).toContain("engineer is at 1");
  });
});
