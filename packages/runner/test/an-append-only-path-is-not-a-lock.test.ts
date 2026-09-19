import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open, type Scope } from "@wecode/core";
import { allocate, appendOnly, DEFAULT_BUDGET } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The map every task that adds a module must name. One line per module, appended. */
const MAP = "packages/core/config/components.yaml";

let dir: string;
let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;
let workers: number[];

const place = async () => ({ worker_id: workers.pop() ?? 0, worktree: "/tmp/wt" });

/** Declare in the workspace's own budget.yaml which paths are only ever appended to. */
function declareAppendOnly(...paths: string[]): void {
  const body = paths.length === 0 ? "" : `\ncollision:\n  append_only:\n${paths.map((p) => `    - ${p}\n`).join("")}`;
  writeFileSync(join(dir, "budget.yaml"), `max_open: 10\n${body}`);
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
  dir = tmp("wecode-append-");
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

describe("a path declared append-only", () => {
  it("is read from the workspace's budget.yaml", () => {
    declareAppendOnly(MAP);
    expect(appendOnly(db)).toEqual([MAP]);
  });

  it("is nothing at all when the config declares none", () => {
    declareAppendOnly();
    expect(appendOnly(db)).toEqual([]);
  });

  it("does not make two tasks exclusive", async () => {
    declareAppendOnly(MAP);
    const a = readyTask("ui/check.ts", ["packages/ui/src/check.ts", MAP]);
    const b = readyTask("cli/ui.ts", ["packages/cli/src/ui.ts", MAP]);

    const first = await allocate(db, DEFAULT_BUDGET, place);
    const second = await allocate(db, DEFAULT_BUDGET, place);

    expect(first.created).not.toBeNull();
    expect(second.created).not.toBeNull();
    expect(running().sort()).toEqual([a, b].sort());
    expect(second.refused.map((r) => r.why).join()).not.toContain("overlaps");
  });

  it("lets the whole fleet run where only the map was shared", async () => {
    declareAppendOnly(MAP);
    const ids = [
      readyTask("ui/check.ts", ["packages/ui/src/check.ts", MAP]),
      readyTask("cli/ui.ts", ["packages/cli/src/ui.ts", MAP]),
      readyTask("runner/screens-check.ts", ["packages/runner/src/screens-check.ts", MAP]),
    ];
    for (const _ of ids) await allocate(db, DEFAULT_BUDGET, place);
    expect(running().sort()).toEqual([...ids].sort());
  });
});

describe("an ordinary shared path", () => {
  it("is still a lock, even beside an append-only one", async () => {
    declareAppendOnly(MAP);
    readyTask("first", ["packages/ui/src/check.ts", MAP]);
    const b = readyTask("second", ["packages/ui/src/check.ts", MAP]);

    await allocate(db, DEFAULT_BUDGET, place);
    const r = await allocate(db, DEFAULT_BUDGET, place);

    expect(r.created).toBeNull();
    expect(r.refused.find((x) => x.id === b)?.why).toContain("overlaps");
  });

  it("is still a lock when the map is not declared append-only", async () => {
    declareAppendOnly();
    readyTask("first", ["packages/ui/src/check.ts", MAP]);
    const b = readyTask("second", ["packages/cli/src/ui.ts", MAP]);

    await allocate(db, DEFAULT_BUDGET, place);
    const r = await allocate(db, DEFAULT_BUDGET, place);

    expect(r.created).toBeNull();
    expect(r.refused.find((x) => x.id === b)?.why).toContain("overlaps");
  });

  it("is still a lock when a glob reaches over the declared path", async () => {
    declareAppendOnly(MAP);
    readyTask("first", ["packages/core/**"]);
    const b = readyTask("second", ["packages/cli/src/ui.ts", MAP]);

    await allocate(db, DEFAULT_BUDGET, place);
    const r = await allocate(db, DEFAULT_BUDGET, place);

    expect(r.created).toBeNull();
    expect(r.refused.find((x) => x.id === b)?.why).toContain("overlaps");
  });
});

describe("letting one back in", () => {
  it("keeps core's order rather than putting it last", async () => {
    declareAppendOnly(MAP);
    const holder = readyTask("holder", ["packages/core/src/map.ts", MAP]);
    const retried = readyTask("retried", ["packages/ui/src/check.ts"]);
    db.prepare("UPDATE task SET attempts = 2 WHERE id = ?").run(retried);
    const fresh = readyTask("fresh", ["packages/cli/src/ui.ts", MAP]);

    // holder goes first and holds the map; fresh was refused for it, retried was not.
    await allocate(db, DEFAULT_BUDGET, place);
    expect(running()).toEqual([holder]);

    const r = await allocate(db, DEFAULT_BUDGET, place);
    const row = db.prepare("SELECT objective_id FROM assignment WHERE id = ?").get(r.created) as {
      objective_id: number;
    };
    expect(row.objective_id).toBe(fresh);
  });

  it("does not reconsider a role that is at its ceiling", async () => {
    declareAppendOnly(MAP);
    readyTask("first", ["packages/ui/src/check.ts", MAP]);
    const b = readyTask("second", ["packages/cli/src/ui.ts", MAP]);
    const config = { ...DEFAULT_BUDGET, max_open_per_role: { engineer: 1 } };

    await allocate(db, config, place);
    const r = await allocate(db, config, place);

    expect(r.created).toBeNull();
    expect(r.refused.find((x) => x.id === b)?.why).toContain("engineer is at 1");
  });
});
